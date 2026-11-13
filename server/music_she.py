"""恋缘之音：让她按当前剧情和心理给你点歌。

她读的是「刚聊完什么、心里在想什么」，不是「剧情里提过哪首歌」。
挑完逐首搜一遍，搜不到就跳过——宁可少一首，也不放一首假的。
"""
from __future__ import annotations
import json
import logging
import re
from typing import Any
from . import auth, db, moments, music, providers
LOG = logging.getLogger(__name__)
PICK_SYSTEM = """你是 {char}，正和 {user} 待在一起。
你不问他听什么，你自己想放给他听。
看你们刚才聊的内容和当时的气氛，挑 {n} 首歌。
要求：
- 挑气氛贴合的，不要挑把剧情直白讲出来的那种
- 歌名和歌手必须是真实存在的、能在音乐平台搜到的流行歌
- 不要编歌手；不确定就写这首歌最有名的那个演唱者
- 只输出 JSON，不要解释，不要 markdown 代码块
格式：
{{"songs":[{{"title":"歌名","artist":"歌手","why":"不超过 20 字，你为什么想放这首"}}]}}"""
def parse_picks(text: str) -> list[dict]:
    """从模型输出里挖出 songs 数组。模型偶尔会加代码块或前言，尽量宽容。"""
    raw = (text or "").strip()
    if not raw:
        return []
    raw = re.sub(r"^```[a-zA-Z]*\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    m = re.search(r"\{.*\}", raw, re.S)
    if not m:
        return []
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return []
    out = []
    for item in data.get("songs") or []:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        out.append({
            "title": title,
            "artist": str(item.get("artist") or "").strip(),
            "why": str(item.get("why") or "").strip()[:40],
        })
    return out
def _norm(s: str) -> str:
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]", "", (s or "").lower())
def _best_match(hits: list[dict], title: str, artist: str) -> dict | None:
    """在搜索结果里挑最像的那首。歌手对上 +2，歌名完全对上 +2，歌名包含 +1。
    一分都没有就放弃——宁可不放，也不放错歌。"""
    if not hits:
        return None
    tn, an = _norm(title), _norm(artist)
    best, score = None, 0
    for h in hits:
        sc = 0
        if an and an in _norm(h.get("artist") or ""):
            sc += 2
        hn = _norm(h.get("name") or "")
        if tn and tn == hn:
            sc += 2
        elif tn and tn in hn:
            sc += 1
        # 名字里带 Cover / 翻唱 / 伴奏 的，扣一分——原唱优先
        low = str(h.get("name") or "").lower()
        if "cover" in low or "翻唱" in low or "伴奏" in low:
            sc -= 1
        if sc > score:
            best, score = h, sc
    return best if score >= 1 else None
async def pick_songs(chat_id: str, count: int = 2) -> dict[str, Any]:
    """让她挑几首。返回新增的歌和当前完整列表。"""
    with db.get_db() as conn:
        chat = db.chat_full_by_id(conn, chat_id)
        if not chat:
            return {"ok": False, "message": "这段对话不在了。"}
        character_id = chat.get("characterId") or ""
        char_name, user_name, desc, body = moments._chat_context(conn, chat_id, limit=10)
        model, err = moments._resolve_model(conn)
        if not model:
            return {"ok": False, "message": err or "还没有可用的模型。"}
        provider_row = db.get_provider_row(conn, model.get("providerId") or "")
        provider = db.provider_json(provider_row) if provider_row else None
        api_key = auth.provider_api_key(conn, model.get("providerId") or "")
    if not provider:
        return {"ok": False, "message": "这个模型的提供商不在列表里了。"}
    if not body:
        return {"ok": False, "message": "还没聊几句，她挑不出来。"}
    system = PICK_SYSTEM.format(char=char_name, user=user_name, n=count)
    parts = []
    if desc:
        parts.append("你是这样的人：" + desc)
    parts.append("刚才聊的：\n" + body)
    user_text = "[PICK_SONG]\n" + "\n\n".join(parts)
    prompt = {
        "segments": [
            {"role": "system", "text": system, "kind": "system", "label": "点歌"},
            {"role": "user", "text": user_text, "kind": "current", "label": "刚才"},
        ],
        "system_text": system,
        "sampling": {"temperature": 0.95, "max_tokens": 400},
        "text": system + "\n\n" + user_text,
        "meta": {},
    }
    try:
        result = await providers.complete(
            provider, model, prompt, api_key, reasoning_level="off", session_id=chat_id
        )
    except Exception as exc:  # noqa: BLE001
        LOG.warning("恋缘之音：生成失败 %s", str(exc)[:150])
        return {"ok": False, "message": "她这会儿没挑出来，过一会儿再试。"}
    picks = parse_picks(result.get("text") or "")
    if not picks:
        return {"ok": False, "message": "她没挑出合适的歌，再试一次。"}
    matched = []
    with db.get_db() as conn:
        for p in picks[: max(1, int(count))]:
            try:
                hits = music.search(p["title"] + " " + p["artist"], limit=6)
            except Exception as exc:  # noqa: BLE001
                LOG.info("恋缘之音：搜 %s 失败 %s", p["title"], str(exc)[:80])
                hits = []
            hit = _best_match(hits, p["title"], p["artist"])
            if not hit:
                LOG.info("恋缘之音：搜不到 %s - %s，跳过", p["title"], p["artist"])
                continue
            song_id = str(hit.get("id") or "")
            if not song_id or any(m["song_id"] == song_id for m in matched):
                continue          # 同一批里重了的直接丢掉
            matched.append({
                "song_id": song_id,
                "name": hit.get("name") or p["title"],
                "artist": hit.get("artist") or p["artist"],
                "album": hit.get("album") or "",
                "cover": hit.get("cover") or "",
                "dur": hit.get("dur") or 0,
                "why": p["why"],
            })
        rows = []
        if matched:
            # 「让她点歌」= 换掉上一批，不是往上叠（以前越点越多、还会重复）
            db.music_pick_clear(conn, chat_id)
            for item in matched:
                db.music_pick_add(conn, item, chat_id, character_id)
            rows = db.music_pick_list(conn, chat_id)
    if not matched:
        return {"ok": False, "message": "挑的歌都搜不到，再试一次。"}
    LOG.info("恋缘之音：为 %s 挑了 %d 首", chat_id, len(matched))
    return {"ok": True, "added": len(matched), "picks": rows}
