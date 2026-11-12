"""上下文压缩：把最早的一段对话折叠成滚动摘要。

为什么要有：
  历史按 token 预算裁剪，超出预算的老消息会被直接丢掉——开场白、第一次见面、
  定下关系的那几个晚上，第一个消失。RP 靠上下文活着，丢掉的部分得有东西替它记着。

做法：
  摘要覆盖 [最早 … upto_message_id] 这些消息，它们不再发给模型，
  改成一条 system 块「前情摘要」放在聊天记录前面。

  新摘要 = 已有摘要 + 新挤出来的这一段，合并成一条连续的时间线。
  不是每轮重新总结全部：已经压过的部分不再重读，只把新挤出来的接上去。
  所以压缩成本跟着「新增量」走，不跟「总长度」走。

  消息正文一条都不删。压缩只改变「发给模型什么」，不改变「聊天记录里有什么」。
"""

from __future__ import annotations

import logging
import re
from typing import Any

from . import db, prompts, providers
from .errors import classify_api_error

LOG = logging.getLogger("msyq")

# 摘要目标长度（字符）。太短丢细节，太长又不省空间。
DEFAULT_DIGEST_CHARS = 700
# 压到预算的多少（0.5 = 腾出一半）
DEFAULT_KEEP_RATIO = 0.5
# 占用超过这个比例才值得压
DEFAULT_TRIGGER = 0.75
# 少于这么多条就不压，模型调用成本比省下的还贵
MIN_MESSAGES = 4


DIGEST_SYSTEM = """你在替人保管一段对话的记忆。

对话的两个人：{user}（用户）和 {char}（角色）。他们可能是恋人、朋友或家人，关系由内容决定。

你会拿到「已有的摘要」和「新挤出来的一段对话」。请把它们合并成一份新的、连续的记录——
不是两段拼在一起，是一份从头读到尾能看懂的记录。

写什么：
· 时间线：什么时候、在哪里、发生了什么。用「后来」「当天晚上」「第二天」这类相对时间。
· 关系：两个人现在是什么关系、走到哪一步了。称呼、默契、亲密的程度。
· 没讲完的事：说好要做还没做的、答应过的、悬着的问题。这些后面一定会被提起，漏了就断层。
· 变了的东西：谁的态度变了、哪句话之后气氛不一样了。已经定下的性格不要反复推翻。
· 具体的东西：名字、地点、物件、约定。宁可写「她答应给他看一样东西」，也不要只写「她答应了什么」。

不写什么：
· 逐句复述。不要「他说……她说……」交替抄一遍。
· 动作和环境。走过去、抬起头、雨停了——这些读原文才有味道，摘要里是噪音。
· 心理描写和抒情。不要写「空气里弥漫着暧昧」。
· 推测。你不知道的不要补全。

写法：
· 第三人称。角色写名字或「{char}」，用户写「{user}」，不要用「你」。
· 分三段，标题照抄：【时间线】【关系】【没讲完的事】，每段两三行。
· 全文 {limit} 字以内。宁可短，不要为了凑字数。
· 如果「已有的摘要」是空的，就只写新对话这一段。

只输出摘要本身。不要前言、不要说明、不要 markdown 代码块。"""


def _mid(msg: dict[str, Any]) -> int:
    try:
        return int(msg.get("id") or 0)
    except (TypeError, ValueError):
        return 0


def _tokens(messages: list[dict[str, Any]]) -> int:
    return sum(prompts.estimate_tokens(str(m.get("text") or "")) for m in messages)


def pending_messages(
    messages: list[dict[str, Any]], digest: dict[str, Any] | None
) -> list[dict[str, Any]]:
    """还没进摘要的那部分（按 id 往后切，不看条数——删消息、分支都不会错位）。

    没有 id 的消息一律算「还没进去」：开场白是即时合成的占位，
    它不在 chat_digests 的覆盖范围里，用 0 <= upto 去筛会把它误删。
    """
    upto = int((digest or {}).get("uptoMessageId") or 0)
    if not upto:
        return list(messages)
    return [m for m in messages if not (_mid(m) and _mid(m) <= upto)]


