"""缪诗鸳杞后端入口。

一个进程同时提供：
  /api/...   FastAPI 接口
  /          dist/index.html（单文件前端，同源，不需要 CORS）
  /assets/   静态资源（如果存在）

启动：
  python -m server.app                 # 默认 127.0.0.1:8080
  uvicorn server.app:app --host 127.0.0.1 --port 8080
"""

from __future__ import annotations

import logging
import os
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
ROOT_DIR = BASE_DIR.parent
if __package__ in (None, ""):  # 允许 python server/app.py 这样直接跑
    sys.path.insert(0, str(ROOT_DIR))

try:  # .env 是可选依赖；没有 python-dotenv 时只读环境变量
    from dotenv import load_dotenv

    load_dotenv(ROOT_DIR / ".env")
    load_dotenv(BASE_DIR / ".env")
except ImportError:  # pragma: no cover
    pass

from fastapi import Depends, FastAPI, Request  # noqa: E402
from fastapi.exceptions import RequestValidationError  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse, Response  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from starlette.exceptions import HTTPException as StarletteHTTPException  # noqa: E402

from server import auth, db, providers, usage as usage_mod  # noqa: E402
from server.errors import MESSAGES, ApiError  # noqa: E402
from server.routers import (  # noqa: E402
    auth as auth_routes,
    characters,
    chats,
    circles as circle_routes,
    events as events_routes,
    home as home_routes,
    memories,
    music as music_routes,
    moments as moments_routes,
    bonds,
    migrate,
    models,
    personas,
    presets,
    providers as provider_routes,
    state,
    stats,
    worldbooks,
)
from server.routers.deps import require_auth_dep  # noqa: E402

LOG = logging.getLogger("msyq")

DIST_INDEX = ROOT_DIR / "dist" / "index.html"


# --------------------------------------------------------------------------- 生命周期
@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init_db()
    LOG.info("数据库：%s", db.db_path())
    try:
        with db.get_db() as conn:
            removed = usage_mod.prune_usage(conn)
        if removed:
            LOG.info("清理了 %d 条超过保留期（%d 天）的 usage 记录。", removed, usage_mod.usage_keep_days())
    except Exception:  # noqa: BLE001 - 清理失败不该拦住服务启动
        LOG.warning("usage 清理失败，已跳过（不影响服务）。", exc_info=True)
    if not (os.environ.get("APP_SECRET") or "").strip():
        LOG.warning("未设置 APP_SECRET：正在使用开发用的弱密钥加密 API Key。请按 .env.example 生成一个。")
    if auth.dev_mode():
        LOG.warning("未设置登录密码（APP_PASSWORD）：开发模式，本机任何程序都能访问这个服务；不要这样放到公网。")
    else:
        LOG.info("登录密码已启用（APP_PASSWORD）。")
    if providers.mock_enabled():
        LOG.warning("MSYQ_MOCK=1：模型回复由本机 mock 生成，不会请求外部接口。仅用于本地演示 / 测试。")
    yield


app = FastAPI(
    title="缪诗鸳杞 API",
    version="0.1.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)

PROTECTED = [Depends(require_auth_dep)]

# 公开：健康检查 / 登录
app.include_router(auth_routes.router)
# 需要登录（未设置 APP_PASSWORD 时自动放行）
for module in (
    state,
    stats,
    provider_routes,
    models,
    presets,
    characters,
    personas,
    worldbooks,
    chats,
    memories,
    bonds,
    moments_routes,
    events_routes,
    circle_routes,
    home_routes,
    music_routes,
    migrate,
):
    app.include_router(module.router, dependencies=PROTECTED)


# --------------------------------------------------------------------------- 中间件
@app.middleware("http")
async def security_and_log(request: Request, call_next):
    started = time.monotonic()
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault(
        "Content-Security-Policy",
        # 正式版（http/https）允许手机直连网易云图片服务器；交付样稿用 --inline-covers 的 data URI
        "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob: https://*.music.126.net http://*.music.126.net; "
        "media-src 'self' blob: https://*.music.126.net http://*.music.126.net; "
        "connect-src 'self'",
    )
    if request.url.path.startswith("/api/"):
        # 只记方法与路径，不记查询串（Gemini 的 Key 在 query 里）与请求头
        LOG.info("%s %s -> %s (%dms)", request.method, request.url.path, response.status_code, int((time.monotonic() - started) * 1000))
    return response


# --------------------------------------------------------------------------- 异常 → 中文 JSON
@app.exception_handler(ApiError)
async def handle_api_error(_request: Request, exc: ApiError):
    return JSONResponse(status_code=exc.status, content=exc.payload())


@app.exception_handler(RequestValidationError)
async def handle_validation(_request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={"error": {"kind": "badrequest", "message": MESSAGES["badrequest"], "detail": "请求参数不完整"}},
    )


@app.exception_handler(StarletteHTTPException)
async def handle_http(_request: Request, exc: StarletteHTTPException):
    if exc.status_code == 404:
        message = "没有这个接口。"
    elif exc.status_code == 405:
        message = "这个接口不支持这种请求方式。"
    else:
        message = MESSAGES.get("http", "请求没成功，稍后再试。")
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"kind": "http", "message": message, "detail": str(exc.detail or "")[:200]}},
    )


@app.exception_handler(Exception)
async def handle_unexpected(_request: Request, exc: Exception):
    # 不把英文堆栈交给前端；详情只进服务端日志
    LOG.exception("未处理的异常：%s", exc.__class__.__name__)
    return JSONResponse(
        status_code=500,
        content={"error": {"kind": "internal", "message": MESSAGES["internal"]}},
    )


# --------------------------------------------------------------------------- 静态前端
@app.get("/", include_in_schema=False)
def index():
    if not DIST_INDEX.exists():
        return JSONResponse(
            status_code=503,
            content={
                "error": {
                    "kind": "internal",
                    "message": "还没有构建前端：先在仓库根目录运行 node scripts/build.mjs。",
                }
            },
        )
    return FileResponse(DIST_INDEX, media_type="text/html; charset=utf-8")


@app.get("/index.html", include_in_schema=False)
def index_html():
    return index()


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return Response(status_code=204)


for name, directory in (("assets", ROOT_DIR / "assets"), ("wallpapers", ROOT_DIR / "wallpapers")):
    if directory.exists():
        app.mount("/" + name, StaticFiles(directory=directory), name=name)

# 朋友圈配图：图片走静态文件，不进数据库
_uploads = db.data_dir() / "uploads"
_uploads.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=_uploads), name="uploads")


# --------------------------------------------------------------------------- 本地启动
def main() -> None:
    import uvicorn

    host = (os.environ.get("HOST") or "127.0.0.1").strip()
    port = int(os.environ.get("PORT") or "8080")
    level = (os.environ.get("LOG_LEVEL") or "info").strip()
    if host == "0.0.0.0":
        LOG.warning("HOST=0.0.0.0：服务会监听所有网卡，请确认只在信任的局域网里使用。")
    uvicorn.run("server.app:app", host=host, port=port, log_level=level)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    main()
