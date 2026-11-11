"""登录 / 登出 / 健康检查。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response

from .. import auth, providers
from ..errors import ApiError
from ..schemas import LoginIn
from .deps import get_conn

router = APIRouter(prefix="/api", tags=["auth"])


@router.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "app": "miushi-yuanqi",
        "version": "0.1.0",
        "authRequired": auth.auth_required(),
        "devMode": auth.dev_mode(),
        "mockModel": providers.mock_enabled(),
    }


@router.get("/auth/me")
def me(request: Request) -> dict:
    return auth.me_payload(request)


@router.post("/auth/login")
def login(payload: LoginIn, request: Request, response: Response, conn=Depends(get_conn)) -> dict:
    if not auth.auth_required():
        return {"ok": True, "devMode": True, "message": "开发模式：没有设置登录密码。"}
    key = auth.client_key(request)
    wait = auth.login_blocked(key)
    if wait:
        raise ApiError("ratelimit", "密码错太多次了，" + str(wait) + " 秒后再试。", status=429)
    if not auth.check_password(payload.password):
        fails = auth.record_login_fail(key)
        left = max(0, auth.LOGIN_MAX_FAILS - fails)
        if left:
            hint = "密码不对，再试一次。（还可以试 " + str(left) + " 次）"
        else:
            hint = "密码不对。短时间内错太多次，先等 5 分钟。"
        raise ApiError("auth", hint, status=401)
    auth.clear_login_fails(key)
    token, expires = auth.create_session(conn)
    response.set_cookie(
        auth.COOKIE_NAME,
        token,
        max_age=auth.SESSION_TTL,
        httponly=True,
        samesite="lax",
        secure=auth.session_secure() or request.url.scheme == "https",
        path="/",
    )
    return {"ok": True, "authenticated": True, "expiresAt": expires}


@router.post("/auth/logout")
def logout(request: Request, response: Response, conn=Depends(get_conn)) -> dict:
    token = auth.token_from_request(request)
    auth.drop_session(conn, token)
    response.delete_cookie(auth.COOKIE_NAME, path="/")
    return {"ok": True}