def plan(
    messages: list[dict[str, Any]],
    digest: dict[str, Any] | None,
    budget: int,
    *,
    trigger: float = DEFAULT_TRIGGER,
    keep_ratio: float = DEFAULT_KEEP_RATIO,
    force: bool = False,
) -> dict[str, Any]:
    """算出这次压哪些、留哪些。不调模型，纯计算，可以先拿来给用户看。"""
    pending = pending_messages(messages, digest)
    pending_tokens = _tokens(pending)
    before_tokens = _tokens(messages)

    if len(pending) <= MIN_MESSAGES:
        return {
            "needed": False,
            "reason": "剩下的对话还太短，压不出什么东西。",
            "pending": pending,
            "pendingTokens": pending_tokens,
            "beforeTokens": before_tokens,
        }

    # 手动点的时候也要有个下限：占不到预算的 20%，压了纯亏
    floor_ratio = 0.2 if force else trigger
    if pending_tokens <= budget * floor_ratio:
        return {
            "needed": False,
            "reason": "才用了 %d%%，现在压缩只会白白丢掉细节。" % round(pending_tokens / max(1, budget) * 100),
            "pending": pending,
            "pendingTokens": pending_tokens,
            "beforeTokens": before_tokens,
        }

    target = max(1024, int(budget * keep_ratio))
    keep = prompts.pick_history(pending, target)
    to_summarize = pending[: len(pending) - len(keep)]
    if not to_summarize:
        return {
            "needed": False,
            "reason": "预算还很宽裕，没有需要折叠的部分。",
            "pending": pending,
            "pendingTokens": pending_tokens,
            "beforeTokens": before_tokens,
        }

    return {
        "needed": True,
        "reason": "",
        "pending": pending,
        "toSummarize": to_summarize,
        "keep": keep,
        "targetUpto": _mid(to_summarize[-1]),
        "sourceTokens": _tokens(to_summarize),
        "pendingTokens": pending_tokens,
        "afterTokens": _tokens(keep),
        "beforeTokens": before_tokens,
    }


def _build_user_prompt(
    old_text: str,
    messages: list[dict[str, Any]],
    char_name: str,
    user_name: str,
) -> str:
    # [CONTEXT_DIGEST] 让 mock 模式认出这是压缩任务，返回可用的假摘要
    lines: list[str] = ["[CONTEXT_DIGEST]", "【已有的摘要】"]
    lines.append(old_text.strip() if old_text.strip() else "（还没有，这是第一次压缩）")
    lines.append("")
    lines.append("【新挤出来的对话】")
    for msg in messages:
        text = str(msg.get("text") or "").strip()
        if not text:
            continue
        who = char_name if msg.get("role") == "ai" else user_name
        lines.append(who + "：" + text)
    return "\n".join(lines)


_LEAD_RE = re.compile(r"^(?:好的|下面是|以下是|这是)[^\n]{0,12}[：:]\s*")


def clean_digest(text: str) -> str:
    """模型爱包代码块、爱加「以下是合并后的摘要：」，去掉。"""
    out = (text or "").strip()
    out = re.sub(r"^```[a-zA-Z0-9_-]*\s*\n?", "", out)
    out = re.sub(r"\n?```\s*$", "", out)
    out = _LEAD_RE.sub("", out.strip())
    return out.strip()


def _resolve_compress_model(conn, chat: dict[str, Any], settings: dict[str, Any]) -> tuple[dict | None, str]:
    """压缩用哪个模型：设置里指定的 > 这场聊天的 > 全局默认。"""
    from . import auth  # 局部导入，避免循环

    for candidate in (
        settings.get("compressModelId") or "",
        chat.get("modelId") or "",
        settings.get("modelId") or "",
    ):
        if not candidate:
            continue
        model = db.get_model(conn, candidate)
        if not model:
            continue
        if auth.provider_api_key(conn, model.get("providerId") or "") or providers.mock_enabled():
            return model, ""
    # 都没有 Key 时，退回到任意一个带 Key 的
    for row in conn.execute("SELECT * FROM models ORDER BY created_at DESC").fetchall():
        model = db.model_json(row)
        if auth.provider_api_key(conn, model.get("providerId") or ""):
            return model, ""
    return None, "还没有能用的模型：先到「模型与提供商」里填好 API Key。"


