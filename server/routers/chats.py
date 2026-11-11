"""聊天：绑定、提示词预览、流式回复、消息落库。

POST /api/chats/{character_id}/messages 返回 text/event-stream：
  user     用户消息已入库
  meta     本次请求的模型 / 思考参数 / 是否走了兜底
  delta    正文增量
  thinking 思考过程增量（提供商关闭回传时不发）
  fallback 思考参数被拒后的兜底说明
  usage    本次 usage（拿不到时为估算）
  error    中文错误 kind + message
  done     落库后的完整消息、fallback、remembered
"""

from __future__ import annotations

import json
import time
from typing import Any, AsyncIterator

from fastapi import APIRouter, Body, Depends
from fastapi.responses import StreamingResponse

from .. import auth, db, memory, prompts, providers, usage as usage_mod
from ..errors import ApiError, classify_api_error
from ..reasoning import build_reasoning_params, default_level
from ..schemas import (
    ChatBranchIn,
    ChatBulkIn,
    ChatCreateIn,
    ChatDetailPatch,
    ChatImportIn,
    ChatPatch,
    ChatSendIn,
    ImpersonateIn,
    MessageEditIn,
)
from .deps import get_conn

router = APIRouter(prefix="/api/chats", tags=["chats"])


def _sse(event: str, data: dict[str, Any]) -> str:
    return "event: " + event + "\ndata: " + json.dumps(data, ensure_ascii=False) + "\n\n"


def _load_context(
    conn,
    character_id: str,
    user_text: str,
    model_id: str | None = None,
    reasoning_level: str | None = None,
    chat_id: str | None = None,
) -> dict[str, Any]:
    character = db.get_character(conn, character_id)
    if not character:
        raise ApiError("notfound", "这位角色已经不在列表里了。", status=404)
    config = db.load_app_settings(conn)
    chat_row = db.get_chat_row_by_id(conn, chat_id) if chat_id else db.get_chat_row(conn, character_id)
    if chat_id and (not chat_row or chat_row["character_id"] != character_id):
        raise ApiError("notfound", "这段对话已经不在了，回去聊天列表刷新一下。", status=404)
    chat = db.chat_json(conn, chat_row, include_messages=True) if chat_row else None
    messages = list((chat or {}).get("messages") or [])
    if not messages and character.get("first_mes"):
        messages = [{"role": "ai", "text": character["first_mes"]}]

    presets = [db.preset_json(r) for r in conn.execute("SELECT * FROM prompt_presets ORDER BY created_at ASC").fetchall()]
    personas = [db.persona_json(r) for r in conn.execute("SELECT * FROM user_personas ORDER BY created_at ASC").fetchall()]
    books = [db.book_json(conn, r) for r in conn.execute("SELECT * FROM world_books ORDER BY created_at ASC").fetchall()]
    models = [db.model_json(r) for r in conn.execute("SELECT * FROM models ORDER BY created_at ASC").fetchall()]
    selected_model_id = model_id or (chat or {}).get("modelId") or config.get("modelId") or ""
    model = next((m for m in models if m["id"] == selected_model_id), None) or (models[0] if models else None)
    if not model:
        raise ApiError("noprovider", "还没有可用的模型：先在「模型与提供商」里添加一家并选一个模型。")
    provider = None
    provider_row = db.get_provider_row(conn, model.get("providerId") or "")
    if provider_row:
        provider = db.provider_json(provider_row)
    api_key = auth.provider_api_key(conn, model.get("providerId") or "")

    preset, preset_source = prompts.resolve_preset(chat, character, presets, (config.get("settings") or {}).get("defaultPresetId") or "")
    persona, persona_source = prompts.resolve_persona(chat, character, personas)
    books_used = prompts.resolve_books((config.get("settings") or {}).get("globalBookId") or "", character, chat, books)
    level = reasoning_level if reasoning_level is not None else ((chat or {}).get("reasoningLevel") or default_level(model))
    author_note = ((chat or {}).get("settings") or {}).get("authorNote") or {}
    prompt = prompts.assemble(
        {
            "character": character,
            "persona": persona,
            "books": books_used,
            "preset": preset,
            "model": model,
            "messages": messages,
            "user_text": user_text,
            # 此刻卡不进提示词：它的内容（现在在哪、在做什么）上下文里本来就有，
            # 而且它是每 N 轮才更新的快照，比历史更旧，一起注入会把模型往回拽
            # （实测：此刻卡说「离开图书馆」，生成却在「图书馆三楼还书」）。
            # 它只留给记忆页和首页展示。
            "now_text": "",
            "memories": memory.pinned_for_prompt(
                conn,
                character_id=character.get("id") or "",
                persona_id=(persona or {}).get("id") or "",
            ),
            "preset_source": preset_source,
            "persona_source": persona_source,
            "author_note": author_note,
        }
    )
    return {
        "character": character,
        "chat": chat,
        "chat_row": chat_row,
        "config": config,
        "model": model,
        "provider": provider,
        "api_key": api_key,
        "reasoning_level": level,
        "prompt": prompt,
        "preset": preset,
        "persona": persona,
        "books": books_used,
        "messages": messages,
    }


