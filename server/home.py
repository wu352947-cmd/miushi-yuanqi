"""首页那几块会变的东西：今日记住 / 她留的话 / 天气 / 生日。

一条原则贯穿全文：**宁可空着，也不显示假话。**

- 记忆不够格 → 返回 null，前端整块隐藏
- 天气拿不到 → 返回 null，不写「18°C 小雨」
- 便条这次没写出来 → 返回 null，明天再说
- 生日没设置 → 返回 null，不写「还有 12 天」

之前首页这四处全是写死的假数据，天天一样，看两次就穿帮。
"""
from __future__ import annotations

import logging
import time
import zlib
from datetime import date
from typing import Any

import httpx

from . import db, providers

LOG = logging.getLogger("miushi.home")

MEMORY_MIN_IMPORTANCE = 6   # 低于这个分的不配上首页
NOTE_MAX_CHARS = 48
WEATHER_TTL = 1800          # 半小时内不再问一次
GEO_TTL = 86400
HTTP_TIMEOUT = 6.0

# WMO 天气代码 → (中文, 图标名)
WMO = {
    0: ("晴", "sun"), 1: ("晴间多云", "sun"), 2: ("多云", "cloud"), 3: ("阴", "cloud"),
    45: ("雾", "fog"), 48: ("雾凇", "fog"),
    51: ("毛毛雨", "rain"), 53: ("毛毛雨", "rain"), 55: ("密毛毛雨", "rain"),
    56: ("冻毛雨", "rain"), 57: ("冻毛雨", "rain"),
    61: ("小雨", "rain"), 63: ("中雨", "rain"), 65: ("大雨", "rain"),
    66: ("冻雨", "rain"), 67: ("冻雨", "rain"),
    71: ("小雪", "snow"), 73: ("中雪", "snow"), 75: ("大雪", "snow"), 77: ("雪粒", "snow"),
    80: ("阵雨", "rain"), 81: ("强阵雨", "rain"), 82: ("暴雨", "rain"),
    85: ("阵雪", "snow"), 86: ("强阵雪", "snow"),
    95: ("雷阵雨", "storm"), 96: ("雷雨冰雹", "storm"), 99: ("强雷雨冰雹", "storm"),
}

_weather_cache: dict[str, tuple[float, dict[str, Any] | None]] = {}
_geo_cache: dict[str, tuple[float, dict[str, Any] | None]] = {}

NOTE_SYSTEM = (
    "你是{char}。现在不是在聊天，是给{user}留一张便条。\n"
    "写一到两句，不超过 40 个字，像贴在冰箱上、压在杯子下面的那种。\n"
    "只写你会说出口的话。不要旁白，不要动作描写，不要引号，不要解释，不要问句催他回来。\n"
    "读的人此刻不在，你不知道他什么时候回来。"
)


def _imp(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


# ---------------- 今日记住 ----------------

def pick_memory(conn, character_id: str, day_key: str) -> dict[str, Any] | None:
    """挑一条记忆当「今日记住」。

    用日期做稳定哈希：同一天反复刷新首页，看到的是同一条；
    换一天就换一条，像在翻相册。
    """
    if not character_id:
        return None
    rows = conn.execute(
        "SELECT title, body, importance, category FROM memories "
        "WHERE character_id = ? AND kind IN ('note', 'now') AND status = 'normal' "
        "ORDER BY importance DESC, created_at DESC",
        (character_id,),
    ).fetchall()
    if not rows:
        return None
    strong = [r for r in rows if _imp(r["importance"]) >= MEMORY_MIN_IMPORTANCE]
    pool = strong or rows
    idx = zlib.crc32(day_key.encode("utf-8")) % len(pool)
    row = pool[idx]
    return {
        "title": row["title"] or "",
        "text": row["body"] or "",
        "category": row["category"] or "",
        "importance": _imp(row["importance"]),
    }


# ---------------- 生日 ----------------

def birthday_days(mmdd: str, today: date | None = None) -> int | None:
    """离下一个生日还有几天。没设置或格式不对就返回 None。"""
    mmdd = (mmdd or "").strip()
    if "-" not in mmdd:
        return None
    try:
        month, day = [int(x) for x in mmdd.split("-")[:2]]
    except ValueError:
        return None
    today = today or date.today()
    try:
        target = date(today.year, month, day)
        if target < today:
            target = date(today.year + 1, month, day)
    except ValueError:
        return None
    return (target - today).days


# ---------------- 天气 ----------------

async def _geocode(client: httpx.AsyncClient, city: str) -> dict[str, Any] | None:
    now = time.monotonic()
    hit = _geo_cache.get(city)
    if hit and now - hit[0] < GEO_TTL:
        return hit[1]
    out = None
    try:
        resp = await client.get(
            "https://geocoding-api.open-meteo.com/v1/search",
            params={"name": city, "count": 1, "language": "zh", "format": "json"},
        )
        resp.raise_for_status()
        results = (resp.json() or {}).get("results") or []
        if results:
            first = results[0]
            out = {
                "lat": first.get("latitude"),
                "lon": first.get("longitude"),
                "name": first.get("name") or city,
            }
    except Exception as exc:  # noqa: BLE001
        LOG.warning("天气：地名 %s 解析失败（%s）", city, exc)
    _geo_cache[city] = (now, out)
    return out


async def get_weather(city: str) -> dict[str, Any] | None:
    """拿当前天气。失败返回 None——不拿假数据顶上。"""
    city = (city or "").strip()
    if not city:
        return None
    now = time.monotonic()
    hit = _weather_cache.get(city)
    if hit and now - hit[0] < WEATHER_TTL:
        return hit[1]

    out: dict[str, Any] | None = None
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(HTTP_TIMEOUT, connect=3.0)) as client:
            geo = await _geocode(client, city)
            if geo and geo.get("lat") is not None:
                resp = await client.get(
                    "https://api.open-meteo.com/v1/forecast",
                    params={
                        "latitude": geo["lat"],
                        "longitude": geo["lon"],
                        "current": "temperature_2m,weather_code,is_day",
                        "timezone": "auto",
                    },
                )
                resp.raise_for_status()
                cur = (resp.json() or {}).get("current") or {}
                code = cur.get("weather_code")
                temp = cur.get("temperature_2m")
                if temp is not None:
                    text, icon = WMO.get(int(code), ("", "cloud")) if code is not None else ("", "cloud")
                    out = {
                        "city": geo.get("name") or city,
                        "temp": round(float(temp)),
                        "text": text,
                        "icon": icon,
                        "day": bool(cur.get("is_day", 1)),
                    }
    except Exception as exc:  # noqa: BLE001
        LOG.warning("天气：%s 获取失败（%s）", city, exc)
        out = None

    _weather_cache[city] = (now, out)
    return out


