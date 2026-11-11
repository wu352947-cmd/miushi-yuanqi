"""记忆库：笔记 CRUD、现在卡、软遗忘 / 恢复、搜索、「记住这个」、自动抽取。"""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, Query

from .. import db, memory
from ..errors import ApiError
from ..schemas import MemoryIn, MemoryPatch, NowIn, RememberIn
from .deps import get_conn

router = APIRouter(prefix="/api/memories", tags=["memories"])


@router.get("")
def list_memories(
    q: str = Query(""),
    category: str = Query(""),
    includeForgotten: int = Query(1),
    kind: str = Query("note"),
    characterId: str = Query(""),
    personaId: str = Query(""),
    scope: str = Query(""),
    conn=Depends(get_conn),
) -> dict:
    items = memory.list_memories(
        conn,
        q=q,
        category=category,
        include_forgotten=bool(includeForgotten),
        kind=kind,
        character_id=characterId,
        persona_id=personaId,
        scope=scope,
    )
    now = memory.now_card(conn, characterId, personaId)
    return {
        "memories": items,
        "now": now,
        "counts": {
            "total": len([m for m in items if not m.get("forgotten")]),
            "pinned": len([m for m in items if m.get("pinned")]),
            "forgotten": len([m for m in items if m.get("forgotten")]),
        },
    }


@router.get("/search")
def search_memories(
    q: str = Query(""),
    characterId: str = Query(""),
    personaId: str = Query(""),
    conn=Depends(get_conn),
) -> dict:
    return {
        "memories": memory.list_memories(
            conn,
            q=q,
            include_forgotten=True,
            kind="note",
            character_id=characterId,
            persona_id=personaId,
        )
    }


@router.get("/now")
def get_now(
    characterId: str = Query(""), personaId: str = Query(""), conn=Depends(get_conn)
) -> dict:
    return {"now": memory.now_card(conn, characterId, personaId)}


@router.put("/now")
def put_now(payload: NowIn, conn=Depends(get_conn)) -> dict:
    return {
        "ok": True,
        "now": memory.set_now(conn, payload.body, payload.characterId, payload.personaId),
    }


@router.post("/remember")
def remember(payload: RememberIn, conn=Depends(get_conn)) -> dict:
    item = memory.remember_text(
        conn,
        payload.text,
        title=payload.title,
        category=payload.category,
        importance=payload.importance,
        source=payload.source or "手动",
        source_chat_id=payload.chatId,
        character_id=payload.characterId,
        persona_id=payload.personaId,
        scope=payload.scope or "pair",
    )
    if not item:
        return {"ok": False, "message": "这句话是空的，或者已经在记忆里了。"}
    return {"ok": True, "memory": item, "message": "记好了：" + item["title"]}


@router.post("/extract")
async def extract(payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    character_id = str(payload.get("characterId") or "")
    if not character_id:
        config = db.load_app_settings(conn)
        character_id = config.get("currentCharacterId") or ""
    if not character_id:
        raise ApiError("badrequest", "先选一位角色。")
    return await memory.extract_memories(
        character_id, str(payload.get("personaId") or ""), manual=True
    )


@router.post("")
def create_memory(payload: MemoryIn, conn=Depends(get_conn)) -> dict:
    item = memory.create_memory(conn, payload.model_dump(), dedupe=False)
    if not item:
        raise ApiError("badrequest", "记忆的正文不能是空的。")
    return {"ok": True, "memory": item}


@router.get("/{memory_id}")
def get_memory(memory_id: str, conn=Depends(get_conn)) -> dict:
    item = memory.get_memory(conn, memory_id)
    if not item:
        raise ApiError("notfound", "这条记忆已经不在列表里了。", status=404)
    return {"memory": item}


@router.put("/{memory_id}")
def update_memory(memory_id: str, payload: MemoryPatch, conn=Depends(get_conn)) -> dict:
    item = memory.update_memory(conn, memory_id, payload.model_dump(exclude_none=True))
    if not item:
        raise ApiError("notfound", "这条记忆已经不在列表里了。", status=404)
    return {"ok": True, "memory": item}


@router.delete("/{memory_id}")
def delete_memory(memory_id: str, conn=Depends(get_conn)) -> dict:
    if not memory.get_memory(conn, memory_id):
        raise ApiError("notfound", "这条记忆已经不在列表里了。", status=404)
    conn.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
    return {"ok": True}


@router.post("/{memory_id}/pin")
def pin_memory(memory_id: str, payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    current = memory.get_memory(conn, memory_id)
    if not current:
        raise ApiError("notfound", "这条记忆已经不在列表里了。", status=404)
    pinned = payload.get("pinned")
    if pinned is None:
        pinned = current["status"] != "pinned"
    item = memory.set_status(conn, memory_id, "pinned" if pinned else "normal")
    return {"ok": True, "memory": item}


@router.post("/{memory_id}/forget")
def forget_memory(memory_id: str, conn=Depends(get_conn)) -> dict:
    item = memory.set_status(conn, memory_id, "forgotten")
    if not item:
        raise ApiError("notfound", "这条记忆已经不在列表里了。", status=404)
    return {"ok": True, "memory": item, "message": "已放进「已遗忘」，随时可以捡回来。"}


@router.post("/{memory_id}/restore")
def restore_memory(memory_id: str, conn=Depends(get_conn)) -> dict:
    item = memory.set_status(conn, memory_id, "normal")
    if not item:
        raise ApiError("notfound", "这条记忆已经不在列表里了。", status=404)
    return {"ok": True, "memory": item, "message": "捡回来了。"}