def _check_ready(ctx: dict[str, Any]) -> None:
    provider = ctx.get("provider")
    if not provider:
        raise ApiError("noprovider", "这个模型所属的提供商已经不在列表里了。")
    if not provider.get("enabled"):
        raise ApiError("badrequest", "这家提供商已停用：先到「模型与提供商」里启用它。")
    if not ctx.get("api_key") and not providers.mock_enabled():
        raise ApiError("nokey", "先到「我的 → 模型与提供商」里填写 API Key，再发消息。")


@router.get("")
def list_chats(characterId: str = "", q: str = "", conn=Depends(get_conn)) -> dict:
    """对话列表：标题 / 最后一句预览 / 时间 / 条数 / 绑定，可按角色过滤与搜索。"""
    return {"chats": db.list_chat_summaries(conn, characterId or None, q)}


# --------------------------------------------------------------------------- 多对话 CRUD
def _character_for_import(conn, item: dict, fallback_character_id: str) -> tuple[dict | None, str]:
    char_id = str(item.get("characterId") or ((item.get("character") or {}).get("id") or ""))
    char_name = str(item.get("characterName") or ((item.get("character") or {}).get("name") or ""))
    if char_id:
        character = db.get_character(conn, char_id)
        if character:
            return character, "characterId"
    if char_name:
        for row in conn.execute("SELECT * FROM characters ORDER BY created_at ASC").fetchall():
            if str(row["name"] or "").strip().lower() == char_name.strip().lower():
                return db.character_json(row), "name"
    if fallback_character_id:
        character = db.get_character(conn, fallback_character_id)
        if character:
            return character, "user"
    return None, ""


def _import_one_chat(conn, item: dict, fallback_character_id: str) -> dict:
    if not isinstance(item, dict):
        raise ApiError("badrequest", "读到一条看不懂的对话，换一个文件再试。")
    character, matched_by = _character_for_import(conn, item, fallback_character_id)
    if not character:
        raise ApiError("badrequest", "先选一个角色再导入。")
    title = str(item.get("title") or "").strip() or db.default_chat_title(conn, character["id"])
    settings = item.get("settings") if isinstance(item.get("settings"), dict) else {}
    row = db.create_chat(
        conn,
        character["id"],
        title=title,
        persona_id=str(item.get("personaId") or ""),
        world_book_id=str(item.get("worldBookId") or ""),
        preset_id=str(item.get("presetId") or ""),
        model_id=str(item.get("modelId") or ""),
        reasoning_level=str(item.get("reasoningLevel") or ""),
        settings=settings,
        pinned=item.get("pinned"),
    )
    count = 0
    for msg in item.get("messages") or []:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role") or "ai")
        role = "me" if role in ("me", "user") else "ai"
        text = str(msg.get("text") or "")
        if not text:
            continue
        db.append_message(
            conn,
            row["id"],
            role,
            text,
            thinking=msg.get("thinking"),
            usage=msg.get("usage"),
            ms=msg.get("ms"),
            fallback=str(msg.get("fallback") or ""),
            aside=str(msg.get("aside") or ""),
            error_kind=str(msg.get("errorKind") or ""),
        )
        count += 1
    full = db.chat_full_by_id(conn, row["id"])
    return {"chat": full, "matchedBy": matched_by, "characterId": character["id"], "messageCount": count}


def _parse_st_jsonl(content: str) -> dict[str, Any]:
    """SillyTavern 聊天 jsonl：首行 metadata，其后每行一条消息。"""
    user_name = ""
    char_name = ""
    created = ""
    messages: list[dict[str, Any]] = []
    for raw in (content or "").splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            item = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(item, dict):
            continue
        if "user_name" in item or "character_name" in item:
            user_name = str(item.get("user_name") or user_name)
            char_name = str(item.get("character_name") or char_name)
            created = str(item.get("create_date") or created)
            continue
        text = item.get("mes")
        if text is None:
            text = item.get("text")
        if text is None:
            continue
        if item.get("is_system"):
            continue
        messages.append(
            {
                "role": "me" if item.get("is_user") else "ai",
                "text": str(text),
                "time": str(item.get("send_date") or ""),
            }
        )
    title = ""
    if char_name and created:
        stamp = created.replace("T", " ")
        title = char_name + " - " + stamp[:16] if " " in stamp else char_name + " - " + stamp[:10]
    return {"userName": user_name, "characterName": char_name, "createdAt": created, "title": title, "messages": messages}


