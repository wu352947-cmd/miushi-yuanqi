"""角色：CRUD、JSON / PNG 导入导出、最近一场聊天。"""

from __future__ import annotations

import base64
from typing import Any

from fastapi import APIRouter, Body, Depends, File, Form, UploadFile
from fastapi.responses import Response

from .. import cards, db
from ..errors import ApiError
from .deps import get_conn

router = APIRouter(prefix="/api/characters", tags=["characters"])


def _body_character(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict) and isinstance(payload.get("character"), dict):
        return payload["character"]
    return payload if isinstance(payload, dict) else {}


def _get_or_404(conn, character_id: str):
    item = db.get_character(conn, character_id)
    if not item:
        raise ApiError("notfound", "这位角色已经不在列表里了。", status=404)
    return item


def _unique_name(conn, base: str) -> str:
    name = base or "未命名角色"
    index = 1
    while conn.execute("SELECT 1 FROM characters WHERE name = ?", (name,)).fetchone():
        index += 1
        name = base + "（" + str(index) + "）"
    return name


def _unique_book_name(conn, base: str) -> str:
    name = base or "导入的世界书"
    index = 1
    while conn.execute("SELECT 1 FROM world_books WHERE name = ?", (name,)).fetchone():
        index += 1
        name = base + "（" + str(index) + "）"
    return name


def _materialize_book(conn, card: dict[str, Any]) -> dict[str, Any] | None:
    book_raw = card.get("character_book")
    if not isinstance(book_raw, dict):
        return None
    entries = cards.convert_book_entries(book_raw.get("entries"))
    if not entries:
        return None
    for entry in entries:
        entry["id"] = db.new_id("e")
        entry["extras"] = {}
    base_name = str(book_raw.get("name") or book_raw.get("title") or (card.get("name", "") + " · 世界书"))
    book = {"id": db.new_id("wb"), "name": _unique_book_name(conn, base_name), "entries": entries}
    db._upsert_book(conn, book, db.now_iso())
    return {"id": book["id"], "name": book["name"], "entryCount": len(entries)}


@router.get("")
def list_characters(conn=Depends(get_conn)) -> dict:
    rows = conn.execute("SELECT * FROM characters ORDER BY created_at ASC").fetchall()
    return {"characters": [db.character_json(row) for row in rows]}


@router.post("/import")
async def import_character(
    file: UploadFile = File(...),
    mode: str = Form("auto"),
    conn=Depends(get_conn),
) -> dict:
    data = await file.read()
    if len(data) > 8 * 1024 * 1024:
        raise ApiError("badrequest", "文件打不开，换一份再试试。")
    is_png = data.startswith(cards.PNG_SIG)
    avatar = ""
    if is_png:
        raw_card = cards.card_from_png(data)
        if not raw_card:
            raise ApiError("badrequest", "这张图里没有角色卡信息，也许只是一张普通图片。")
        card = cards.normalize_character_card(raw_card)
        avatar = "data:image/png;base64," + base64.b64encode(data).decode("ascii")
    else:
        try:
            card = cards.card_from_json_bytes(data)
        except ValueError as exc:
            raise ApiError("badrequest", str(exc)) from exc
    if card.get("error"):
        raise ApiError("badrequest", "这不是一份能读的角色卡文件。")
    existing = conn.execute("SELECT * FROM characters WHERE name = ?", (card["name"],)).fetchone()
    if mode == "replace" and existing:
        target = db.character_json(existing)
        target.update({key: card.get(key) or "" for key in ("desc", "description", "personality", "scenario", "first_mes", "mes_example")})
        target["source"] = "import"
        target["extras"] = card.get("extras") or {}
        if avatar:
            target["avatar"] = avatar
        book = _materialize_book(conn, card)
        if book:
            target["worldBookId"] = book["id"]
        db._upsert_character(conn, target, db.now_iso())
        return {"ok": True, "character": db.get_character(conn, target["id"]), "book": book, "mode": "replace", "note": "已替换「" + target["name"] + "」。"}
    name = card["name"] if not existing else _unique_name(conn, card["name"] + "（2）")
    item = {
        "id": db.new_id("char"),
        "name": name,
        "desc": card.get("desc") or cards.first_sentence(card.get("description") or ""),
        "description": card.get("description") or "",
        "personality": card.get("personality") or "",
        "scenario": card.get("scenario") or "",
        "first_mes": card.get("first_mes") or "",
        "mes_example": card.get("mes_example") or "",
        "avatar": avatar,
        "worldBookId": "",
        "defaultPersonaId": "",
        "defaultPresetId": "",
        "source": "import",
        "extras": card.get("extras") or {},
    }
    book = _materialize_book(conn, card)
    if book:
        item["worldBookId"] = book["id"]
    db._upsert_character(conn, item, db.now_iso())
    note = "已导入「" + name + "」。"
    if book:
        note = "已导入「" + name + "」，并带入一本世界书。"
    return {"ok": True, "character": db.get_character(conn, item["id"]), "book": book, "mode": "new", "note": note}


