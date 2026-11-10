"""提示词拼装 assemblePrompt 的服务器版。

顺序（与 PROVIDERS_DESIGN 第 8.2 节、前端 assemblePrompt 一致）：

  预设前置（before_char）
  → 角色设定（description / personality / scenario）
  → 角色设定之后的预设片段（after_char）
  → 世界书（常开 + 关键词命中，跨书去重，简单字符预算）
  → 用户设定
  → 现在卡 + 钉住的记忆
  → 聊天记录（最近 context_messages 条；depth 片段插到倒数第 N 条之前）
  → 预设后置（after_user 片段）
  → 当前用户句

世界书 v1 只做常开 / 关键词 + 简单预算：扫描最近若干条消息（含当前用户句），
不做递归激活、概率 / 冷却、正则引擎。
"""

from __future__ import annotations

import math
from typing import Any

DEFAULT_SAMPLING: dict[str, Any] = {
    "temperature": 0.85,
    "top_p": 0.95,
    "max_tokens": 1200,
    "context_messages": 16,
    "stream": True,
    "frequency_penalty": None,
    "presence_penalty": None,
}

DEFAULT_WORLD_BUDGET = 2400  # 字符
DEFAULT_MEMORY_BUDGET = 1600
DEFAULT_SCAN_MESSAGES = 8


def estimate_tokens(text: str) -> int:
    """粗略估算 token：中文按约 2 字符 / token。只用于展示与估算标记。"""
    if not text:
        return 0
    return max(1, int(math.ceil(len(text) / 2.2)))


def _sampling(preset: dict[str, Any] | None) -> dict[str, Any]:
    out = dict(DEFAULT_SAMPLING)
    raw = (preset or {}).get("sampling") or {}
    for key in ("temperature", "top_p", "max_tokens", "context_messages", "frequency_penalty", "presence_penalty"):
        if raw.get(key) is not None and raw.get(key) != "":
            out[key] = raw[key]
    if raw.get("stream") is False:
        out["stream"] = False
    return out


def _char_text(character: dict[str, Any] | None) -> str:
    if not character:
        return ""
    parts: list[str] = []
    if character.get("description"):
        parts.append(str(character["description"]).strip())
    if character.get("personality"):
        parts.append("性格：" + str(character["personality"]).strip())
    if character.get("scenario"):
        parts.append("情景：" + str(character["scenario"]).strip())
    return "\n".join(parts)


def _preset_block(fragment: dict[str, Any], position_label: str) -> dict[str, Any]:
    return {
        "kind": "preset",
        "label": "预设 · " + str(fragment.get("title") or "未命名片段") + "（" + position_label + "）",
        "role": fragment.get("role") or "system",
        "text": fragment.get("content") or "",
        "position": fragment.get("position"),
    }


def activate_world_entries(
    books: list[dict[str, Any]],
    scan_text: str,
    budget: int = DEFAULT_WORLD_BUDGET,
) -> dict[str, Any]:
    """常开 + 关键词命中，跨书去重，按字符预算截断。"""
    activated: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    seen: set[str] = set()
    lowered = (scan_text or "").lower()
    used_chars = 0
    for book in books or []:
        book_name = book.get("name") or "世界书"
        entries = [e for e in (book.get("entries") or []) if e and e.get("enabled", True) is not False]
        entries.sort(key=lambda e: (0 if e.get("constant") else 1, int(e.get("order") or 0)))
        for entry in entries:
            content = str(entry.get("content") or "").strip()
            title = str(entry.get("title") or "条目").strip()
            if not content:
                continue
            key = (title + "|" + content)[:160]
            if key in seen:
                continue
            seen.add(key)
            constant = bool(entry.get("constant"))
            keys = [str(k).strip() for k in (entry.get("keys") or []) if str(k).strip()]
            hit = constant
            if not hit:
                for k in keys:
                    if k.lower() in lowered:
                        hit = True
                        break
            if not hit:
                continue
            cost = len(title) + len(content)
            if used_chars + cost > budget:
                skipped.append({"book": book_name, "title": title, "reason": "超出世界书预算"})
                continue
            used_chars += cost
            activated.append({"book": book_name, "title": title, "content": content, "constant": constant})
    return {"entries": activated, "skipped": skipped, "chars": used_chars}


