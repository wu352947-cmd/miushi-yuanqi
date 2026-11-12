"""朋友圈：她的世界里有谁、她发了什么、谁在下面说话。

隔离：一切按 character_id。温羽蓉和云诗蘩是两个平行世界，
NPC 也不共用——她妈妈不会出现在别人的朋友圈里。

三层内容：
  她发的    ← 聊天后生成，每天最多 1 条，发出去即事实（locked）
  我发的    ← 手动
  NPC 发的  ← 从剧情里实时抽出来的人，随机发

只有「她 + 我」发的最近 3 条进聊天上下文。
NPC 只在自己的动态下说话——她不需要记得路人的朋友圈。

为什么 NPC 是抽的而不是预先登记：
  剧情是实时长的，预先登记追不上。代价是可能抽错（把地点当成人），
  所以抽取要卡得紧，错了让用户手动删，不在这里猜。
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import re
from typing import Any

from . import auth, db, prompts, providers
from .errors import classify_api_error

LOG = logging.getLogger("msyq")

# 每天最多几条（防止某天突然刷出一堆）
DAILY_CHARACTER_LIMIT = 1
DAILY_NPC_LIMIT = 1
# 她发完，有 NPC 来评论的概率
COMMENT_CHANCE = 0.4
# 她评论之后，有多大比例同时点个赞
LIKE_CHANCE = 0.5
# 进上下文的条数
PROMPT_POSTS = 3


POST_SYSTEM = """你就是 {char}。现在是晚上，你在翻朋友圈，想发一条。

写什么：
· 今天的一件小事，或者刚冒出来的一个念头。
· 可以关于 {user}，也可以只关于你自己。
· 用你平时说话的样子。

不要写：
· 不要总结对话，不要复述聊天内容。
· 不要写成一封信或一篇日记。
· 不要写「刚刚聊到」这种话——朋友圈是给别人看的，不是在回复谁。

15 到 60 字，像随手拍张照配的那句话。
只输出正文本身。不要引号，不要解释，不要任何前缀。"""


NPC_EXTRACT_SYSTEM = """从这段对话里，找出「除 {char} 和 {user} 之外、有名字或明确身份的人」。

只收：
· 有称呼或名字的：她妈妈、室友小周、班主任李老师、楼下修车的师傅
· 被明确当作一个人在说话的

不收：
· 地点和地点里的东西（小卖部、三楼、还书机、那本书）
· 群体（同学们、路上的行人）
· 只出现一次、没有任何信息的陌生人

宁可漏，不要收错——错一个，她就多了一个不存在的关系。

输出 JSON：{{"npcs": [{{"name": "小周", "relation": "她的室友"}}]}}
没有就输出 {{"npcs": []}}"""


REACT_SYSTEM = """你是 {char}。你现在在翻朋友圈，看到了下面这件事。

写一句评论：不超过 20 字，用你平时说话的样子。
口语、短、有情绪。不要解释自己，不要旁白，不要引号，不要写成一整段。
不要每次都问问题，也不要写「你怎么了」这种试探——你就是随口回一句。"""

COMMENT_SYSTEM = """{char} 发了一条朋友圈：

{post}

你是 {name}，{relation}。

在下面评论一句。口语、短，不超过 25 字。
可以是关心、调侃、或者一句家常。不要长篇大论，不要解释自己是谁。