@router.get("/export")
def export_all_characters(conn=Depends(get_conn)) -> dict:
    rows = conn.execute("SELECT * FROM characters ORDER BY created_at ASC").fetchall()
    return {
        "app": "miushi-yuanqi",
        "kind": "characters",
        "version": 1,
        "exportedAt": db.now_iso(),
        "characters": [db.character_json(row) for row in rows],
    }


@router.post("")
def create_character(payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    item = dict(_body_character(payload))
    item.setdefault("id", db.new_id("char"))
    if not item.get("name"):
        raise ApiError("badrequest", "先给她起个名字。")
    db._upsert_character(conn, item, db.now_iso())
    return {"ok": True, "character": db.get_character(conn, item["id"])}


@router.get("/{character_id}/export")
def export_character(character_id: str, format: str = "json", conn=Depends(get_conn)) -> Response:
    character = _get_or_404(conn, character_id)
    book = db.get_book(conn, character.get("worldBookId") or "") if character.get("worldBookId") else None
    card = cards.build_v2_character(character, book)
    if format == "png":
        base_png = cards.data_url_to_png(character.get("avatar") or "")
        data = cards.png_with_card(base_png, card)
        return Response(
            content=data,
            media_type="image/png",
            headers={"Content-Disposition": 'attachment; filename="character-' + character_id + '.png"'},
        )
    import json

    return Response(
        content=json.dumps(card, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": 'attachment; filename="character-' + character_id + '.json"'},
    )


@router.get("/{character_id}/chats")
def character_chats(character_id: str, conn=Depends(get_conn)) -> dict:
    _get_or_404(conn, character_id)
    row = db.get_chat_row(conn, character_id)
    return {"chats": [db.chat_json(conn, row, include_messages=False)] if row else []}


@router.get("/{character_id}")
def get_character(character_id: str, conn=Depends(get_conn)) -> dict:
    return {"character": _get_or_404(conn, character_id)}


@router.put("/{character_id}")
def update_character(character_id: str, payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    current = _get_or_404(conn, character_id)
    item = dict(_body_character(payload))
    item["id"] = character_id
    for key in ("name", "desc", "description", "personality", "scenario", "first_mes", "mes_example", "avatar", "worldBookId", "defaultPersonaId", "defaultPresetId", "source", "extras"):
        if key not in item:
            item[key] = current.get(key) or ""
    db._upsert_character(conn, item, db.now_iso())
    return {"ok": True, "character": db.get_character(conn, character_id)}


@router.delete("/{character_id}")
def delete_character(character_id: str, conn=Depends(get_conn)) -> dict:
    _get_or_404(conn, character_id)
    total = conn.execute("SELECT COUNT(*) AS n FROM characters").fetchone()["n"]
    if total <= 1:
        raise ApiError("badrequest", "至少留一位角色。")
    conn.execute("DELETE FROM characters WHERE id = ?", (character_id,))
    for row in conn.execute("SELECT id FROM chats WHERE character_id = ?", (character_id,)).fetchall():
        conn.execute("DELETE FROM messages WHERE chat_id = ?", (row["id"],))
        conn.execute("DELETE FROM chats WHERE id = ?", (row["id"],))
    config = db.load_app_settings(conn)
    if config.get("currentCharacterId") == character_id:
        first = conn.execute("SELECT id FROM characters ORDER BY created_at ASC LIMIT 1").fetchone()
        config["currentCharacterId"] = first["id"] if first else ""
        db.save_app_settings(conn, config)
    return {"ok": True}