def preview(chat_id: str, keep_ratio: float = DEFAULT_KEEP_RATIO) -> dict[str, Any]:
    """只算不压：能折叠多少条、大概腾多少 token。给前端显示用，不花钱。"""
    with db.get_db() as conn:
        chat = db.chat_full_by_id(conn, chat_id)
        if not chat:
            return {"ok": False, "message": "这段对话已经不在了。"}
        messages = chat.get("messages") or []
        if not messages:
            return {"ok": False, "message": "这场聊天还没有内容。"}
        config = db.load_app_settings(conn)
        settings = config.get("settings") or {}
        chat_model = db.get_model(conn, chat.get("modelId") or "") or db.get_model(
            conn, settings.get("modelId") or ""
        )
        presets = [db.preset_json(r) for r in conn.execute("SELECT * FROM prompt_presets").fetchall()]
        character = db.get_character(conn, chat.get("characterId") or "") or {}
        preset, _ = prompts.resolve_preset(
            chat, character, presets, settings.get("defaultPresetId") or ""
        )
        sampling = prompts._sampling(preset)
        budget = prompts.history_budget(chat_model, sampling)
        current = db.get_digest(conn, chat_id)
        try:
            th = float(settings.get("contextThreshold") or 75)
        except (TypeError, ValueError):
            th = 75.0
        p = plan(
            messages,
            current,
            budget,
            trigger=max(0.1, min(1.0, th / 100.0)),
            keep_ratio=keep_ratio,
            force=True,
        )
        to_sum = p.get("toSummarize") or []
        freed = 0
        if p["needed"]:
            # 摘要按 700 字估，实际会差一些
            freed = max(0, p["sourceTokens"] - prompts.estimate_tokens("x" * DEFAULT_DIGEST_CHARS))
        return {
            "ok": True,
            "needed": p["needed"],
            "reason": p["reason"],
            "budget": budget,
            "threshold": th,
            "beforeTokens": p["beforeTokens"],
            "pendingTokens": p["pendingTokens"],
            "pendingCount": len(p["pending"]),
            "messageCount": len(messages),
            "toCount": len(to_sum),
            "toTokens": p.get("sourceTokens") or 0,
            "freedTokens": freed,
            "percent": round(p["beforeTokens"] / max(1, budget) * 100),
            "digest": current,
        }


