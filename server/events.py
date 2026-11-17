"""剧情事件：从最近对话里抽「这一次发生了什么」。

和 memory.py 的分工是互补的，不是重复：
- memory 记「她这个人」：喜好、怕黑、两个人之间的约定，长期稳定；
- events 记「这一天推进了什么」：去了哪、做了什么、关系走到哪一步。

两者共用同一个后台触发点（memory.schedule_extract_after_reply），
但各自发请求、各自开关，互不挤占注意力。
"""
from __future__ import annotations

import logging
from typing import Any

from . import db, memory, providers
from .errors import classify_api_error

LOG = logging.getLogger("msyq")

MAX_EVENTS = 3
KINDS = ("日常", "关系", "秘密", "冲突", "约定")

EVENT_SYSTEM = (
    "你是场记 EVENT_EXTRACT。从最近这段对话里，记下「这一次发生了什么」。\n"
    "\n"
    "和记忆库的分工：\n"
    "- 记忆库记「她这个人」：喜好、怕黑、两个人之间的约定。那些不要写进来。\n"
    "- 你只记「这一天推进了什么」：去了哪里、做了什么、关系或情绪走到哪一步、说定了什么。\n"
    "\n"
    "写法：\n"
    "- title 一行，不超过 24 字，第三人称，像时间轴上的一格：看《你的名字》，她哭了\n"
    "- body 一到两句，补上关键细节：因为奥寺前辈吃醋，靠在他肩上哭完，说想再看一次。\n"
    "- kind 只能取：日常 / 关系 / 秘密 / 冲突 / 约定\n"
    "- importance 1-10，真正改变关系或留下印记的才给 7 以上\n"
    "\n"
    "只写已经发生的。不要写还没发生的承诺，不要写天气和氛围描写，不要换着说法重复同一个意思。\n"
    "最多 3 条，按时间先后排。只输出一个 JSON 对象，不要解释，不要 Markdown：\n"
    '{"events":[{"title":"","body":"","kind":"日常","importance":5}]}\n'
    "没有值得记的，返回空的 events 数组。"
)


def _clean_kind(value: str) -> str:
    value = (value or "").strip()
    return value if value in KINDS else "日常"


def _build_prompt(character_name: str, messages: list) -> str:
    lines = []
    for msg in messages[-12:]:
        who = character_name if msg.get("role") == "ai" else "用户"
        lines.append(who + "：" + str(msg.get("text") or "")[:400])
    parts = [
        "角色：" + character_name,
        "最近对话：",
        "\n".join(lines),
    ]
    return "\n".join(parts)


async def extract_events(chat_id: str, max_events: int = MAX_EVENTS) -> dict[str, Any]:
    """抽一轮事件。失败只返回错误信息，不抛异常，不影响聊天。"""
    if not chat_id:
        return {"ok": False, "message": "缺少对话。", "created": []}

    with db.get_db() as conn:
        chat = db.chat_full_by_id(conn, chat_id)
        if not chat:
            return {"ok": False, "message": "这段对话不在了。", "created": []}
        messages = chat.get("messages") or []
        if len(messages) < 2:
            return {"ok": False, "message": "还没有可抽的内容。", "created": []}
        character_id = chat.get("characterId") or ""
        persona_id = chat.get("personaId") or ""
        bond_row = db.get_bond_row(conn, persona_id, character_id)
        bond_id = (bond_row["id"] if bond_row else "") or ""
        character = db.get_character(conn, character_id) if character_id else None
        character_name = (character or {}).get("name") or "她"
        model, provider, api_key = memory._resolve_model(conn)
        if not model or not provider:
            return {"ok": False, "message": "还没有可用的模型。", "created": []}
        if not api_key and not providers.mock_enabled():
            return {"ok": False, "message": "先到「模型与提供商」里填写 API Key。", "created": []}
        last_id = int(messages[-1].get("id") or 0)
        if last_id:
            done = conn.execute(
                "SELECT 1 FROM events WHERE chat_id = ? AND source_message_id = ? LIMIT 1",
                (chat_id, last_id),
            ).fetchone()
            if done:
                return {"ok": True, "created": [], "skipped": "这一轮已经记过了"}
        day_key = db.event_day_key(conn, chat_id)
        user_text = "[EVENT_EXTRACT]\n" + _build_prompt(character_name, messages)

    system = EVENT_SYSTEM
    prompt = {
        "segments": [
            {"role": "system", "text": system, "kind": "system", "label": "场记"},
            {"role": "user", "text": user_text, "kind": "current", "label": "最近"},
        ],
        "system_text": system,
        "sampling": {"temperature": 0.3, "max_tokens": 500},
        "text": system + "\n" + user_text,
        "meta": {},
    }
    try:
        result = await providers.complete(
            provider, model, prompt, api_key, reasoning_level="off", session_id=chat_id
        )
    except Exception as exc:  # noqa: BLE001
        error = classify_api_error(None, exc, detail=str(exc))
        return {"ok": False, "message": error.get("message") or "抽取失败。", "created": []}

    payload = memory._parse_json_block(result.get("text") or "")
    if not payload:
        return {"ok": False, "message": "模型没给出可读的事件，这次先跳过。", "created": []}

    created: list[dict[str, Any]] = []
    items = payload.get("events")
    if not isinstance(items, list):
        return {"ok": True, "created": [], "skipped": "没有新事件"}

    with db.get_db() as conn:
        for item in items[: max(1, int(max_events))]:
            if not isinstance(item, dict):
                continue
            title = str(item.get("title") or "").strip()
            if not title:
                continue
            try:
                importance = int(item.get("importance") or 5)
            except (TypeError, ValueError):
                importance = 5
            row = db.create_event(
                conn,
                bond_id=bond_id,
                chat_id=chat_id,
                title=title,
                body=str(item.get("body") or "").strip(),
                kind=_clean_kind(str(item.get("kind") or "")),
                importance=importance,
                day_key=day_key,
                source_message_id=last_id,
                character_id=character_id,
                persona_id=persona_id,
                manual=False,
            )
            if row:
                created.append(row)
    return {"ok": True, "created": created}