# ---------------- 她留的那句话 ----------------

def _clean_note(text: str) -> str:
    text = (text or "").strip()
    for mark in ("```", "「", "」", "“", "”", '"', "'"):
        text = text.replace(mark, "")
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    text = lines[0] if lines else ""
    text = text.split("——")[0].strip()
    if len(text) > NOTE_MAX_CHARS:
        text = text[:NOTE_MAX_CHARS].rstrip("，。、 ") + "。"
    return text


async def write_note(chat_id: str, force: bool = False) -> dict[str, Any] | None:
    """让角色给「你」留一张便条，按天缓存。

    同一天已经写过就不再调模型（force=True 是设置页的「再写一张」）。
    失败静默返回 None，页面上那块就空着。
    """
    from .moments import _chat_context, _resolve_model  # 复用同一套挑模型 / 取上下文

    day = date.today().isoformat()
    with db.get_db() as conn:
        if not force:
            cached = db.get_home_note(conn, chat_id, day)
            if cached:
                return cached
        char_name, user_name, desc, body = _chat_context(conn, chat_id, limit=8)
        if not char_name:
            return None
        model, _err = _resolve_model(conn)
        if not model:
            return None
        provider_row = db.get_provider_row(conn, model.get("providerId") or "")
        provider = db.provider_json(provider_row) if provider_row else None
        from . import auth

        api_key = auth.provider_api_key(conn, model.get("providerId") or "")

    if not provider:
        return None

    system = NOTE_SYSTEM.format(char=char_name, user=user_name)
    parts: list[str] = []
    if desc:
        parts.append("你是：" + desc)
    if body:
        parts.append("最近发生过的事：\n" + body)
    parts.append("现在写那张便条。只写便条本身。")
    user_text = "\n\n".join(parts)

    prompt = {
        "segments": [
            {"role": "system", "text": system, "kind": "system", "label": "便条"},
            {"role": "user", "text": user_text, "kind": "current", "label": "最近"},
        ],
        "system_text": system,
        "sampling": {"temperature": 0.85, "max_tokens": 160},
        "text": system + "\n\n" + user_text,
        "meta": {},
    }
    try:
        result = await providers.complete(
            provider, model, prompt, api_key, reasoning_level="off", session_id=chat_id
        )
    except Exception as exc:  # noqa: BLE001
        LOG.warning("首页便条：生成失败（%s）", exc)
        return None

    text = _clean_note(result.get("text") or "")
    if len(text) < 4:
        LOG.info("首页便条：这次没写出有效的句子，留空")
        return None
    with db.get_db() as conn:
        saved = db.save_home_note(conn, chat_id, day, text)
    LOG.info("首页便条：%s 写了一句（%d 字）", char_name, len(text))
    return saved


# ---------------- 汇总 ----------------

async def payload(conn, character_id: str, chat_id: str, settings: dict[str, Any]) -> dict[str, Any]:
    """首页要的那几块。同步的立刻给，要联网的尽力给，拿不到就是 null。"""
    day = date.today()
    day_key = day.isoformat()

    memory = pick_memory(conn, character_id, day_key)

    note = None
    if chat_id and settings.get("homeNoteEnabled") is not False:
        note = db.get_home_note(conn, chat_id, day_key)

    weather = None
    city = str(settings.get("homeCity") or "").strip()
    if city:
        weather = await get_weather(city)

    days = birthday_days(str(settings.get("birthday") or ""), day)

    return {
        "day": day_key,
        "memory": memory,
        "note": note,
        "weather": weather,
        "birthday": None if days is None else {"days": days, "date": str(settings.get("birthday") or "")},
    }