"""世界书 CRUD、条目编辑、酒馆 JSON 导入导出。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends

from .. import cards, db
from ..errors import ApiError
from .deps import get_conn

router = APIRouter(prefix="/api/worldbooks", tags=["worldbooks"])


def _body_book(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict) and isinstance(payload.get("book"), dict):
        return payload["book"]
    return payload if isinstance(payload, dict) else {}


def _get_or_404(conn, book_id: str):
    item = db.get_book(conn, book_id)
    if not item:
        raise ApiError("notfound", "这本世界书已经不在列表里了。", status=404)
    return item


def _unique_name(conn, base: str) -> str:
    name = base or "导入的世界书"
    index = 1
    while conn.execute("SELECT 1 FROM world_books WHERE name = ?", (name,)).fetchone():
        index += 1
        name = base + "（" + str(index) + "）"
    return name


def _normalize_entries(entries: Any) -> list[dict[str, Any]]:
    out = []
    for entry in cards.convert_book_entries(entries):
        item = dict(entry)
        item["id"] = db.new_id("e")
        item["extras"] = {}
        out.append(item)
    return out


@router.get("")
def list_books(conn=Depends(get_conn)) -> dict:
    rows = conn.execute("SELECT * FROM world_books ORDER BY created_at ASC").fetchall()
    return {"books": [db.book_json(conn, row) for row in rows]}


@router.post("/import")
def import_book(payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    raw = payload.get("payload") if isinstance(payload.get("payload"), dict) else payload
    if isinstance(raw.get("book"), dict):
        raw = raw["book"]
    entries_source = raw.get("entries")
    if not entries_source:
        raise ApiError("badrequest", "这份文件里没有世界书条目。")
    entries = _normalize_entries(entries_source)
    if not entries:
        raise ApiError("badrequest", "这份文件里没有世界书条目。")
    base_name = str(raw.get("name") or raw.get("title") or "导入的世界书").strip()
    book = {"id": db.new_id("wb"), "name": _unique_name(conn, base_name), "entries": entries}
    db._upsert_book(conn, book, db.now_iso())
    return {"ok": True, "book": db.get_book(conn, book["id"]), "note": "已导入 " + str(len(entries)) + " 个条目。"}


@router.get("/export")
def export_all_books(conn=Depends(get_conn)) -> dict:
    rows = conn.execute("SELECT * FROM world_books ORDER BY created_at ASC").fetchall()
    return {
        "app": "miushi-yuanqi",
        "kind": "world_books",
        "version": 1,
        "exportedAt": db.now_iso(),
        "books": [db.book_json(conn, row) for row in rows],
    }


@router.get("/{book_id}/export")
def export_book(book_id: str, conn=Depends(get_conn)) -> dict:
    return cards.book_to_tavern(_get_or_404(conn, book_id))


@router.post("")
def create_book(payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    item = dict(_body_book(payload))
    item.setdefault("id", db.new_id("wb"))
    if not item.get("name"):
        raise ApiError("badrequest", "先给这本世界书起个名字。")
    if not isinstance(item.get("entries"), list):
        item["entries"] = []
    db._upsert_book(conn, item, db.now_iso())
    return {"ok": True, "book": db.get_book(conn, item["id"])}


@router.get("/{book_id}")
def get_book(book_id: str, conn=Depends(get_conn)) -> dict:
    return {"book": _get_or_404(conn, book_id)}


@router.put("/{book_id}")
def update_book(book_id: str, payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    current = _get_or_404(conn, book_id)
    item = dict(_body_book(payload))
    item["id"] = book_id
    item.setdefault("name", current["name"])
    if not isinstance(item.get("entries"), list):
        item["entries"] = current.get("entries") or []
    db._upsert_book(conn, item, db.now_iso())
    return {"ok": True, "book": db.get_book(conn, book_id)}


@router.delete("/{book_id}")
def delete_book(book_id: str, conn=Depends(get_conn)) -> dict:
    _get_or_404(conn, book_id)
    conn.execute("DELETE FROM world_books WHERE id = ?", (book_id,))
    conn.execute("DELETE FROM world_book_entries WHERE book_id = ?", (book_id,))
    conn.execute("UPDATE characters SET world_book_id = '' WHERE world_book_id = ?", (book_id,))
    conn.execute("UPDATE chats SET world_book_id = '' WHERE world_book_id = ?", (book_id,))
    config = db.load_app_settings(conn)
    if (config.get("settings") or {}).get("globalBookId") == book_id:
        config["settings"]["globalBookId"] = ""
        db.save_app_settings(conn, config)
    return {"ok": True}


@router.post("/{book_id}/entries")
def create_entry(book_id: str, payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    book = _get_or_404(conn, book_id)
    raw = payload.get("entry") if isinstance(payload.get("entry"), dict) else payload
    entry = dict(raw)
    entry.setdefault("id", db.new_id("e"))
    if not entry.get("title"):
        raise ApiError("badrequest", "给这个条目写个标题。")
    entries = list(book.get("entries") or [])
    entries.append(entry)
    book["entries"] = entries
    db._upsert_book(conn, book, db.now_iso())
    return {"ok": True, "book": db.get_book(conn, book_id)}


@router.put("/{book_id}/entries/{entry_id}")
def update_entry(book_id: str, entry_id: str, payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    book = _get_or_404(conn, book_id)
    raw = payload.get("entry") if isinstance(payload.get("entry"), dict) else payload
    found = False
    entries = []
    for entry in book.get("entries") or []:
        if entry.get("id") == entry_id:
            merged = dict(entry)
            merged.update(raw)
            merged["id"] = entry_id
            entries.append(merged)
            found = True
        else:
            entries.append(entry)
    if not found:
        raise ApiError("notfound", "这个条目已经不在书里了。", status=404)
    book["entries"] = entries
    db._upsert_book(conn, book, db.now_iso())
    return {"ok": True, "book": db.get_book(conn, book_id)}


@router.delete("/{book_id}/entries/{entry_id}")
def delete_entry(book_id: str, entry_id: str, conn=Depends(get_conn)) -> dict:
    book = _get_or_404(conn, book_id)
    before = len(book.get("entries") or [])
    book["entries"] = [entry for entry in book.get("entries") or [] if entry.get("id") != entry_id]
    if len(book["entries"]) == before:
        raise ApiError("notfound", "这个条目已经不在书里了。", status=404)
    db._upsert_book(conn, book, db.now_iso())
    return {"ok": True, "book": db.get_book(conn, book_id)}
