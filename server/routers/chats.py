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
from ..schemas import ChatPatch, ChatSendIn
from .deps import get_conn

router = APIRouter(prefix="/api/chats", tags=["chats"])


def _sse(event: str, data: dict[str, Any]) -> str:
    return "event: " + event + "\ndata: " + json.dumps(data, ensure_ascii=False) + "\n\n"


def _load_context(conn, character_id: str, user_text: str, model_id: str | None = None, reasoning_level: str | None = None) -> dict[str, Any]:
    character = db.get_character(conn, character_id)
    if not character:
        raise ApiError("notfound", "这位角色已经不在列表里了。", status=404)
    config = db.load_app_settings(conn)
    chat_row = db.get_chat_row(conn, character_id)
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
    prompt = prompts.assemble(
        {
            "character": character,
            "persona": persona,
            "books": books_used,
            "preset": preset,
            "model": model,
            "messages": messages,
            "user_text": user_text,
            "now_text": memory.now_card(conn).get("body") or "",
            "memories": memory.pinned_for_prompt(conn),
            "preset_source": preset_source,
            "persona_source": persona_source,
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
def list_chats(conn=Depends(get_conn)) -> dict:
    rows = conn.execute("SELECT * FROM chats ORDER BY created_at ASC").fetchall()
    return {"chats": [db.chat_json(conn, row, include_messages=False) for row in rows]}


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


@router.post("/{character_id}/messages")
async def send_message(character_id: str, payload: ChatSendIn, conn=Depends(get_conn)) -> StreamingResponse:
    text = (payload.text or "").strip()
    if not text:
        raise ApiError("badrequest", "先说点什么吧。")
    ctx = _load_context(conn, character_id, text, payload.modelId, payload.reasoningLevel)
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
            user_msg = db.append_message(conn2, chat_id, "me", text)
            if remember_body is not None:
                body = remember_body or last_ai_text
                remembered = memory.remember_text(
                    conn2,
                    body,
                    source="聊天里说「记住这个」",
                    source_chat_id=chat_id,
                )
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
            async for event in providers.chat_stream(provider, model, prompt, api_key, level):
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
                "message": assistant,
                "fallback": fallback_note,
                "fallbackRemoved": fallback_removed,
                "remembered": remembered,
                "usage": _frontend_usage(usage),
                "estimated": estimated,
                "durationMs": duration_ms,
                "error": error,
            },
        )
        if not error:
            memory.schedule_extract_after_reply(character_id)

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
