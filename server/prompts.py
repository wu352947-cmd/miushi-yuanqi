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
    # 0 = 不限制条数，只按 token 预算挑（默认走预算制）
    "context_messages": 0,
    "context_budget": 32000,
    "stream": True,
    "frequency_penalty": None,
    "presence_penalty": None,
}

DEFAULT_WORLD_BUDGET = 2400  # 字符
DEFAULT_MEMORY_BUDGET = 1600
DEFAULT_SCAN_MESSAGES = 8


def estimate_tokens(text: str) -> int:
    """粗略估算 token：中文按约 1.6 字符 / token。

    校准依据：温羽蓉那场提示词约 9,816 字，上游报 prompt_tokens=6,645
    （1.48 字/token）。原先按 2.2 会低报 33%，预算制据此裁剪就会带太多历史。
    """
    if not text:
        return 0
    return max(1, int(math.ceil(len(text) / 1.6)))


def history_budget(
    model: dict[str, Any] | None, sampling: dict[str, Any], override: int = 0
) -> int:
    """历史能占多少 token。

    两层限制，取小的：
      · 窗口 × 60%   —— 再大的窗口也不能把历史塞满，得给系统块和输出留位置
      · 用户设定的绝对上限 —— 防止 1M 窗口下每次请求几十万 token
    """
    window = int((model or {}).get("context") or 0) or 32768
    reserve = max(1024, int(sampling.get("max_tokens") or 1200))
    usable = max(1024, window - reserve)
    # 90%：历史最多占窗口的九成，剩下留给系统块（角色卡 / 世界书 / 记忆）
    # 和输出。再往上，请求会直接因为超长被上游拒掉。
    ratio_cap = int(usable * 0.9)
    # override 是用户在设置里调的上限，优先于预设里的默认值——
    # 预设编辑界面没有采样参数，那个值实际上改不动，只能当兜底。
    user_cap = int(override or sampling.get("context_budget") or 0) or 32000
    return max(1024, min(user_cap, ratio_cap))


def pick_history(
    messages: list[dict[str, Any]], budget_tokens: int, hard_limit: int = 0
) -> list[dict[str, Any]]:
    """从最新往前填，填到预算用完为止。返回按时间正序。

    至少保留 1 条（哪怕它自己就超预算），否则会发出空对话。
    hard_limit > 0 时同时受条数限制（预设里配了具体条数才生效）。
    """
    picked: list[dict[str, Any]] = []
    total = 0
    for msg in reversed(messages):
        cost = estimate_tokens(str(msg.get("text") or ""))
        if picked and total + cost > budget_tokens:
            break
        picked.append(msg)
        total += cost
        if hard_limit > 0 and len(picked) >= hard_limit:
            break
    picked.reverse()
    return picked


def _sampling(preset: dict[str, Any] | None) -> dict[str, Any]:
    out = dict(DEFAULT_SAMPLING)
    raw = (preset or {}).get("sampling") or {}
    for key in (
        "temperature", "top_p", "max_tokens", "context_messages",
        "context_budget", "frequency_penalty", "presence_penalty",
    ):
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
    author_note = context.get("author_note") or {}
    note_text = str(author_note.get("text") or "").strip()
    note_depth = int(author_note.get("depth") or 0)
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

    # 前情摘要：比这段更早的对话已经折叠成一条，替它记住那些事。
    # 消息本体一条没删，只是不再发出去——所以随时可以撤销重来。
    digest = context.get("digest") or {}
    digest_text = str(digest.get("text") or "").strip()
    digest_upto = int(digest.get("uptoMessageId") or 0)
    if digest_text:
        blocks.append(
            {
                "kind": "digest",
                "label": "前情摘要 · 更早的对话已折叠",
                "role": "system",
                "text": digest_text,
            }
        )
    # 聊天记录 + 深度注入 + 预设后置
    hard_limit = int(sampling.get("context_messages") or 0)
    budget = history_budget(
        context.get("model"), sampling, int(context.get("context_budget") or 0)
    )
    # 已被摘要覆盖的消息不再发出去：它们的内容由上面那条系统块代表。
    # 没有 id 的（开场白占位）一律保留，不能因为 0 <= upto 被误删。
    visible = messages
    if digest_upto:
        visible = [
            m for m in messages
            if not (int(m.get("id") or 0) and int(m.get("id") or 0) <= digest_upto)
        ]
    history = pick_history(visible, budget, hard_limit)
    total = len(history)
    insert_before: dict[int, list[dict[str, Any]]] = {}
    for f in depth_frags:
        depth = max(1, int(f.get("depth") or 2))
        idx = max(0, total - depth)
        insert_before.setdefault(idx, []).append(f)
    note_index = max(0, total - 1 - note_depth) if note_text else -1
    for idx, msg in enumerate(history):
        if note_text and idx == note_index:
            blocks.append(
                {
                    "kind": "author_note",
                    "label": "作者注释 · 只对这段聊天生效",
                    "role": "system",
                    "text": note_text,
                }
            )
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
            "digest": bool(digest_text),
            "digestTokens": estimate_tokens(digest_text) if digest_text else 0,
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
