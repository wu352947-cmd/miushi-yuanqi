"""剧情事件接口：列表 / 手动补一条 / 编辑 / 删除 / 手动抽一轮。"""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, Query

from .. import db
from .. import events as events_mod
from ..errors import ApiError
from ..schemas import EventIn, EventPatch
from .deps import get_conn

router = APIRouter(prefix="/api/events", tags=["events"])


@router.get("")
def list_events(
    bondId: str = Query(""),
    chatId: str = Query(""),
    limit: int = Query(50),
    conn=Depends(get_conn),
) -> dict:
    items = db.list_events(conn, bond_id=bondId, chat_id=chatId, limit=limit)
    return {"events": items, "count": len(items)}


@router.get("/recent")
def recent_events(
    bondId: str = Query(""),
    limit: int = Query(3),
    conn=Depends(get_conn),
) -> dict:
    items = db.recent_events(conn, bondId, limit=max(1, min(10, int(limit))))
    return {"events": items}


@router.post("")
def create_event(payload: EventIn = Body(...), conn=Depends(get_conn)) -> dict:
    """手动补一条。manual=1，自动抽取不会覆盖它。"""
    title = (payload.title or "").strip()
    if not title:
        raise ApiError("badrequest", "写一句发生了什么。")
    row = db.create_event(
        conn,
        bond_id=payload.bondId,
        chat_id=payload.chatId,
        title=title,
        body=payload.body,
        kind=payload.kind,
        importance=payload.importance,
        day_key=payload.day,
        character_id=payload.characterId,
        persona_id=payload.personaId,
        manual=True,
    )
    if not row:
        raise ApiError("badrequest", "这条没能存下来。")
    return {"ok": True, "event": row}


@router.patch("/{event_id}")
def update_event(
    event_id: str, payload: EventPatch = Body(...), conn=Depends(get_conn)
) -> dict:
    row = db.update_event(conn, event_id, payload.model_dump(exclude_unset=True))
    if not row:
        raise ApiError("badrequest", "这条事件不在了。")
    return {"ok": True, "event": row}


@router.delete("/{event_id}")
def delete_event(event_id: str, conn=Depends(get_conn)) -> dict:
    return {"ok": db.delete_event(conn, event_id)}


@router.post("/extract")
async def extract_now(
    chatId: str = Query(""),
    payload: dict | None = Body(default=None),
    conn=Depends(get_conn),
) -> dict:
    """手动触发一轮抽取（调试与「现在就记一下」用）。"""
    cid = (chatId or "").strip() or str((payload or {}).get("chatId") or "").strip()
    if not cid:
        raise ApiError("badrequest", "先选一段对话。")
    result = await events_mod.extract_events(cid)
    if not result.get("ok"):
        raise ApiError("badrequest", str(result.get("message") or "这次没抽出来。"))
    return result