"""登录会话、密码校验与 API Key 加密。

环境变量：
  APP_SECRET    必填。用于派生 Fernet 密钥（API Key 加密）和会话 cookie 的 HMAC。
  APP_PASSWORD  可选。设置了就要求登录；没设置时是开发模式（页面/日志明确提示）。
  APP_USER_NAME 可选，默认 owner。

会话 token 只以 SHA-256 摘要存库；cookie 为 HttpOnly + SameSite=Lax，
请求是 HTTPS（或 SESSION_SECURE=1）时再加 Secure。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import time
from functools import lru_cache
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from .errors import ApiError

COOKIE_NAME = "msyq_session"
SESSION_TTL = 60 * 60 * 24 * 30  # 30 天


# --------------------------------------------------------------------------- 配置
def app_secret() -> str:
    secret = (os.environ.get("APP_SECRET") or "").strip()
    if not secret:
        # 开发便利：没配 APP_SECRET 时用固定的弱密钥，但必须显眼地提示。
        return "msyq-dev-insecure-secret-change-me"
    return secret


def app_password() -> str:
    return os.environ.get("APP_PASSWORD") or ""


def auth_required() -> bool:
    return bool(app_password())


def dev_mode() -> bool:
    return not auth_required()


def session_secure() -> bool:
    flag = (os.environ.get("SESSION_SECURE") or "").strip().lower()
    if flag in ("1", "true", "yes", "on"):
        return True
    return False


def user_name() -> str:
    return (os.environ.get("APP_USER_NAME") or "owner").strip() or "owner"


# --------------------------------------------------------------------------- 密码 / 会话
def check_password(password: str) -> bool:
    expected = app_password()
    if not expected:
        return True
    return hmac.compare_digest(str(password or ""), expected)


def hash_token(token: str) -> str:
    return hashlib.sha256((app_secret() + "|" + token).encode("utf-8")).hexdigest()


def create_session(conn) -> tuple[str, int]:
    """创建一条会话，返回 (明文 token, 过期时间戳)。明文只放 cookie。"""
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    expires = now + SESSION_TTL
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        (hash_token(token), "local", now, expires),
    )
    return token, expires


def drop_session(conn, token: str | None) -> None:
    if not token:
        return
    conn.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_token(token),))


def session_valid(conn, token: str | None) -> bool:
    if not token:
        return False
    row = conn.execute(
        "SELECT expires_at FROM sessions WHERE token_hash = ?", (hash_token(token),)
    ).fetchone()
    if not row:
        return False
    if int(row["expires_at"]) < int(time.time()):
        conn.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_token(token),))
        return False
    return True


def token_from_request(request) -> str | None:
    return request.cookies.get(COOKIE_NAME)


def require_auth(request) -> None:
    """依赖：需要登录时校验 cookie；开发模式直接放行。"""
    if not auth_required():
        return
    conn = getattr(request.state, "conn", None)
    token = token_from_request(request)
    if conn is not None:
        ok = session_valid(conn, token)
    else:
        from . import db

        with db.get_db() as c:
            ok = session_valid(c, token)
    if not ok:
        raise ApiError("auth", "还没有登录，或者登录已经过期。", status=401)


def me_payload(request) -> dict[str, Any]:
    from . import db

    token = token_from_request(request)
    with db.get_db() as conn:
        logged_in = session_valid(conn, token)
    return {
        "authenticated": bool(logged_in) or not auth_required(),
        "authRequired": auth_required(),
        "devMode": dev_mode(),
        "user": {"name": user_name()},
    }


# --------------------------------------------------------------------------- 登录限流
# 单进程内存计数。当前服务是单实例、只监听 127.0.0.1，够用。
# 什么时候需要改：如果哪天挂到 nginx 反代后面，client.host 会全部变成
# 127.0.0.1，那时必须改读 X-Real-IP（下面已经优先取它）。
LOGIN_MAX_FAILS = 10
LOGIN_WINDOW = 300  # 秒

_login_fails: dict[str, list[float]] = {}


def client_key(request) -> str:
    """请求来源标识：优先反代写的 X-Real-IP，否则用 TCP 对端地址。"""
    forwarded = (request.headers.get("x-real-ip") or "").strip()
    if forwarded:
        return forwarded[:64]
    client = getattr(request, "client", None)
    return (getattr(client, "host", "") or "unknown")[:64]


def login_blocked(key: str) -> int:
    """还被挡着吗？返回剩余秒数，0 表示可以尝试。"""
    now = time.time()
    stamps = [t for t in _login_fails.get(key, []) if now - t < LOGIN_WINDOW]
    if not stamps:
        _login_fails.pop(key, None)
        return 0
    _login_fails[key] = stamps
    if len(stamps) >= LOGIN_MAX_FAILS:
        return max(1, int(LOGIN_WINDOW - (now - stamps[0])) + 1)
    return 0


def record_login_fail(key: str) -> int:
    """记一次失败，返回窗口内的累计失败次数。"""
    now = time.time()
    stamps = [t for t in _login_fails.get(key, []) if now - t < LOGIN_WINDOW]
    stamps.append(now)
    _login_fails[key] = stamps
    # 顺手清掉过期条目，避免长期运行内存慢慢堆积
    if len(_login_fails) > 200:
        for stale in [k for k, v in _login_fails.items() if not v or now - v[-1] > LOGIN_WINDOW]:
            _login_fails.pop(stale, None)
    return len(stamps)


def clear_login_fails(key: str) -> None:
    """登录成功后清零，免得正常用户被自己之前的错别字连累。"""
    _login_fails.pop(key, None)


# --------------------------------------------------------------------------- API Key 加密
@lru_cache(maxsize=1)
def _fernet_for(secret: str) -> Fernet:
    digest = hashlib.sha256(("msyq-key-v1|" + secret).encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def fernet() -> Fernet:
    return _fernet_for(app_secret())


def encrypt_key(plain: str) -> str:
    if not plain:
        return ""
    return fernet().encrypt(plain.encode("utf-8")).decode("ascii")


def decrypt_key(token: str) -> str:
    if not token:
        return ""
    try:
        return fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        return ""


def mask_key(plain: str) -> str:
    if not plain:
        return ""
    if len(plain) <= 8:
        return "sk-••••••••"
    return plain[:3] + "••••••••" + plain[-4:]


def store_key(conn, provider_id: str, plain: str) -> tuple[bool, str]:
    """写入加密 Key；空字符串表示清除。返回 (hasKey, mask)。"""
    plain = (plain or "").strip()
    if not plain:
        conn.execute(
            "UPDATE providers SET api_key_enc = '', api_key_mask = '', updated_at = ? WHERE id = ?",
            (_now(), provider_id),
        )
        return False, ""
    conn.execute(
        "UPDATE providers SET api_key_enc = ?, api_key_mask = ?, updated_at = ? WHERE id = ?",
        (encrypt_key(plain), mask_key(plain), _now(), provider_id),
    )
    return True, mask_key(plain)


def provider_api_key(conn, provider_id: str) -> str:
    row = conn.execute("SELECT api_key_enc FROM providers WHERE id = ?", (provider_id,)).fetchone()
    if not row:
        return ""
    return decrypt_key(row["api_key_enc"])


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


if __name__ == "__main__":  # 方便本地生成 APP_SECRET
    print(secrets.token_urlsafe(48))
