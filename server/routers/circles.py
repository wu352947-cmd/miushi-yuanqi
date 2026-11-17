"""世界圈：查看圈与成员、把两个圈并成一个。"""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, Query

from .. import db
from ..errors import ApiError
from ..schemas import CircleMergeIn
from .deps import get_conn

router = APIRouter(prefix="/api/circles", tags=["circles"])


@router.get("")
def list_circles(personaId: str = Query(""), conn=Depends(get_conn)) -> dict:
    items = db.list_circles(conn, persona_id=personaId)
    return {"circles": items, "count": len(items)}


@router.post("/merge")
def merge_circles(payload: CircleMergeIn = Body(...), conn=Depends(get_conn)) -> dict:
    """把一个圈整体并进另一个：动态、NPC、bond 一起搬，源圈删除。"""
    result = db.merge_circles(conn, payload.fromId, payload.intoId)
    if not result.get("ok"):
        raise ApiError("badrequest", str(result.get("message") or "这两个圈合并不了。"))
    return result