def assemble(context: dict[str, Any]) -> dict[str, Any]:
    character = context.get("character")
    persona = context.get("persona")
    books = context.get("books") or []
    preset = context.get("preset")
    model = context.get("model")
    messages = list(context.get("messages") or [])
    user_text = context.get("user_text") or ""
    now_text = (context.get("now_text") or "").strip()
    memories = context.get("memories") or []
    sampling = _sampling(preset)
    scan_count = int(context.get("scan_messages") or DEFAULT_SCAN_MESSAGES)
    world_budget = int(context.get("world_budget") or DEFAULT_WORLD_BUDGET)
    memory_budget = int(context.get("memory_budget") or DEFAULT_MEMORY_BUDGET)

    blocks: list[dict[str, Any]] = []

    # 预设片段分组
    fragments = [
        f
        for f in ((preset or {}).get("fragments") or [])
        if f and f.get("enabled", True) is not False
    ]
    fragments.sort(key=lambda f: int(f.get("order") or 0))
    before_char = [f for f in fragments if f.get("position") == "before_char"]
    after_char = [f for f in fragments if f.get("position") == "after_char"]
    depth_frags = [f for f in fragments if f.get("position") == "depth"]
    after_user = [f for f in fragments if f.get("position") == "after_user"]

    for f in before_char:
        blocks.append(_preset_block(f, "前置"))

    blocks.append(
        {
            "kind": "char",
            "label": "角色设定 · " + (str(character.get("name")) if character else "未选角色"),
            "role": "system",
            "text": _char_text(character),
        }
    )
    for f in after_char:
        blocks.append(_preset_block(f, "角色设定之后"))

    # 世界书：扫描最近若干条消息 + 当前用户句
    scan_source = messages[-scan_count:] if scan_count > 0 else []
    scan_text = "\n".join([str(m.get("text") or "") for m in scan_source] + [user_text])
    world = activate_world_entries(books, scan_text, world_budget)
    if world["entries"]:
        grouped: dict[str, list[dict[str, Any]]] = {}
        for entry in world["entries"]:
            grouped.setdefault(entry["book"], []).append(entry)
        for book_name, entries in grouped.items():
            blocks.append(
                {
                    "kind": "book",
                    "label": "世界书 · " + book_name + "（" + str(len(entries)) + " 条）",
                    "role": "system",
                    "text": "\n".join(
                        ("· " + ("常开 · " if e["constant"] else "") + e["title"] + "：" + e["content"])
                        for e in entries
                    ),
                }
            )

    # 用户设定
    if persona:
        blocks.append(
            {
                "kind": "user",
                "label": "用户设定 · " + str(persona.get("name") or "我"),
                "role": "system",
                "text": str(persona.get("description") or ""),
            }
        )

    # 现在卡 + 钉住 / 重要的记忆
    memory_lines: list[str] = []
    if now_text:
        memory_lines.append("此刻：" + now_text)
    sorted_memories = sorted(
        [m for m in memories if not m.get("forgotten")],
        key=lambda m: (0 if m.get("pinned") else 1, -int(m.get("importance") or 0)),
    )
    used_memory_chars = len(now_text)
    for m in sorted_memories:
        line = str(m.get("title") or "") + "：" + str(m.get("body") or "")
        if used_memory_chars + len(line) > memory_budget:
            continue
        used_memory_chars += len(line)
        memory_lines.append(("钉住 · " if m.get("pinned") else "") + line)
    if memory_lines:
        blocks.append(
            {
                "kind": "memory",
                "label": "记忆 · 现在卡与钉住的笔记",
                "role": "system",
                "text": "\n".join(memory_lines),
            }
        )

    # 聊天记录 + 深度注入 + 预设后置
    limit = int(sampling.get("context_messages") or DEFAULT_SAMPLING["context_messages"])
    history = messages[-limit:] if limit > 0 else []
    total = len(history)
    insert_before: dict[int, list[dict[str, Any]]] = {}
    for f in depth_frags:
        depth = max(1, int(f.get("depth") or 2))
        idx = max(0, total - depth)
        insert_before.setdefault(idx, []).append(f)
    for idx, msg in enumerate(history):
        for f in insert_before.get(idx, []):
            blocks.append(_preset_block(f, "深度注入 · 倒数第 " + str(int(f.get("depth") or 2)) + " 条"))
        blocks.append(
            {
                "kind": "chat",
                "label": str(character.get("name") if character else "角色")
                if msg.get("role") == "ai"
                else str(persona.get("name") if persona else "我"),
                "role": "assistant" if msg.get("role") == "ai" else "user",
                "text": str(msg.get("text") or ""),
            }
        )
    for f in after_user:
        blocks.append(_preset_block(f, "用户这句话之后 / 后置"))

    if user_text:
        blocks.append(
            {
                "kind": "current",
                "label": "当前用户句",
                "role": "user",
                "text": user_text,
            }
        )

    segments = [
        {"role": b["role"], "text": b["text"], "kind": b["kind"], "label": b["label"]}
        for b in blocks
        if (b.get("text") or "").strip()
    ]
    text = "\n\n".join("[" + b["label"] + "]\n" + b["text"] for b in blocks)
    chars = sum(len(b.get("text") or "") for b in blocks)
    system_text = "\n\n".join(
        (b.get("text") or "") for b in blocks if b.get("role") == "system" and (b.get("text") or "").strip()
    )
    return {
        "blocks": blocks,
        "segments": segments,
        "text": text,
        "chars": chars,
        "tokens": estimate_tokens(text),
        "system_text": system_text,
        "sampling": sampling,
        "meta": {
            "model": (model or {}).get("name") or "",
            "modelId": (model or {}).get("id") or "",
            "modelKey": (model or {}).get("modelId") or "",
            "preset": (preset or {}).get("name") or "默认",
            "presetId": (preset or {}).get("id") or "",
            "presetSource": context.get("preset_source") or "global",
            "persona": (persona or {}).get("name") or "",
            "personaId": (persona or {}).get("id") or "",
            "personaSource": context.get("persona_source") or "global",
            "char": (character or {}).get("name") or "",
            "charId": (character or {}).get("id") or "",
            "books": [b.get("name") for b in books if b.get("name")],
            "worldActivated": [e["title"] for e in world["entries"]],
            "worldSkipped": len(world["skipped"]),
            "contextMessages": len(history),
            "nowCard": bool(now_text),
            "memoryNotes": max(0, len(memory_lines) - (1 if now_text else 0)),
        },
    }


