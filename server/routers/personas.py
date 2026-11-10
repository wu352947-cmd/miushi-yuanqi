"""用户设定 CRUD 与整包 JSON 导入导出。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends

from .. import db
from ..errors import ApiError
from .deps import get_conn

router = APIRouter(prefix="/api/personas", tags=["personas"])


def _body(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict) and isinstance(payload.get("persona"), dict):
        return payload["persona"]
    return payload if isinstance(payload, dict) else {}


def _get_or_404(conn, persona_id: str):
    item = db.get_persona(conn, persona_id)
    if not item:
        raise ApiError("notfound", "这套用户设定已经不在列表里了。", status=404)
    return item


def _apply(conn, payload: dict[str, Any], persona_id: str | None = None, now: str | None = None) -> dict[str, Any]:
    item = dict(_body(payload))
    if persona_id:
        item["id"] = persona_id
    if not item.get("id"):
        item["id"] = db.new_id("persona")
    if not item.get("name"):
        raise ApiError("badrequest", "先给这套用户设定起个名字。")
    if item.get("is_default"):
        conn.execute("UPDATE user_personas SET is_default = 0")
    db._upsert_persona(conn, item, now or db.now_iso())
    return db.get_persona(conn, item["id"])


@router.get("")
def list_personas(conn=Depends(get_conn)) -> dict:
    rows = conn.execute("SELECT * FROM user_personas ORDER BY created_at ASC").fetchall()
    return {"personas": [db.persona_json(r) for r in rows]}


@router.get("/export")
def export_personas(conn=Depends(get_conn)) -> dict:
    rows = conn.execute("SELECT * FROM user_personas ORDER BY created_at ASC").fetchall()
    personas = [db.persona_json(r) for r in rows]
    descs = {p["name"]: {"description": p.get("description") or ""} for p in personas}
    default = next((p["name"] for p in personas if p.get("is_default")), "")
    return {
        "app": "miushi-yuanqi",
        "kind": "user_personas",
        "version": 1,
        "exportedAt": db.now_iso(),
        "personas": personas,
        "persona_descriptions": descs,
        "default_persona": default,
    }


@router.post("/import")
def import_personas(payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    raw = payload.get("payload") if isinstance(payload.get("payload"), dict) else payload
    incoming: list[dict[str, Any]] = []
    if isinstance(raw.get("personas"), list):
        for item in raw["personas"]:
            if isinstance(item, dict):
                incoming.append(
                    {
                        "name": str(item.get("name") or item.get("title") or "").strip(),
                        "description": str(item.get("description") or item.get("persona") or item.get("text") or "").strip(),
                        "avatar": str(item.get("avatar") or ""),
                    }
                )
    elif isinstance(raw.get("personas"), dict):
        descs = raw.get("persona_descriptions") or {}
        for key, value in raw["personas"].items():
            detail = descs.get(key) or {}
            incoming.append(
                {
                    "name": str(value or key).strip(),
                    "description": str((detail or {}).get("description") or "").strip(),
                    "avatar": "",
                }
            )
    elif isinstance(raw.get("persona_descriptions"), dict):
        for key, detail in raw["persona_descriptions"].items():
            incoming.append(
                {
                    "name": str(key).strip(),
                    "description": str((detail or {}).get("description") or "").strip(),
                    "avatar": "",
                }
            )
    added = 0
    now = db.now_iso()
    for item in incoming:
        if not item["name"]:
            continue
        if conn.execute("SELECT 1 FROM user_personas WHERE name = ?", (item["name"],)).fetchone():
            continue
        db._upsert_persona(
            conn,
            {
                "id": db.new_id("persona"),
                "name": item["name"],
                "description": item["description"],
                "avatar": item["avatar"],
                "is_default": False,
            },
            now,
        )
        added += 1
    if not added:
        raise ApiError("badrequest", "没有新的用户设定可导入。")
    return {"ok": True, "imported": added, "message": "文字已导入，头像请再选一张。" if not any(i["avatar"] for i in incoming) else "已导入 " + str(added) + " 套用户设定。"}


@router.post("")
def create_persona(payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    return {"ok": True, "persona": _apply(conn, payload)}


@router.get("/{persona_id}")
def get_persona(persona_id: str, conn=Depends(get_conn)) -> dict:
    return {"persona": _get_or_404(conn, persona_id)}


@router.put("/{persona_id}")
def update_persona(persona_id: str, payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    _get_or_404(conn, persona_id)
    return {"ok": True, "persona": _apply(conn, payload, persona_id)}


@router.delete("/{persona_id}")
def delete_persona(persona_id: str, conn=Depends(get_conn)) -> dict:
    _get_or_404(conn, persona_id)
    conn.execute("DELETE FROM user_personas WHERE id = ?", (persona_id,))
    conn.execute("UPDATE characters SET default_persona_id = '' WHERE default_persona_id = ?", (persona_id,))
    conn.execute("UPDATE chats SET persona_id = '' WHERE persona_id = ?", (persona_id,))
    return {"ok": True}
