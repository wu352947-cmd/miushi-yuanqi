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
