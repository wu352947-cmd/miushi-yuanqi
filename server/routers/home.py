"""首页：今日记住 / 她留的话 / 天气 / 生日。

GET  /api/home        一次拿全（天气和时间都要，可能慢个几百毫秒）
POST /api/home/note   让她现在写一张便条（前端发现当天还没有时后台触发）
"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from .. import db, home
from .deps import get_conn

router = APIRouter(prefix="/api/home", tags=["home"])


@router.get("")
async def read_home(character_id: str = "", chat_id: str = "", conn=Depends(get_conn)) -> dict:
    """首页那几块。任何一块拿不到就是 null，前端负责隐藏。"""
    config = db.load_app_settings(conn)
    settings = config.get("settings") or {}
    data = await home.payload(conn, character_id, chat_id, settings)
    return {"ok": True, **data}


@router.post("/note")
async def refresh_note(chat_id: str = "", force: bool = False, conn=Depends(get_conn)) -> dict:
    """写一张便条。force=true 会覆盖今天已有的那张。"""
    if not chat_id:
        return {"ok": False, "message": "先选一段对话。"}
    note = await home.write_note(chat_id, force=force)
    if not note:
        return {"ok": False, "message": "这次没写出来，等会儿再试。"}
    return {"ok": True, "note": note}
