"""路由共用依赖：SQLite 连接与登录校验。"""

from __future__ import annotations

from typing import Iterator

from fastapi import Request

from .. import auth, db


def get_conn() -> Iterator:
    conn = db.connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def require_auth_dep(request: Request) -> None:
    auth.require_auth(request)