@router.get("/search")
def search_chats(q: str = "", characterId: str = "", conn=Depends(get_conn)) -> dict:
    return {"results": db.search_chat_messages(conn, q, characterId or None)}


@router.post("/bulk-delete")
def bulk_delete_chats(payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    ids = [str(item) for item in (payload.get("chatIds") or []) if item]
    deleted = 0
    for chat_id in ids:
        if db.delete_chat_by_id(conn, chat_id):
            deleted += 1
    return {"ok": True, "deleted": deleted}


@router.post("/bulk-export")
def bulk_export_chats(payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    ids = [str(item) for item in (payload.get("chatIds") or []) if item]
    chats = [chat for chat in (db.chat_full_by_id(conn, chat_id) for chat_id in ids) if chat]
    return {
        "app": "miushi-yuanqi",
        "kind": "chats",
        "version": 1,
        "exportedAt": db.now_iso(),
        "chats": chats,
    }


@router.post("/import")
def import_chat(payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    """导入本项目导出的 JSON（单个 / 批量）或 SillyTavern 聊天 jsonl。"""
    fmt = str(payload.get("format") or "auto")
    content = str(payload.get("content") or "")
    fallback_character_id = str(payload.get("characterId") or "")
    data: Any = payload.get("payload")
    items: list[dict] = []
    if isinstance(data, dict):
        if isinstance(data.get("chats"), list):
            items = [item for item in data["chats"] if isinstance(item, dict)]
        elif isinstance(data.get("chat"), dict):
            items = [data["chat"]]
        else:
            items = [data]
    elif content.strip():
        stripped = content.lstrip()
        if fmt == "jsonl" or not stripped.startswith("{"):
            parsed = _parse_st_jsonl(content)
            items = [{"title": parsed.get("title") or "", "characterName": parsed.get("characterName") or "", "messages": parsed["messages"]}]
        else:
            try:
                data = json.loads(content)
            except ValueError:
                # 多行 JSONL 的每一行都以 { 开头：尝试按酒馆 jsonl 解析
                parsed = _parse_st_jsonl(content)
                if not parsed["messages"]:
                    raise ApiError("badrequest", "这个文件读不出来：确认是本项目导出的 JSON，或酒馆的聊天 jsonl。")
                items = [{"title": parsed.get("title") or "", "characterName": parsed.get("characterName") or "", "messages": parsed["messages"]}]
                data = None
            if isinstance(data, dict):
                if isinstance(data.get("chats"), list):
                    items = [item for item in data["chats"] if isinstance(item, dict)]
                elif isinstance(data.get("chat"), dict):
                    items = [data["chat"]]
                else:
                    items = [data]
            elif isinstance(data, list):
                items = [item for item in data if isinstance(item, dict)]
    if not items:
        raise ApiError("badrequest", "没有读到要导入的对话：换一个文件再试。")
    imported: list[dict] = []
    for item in items:
        imported.append(_import_one_chat(conn, item, fallback_character_id))
    first = imported[0]
    return {
        "ok": True,
        "imported": len(imported),
        "chat": first["chat"],
        "chats": [entry["chat"] for entry in imported],
        "matchedBy": first["matchedBy"],
        "characterId": first["characterId"],
        "messageCount": sum(entry["messageCount"] for entry in imported),
    }


@router.post("")
def create_chat_api(payload: ChatCreateIn, conn=Depends(get_conn)) -> dict:
    character = db.get_character(conn, payload.characterId)
    if not character:
        raise ApiError("notfound", "这位角色已经不在列表里了。", status=404)
    config = db.load_app_settings(conn)
    row = db.create_chat(
        conn,
        payload.characterId,
        title=str(payload.title or "").strip() or db.default_chat_title(conn, payload.characterId),
        persona_id=str(payload.personaId or ""),
        world_book_id=str(payload.worldBookId or ""),
        preset_id=str(payload.presetId or ""),
        model_id=str(payload.modelId or config.get("modelId") or ""),
        reasoning_level=str(payload.reasoningLevel or ""),
        settings=payload.settings or {},
        pinned=payload.pinned,
    )
    if character.get("first_mes"):
        db.append_message(conn, row["id"], "ai", character["first_mes"])
    return {"chat": db.chat_full_by_id(conn, row["id"])}


@router.get("/{character_id}")
def get_chat(character_id: str, conn=Depends(get_conn)) -> dict:
    chat = db.get_chat(conn, character_id, include_messages=True)
    if not chat:
        raise ApiError("notfound", "这场聊天还没有开始。", status=404)
    return {"chat": chat}


@router.post("/{character_id}/ensure")
def ensure_chat(character_id: str, conn=Depends(get_conn)) -> dict:
    if not db.get_character(conn, character_id):
        raise ApiError("notfound", "这位角色已经不在列表里了。", status=404)
    row = db.ensure_chat(conn, character_id)
    count = conn.execute("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?", (row["id"],)).fetchone()["n"]
    character = db.get_character(conn, character_id)
    if count == 0 and character and character.get("first_mes"):
        db.append_message(conn, row["id"], "ai", character["first_mes"])
    return {"chat": db.chat_json(conn, row, include_messages=True)}


@router.patch("/{character_id}")
def patch_chat(character_id: str, payload: ChatPatch, conn=Depends(get_conn)) -> dict:
    if not db.get_character(conn, character_id):
        raise ApiError("notfound", "这位角色已经不在列表里了。", status=404)
    row = db.ensure_chat(conn, character_id)
    fields = {}
    mapping = {
        "personaId": "persona_id",
        "worldBookId": "world_book_id",
        "presetId": "preset_id",
        "modelId": "model_id",
        "reasoningLevel": "reasoning_level",
        "title": "title",
    }
    for key, column in mapping.items():
        value = getattr(payload, key)
        if value is not None:
            fields[column] = value
    if fields:
        assignments = ", ".join(key + " = ?" for key in fields)
        conn.execute(
            "UPDATE chats SET " + assignments + ", updated_at = ? WHERE id = ?",
            list(fields.values()) + [db.now_iso(), row["id"]],
        )
    return {"ok": True, "chat": db.chat_json(conn, db.get_chat_row(conn, character_id), include_messages=False)}


@router.delete("/{character_id}")
def delete_chat(character_id: str, conn=Depends(get_conn)) -> dict:
    row = db.get_chat_row(conn, character_id)
    if not row:
        return {"ok": True}
    conn.execute("DELETE FROM messages WHERE chat_id = ?", (row["id"],))
    conn.execute("DELETE FROM chats WHERE id = ?", (row["id"],))
    return {"ok": True}


# --------------------------------------------------------------------------- 单个对话（按 chat id）
@router.get("/id/{chat_id}")
def get_chat_by_id(chat_id: str, conn=Depends(get_conn)) -> dict:
    chat = db.chat_full_by_id(conn, chat_id)
    if not chat:
        raise ApiError("notfound", "这段对话已经不在了，回去聊天列表刷新一下。", status=404)
    return {"chat": chat}


@router.patch("/id/{chat_id}")
def patch_chat_by_id(chat_id: str, payload: ChatDetailPatch, conn=Depends(get_conn)) -> dict:
    row = db.get_chat_row_by_id(conn, chat_id)
    if not row:
        raise ApiError("notfound", "这段对话已经不在了，回去聊天列表刷新一下。", status=404)
    data = payload.model_dump(exclude_none=True)
    fields: dict[str, Any] = {}
    mapping = {
        "personaId": "persona_id",
        "worldBookId": "world_book_id",
        "presetId": "preset_id",
        "modelId": "model_id",
        "reasoningLevel": "reasoning_level",
        "title": "title",
    }
    for key, column in mapping.items():
        if key in data:
            fields[column] = str(data[key] or "")
    if "pinned" in data:
        fields["pinned"] = 1 if data["pinned"] else 0
    settings = db.jloads(row["settings_json"], {})
    if isinstance(payload.settings, dict):
        settings.update(payload.settings)
    if "title" in data:
        # 用户自己改过标题后，AI 不再覆盖
        settings["titleLocked"] = bool(data.get("titleLocked", True))
    if "titleLocked" in data:
        settings["titleLocked"] = bool(data["titleLocked"])
    fields["settings_json"] = db.jdumps(settings)
    fields["updated_at"] = db.now_iso()
    assignments = ", ".join(key + " = ?" for key in fields)
    conn.execute("UPDATE chats SET " + assignments + " WHERE id = ?", list(fields.values()) + [chat_id])
    return {"chat": db.chat_summary(conn, db.get_chat_row_by_id(conn, chat_id))}


@router.delete("/id/{chat_id}")
def delete_chat_by_id_api(chat_id: str, conn=Depends(get_conn)) -> dict:
    return {"ok": db.delete_chat_by_id(conn, chat_id)}


@router.post("/id/{chat_id}/branch")
def branch_chat_api(chat_id: str, payload: ChatBranchIn, conn=Depends(get_conn)) -> dict:
    chat = db.branch_chat(conn, chat_id, payload.messageId)
    if not chat:
        raise ApiError("notfound", "找不到这条消息：刷新一下再试。", status=404)
    return {"chat": chat}


@router.get("/id/{chat_id}/export")
def export_chat_by_id(chat_id: str, conn=Depends(get_conn)) -> dict:
    chat = db.chat_full_by_id(conn, chat_id)
    if not chat:
        raise ApiError("notfound", "这段对话已经不在了，回去聊天列表刷新一下。", status=404)
    character = db.get_character(conn, chat.get("characterId") or "")
    return {
        "app": "miushi-yuanqi",
        "kind": "chat",
        "version": 1,
        "exportedAt": db.now_iso(),
        "character": {"id": chat.get("characterId") or "", "name": (character or {}).get("name") or ""},
        "bindings": {
            "personaId": chat.get("personaId") or "",
            "worldBookId": chat.get("worldBookId") or "",
            "presetId": chat.get("presetId") or "",
            "modelId": chat.get("modelId") or "",
            "reasoningLevel": chat.get("reasoningLevel") or "",
        },
        "chat": chat,
    }


@router.patch("/id/{chat_id}/messages/{message_id}")
def edit_message(chat_id: str, message_id: int, payload: MessageEditIn, conn=Depends(get_conn)) -> dict:
    message = db.update_message_text(conn, chat_id, message_id, payload.text)
    if not message:
        raise ApiError("notfound", "这条消息不在了：刷新一下再试。", status=404)
    return {"message": message}


@router.delete("/id/{chat_id}/messages/{message_id}")
def delete_message(chat_id: str, message_id: int, conn=Depends(get_conn)) -> dict:
    if not db.delete_message_row(conn, chat_id, message_id):
        raise ApiError("notfound", "这条消息不在了：刷新一下再试。", status=404)
    return {"ok": True, "deletedId": message_id}


@router.post("/id/{chat_id}/auto-title")
async def auto_title(chat_id: str, conn=Depends(get_conn)) -> dict:
    """AI 起名（可选功能，默认关闭）：按次计费接口由前端先提示可能扣一次费。"""
    row = db.get_chat_row_by_id(conn, chat_id)
    if not row:
        raise ApiError("notfound", "这段对话已经不在了，回去聊天列表刷新一下。", status=404)
    chat = db.chat_json(conn, row, include_messages=True)
    settings = chat.get("settings") or {}
    if settings.get("titleLocked"):
        return {"ok": False, "title": row["title"], "message": "标题是你自己改的，AI 不会再改。"}
    config = db.load_app_settings(conn)
    model = db.get_model(conn, str(row["model_id"] or config.get("modelId") or ""))
    if not model:
        model = next(iter([db.model_json(r) for r in conn.execute("SELECT * FROM models ORDER BY created_at ASC").fetchall()]), None)
    if not model:
        return {"ok": False, "title": row["title"], "message": "还没有可用的模型：先到「模型与提供商」里添加一家。"}
    provider_row = db.get_provider_row(conn, model.get("providerId") or "")
    if not provider_row:
        return {"ok": False, "title": row["title"], "message": "这个模型所属的提供商已经不在了。"}
    provider = db.provider_json(provider_row)
    api_key = auth.provider_api_key(conn, model.get("providerId") or "")
    if not api_key and not providers.mock_enabled():
        return {"ok": False, "title": row["title"], "message": "先填这家提供商的 API Key，再让 AI 起名。"}
    excerpt = "\n".join(
        ("我：" if item.get("role") == "me" else ((chat.get("title") or "角色") + "：")) + str(item.get("text") or "")[:80]
        for item in (chat.get("messages") or [])[-8:]
    )
    prompt = {
        "segments": [
            {"role": "system", "text": "你是一个给聊天记录起名的助手。只输出一个不超过 16 个字的短标题，不要引号、句号或解释。"},
            {"role": "user", "text": "聊天记录片段：\n" + excerpt + "\n\n请起一个短标题。"},
        ],
        "sampling": {"max_tokens": 32, "temperature": 0.4},
        "system_text": "",
    }
    try:
        result = await providers.complete(provider, model, prompt, api_key, None, session_id=chat_id)
    except Exception as exc:  # noqa: BLE001
        info = classify_api_error(None, exc, detail=str(exc)[:200])
        return {"ok": False, "title": row["title"], "message": str(info.get("message") or "这次没能起名，可以自己改。")}
    title = " ".join(str(result.get("text") or "").split()).strip("「」\"'“”‘’。.")
    title = title[:24]
    if not title:
        return {"ok": False, "title": row["title"], "message": "这次没能起名，可以自己改。"}
    conn.execute(
        "UPDATE chats SET title = ?, updated_at = ? WHERE id = ?",
        (title, db.now_iso(), chat_id),
    )
    return {"ok": True, "title": title, "modelName": model.get("name") or ""}


@router.post("/{character_id}/impersonate")
async def impersonate(character_id: str, payload: ImpersonateIn, conn=Depends(get_conn)) -> dict:
    """AI 帮答：替用户写一条候选回复，不落库；用户确认后再按正常消息发送。"""
    ctx = _load_context(
        conn,
        character_id,
        "（现在替「用户」写一条要发出去的话：用用户的口吻，只输出这句话本身，不要加引号或解释。）",
        payload.modelId,
        payload.reasoningLevel,
    )
    _check_ready(ctx)
    try:
        result = await providers.complete(
            ctx["provider"],
            ctx["model"],
            ctx["prompt"],
            ctx["api_key"],
            ctx["reasoning_level"],
            session_id=str((ctx.get("chat") or {}).get("id") or "") or None,
        )
    except Exception as exc:  # noqa: BLE001
        info = classify_api_error(None, exc, detail=str(exc)[:200])
        raise ApiError(info.get("kind") or "internal", str(info.get("message") or "这次没写出来，可以自己写一条。") + "，或者自己写一条。")
    text = str(result.get("text") or "").strip()
    if not text:
        raise ApiError("badresponse", "这次没写出来，可以自己写一条。")
    return {"ok": True, "text": text[:500]}


@router.get("/{character_id}/prompt-preview")
def prompt_preview(character_id: str, text: str = "", conn=Depends(get_conn)) -> dict:
    ctx = _load_context(conn, character_id, text or "（下一条消息）")
    prompt = ctx["prompt"]
    return {
        "blocks": prompt["blocks"],
        "text": prompt["text"],
        "chars": prompt["chars"],
        "tokens": prompt["tokens"],
        "meta": prompt["meta"],
        "reasoning": build_reasoning_params(ctx["model"], ctx["reasoning_level"], (ctx["provider"] or {}).get("protocol") or "openai"),
    }


# 离线续写：没人说话的时候，让她自己开口。
# 三条硬规矩来自实际讨论——不评论隔了多久、不索取回应、不替用户说话。
PROACTIVE_NUDGE = (
    "（现在没有人对你说话，你自己开口。\n"
    "人称：叙述人称完全跟上文——上文用「她」写角色，你就全程用「她」，不要改成「我」；上文用「我」才用「我」。"
    "她开口说话时引号里出现「我」是正常的（那是她在自称），但引号外的叙述必须保持上文的人称。"
    "对方固定用「你」，不写成名字或「他」「她」。两人一起写「两人」，不要写「她们」「他们」。\n"
    "写 2-3 段，一共 150-350 字。内容是此刻正在做的事、眼前看到的东西，或者刚冒出来的一个念头。\n"
    "不要写「你回来了」「终于等到你」，不要提隔了多久，不要问对方去哪了，"
    "不要表现委屈或索取回应，不要替对方说话、写对方的动作和心理。\n"
    "可以只写自己一个人，写着写着想到对方；可以只有半句话就停；可以平平淡淡没有情绪起伏。\n"
    "结尾不要收束收干净：最后要落在她开口对你说的一句话上。"
    "半句、含糊、说到一半都行，但必须是说出口的，不是心里的念头。）"
)


@router.post("/{character_id}/messages")
async def send_message(character_id: str, payload: ChatSendIn, conn=Depends(get_conn)) -> StreamingResponse:
    text = (payload.text or "").strip()
    mode = str(payload.mode or "normal").strip()
    if mode not in ("normal", "continue", "regenerate", "proactive"):
        mode = "normal"
    target_chat_id = str(payload.chatId or "")
    if mode == "normal" and not text:
        raise ApiError("badrequest", "先说点什么吧。")
    if mode == "regenerate":
        # 重新生成：先删掉最后一条 AI 回复，再按同样的上文写一条
        with db.get_db() as conn_del:
            row = db.get_chat_row_by_id(conn_del, target_chat_id) if target_chat_id else db.get_chat_row(conn_del, character_id)
            if row:
                last = conn_del.execute(
                    "SELECT id, role FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1", (row["id"],)
                ).fetchone()
                if last and last["role"] == "ai":
                    conn_del.execute("DELETE FROM messages WHERE id = ?", (last["id"],))
        user_text = ""
    elif mode == "continue":
        # 续写：不写新的 user 消息，让模型接着最后一条 AI 回复继续
        user_text = "（请顺着上面最后一条继续写下去，不要重复，也不要替我说话。）"
    elif mode == "proactive":
        # 离线续写：同样不写 user 消息，但语义是「她主动开口」，不是「接着说」
        user_text = PROACTIVE_NUDGE
    else:
        user_text = text
    ctx = _load_context(conn, character_id, user_text, payload.modelId, payload.reasoningLevel, chat_id=target_chat_id or None)
    _check_ready(ctx)
    last_ai_text = ""
    for item in reversed(ctx["messages"]):
        if item.get("role") == "ai":
            last_ai_text = str(item.get("text") or "")
            break
    remember_body = memory.detect_remember(text)
    character = ctx["character"]
    prompt = ctx["prompt"]
    model = ctx["model"]
    provider = ctx["provider"]
    api_key = ctx["api_key"]
    level = ctx["reasoning_level"]
    return_thinking = bool((provider or {}).get("advanced", {}).get("returnThinking", True))
    built = build_reasoning_params(model, level, (provider or {}).get("protocol") or "openai")

    async def generator() -> AsyncIterator[str]:
        started = time.monotonic()
        text_parts: list[str] = []
        thinking_parts: list[str] = []
        finish_reason = ""
        usage: dict[str, Any] | None = None
        estimated = False
        fallback_note = ""
        fallback_removed: list[str] = []
        error: dict[str, Any] | None = None
        first_token_ms = 0
        remembered: dict[str, Any] | None = None

        user_msg = None
        chat_id = ""
        with db.get_db() as conn2:
            row = db.get_chat_row_by_id(conn2, target_chat_id) if target_chat_id else db.ensure_chat(conn2, character_id)
            if row is None:
                row = db.ensure_chat(conn2, character_id)
            chat_id = row["id"]
            updates = {}
            if payload.modelId:
                updates["model_id"] = payload.modelId
            if payload.reasoningLevel is not None:
                updates["reasoning_level"] = payload.reasoningLevel
            if updates:
                assignments = ", ".join(key + " = ?" for key in updates)
                conn2.execute(
                    "UPDATE chats SET " + assignments + ", updated_at = ? WHERE id = ?",
                    list(updates.values()) + [db.now_iso(), chat_id],
                )
            count = conn2.execute("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?", (chat_id,)).fetchone()["n"]
            if count == 0 and character.get("first_mes"):
                db.append_message(conn2, chat_id, "ai", character["first_mes"])
            if mode == "normal":
                user_msg = db.append_message(conn2, chat_id, "me", text)
                if remember_body is not None:
                    body = remember_body or last_ai_text
                    remembered = memory.remember_text(
                        conn2,
                        body,
                        source="聊天里说「记住这个」",
                        source_chat_id=chat_id,
                    )
        if user_msg:
            yield _sse("user", {"message": user_msg})
        yield _sse(
            "meta",
            {
                "modelId": model.get("id"),
                "modelName": model.get("name"),
                "modelKey": model.get("modelId"),
                "providerId": (provider or {}).get("id"),
                "providerName": (provider or {}).get("name"),
                "reasoning": {
                    "supported": built.get("supported"),
                    "mode": built.get("mode"),
                    "level": built.get("level"),
                    "params": built.get("params"),
                    "note": built.get("note"),
                },
                "mock": providers.mock_enabled(),
            },
        )
        try:
            async for event in providers.chat_stream(
                provider, model, prompt, api_key, level, session_id=chat_id
            ):
                etype = event.get("type")
                if etype == "start":
                    first_token_ms = int(event.get("duration_ms") or 0)
                elif etype == "delta":
                    chunk = str(event.get("text") or "")
                    if chunk:
                        text_parts.append(chunk)
                        yield _sse("delta", {"text": chunk})
                elif etype == "thinking":
                    chunk = str(event.get("text") or "")
                    if chunk:
                        thinking_parts.append(chunk)
                        if return_thinking:
                            yield _sse("thinking", {"text": chunk})
                elif etype == "finish":
                    finish_reason = str(event.get("reason") or "")
                elif etype == "usage":
                    incoming = event.get("usage") or {}
                    if usage is None:
                        usage = {}
                    for _k, _v in incoming.items():
                        try:
                            value = int(_v or 0)
                        except (TypeError, ValueError):
                            value = 0
                        if value > int(usage.get(_k) or 0):
                            usage[_k] = value
                    estimated = bool(event.get("estimated"))
                    yield _sse("usage", {"usage": _frontend_usage(usage), "estimated": estimated})
                elif etype == "fallback":
                    fallback_note = str(event.get("message") or "这家不支持调思考深度，已按默认回复。")
                    fallback_removed = list(event.get("removed") or [])
                    yield _sse("fallback", {"message": fallback_note})
                elif etype == "error":
                    error = event
                    break
        except Exception as exc:  # noqa: BLE001 - 上游异常不能再抛给前端
            info = classify_api_error(None, exc, detail=str(exc))
            error = {"type": "error", **info}

        duration_ms = int((time.monotonic() - started) * 1000)
        full_text = "".join(text_parts)
        thinking_text = "".join(thinking_parts)
        if usage is None:
            estimated = True
            usage = {
                "prompt_tokens": prompts.estimate_tokens(prompt.get("text") or ""),
                "cache_tokens": 0,
                "output_tokens": prompts.estimate_tokens(full_text),
                "total_tokens": 0,
            }
        usage["total_tokens"] = usage.get("total_tokens") or (int(usage.get("prompt_tokens") or 0) + int(usage.get("output_tokens") or 0))
        thinking_payload = None
        if return_thinking and thinking_text.strip():
            thinking_payload = {"sec": max(1, int(round(duration_ms / 1000))), "text": thinking_text.strip()}

        assistant = None
        if full_text.strip() or error:
            with db.get_db() as conn3:
                if full_text.strip():
                    assistant = db.append_message(
                        conn3,
                        chat_id,
                        "ai",
                        full_text.strip(),
                        thinking=thinking_payload,
                        usage=_frontend_usage(usage),
                        ms=duration_ms,
                        fallback=fallback_note,
                        error_kind=(error or {}).get("kind") if error else "",
                    )
                usage_mod.record_usage(
                    conn3,
                    conversation_id=chat_id,
                    character_id=character_id,
                    provider_id=(provider or {}).get("id") or "",
                    model_id=model.get("id") or "",
                    model_key=model.get("modelId") or "",
                    model_name=model.get("name") or "",
                    prompt_tokens=int(usage.get("prompt_tokens") or 0),
                    cache_tokens=int(usage.get("cache_tokens") or 0),
                    cache_write_tokens=int(usage.get("cache_write_tokens") or 0),
                    output_tokens=int(usage.get("output_tokens") or 0),
                    reasoning_tokens=int(usage.get("reasoning_tokens") or 0),
                    duration_ms=duration_ms,
                    first_token_ms=first_token_ms,
                    ok=not bool(error),
                    error_kind=(error or {}).get("kind") if error else None,
                    estimated=estimated,
                    fallback_reasoning=bool(fallback_note),
                    kind="chat",
                )
        if error:
            yield _sse("error", {"kind": error.get("kind") or "internal", "message": error.get("message") or "这次没成功，稍后再试。", "detail": error.get("detail") or ""})
        yield _sse(
            "done",
            {
                "chatId": chat_id,
                "message": assistant,
                "fallback": fallback_note,
                "fallbackRemoved": fallback_removed,
                "remembered": remembered,
                "usage": _frontend_usage(usage),
                "estimated": estimated,
                "durationMs": duration_ms,
                "error": error,
                # 被 max_tokens 截断时前端要明确提示，不能当成「她说完了」
                "truncated": finish_reason == "length",
                "finishReason": finish_reason,
            },
        )
        if not error:
            memory.schedule_extract_after_reply(
                character_id,
                (ctx.get("persona") or {}).get("id") or "",
                # 离线续写不增加用户轮数，按轮数算永远轮不到它，
                # 那她说的细节就永远进不了记忆库 —— 下次再编就对不上了
                force=(mode == "proactive"),
            )

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


def _frontend_usage(usage: dict[str, Any] | None) -> dict[str, Any]:
    """前端 renderUsage 认 OpenAI 兼容的 usage 结构。"""
    usage = usage or {}
    prompt = int(usage.get("prompt_tokens") or 0)
    output = int(usage.get("output_tokens") or usage.get("completion_tokens") or 0)
    return {
        "prompt_tokens": prompt,
        "completion_tokens": output,
        "total_tokens": int(usage.get("total_tokens") or (prompt + output)),
        "cache_tokens": int(usage.get("cache_tokens") or 0),
        "cache_write_tokens": int(usage.get("cache_write_tokens") or 0),
        "reasoning_tokens": int(usage.get("reasoning_tokens") or 0),
    }
