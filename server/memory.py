"""记忆库 v1：现在卡、主题笔记、软遗忘、自动抽取、「记住这个」。

- 一张现在卡（kind = now），进入提示词。
- 主题笔记（kind = note）：标题、正文、重要度、标签、来源、可钉住、可搜索。
- 默认软遗忘：只改 status = forgotten，不真删，可恢复。
- 每聊 N 轮（默认 4，可配置）用当前模型异步抽新记忆；写入前去重；失败不影响聊天。
- 不做向量库、图谱、自动梦境整理；搜索先做关键词 / 全文。
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any

from . import auth, db, prompts, providers
from .errors import classify_api_error

CATEGORIES = ["关于我", "我们", "喜好", "日常", "约定"]
DEFAULT_CATEGORY = "日常"

_REMEMBER_RE = re.compile(r"(?:^|[。！？!?；;\n])\s*记住(?:这个|这句话|一下)?[：:，,]?\s*(.*)$", re.S)
_TITLE_MAX = 40


def _now() -> str:
    return db.now_iso()


def _normalize_text(text: str) -> str:
    return re.sub(r"\s+", "", (text or "").lower())


def _dedupe_key(title: str, body: str) -> str:
    return _normalize_text(title) + "|" + _normalize_text(body)[:200]


def _similar(a: str, b: str) -> bool:
    a, b = _normalize_text(a), _normalize_text(b)
    if not a or not b:
        return False
    if a == b:
        return True
    if a in b or b in a:
        return min(len(a), len(b)) >= 8
    grams_a = {a[i:i + 2] for i in range(max(1, len(a) - 1))}
    grams_b = {b[i:i + 2] for i in range(max(1, len(b) - 1))}
    if not grams_a or not grams_b:
        return False
    overlap = len(grams_a & grams_b) / len(grams_a | grams_b)
    return overlap >= 0.8


def list_memories(
    conn,
    q: str = "",
    category: str = "",
    include_forgotten: bool = True,
    kind: str = "note",
) -> list[dict[str, Any]]:
    sql = "SELECT * FROM memories WHERE kind = ?"
    params: list[Any] = [kind]
    if category and category != "全部":
        sql += " AND category = ?"
        params.append(category)
    if not include_forgotten:
        sql += " AND status != 'forgotten'"
    if q:
        sql += " AND (title LIKE ? OR body LIKE ? OR tags_json LIKE ?)"
        like = "%" + q + "%"
        params.extend([like, like, like])
    sql += " ORDER BY CASE status WHEN 'pinned' THEN 0 ELSE 1 END, updated_at DESC, created_at DESC"
    rows = conn.execute(sql, params).fetchall()
    return [db.memory_json(r) for r in rows]


def get_memory(conn, memory_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM memories WHERE id = ?", (memory_id,)).fetchone()
    return db.memory_json(row) if row else None


def create_memory(conn, payload: dict[str, Any], dedupe: bool = False) -> dict[str, Any] | None:
    title = str(payload.get("title") or "").strip() or "一条记忆"
    body = str(payload.get("body") or "").strip()
    if not body:
        return None
    category = str(payload.get("category") or payload.get("cat") or DEFAULT_CATEGORY)
    if category not in CATEGORIES:
        category = DEFAULT_CATEGORY
    if dedupe and _find_duplicate(conn, title, body):
        return None
    memory_id = db.new_id("mem")
    status = "pinned" if payload.get("pinned") else "normal"
    if payload.get("forgotten"):
        status = "forgotten"
    now = _now()
    conn.execute(
        "INSERT INTO memories (id, kind, category, title, body, importance, tags_json, source, source_chat_id, status, protected, created_at, updated_at) "
        "VALUES (?, 'note', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            memory_id,
            category,
            title,
            body,
            max(1, min(10, db._int(payload.get("importance"), 5))),
            db.jdumps(payload.get("tags") or []),
            str(payload.get("source") or "手动"),
            str(payload.get("sourceChatId") or ""),
            status,
            db._bool(payload.get("protected")),
            now,
            now,
        ),
    )
    return get_memory(conn, memory_id)


def _find_duplicate(conn, title: str, body: str) -> bool:
    for row in conn.execute("SELECT title, body FROM memories WHERE kind = 'note' AND status != 'forgotten'").fetchall():
        if _similar(title, row["title"]) and _similar(body, row["body"]):
            return True
    return False


def update_memory(conn, memory_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
    current = get_memory(conn, memory_id)
    if not current:
        return None
    fields: dict[str, Any] = {}
    if "title" in patch:
        fields["title"] = str(patch.get("title") or "").strip() or current["title"]
    if "body" in patch:
        fields["body"] = str(patch.get("body") or current["body"])
    if "category" in patch or "cat" in patch:
        category = str(patch.get("category") or patch.get("cat") or DEFAULT_CATEGORY)
        fields["category"] = category if category in CATEGORIES else DEFAULT_CATEGORY
    if "importance" in patch:
        fields["importance"] = max(1, min(10, db._int(patch.get("importance"), current["importance"])))
    if "tags" in patch:
        fields["tags_json"] = db.jdumps(patch.get("tags") or [])
    if "source" in patch:
        fields["source"] = str(patch.get("source") or current["source"])
    if "protected" in patch:
        fields["protected"] = db._bool(patch.get("protected"))
    if not fields:
        return current
    fields["updated_at"] = _now()
    assignments = ", ".join(key + " = ?" for key in fields)
    conn.execute(
        "UPDATE memories SET " + assignments + " WHERE id = ?",
        list(fields.values()) + [memory_id],
    )
    return get_memory(conn, memory_id)


def set_status(conn, memory_id: str, status: str) -> dict[str, Any] | None:
    if status not in ("normal", "pinned", "forgotten"):
        return None
    conn.execute(
        "UPDATE memories SET status = ?, updated_at = ? WHERE id = ? AND kind = 'note'",
        (status, _now(), memory_id),
    )
    return get_memory(conn, memory_id)


def now_card(conn) -> dict[str, Any]:
    row = db.get_now_row(conn)
    if not row:
        return {"id": "now-card", "body": "", "updatedAt": ""}
    return {"id": row["id"], "body": row["body"], "updatedAt": row["updated_at"]}


def set_now(conn, body: str) -> dict[str, Any]:
    body = (body or "").strip()
    row = db.get_now_row(conn)
    now = _now()
    if row:
        conn.execute("UPDATE memories SET body = ?, updated_at = ? WHERE id = ?", (body, now, row["id"]))
        memory_id = row["id"]
    else:
        memory_id = "now-card"
        conn.execute(
            "INSERT INTO memories (id, kind, category, title, body, importance, tags_json, source, source_chat_id, status, protected, created_at, updated_at) "
            "VALUES (?, 'now', '此刻', '现在卡', ?, 5, '[]', '手动', '', 'normal', 0, ?, ?)",
            (memory_id, body, now, now),
        )
    return {"id": memory_id, "body": body, "updatedAt": now}


def pinned_for_prompt(conn, limit: int = 10) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM memories WHERE kind = 'note' AND status != 'forgotten' "
        "ORDER BY CASE status WHEN 'pinned' THEN 0 ELSE 1 END, importance DESC, updated_at DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return [db.memory_json(r) for r in rows]


# --------------------------------------------------------------------------- 「记住这个」
def detect_remember(text: str) -> str | None:
    """用户说「记住这个 / 记住：……」时，返回要记下的正文（可能为空字符串）。

    返回 None 表示这句话不是在要求记住。
    """
    match = _REMEMBER_RE.search(text or "")
    if not match:
        return None
    return (match.group(1) or "").strip()


def remember_text(
    conn,
    text: str,
    title: str = "",
    category: str = "",
    importance: int = 7,
    source: str = "手动",
    source_chat_id: str = "",
) -> dict[str, Any] | None:
    body = (text or "").strip()
    if not body:
        return None
    if not title:
        title = body.split("。")[0].split("\n")[0][:_TITLE_MAX] or "记住的一句话"
    return create_memory(
        conn,
        {
            "title": title,
            "body": body,
            "category": category or DEFAULT_CATEGORY,
            "importance": importance,
            "tags": ["手动记住"],
            "source": source,
            "sourceChatId": source_chat_id,
        },
        dedupe=True,
    )


# --------------------------------------------------------------------------- 自动抽取
EXTRACT_SYSTEM = (
    "你是记忆整理器 MEMORY_EXTRACT。读下面最近的一段对话，抽取值得长期记住的内容。\n"
    "只输出一个 JSON 对象，不要解释，不要 Markdown：\n"
    '{"notes":[{"title":"不超过20字","body":"一到两句，第三人称","category":"关于我|我们|喜好|日常|约定","importance":1-10,"tags":["标签"]}],"now":"用一句话更新此刻，没有就留空"}\n'
    "规则：只抽新的、具体的事；不要复述常识；没有值得记的就返回空的 notes。"
)


def _build_extract_prompt(conn, character: dict[str, Any], chat: dict[str, Any]) -> str:
    persona = prompts.resolve_persona(chat, character, _all_personas(conn))[0]
    now = now_card(conn)
    existing = [m["title"] for m in list_memories(conn, include_forgotten=False, kind="note")[:30]]
    messages = (chat.get("messages") or [])[-14:]
    lines = []
    for msg in messages:
        lines.append(("她" if msg.get("role") == "ai" else "用户") + "：" + str(msg.get("text") or "")[:400])
    parts = [
        "角色：" + str(character.get("name") or ""),
        "用户设定：" + str((persona or {}).get("description") or "")[:300],
        "现在卡：" + (now.get("body") or "（空）"),
        "已有记忆标题：" + ("、".join(existing) if existing else "（空）"),
        "最近对话：",
        "\n".join(lines),
    ]
    return "\n".join(parts)


def _all_personas(conn) -> list[dict[str, Any]]:
    return [db.persona_json(r) for r in conn.execute("SELECT * FROM user_personas ORDER BY created_at ASC").fetchall()]


def _parse_json_block(text: str) -> dict[str, Any] | None:
    text = (text or "").strip()
    if not text:
        return None
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        return json.loads(text[start:end + 1])
    except ValueError:
        return None


def _resolve_model(conn) -> tuple[dict | None, dict | None, str]:
    config = db.load_app_settings(conn)
    model = db.get_model(conn, config.get("modelId") or "")
    if not model:
        rows = conn.execute("SELECT id FROM models ORDER BY created_at ASC LIMIT 1").fetchone()
        model = db.get_model(conn, rows["id"]) if rows else None
    if not model:
        return None, None, ""
    provider = None
    row = db.get_provider_row(conn, model.get("providerId") or "")
    if row:
        provider = db.provider_json(row)
    api_key = auth.provider_api_key(conn, model.get("providerId") or "")
    return model, provider, api_key


async def extract_memories(character_id: str, manual: bool = False) -> dict[str, Any]:
    """用当前模型抽一轮新记忆。失败只返回错误信息，不影响聊天。"""
    with db.get_db() as conn:
        character = db.get_character(conn, character_id)
        if not character:
            return {"ok": False, "message": "角色不存在。", "created": []}
        chat = db.get_chat(conn, character_id, include_messages=True)
        if not chat or not chat.get("messages"):
            return {"ok": False, "message": "这场聊天还没有内容。", "created": []}
        model, provider, api_key = _resolve_model(conn)
        if not model or not provider:
            return {"ok": False, "message": "还没有可用的模型。", "created": []}
        if not api_key and not providers.mock_enabled():
            return {"ok": False, "message": "先到「模型与提供商」里填写 API Key。", "created": []}
        system_prompt = EXTRACT_SYSTEM
        user_text = "[MEMORY_EXTRACT]\n" + _build_extract_prompt(conn, character, chat)
        chat_id = chat["id"]
        character_name = character.get("name") or ""
        existing_titles = [m["title"] for m in list_memories(conn, include_forgotten=False, kind="note")]

    prompt = {
        "segments": [
            {"role": "system", "text": system_prompt, "kind": "system", "label": "记忆整理"},
            {"role": "user", "text": user_text, "kind": "current", "label": "讨论"},
        ],
        "system_text": system_prompt,
        "sampling": {"temperature": 0.3, "max_tokens": 800},
        "text": system_prompt + "\n" + user_text,
        "meta": {},
    }
    try:
        result = await providers.complete(provider, model, prompt, api_key, reasoning_level="off")
    except Exception as exc:  # noqa: BLE001
        error = classify_api_error(None, exc, detail=str(exc))
        return {"ok": False, "message": error["message"], "created": []}
    payload = _parse_json_block(result.get("text") or "")
    if not payload:
        return {"ok": False, "message": "模型没有给出可读的记忆内容，这次先跳过。", "created": []}
    created: list[dict[str, Any]] = []
    skipped = 0
    now_text = str(payload.get("now") or "").strip()
    with db.get_db() as conn:
        for note in payload.get("notes") or []:
            if not isinstance(note, dict):
                continue
            title = str(note.get("title") or "").strip()
            body = str(note.get("body") or "").strip()
            if not body:
                continue
            if any(_similar(title, t) for t in existing_titles):
                skipped += 1
                continue
            memory = create_memory(
                conn,
                {
                    "title": title or body[:_TITLE_MAX],
                    "body": body,
                    "category": note.get("category"),
                    "importance": note.get("importance"),
                    "tags": note.get("tags") or ["自动抽取"],
                    "source": ("手动整理 · " if manual else "自动抽取 · ") + character_name,
                    "sourceChatId": chat_id,
                },
                dedupe=True,
            )
            if memory:
                created.append(memory)
                existing_titles.append(memory["title"])
            else:
                skipped += 1
        now_updated = False
        if now_text and len(now_text) <= 400:
            current = now_card(conn)
            if not _similar(current.get("body") or "", now_text):
                set_now(conn, now_text)
                now_updated = True
        # 记录一条 usage（抽取本身也消耗 token）；拿不到 usage 时按字数估算
        usage = result.get("usage") or {
            "prompt_tokens": prompts.estimate_tokens(prompt["text"]),
            "cache_tokens": 0,
            "output_tokens": prompts.estimate_tokens(result.get("text") or ""),
            "total_tokens": 0,
        }
        usage["total_tokens"] = usage.get("total_tokens") or (usage["prompt_tokens"] + usage["output_tokens"])
        from . import usage as usage_mod

        usage_mod.record_usage(
            conn,
            conversation_id=chat_id,
            character_id=character_id,
            provider_id=model.get("providerId") or "",
            model_id=model.get("id") or "",
            model_key=model.get("modelId") or "",
            model_name=model.get("name") or "",
            prompt_tokens=usage["prompt_tokens"],
            cache_tokens=usage.get("cache_tokens") or 0,
            output_tokens=usage["output_tokens"],
            duration_ms=0,
            ok=True,
            estimated=not bool(result.get("usage")),
            kind="memory",
        )
    return {"ok": True, "created": created, "nowUpdated": now_updated, "skipped": skipped}


def _config_value(conn, key: str, default: Any = None) -> Any:
    return db.load_app_settings(conn).get("settings", {}).get(key, default)


def schedule_extract_after_reply(character_id: str) -> None:
    """每聊 N 轮自动抽取一次；写入标记避免重复抽同一轮。"""
    try:
        with db.get_db() as conn:
            if not _config_value(conn, "memoryExtractEnabled", True):
                return
            every = max(1, db._int(_config_value(conn, "memoryExtractEvery", 4), 4))
            chat = db.get_chat(conn, character_id, include_messages=True)
            if not chat:
                return
            user_turns = sum(1 for m in chat.get("messages") or [] if m.get("role") == "me")
            if user_turns == 0 or user_turns % every != 0:
                return
            config = db.load_app_settings(conn)
            marks = config.setdefault("memoryMarks", {})
            if marks.get(chat["id"]) == user_turns:
                return
            marks[chat["id"]] = user_turns
            db.save_app_settings(conn, config)
    except Exception:  # noqa: BLE001
        return

    async def _run() -> None:
        try:
            await extract_memories(character_id)
        except Exception:  # noqa: BLE001 - 抽取失败不能影响聊天
            pass

    try:
        asyncio.get_running_loop().create_task(_run())
    except RuntimeError:
        pass
