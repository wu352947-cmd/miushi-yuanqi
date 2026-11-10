"""提示词预设：CRUD、酒馆 JSON 导入、导出、绑定。"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Body, Depends

from .. import db
from ..errors import ApiError
from .deps import get_conn

router = APIRouter(prefix="/api/presets", tags=["presets"])


def _body_preset(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict) and isinstance(payload.get("preset"), dict):
        return payload["preset"]
    return payload if isinstance(payload, dict) else {}


def _get_or_404(conn, preset_id: str):
    item = db.get_preset(conn, preset_id)
    if not item:
        raise ApiError("notfound", "这个预设已经不在列表里了。", status=404)
    return item


def _num_or_none(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _map_role(role: Any) -> str:
    if role in (1, "user"):
        return "user"
    if role in (2, "assistant"):
        return "assistant"
    return "system"


def _map_position(item: dict[str, Any]) -> str:
    position = item.get("position")
    if position in ("before_char", "after_char"):
        return position
    if item.get("injection_position") is not None and db._int(item.get("injection_depth"), 0) > 0:
        return "depth"
    if item.get("role") in (1, "user"):
        return "after_user"
    return "before_char"


def normalize_tavern_preset(raw: dict[str, Any], filename: str = "") -> dict[str, Any]:
    if not isinstance(raw, dict) or isinstance(raw, list):
        raise ApiError("badrequest", "这不是一份能读的预设文件。")
    prompts = raw.get("prompts") if isinstance(raw.get("prompts"), list) else None
    has_sampling = any(
        key in raw
        for key in ("temperature", "top_p", "max_tokens", "openai_max_tokens", "frequency_penalty", "presence_penalty", "top_k")
    )
    if not prompts and not has_sampling and not isinstance(raw.get("prompt_order"), list):
        raise ApiError("badrequest", "这不是酒馆格式的提示词预设。")
    fragments: list[dict[str, Any]] = []
    by_identifier: dict[str, dict[str, Any]] = {}
    for index, prompt in enumerate(prompts or []):
        if not isinstance(prompt, dict):
            continue
        title = str(prompt.get("name") or prompt.get("title") or prompt.get("comment") or ("片段 " + str(index + 1))).strip()
        content = prompt.get("content") if isinstance(prompt.get("content"), str) else ""
        if not content.strip():
            continue
        fragment = {
            "id": db.new_id("frag"),
            "title": title,
            "content": content,
            "role": _map_role(prompt.get("role")),
            "position": _map_position(prompt),
            "depth": max(1, db._int(prompt.get("injection_depth"), 2)),
            "enabled": prompt.get("enabled") is not False,
            "order": 10 + index * 10,
        }
        fragments.append(fragment)
        if prompt.get("identifier"):
            by_identifier[str(prompt["identifier"])] = fragment
    order_list = None
    if isinstance(raw.get("prompt_order"), list) and raw["prompt_order"]:
        first = raw["prompt_order"][0]
        if isinstance(first, list):
            order_list = first
        elif isinstance(first, dict) and isinstance(first.get("order"), list):
            order_list = first["order"]
    if order_list:
        ordered: list[dict[str, Any]] = []
        used: set[str] = set()
        for index, item in enumerate(order_list):
            identifier = item if isinstance(item, str) else (item or {}).get("identifier") if isinstance(item, dict) else None
            enabled = (item.get("enabled", True) is not False) if isinstance(item, dict) else True
            fragment = by_identifier.get(str(identifier)) if identifier is not None else None
            if fragment and fragment["id"] not in used:
                fragment["order"] = 10 + index * 10
                fragment["enabled"] = enabled
                ordered.append(fragment)
                used.add(fragment["id"])
        fragments = ordered + [f for f in fragments if f["id"] not in used]
    known = {
        "prompts", "prompt_order", "temperature", "top_p", "top_k", "max_tokens", "openai_max_tokens",
        "context_messages", "chat_history_limit", "frequency_penalty", "presence_penalty", "name",
        "preset_name", "stream", "streaming", "extensions", "extra",
    }
    extras = {key: value for key, value in raw.items() if key not in known}
    sampling = {
        "temperature": _num_or_none(raw.get("temperature")),
        "top_p": _num_or_none(raw.get("top_p")),
        "max_tokens": _num_or_none(raw.get("max_tokens") if raw.get("max_tokens") is not None else raw.get("openai_max_tokens")),
        "context_messages": _num_or_none(raw.get("context_messages") if raw.get("context_messages") is not None else raw.get("chat_history_limit")),
        "stream": not (raw.get("stream") is False or raw.get("streaming") is False),
        "frequency_penalty": _num_or_none(raw.get("frequency_penalty")),
        "presence_penalty": _num_or_none(raw.get("presence_penalty")),
    }
    name = str(raw.get("name") or raw.get("preset_name") or "导入的预设").strip()
    return {
        "id": db.new_id("preset"),
        "name": name,
        "desc": "从酒馆导入 · " + str(len(fragments)) + " 条片段",
        "builtin": False,
        "source": "tavern",
        "fragments": fragments,
        "sampling": sampling,
        "extras": extras,
    }


@router.get("")
def list_presets(conn=Depends(get_conn)) -> dict:
    rows = conn.execute("SELECT * FROM prompt_presets ORDER BY created_at ASC").fetchall()
    return {"presets": [db.preset_json(r) for r in rows]}


@router.post("/import")
def import_preset(payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    raw = payload.get("payload") if isinstance(payload.get("payload"), dict) else payload
    if isinstance(raw.get("preset"), dict):
        raw = raw["preset"]
    preset = normalize_tavern_preset(raw)
    preset["name"] = _unique_name(conn, preset["name"])
    db._upsert_preset(conn, preset, db.now_iso())
    return {"ok": True, "preset": preset, "note": "不认识的字段收进了额外资料。"}


def _unique_name(conn, base: str) -> str:
    name = base
    index = 1
    while conn.execute("SELECT 1 FROM prompt_presets WHERE name = ?", (name,)).fetchone():
        index += 1
        name = base + "（" + str(index) + "）"
    return name


@router.get("/export")
def export_all_presets(conn=Depends(get_conn)) -> dict:
    rows = conn.execute("SELECT * FROM prompt_presets ORDER BY created_at ASC").fetchall()
    return {
        "app": "miushi-yuanqi",
        "kind": "prompt_presets",
        "version": 1,
        "exportedAt": db.now_iso(),
        "presets": [db.preset_json(r) for r in rows],
    }


@router.get("/{preset_id}/export")
def export_preset(preset_id: str, conn=Depends(get_conn)) -> dict:
    return {
        "app": "miushi-yuanqi",
        "kind": "prompt_preset",
        "version": 1,
        "exportedAt": db.now_iso(),
        "preset": _get_or_404(conn, preset_id),
    }


@router.post("")
def create_preset(payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    item = _body_preset(payload)
    item = dict(item)
    item.setdefault("id", db.new_id("preset"))
    if not item.get("name"):
        raise ApiError("badrequest", "先给这个预设起个名字。")
    db._upsert_preset(conn, item, db.now_iso())
    return {"ok": True, "preset": db.get_preset(conn, item["id"])}


@router.get("/{preset_id}")
def get_preset(preset_id: str, conn=Depends(get_conn)) -> dict:
    return {"preset": _get_or_404(conn, preset_id)}


@router.put("/{preset_id}")
def update_preset(preset_id: str, payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    _get_or_404(conn, preset_id)
    item = _body_preset(payload)
    item = dict(item)
    item["id"] = preset_id
    db._upsert_preset(conn, item, db.now_iso())
    return {"ok": True, "preset": db.get_preset(conn, preset_id)}


@router.delete("/{preset_id}")
def delete_preset(preset_id: str, conn=Depends(get_conn)) -> dict:
    _get_or_404(conn, preset_id)
    conn.execute("DELETE FROM prompt_presets WHERE id = ?", (preset_id,))
    # 清掉悬空绑定
    conn.execute("UPDATE characters SET default_preset_id = '' WHERE default_preset_id = ?", (preset_id,))
    conn.execute("UPDATE chats SET preset_id = '' WHERE preset_id = ?", (preset_id,))
    config = db.load_app_settings(conn)
    if (config.get("settings") or {}).get("defaultPresetId") == preset_id:
        first = conn.execute("SELECT id FROM prompt_presets ORDER BY created_at ASC LIMIT 1").fetchone()
        config["settings"]["defaultPresetId"] = first["id"] if first else ""
        db.save_app_settings(conn, config)
    return {"ok": True}


@router.post("/{preset_id}/bind")
def bind_preset(preset_id: str, payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    _get_or_404(conn, preset_id)
    chat_id = payload.get("chatId")
    character_id = payload.get("characterId")
    if chat_id:
        conn.execute("UPDATE chats SET preset_id = ?, updated_at = ? WHERE id = ?", (preset_id, db.now_iso(), chat_id))
        return {"ok": True, "scope": "chat"}
    if character_id:
        conn.execute("UPDATE characters SET default_preset_id = ?, updated_at = ? WHERE id = ?", (preset_id, db.now_iso(), character_id))
        return {"ok": True, "scope": "character"}
    config = db.load_app_settings(conn)
    config["settings"]["defaultPresetId"] = preset_id
    db.save_app_settings(conn, config)
    return {"ok": True, "scope": "global"}