async def compress_chat(
    chat_id: str,
    *,
    model_id: str = "",
    force: bool = True,
    keep_ratio: float = DEFAULT_KEEP_RATIO,
) -> dict[str, Any]:
    """压缩一段对话。force=True 表示用户手动点的，不等阈值。"""
    from . import auth  # 局部导入

    with db.get_db() as conn:
        chat = db.chat_full_by_id(conn, chat_id)
        if not chat:
            return {"ok": False, "message": "这段对话已经不在了。"}
        messages = chat.get("messages") or []
        if not messages:
            return {"ok": False, "message": "这场聊天还没有内容。"}

        config = db.load_app_settings(conn)
        settings = config.get("settings") or {}
        character = db.get_character(conn, chat.get("characterId") or "") or {}
        personas = [db.persona_json(r) for r in conn.execute("SELECT * FROM user_personas").fetchall()]
        persona, _ = prompts.resolve_persona(chat, character, personas)

        # 预算按「这场聊天用的模型」算——要约束的是发给它的内容；
        # 压缩模型只影响摘要质量，不影响预算。
        chat_model = db.get_model(conn, chat.get("modelId") or "") or db.get_model(conn, settings.get("modelId") or "")
        presets = [db.preset_json(r) for r in conn.execute("SELECT * FROM prompt_presets").fetchall()]
        preset, _ = prompts.resolve_preset(chat, character, presets, settings.get("defaultPresetId") or "")
        sampling = prompts._sampling(preset)
        budget = prompts.history_budget(chat_model, sampling)

        digest = db.get_digest(conn, chat_id)
        try:
            th = float(settings.get("contextThreshold") or 75)
        except (TypeError, ValueError):
            th = 75.0
        p = plan(
            messages,
            digest,
            budget,
            trigger=max(0.1, min(1.0, th / 100.0)),
            keep_ratio=keep_ratio,
            force=force,
        )
        if not p["needed"]:
            return {
                "ok": False,
                "reason": "nothing",
                "message": p["reason"],
                "usage": {
                    "beforeTokens": p["beforeTokens"],
                    "budget": budget,
                },
            }

        model, err = (None, "")
        provider = None
        api_key = ""
        target = model_id or ""
        if target:
            m = db.get_model(conn, target)
            if m:
                provider_row = db.get_provider_row(conn, m.get("providerId") or "")
                if provider_row:
                    model = m
                    provider = db.provider_json(provider_row)
                    api_key = auth.provider_api_key(conn, m.get("providerId") or "")
                else:
                    model = None
        if not model:
            model, err = _resolve_compress_model(conn, chat, settings)
            if model:
                provider_row = db.get_provider_row(conn, model.get("providerId") or "")
                provider = db.provider_json(provider_row) if provider_row else None
                api_key = auth.provider_api_key(conn, model.get("providerId") or "")
        if not model:
            return {"ok": False, "message": err or "还没有能用的压缩模型。"}
        if not provider:
            return {"ok": False, "message": "这个压缩模型的提供商已经不在列表里了。"}

        char_name = character.get("name") or "角色"
        user_name = (persona or {}).get("name") or (settings.get("userName") or "我")
        old_text = (digest or {}).get("text") or ""
        to_sum = p["toSummarize"]
        user_prompt = _build_user_prompt(old_text, to_sum, char_name, user_name)
        system_prompt = DIGEST_SYSTEM.format(
            user=user_name, char=char_name, limit=DEFAULT_DIGEST_CHARS
        )
        model_key = model.get("modelId") or ""
        # 统计要在 with 里取，出了 with 连接就关了
        stats = {
            "toCount": len(to_sum),
            "sourceTokens": p["sourceTokens"],
            "beforeTokens": p["beforeTokens"],
            "afterTokens": p["afterTokens"],
            "budget": budget,
            "targetUpto": p["targetUpto"],
        }

    prompt = {
        "segments": [
            {"role": "system", "text": system_prompt, "kind": "system", "label": "上下文压缩"},
            {"role": "user", "text": user_prompt, "kind": "current", "label": "待折叠的对话"},
        ],
        "system_text": system_prompt,
        "sampling": {"temperature": 0.3, "max_tokens": 2000},
        "text": system_prompt + "\n\n" + user_prompt,
        "meta": {},
    }

    try:
        result = await providers.complete(
            provider, model, prompt, api_key, reasoning_level="off", session_id=chat_id
        )
    except Exception as exc:  # noqa: BLE001
        error = classify_api_error(None, exc, detail=str(exc))
        LOG.warning("压缩失败：%s", error.get("message"))
        return {"ok": False, "message": error.get("message") or "压缩时模型没有响应。"}

    new_text = clean_digest(result.get("text") or "")
    if len(new_text) < 40:
        return {"ok": False, "message": "模型这次没给出可读的摘要，先不覆盖旧的。"}

    digest_tokens = prompts.estimate_tokens(new_text)
    with db.get_db() as conn:
        saved = db.save_digest(
            conn,
            chat_id,
            new_text,
            upto_message_id=stats["targetUpto"],
            message_count=stats["toCount"] + int((digest or {}).get("messageCount") or 0),
            source_tokens=(digest or {}).get("sourceTokens", 0) + stats["sourceTokens"],
            digest_tokens=digest_tokens,
            model_key=model_key,
            manual=True,
        )

    after = stats["afterTokens"] + digest_tokens
    return {
        "ok": True,
        "digest": saved,
        "usage": {
            "beforeTokens": stats["beforeTokens"],
            "afterTokens": after,
            "freedTokens": max(0, stats["beforeTokens"] - after),
            "toCount": stats["toCount"],
            "budget": stats["budget"],
            "model": model.get("name") or model_key,
        },
    }


def undo_digest(chat_id: str) -> dict[str, Any]:
    """撤销压缩：历史重新全部发给模型。消息本来就没删，所以随时可撤。"""
    with db.get_db() as conn:
        ok = db.delete_digest(conn, chat_id)
    return {"ok": ok, "message": "已撤销，下次起完整历史会重新发出去。" if ok else "这段对话本来就没有压缩过。"}