def resolve_preset(chat: dict | None, character: dict | None, presets: list[dict], global_default_id: str) -> tuple[dict | None, str]:
    """这场指定 > 角色默认 > 全局默认。"""
    by_id = {p["id"]: p for p in presets}
    if chat and chat.get("presetId") and chat["presetId"] in by_id:
        return by_id[chat["presetId"]], "chat"
    if character and character.get("defaultPresetId") and character["defaultPresetId"] in by_id:
        return by_id[character["defaultPresetId"]], "char"
    if global_default_id and global_default_id in by_id:
        return by_id[global_default_id], "global"
    return (presets[0] if presets else None), "global"


def resolve_persona(chat: dict | None, character: dict | None, personas: list[dict]) -> tuple[dict | None, str]:
    """这场指定 > 角色默认 > 全局默认。"""
    by_id = {p["id"]: p for p in personas}
    if chat and chat.get("personaId") and chat["personaId"] in by_id:
        return by_id[chat["personaId"]], "chat"
    if character and character.get("defaultPersonaId") and character["defaultPersonaId"] in by_id:
        return by_id[character["defaultPersonaId"]], "char"
    for p in personas:
        if p.get("is_default"):
            return p, "global"
    return (personas[0] if personas else None), "global"


def resolve_books(global_book_id: str, character: dict | None, chat: dict | None, books: list[dict]) -> list[dict]:
    """全局 + 角色一本 + 聊天一本，合并去重（同一本只算一次）。"""
    by_id = {b["id"]: b for b in books}
    out: list[dict] = []
    for book_id in (
        global_book_id,
        (character or {}).get("worldBookId"),
        (chat or {}).get("worldBookId"),
    ):
        if book_id and book_id in by_id and by_id[book_id] not in out:
            out.append(by_id[book_id])
    return out