只输出这句话本身。"""


def _resolve_model(conn):
    """后台任务用压缩模型。

    这里没有具体会话，所以候选里不会有 chat.modelId；候选全空时
    再兜底拿第一个模型——mock 模式下没有任何 Key 也要能跑。
    """
    from . import digest  # 复用同一套挑选逻辑

    config = db.load_app_settings(conn)
    settings = config.get("settings") or {}
    fake_chat = {"modelId": settings.get("modelId") or ""}
    model, err = digest._resolve_compress_model(conn, fake_chat, settings)
    if model:
        return model, ""
    row = conn.execute("SELECT * FROM models ORDER BY created_at ASC LIMIT 1").fetchone()
    if row:
        return db.model_json(row), ""
    return None, err or "还没有可用的模型。"


def _bond_for(conn, character_id: str, persona_id: str) -> str:
    """一段关系的 id。朋友圈、NPC、每日配额都挂在它上面。

    同一个人设换了角色、同一个角色换个人设，都是不同的 bond——
    也就是不同的世界。
    """
    if not character_id:
        return ""
    row = conn.execute(
        "SELECT id FROM bonds WHERE character_id = ? AND persona_id = ?",
        (character_id, persona_id or ""),
    ).fetchone()
    return row["id"] if row else ""


def _today_count(conn, bond_id: str, author_kind: str) -> int:
    return conn.execute(
        "SELECT COUNT(*) AS n FROM posts "
        "WHERE bond_id = ? AND author_kind = ? AND date(at) = date('now', 'localtime')",
        (bond_id, author_kind),
    ).fetchone()["n"]


def recent_for_prompt(
    conn, character_id: str, persona_id: str = "", limit: int = PROMPT_POSTS
) -> list[dict[str, Any]]:
    """进上下文的那几条：只要她和我发的，NPC 的不带。

    NPC 的话零碎、且和「她是谁」无关，带进去只会稀释注意力。
    按 bond 取——换个人设就是另一个世界，不能让她看到别人的朋友圈。
    """
    bond_id = _bond_for(conn, character_id, persona_id)
    if not bond_id:
        return []
    rows = conn.execute(
        "SELECT * FROM posts WHERE bond_id = ? AND author_kind IN ('character', 'persona') "
        "ORDER BY at DESC, created_at DESC LIMIT ?",
        (bond_id, int(limit)),
    ).fetchall()
    out = []
    for r in reversed(rows):  # 正序给模型看
        at = str(r["at"] or r["created_at"] or "")
        out.append(
            {
                "author": "我" if r["author_kind"] == "persona" else str(r["author_name"]),
                "at": at[:10],
                "text": str(r["text"] or ""),
            }
        )
    return out


def _clean(text: str) -> str:
    out = (text or "").strip()
    out = re.sub(r"^```[a-zA-Z0-9_-]*\s*\n?", "", out)
    out = re.sub(r"\n?```\s*$", "", out)
    out = re.sub(r'^["「『]|["」』]$', "", out.strip())
    # 模型爱加「朋友圈文案：」这种前缀
    out = re.sub(r"^(?:朋友圈|文案|正文)[：:]\s*", "", out)
    return out.strip()


def _json_block(text: str) -> dict | None:
    raw = (text or "").strip()
    raw = re.sub(r"^```[a-zA-Z0-9_-]*\s*\n?", "", raw)
    raw = re.sub(r"\n?```\s*$", "", raw)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", raw, re.S)
        if not m:
            return None
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            return None


def _chat_context(conn, chat_id: str, limit: int = 10) -> tuple[str, str, str, str]:
    """取一段对话，返回 (角色名, 用户名, 角色设定, 聊天正文)。"""
    chat = db.chat_full_by_id(conn, chat_id)
    if not chat:
        return "", "", "", ""
    character = db.get_character(conn, chat.get("characterId") or "") or {}
    personas = [
        db.persona_json(r) for r in conn.execute("SELECT * FROM user_personas").fetchall()
    ]
    persona, _ = prompts.resolve_persona(chat, character, personas)
    char_name = character.get("name") or "她"
    user_name = (persona or {}).get("name") or "我"
    desc = " ".join(
        str(character.get(k) or "") for k in ("description", "personality")
    ).strip()[:600]
    msgs = (chat.get("messages") or [])[-limit:]
    lines = []
    for m in msgs:
        text = str(m.get("text") or "").strip()
        if not text:
            continue
        who = char_name if m.get("role") == "ai" else user_name
        lines.append(who + "：" + text[:400])
    return char_name, user_name, desc, "\n".join(lines)


async def extract_circle_npcs(chat_id: str) -> list[dict[str, Any]]:
    """从最近的对话里抽「她世界里的其他人」。

    只记名字和关系。抽错的由用户手动删——这里不猜。
    """
    with db.get_db() as conn:
        chat = db.chat_full_by_id(conn, chat_id)
        if not chat:
            return []
        character_id = chat.get("characterId") or ""
        bond_id = _bond_for(conn, character_id, chat.get("personaId") or "")
        if not bond_id:
            return []
        char_name, user_name, _desc, body = _chat_context(conn, chat_id, limit=10)
        if not body:
            return []
        existing = [n["name"] for n in db.list_npcs(conn, bond_id)]
        model, err = _resolve_model(conn)
        if not model:
            return []
        provider_row = db.get_provider_row(conn, model.get("providerId") or "")
        provider = db.provider_json(provider_row) if provider_row else None
        api_key = auth.provider_api_key(conn, model.get("providerId") or "")

    if not provider:
        return []

    known = "、".join(existing) if existing else "（还没有）"
    system = NPC_EXTRACT_SYSTEM.format(char=char_name, user=user_name)
    user_text = "[CIRCLE_NPC]\n已经认识的：" + known + "\n\n对话：\n" + body
    prompt = {
        "segments": [
            {"role": "system", "text": system, "kind": "system", "label": "找出其他人"},
            {"role": "user", "text": user_text, "kind": "current", "label": "对话"},
        ],
        "system_text": system,
        "sampling": {"temperature": 0.2, "max_tokens": 500},
        "text": system + "\n\n" + user_text,
        "meta": {},
    }

    try:
        result = await providers.complete(
            provider, model, prompt, api_key, reasoning_level="off", session_id=chat_id
        )
    except Exception as exc:  # noqa: BLE001
        LOG.warning("朋友圈 NPC 抽取失败：%s", classify_api_error(None, exc, detail=str(exc)).get("message"))
        return []

    payload = _json_block(result.get("text") or "")
    if not payload:
        return []

    added: list[dict[str, Any]] = []
    with db.get_db() as conn:
        for item in payload.get("npcs") or []:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()
            relation = str(item.get("relation") or "").strip()
            # 简单护栏：名字太长、或者和两个人重名，一律不要
            if not name or len(name) > 12:
                continue
            if name in (char_name, user_name):
                continue
            if name in existing:
                continue
            npc = db.upsert_npc(conn, bond_id, character_id, name, relation)
            if npc:
                added.append(npc)
                existing.append(name)
    return added


async def compose_character_post(chat_id: str) -> dict[str, Any]:
    """让她发一条朋友圈。发出去即事实（locked），之后谁都不能改。"""
    with db.get_db() as conn:
        chat = db.chat_full_by_id(conn, chat_id)
        if not chat:
            return {"ok": False, "message": "这段对话不在了。"}
        character_id = chat.get("characterId") or ""
        bond_id = _bond_for(conn, character_id, chat.get("personaId") or "")
        if not bond_id:
            return {"ok": False, "message": "这段关系还没建立起来。", "skipped": True}
        if _today_count(conn, bond_id, "character") >= DAILY_CHARACTER_LIMIT:
            return {"ok": False, "message": "今天已经发过了。", "skipped": True}
        char_name, user_name, desc, body = _chat_context(conn, chat_id, limit=12)
        if not body:
            return {"ok": False, "message": "还没有可写的素材。", "skipped": True}
        recent = db.list_posts(conn, bond_id, limit=3)
        npcs = db.list_npcs(conn, bond_id)
        model, err = _resolve_model(conn)
        if not model:
            return {"ok": False, "message": err or "还没有可用的模型。"}
        provider_row = db.get_provider_row(conn, model.get("providerId") or "")
        provider = db.provider_json(provider_row) if provider_row else None
        api_key = auth.provider_api_key(conn, model.get("providerId") or "")

    if not provider:
        return {"ok": False, "message": "这个模型的提供商不在列表里了。"}

    system = POST_SYSTEM.format(char=char_name, user=user_name)
    parts = []
    if desc:
        parts.append("你是谁：" + desc)
    if npcs:
        parts.append("你身边有：" + "、".join(n["name"] + "（" + n["relation"] + "）" for n in npcs[:6] if n["relation"]) or "、".join(n["name"] for n in npcs[:6]))
    if recent:
        parts.append("你最近发过：\n" + "\n".join("· " + str(p["text"])[:40] for p in recent))
    parts.append("最近发生的事：\n" + body)
    user_text = "[CIRCLE_POST]\n" + "\n\n".join(parts)

    prompt = {
        "segments": [
            {"role": "system", "text": system, "kind": "system", "label": "发朋友圈"},
            {"role": "user", "text": user_text, "kind": "current", "label": "最近"},
        ],
        "system_text": system,
        "sampling": {"temperature": 0.9, "max_tokens": 300},
        "text": system + "\n\n" + user_text,
        "meta": {},
    }

    try:
        result = await providers.complete(
            provider, model, prompt, api_key, reasoning_level="off", session_id=chat_id
        )
    except Exception as exc:  # noqa: BLE001
        error = classify_api_error(None, exc, detail=str(exc))
        return {"ok": False, "message": error.get("message") or "生成失败。"}

    text = _clean(result.get("text") or "")
    if len(text) < 4:
        return {"ok": False, "message": "这次没写出什么，跳过。"}

    with db.get_db() as conn:
        post = db.create_post(
            conn,
            character_id,
            "character",
            character_id,
            char_name,
            text[:400],
            source="chat",
            bond_id=bond_id,
            locked=True,
        )
    LOG.info("朋友圈：%s 发了一条（%d 字）", char_name, len(text))
    return {"ok": True, "post": post}


async def npc_post(chat_id: str) -> dict[str, Any]:
    """让某个 NPC 发一条。从这个世界的 NPC 里挑。"""
    with db.get_db() as conn:
        chat = db.chat_full_by_id(conn, chat_id)
        if not chat:
            return {"ok": False, "message": "这段对话不在了。"}
        character_id = chat.get("characterId") or ""
        bond_id = _bond_for(conn, character_id, chat.get("personaId") or "")
        if not bond_id:
            return {"ok": False, "message": "这段关系还没建立起来。", "skipped": True}
        npcs = [n for n in db.list_npcs(conn, bond_id) if n.get("relation")]
        if not npcs:
            return {"ok": False, "message": "还没有认识的人。", "skipped": True}
        if _today_count(conn, bond_id, "npc") >= DAILY_NPC_LIMIT:
            return {"ok": False, "message": "今天 NPC 已经发过了。", "skipped": True}
        character = db.get_character(conn, character_id) or {}
        char_name = character.get("name") or "她"
        recent = db.list_posts(conn, bond_id, limit=4)
        model, err = _resolve_model(conn)
        if not model:
            return {"ok": False, "message": err or "还没有可用的模型。"}
        provider_row = db.get_provider_row(conn, model.get("providerId") or "")
        provider = db.provider_json(provider_row) if provider_row else None
        api_key = auth.provider_api_key(conn, model.get("providerId") or "")

    if not provider:
        return {"ok": False, "message": "这个模型的提供商不在列表里了。"}

    # 挑一个：优先最近出现过的
    npc = sorted(npcs, key=lambda n: n.get("lastSeenAt") or "", reverse=True)[0]
    system = (
        "你是 " + npc["name"] + "，" + (npc.get("relation") or "她身边的人") + "。\n"
        "你在发一条朋友圈。可以提到 " + char_name + "，也可以只是自己的生活。"
    )
    user_text = "[CIRCLE_NPC_POST] 15 到 50 字，口语，像随手一写。只输出正文。"
    if recent:
        user_text += "\n\n最近看到的：" + "；".join(str(p["text"])[:30] for p in recent[:3])

    prompt = {
        "segments": [
            {"role": "system", "text": system, "kind": "system", "label": "NPC 发朋友圈"},
            {"role": "user", "text": user_text, "kind": "current", "label": "要求"},
        ],
        "system_text": system,
        "sampling": {"temperature": 0.95, "max_tokens": 200},
        "text": system + "\n\n" + user_text,
        "meta": {},
    }

    try:
        result = await providers.complete(provider, model, prompt, api_key, reasoning_level="off")
    except Exception as exc:  # noqa: BLE001
        LOG.warning("NPC 发朋友圈失败：%s", str(exc)[:120])
        return {"ok": False, "message": "生成失败。"}

    text = _clean(result.get("text") or "")
    if len(text) < 4:
        return {"ok": False, "message": "没写出什么。"}

    with db.get_db() as conn:
        post = db.create_post(
            conn,
            character_id,
            "npc",
            npc["id"],
            npc["name"],
            text[:300],
            source="npc",
            locked=True,
        )
    return {"ok": True, "post": post}


async def character_react(post_id: str, my_text: str = "") -> dict[str, Any]:
    """我在朋友圈说话了，她本人接一句。

    两种场景，用同一套流程，只是交代的不同：
    · 我发了条动态（my_text 为空）→ 她来评论
    · 我评论了她的动态（my_text 是那句评论）→ 她回我

    她不是 NPC：这是本人开口，所以身份是 character、名字是角色名。
    """
    with db.get_db() as conn:
        row = db.get_post_row(conn, post_id)
        if not row:
            return {"ok": False, "message": "这条动态不在了。"}
        character_id = row["character_id"]
        post_kind = str(row["author_kind"] or "")
        post_text = str(row["text"] or "")

        # 同一个帖子下面她最多说两句，多了就变成刷屏
        said = conn.execute(
            "SELECT COUNT(*) AS n FROM post_replies "
            "WHERE post_id = ? AND author_kind = 'character'",
            (post_id,),
        ).fetchone()["n"]
        if said >= 2:
            return {"ok": False, "message": "这条她已经说过了。", "skipped": True}

        character = db.get_character(conn, character_id) or {}
        char_name = character.get("name") or "她"

        chat_row = db.get_chat_row(conn, character_id)
        chat_id = chat_row["id"] if chat_row else ""
        personas = [
            db.persona_json(r) for r in conn.execute("SELECT * FROM user_personas").fetchall()
        ]
        chat_obj = db.chat_json(conn, chat_row, include_messages=False) if chat_row else {}
        persona, _ = prompts.resolve_persona(chat_obj, character, personas)
        user_name = (persona or {}).get("name") or "我"

        desc = ""
        body = ""
        if chat_id:
            _, _, desc, body = _chat_context(conn, chat_id, limit=6)

        model, err = _resolve_model(conn)
        if not model:
            return {"ok": False, "message": err or "还没有可用的模型。"}
        provider_row = db.get_provider_row(conn, model.get("providerId") or "")
        provider = db.provider_json(provider_row) if provider_row else None
        api_key = auth.provider_api_key(conn, model.get("providerId") or "")

    if not provider:
        return {"ok": False, "message": "这个模型的提供商不在列表里了。"}

    if my_text:
        scene = (
            "你自己发过一条：\n「" + post_text + "」\n\n"
            + user_name + " 在下面评论：\n「" + my_text + "」"
        )
    elif post_kind == "persona":
        scene = user_name + " 刚在朋友圈发了一条：\n「" + post_text + "」"
    else:
        scene = "朋友圈有人发了：\n「" + post_text + "」"

    parts: list[str] = []
    if desc:
        parts.append("你是：" + desc)
    if body:
        parts.append("最近发生的事：\n" + body)
    parts.append(scene)
    parts.append("写一句评论。只写评论本身。")
    user_text = "\n\n".join(parts)

    system = REACT_SYSTEM.format(char=char_name)
    prompt = {
        "segments": [
            {"role": "system", "text": system, "kind": "system", "label": "朋友圈回复"},
            {"role": "user", "text": user_text, "kind": "current", "label": "看到了什么"},
        ],
        "system_text": system,
        "sampling": {"temperature": 0.9, "max_tokens": 120},
        "text": system + "\n\n" + user_text,
        "meta": {},
    }
    try:
        result = await providers.complete(
            provider, model, prompt, api_key, reasoning_level="off", session_id=chat_id
        )
    except Exception as exc:  # noqa: BLE001
        LOG.warning("朋友圈回复失败：%s", str(exc)[:120])
        return {"ok": False, "message": "这次没回上来。"}

    text = _clean(result.get("text") or "")[:120]
    if len(text) < 2:
        LOG.info("朋友圈回复：这次没写出有效内容，跳过")
        return {"ok": False, "message": "没写出什么。"}

    with db.get_db() as conn:
        reply = db.add_reply(conn, post_id, "character", character_id, char_name, text)
        # 既然看到了、也开口了，顺手点个赞。不总是点，免得每条都带一个心
        if random.random() < LIKE_CHANCE:
            db.add_like(conn, post_id, "character", character_id, char_name)
    LOG.info("朋友圈：%s 接了一句（%d 字）", char_name, len(text))
    return {"ok": True, "reply": reply}


async def maybe_comment(post_id: str) -> dict[str, Any]:
    """她的动态下面，可能有人来评论。概率触发，不是每条都有。"""
    import random

    if random.random() > COMMENT_CHANCE:
        return {"ok": False, "message": "这次没人评论。", "skipped": True}

    with db.get_db() as conn:
        row = db.get_post_row(conn, post_id)
        if not row:
            return {"ok": False, "message": "这条动态不在了。"}
        character_id = row["character_id"]
        bond_id = str(row["bond_id"] or "")
        npcs = [n for n in db.list_npcs(conn, bond_id) if n.get("relation")]
        if not npcs:
            return {"ok": False, "message": "还没有认识的人。", "skipped": True}
        character = db.get_character(conn, character_id) or {}
        char_name = character.get("name") or "她"
        post_text = str(row["text"] or "")
        model, err = _resolve_model(conn)
        if not model:
            return {"ok": False, "message": err or "还没有可用的模型。"}
        provider_row = db.get_provider_row(conn, model.get("providerId") or "")
        provider = db.provider_json(provider_row) if provider_row else None
        api_key = auth.provider_api_key(conn, model.get("providerId") or "")

    if not provider:
        return {"ok": False, "message": "这个模型的提供商不在列表里了。"}

    # 挑评论人：优先和这条内容沾边的（名字出现在正文里）
    hot = [n for n in npcs if n["name"] in post_text]
    npc = hot[0] if hot else sorted(npcs, key=lambda n: n.get("lastSeenAt") or "")[-1]

    system = COMMENT_SYSTEM.format(
        char=char_name, post=post_text, name=npc["name"], relation=npc.get("relation") or ""
    )
    prompt = {
        "segments": [
            {"role": "system", "text": system, "kind": "system", "label": "评论"},
            {"role": "user", "text": "[CIRCLE_COMMENT] 写一句评论。", "kind": "current", "label": "要求"},
        ],
        "system_text": system,
        "sampling": {"temperature": 0.9, "max_tokens": 120},
        "text": system,
        "meta": {},
    }

    try:
        result = await providers.complete(provider, model, prompt, api_key, reasoning_level="off")
    except Exception as exc:  # noqa: BLE001
        LOG.warning("朋友圈评论失败：%s", str(exc)[:120])
        return {"ok": False, "message": "生成失败。"}

    text = _clean(result.get("text") or "")[:120]
    if len(text) < 2:
        return {"ok": False, "message": "没写出什么。"}

    with db.get_db() as conn:
        reply = db.add_reply(conn, post_id, "npc", npc["id"], npc["name"], text)
    return {"ok": True, "reply": reply}


def schedule_after_reply(chat_id: str, force: bool = False) -> None:
    """聊天结束后异步跑：抽 NPC → 她发朋友圈 → 也许有人评论。

    失败一律不影响聊天，只写日志。
    """

    async def _run() -> None:
        try:
            await extract_circle_npcs(chat_id)
            made = await compose_character_post(chat_id)
            if made.get("ok") and made.get("post"):
                await maybe_comment(made["post"]["id"])
            await npc_post(chat_id)
        except Exception:  # noqa: BLE001
            LOG.exception("朋友圈后台任务出错")

    try:
        asyncio.create_task(_run())
    except RuntimeError:
        pass