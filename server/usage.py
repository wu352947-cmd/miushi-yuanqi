"""usage 记录与统计汇总。

每次回复由后端写一条 usage（时间、聊天、角色、提供商、模型、各类 token、耗时、
是否出错、是否估算、是否走过思考参数兜底）；统计页所有数字都从这张表汇总，
浏览器不再累加权威数据。
"""

from __future__ import annotations

import os
import time
from datetime import datetime, timedelta
from typing import Any

from . import db

RANGES = {
    "today": "今天",
    "7d": "7 天",
    "30d": "30 天",
    "90d": "90 天",
    "all": "全部",
}


def currency_rate() -> float:
    try:
        return float(os.environ.get("CURRENCY_USD_CNY") or 7.1)
    except (TypeError, ValueError):
        return 7.1


def record_usage(conn, **fields: Any) -> int:
    cur = conn.execute(
        "INSERT INTO usage (at, conversation_id, character_id, provider_id, model_id, model_key, model_name, "
        "prompt_tokens, cache_tokens, cache_write_tokens, output_tokens, reasoning_tokens, duration_ms, first_token_ms, ok, error_kind, estimated, fallback_reasoning, kind) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            fields.get("at") or db.now_iso(),
            fields.get("conversation_id") or "",
            fields.get("character_id") or "",
            fields.get("provider_id") or "",
            fields.get("model_id") or "",
            fields.get("model_key") or "",
            fields.get("model_name") or "",
            db._int(fields.get("prompt_tokens"), 0),
            db._int(fields.get("cache_tokens"), 0),
            db._int(fields.get("cache_write_tokens"), 0),
            db._int(fields.get("output_tokens"), 0),
            db._int(fields.get("reasoning_tokens"), 0),
            db._int(fields.get("duration_ms"), 0),
            db._int(fields.get("first_token_ms"), 0),
            db._bool(fields.get("ok", True)),
            fields.get("error_kind") or None,
            db._bool(fields.get("estimated")),
            db._bool(fields.get("fallback_reasoning")),
            fields.get("kind") or "chat",
        ),
    )
    return int(cur.lastrowid or 0)


def _models(conn) -> dict[str, dict[str, Any]]:
    return {m["id"]: m for m in (db.model_json(r) for r in conn.execute("SELECT * FROM models").fetchall())}


def _is_peak(at: datetime | None = None) -> bool:
    """DeepSeek 峰谷：北京时间周一至周五 9:00–12:00、14:00–18:00；法定节假日表本轮先不做。"""
    at = at or datetime.now()
    if at.weekday() >= 5:
        return False
    minutes = at.hour * 60 + at.minute
    return (9 * 60 <= minutes < 12 * 60) or (14 * 60 <= minutes < 18 * 60)


def _price_table(price: dict[str, Any], at: datetime | None) -> dict[str, Any]:
    if isinstance(price.get("peak"), dict) and isinstance(price.get("offpeak"), dict):
        return price["peak"] if _is_peak(at) else price["offpeak"]
    return price


def _cost(
    prompt: int, cache: int, output: int, model: dict[str, Any] | None, rate: float,
    cache_write: int = 0, at: datetime | None = None,
) -> tuple[float, bool]:
    price = (model or {}).get("price")
    if not price:
        return 0.0, False
    table = _price_table(price, at)
    factor = rate if price.get("currency") == "$" else 1.0
    cached = max(0, min(cache, prompt))
    write = max(0, cache_write)
    uncached = max(0, prompt - cached)
    write_price = table.get("cacheWrite")
    if write_price is None:
        write_price = float(table.get("input") or 0) * 1.25
    cost = (
        uncached * float(table.get("input") or 0)
        + cached * float(table.get("cache") or table.get("input") or 0)
        + write * float(write_price or 0)
        + output * float(table.get("output") or 0)
    ) / 1_000_000 * factor
    return cost, True


def _rows(conn, start: datetime | None) -> list[dict[str, Any]]:
    if start is None:
        rows = conn.execute("SELECT * FROM usage ORDER BY at ASC, id ASC").fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM usage WHERE at >= ? ORDER BY at ASC, id ASC",
            (start.strftime("%Y-%m-%dT%H:%M:%S"),),
        ).fetchall()
    return [dict(r) for r in rows]


def range_start(range_key: str) -> datetime | None:
    now = datetime.now()
    today = datetime(now.year, now.month, now.day)
    if range_key == "today":
        return today
    if range_key == "7d":
        return today - timedelta(days=6)
    if range_key == "30d":
        return today - timedelta(days=29)
    if range_key == "90d":
        return today - timedelta(days=89)
    return None


def _day_key(value: datetime) -> str:
    return value.strftime("%Y-%m-%d")


def _month_key(value: datetime) -> str:
    return value.strftime("%Y-%m")


def _parse_at(text: str) -> datetime:
    try:
        return datetime.strptime(text, "%Y-%m-%dT%H:%M:%S")
    except (TypeError, ValueError):
        return datetime.now()


def _overview(rows: list[dict[str, Any]], models: dict[str, dict[str, Any]], rate: float) -> dict[str, Any]:
    prompt = cache = output = duration = 0
    reasoning = cache_write = 0
    errors = estimated = 0
    cost = 0.0
    unpriced: set[str] = set()
    for row in rows:
        prompt += int(row["prompt_tokens"] or 0)
        cache += int(row["cache_tokens"] or 0)
        if "cache_write_tokens" in row.keys():
            cache_write += int(row["cache_write_tokens"] or 0)
        output += int(row["output_tokens"] or 0)
        if "reasoning_tokens" in row.keys():
            reasoning += int(row["reasoning_tokens"] or 0)
        duration += int(row["duration_ms"] or 0)
        if not row["ok"]:
            errors += 1
        if row["estimated"]:
            estimated += 1
        item_cost, priced = _cost(
            int(row["prompt_tokens"] or 0), int(row["cache_tokens"] or 0), int(row["output_tokens"] or 0),
            models.get(row["model_id"]), rate,
            int(row["cache_write_tokens"] or 0) if "cache_write_tokens" in row.keys() else 0,
            _parse_at(row["at"]),
        )
        cost += item_cost
        if not priced:
            unpriced.add(row["model_id"] or "未标记")
    count = len(rows)
    return {
        "prompt": prompt,
        "cache": cache,
        "output": output,
        "reasoning": reasoning,
        "cacheWrite": cache_write,
        "totalTokens": prompt + output,
        "count": count,
        "errors": errors,
        "estimatedCount": estimated,
        "avgMs": (duration / count) if count else 0,
        "hitRate": (cache / prompt) if prompt else 0.0,
        "cost": round(cost, 6),
        "unpricedCount": len(unpriced) if count else 0,
        "currencyRate": rate,
    }


def _chart(rows: list[dict[str, Any]], range_key: str, models: dict[str, dict[str, Any]], rate: float, metric: str) -> dict[str, Any]:
    now = datetime.now()
    today = datetime(now.year, now.month, now.day)
    if range_key == "today":
        buckets = [
            {"key": "h" + str(h), "label": (str(h) + "时") if h in (0, 6, 12, 18) else "", "prompt": 0, "cache": 0, "output": 0, "cost": 0.0, "count": 0}
            for h in range(24)
        ]
        mode = "hour"
        for row in rows:
            at = _parse_at(row["at"])
            bucket = buckets[at.hour]
            _bump(bucket, row, models, rate)
    elif range_key == "all":
        months = sorted({_month_key(_parse_at(row["at"])) for row in rows})
        if not months:
            months = [_month_key(now)]
        buckets = [
            {"key": key, "label": str(int(key[5:])) + "月", "prompt": 0, "cache": 0, "output": 0, "cost": 0.0, "count": 0}
            for key in months
        ]
        mode = "month"
        index = {b["key"]: b for b in buckets}
        for row in rows:
            bucket = index.get(_month_key(_parse_at(row["at"])))
            if bucket:
                _bump(bucket, row, models, rate)
    else:
        days = 90 if range_key == "90d" else 30 if range_key == "30d" else 7
        buckets = []
        for offset in range(days - 1, -1, -1):
            day = today - timedelta(days=offset)
            buckets.append(
                {"key": _day_key(day), "label": day.strftime("%m/%d"), "prompt": 0, "cache": 0, "output": 0, "cost": 0.0, "count": 0}
            )
        mode = "day"
        index = {b["key"]: b for b in buckets}
        for row in rows:
            bucket = index.get(_day_key(_parse_at(row["at"])))
            if bucket:
                _bump(bucket, row, models, rate)
    for bucket in buckets:
        bucket["value"] = bucket["cost"] if metric == "cost" else bucket["prompt"] + bucket["cache"] + bucket["output"]
        bucket["cost"] = round(bucket["cost"], 4)
    return {"mode": mode, "buckets": buckets}


def _bump(bucket: dict[str, Any], row: dict[str, Any], models: dict[str, dict[str, Any]], rate: float) -> None:
    prompt = int(row["prompt_tokens"] or 0)
    cache_token = int(row["cache_tokens"] or 0)
    output = int(row["output_tokens"] or 0)
    bucket["prompt"] += prompt
    bucket["cache"] += cache_token
    bucket["output"] += output
    bucket["count"] += 1
    item_cost, _priced = _cost(
        prompt, cache_token, output, models.get(row["model_id"]), rate,
        int(row["cache_write_tokens"] or 0) if "cache_write_tokens" in row.keys() else 0,
        _parse_at(row["at"]),
    )
    bucket["cost"] += item_cost


def _heatmap(conn) -> dict[str, Any]:
    today = datetime.now()
    today = datetime(today.year, today.month, today.day)
    start = today - timedelta(days=364)
    start = start - timedelta(days=(start.weekday() + 1) % 7)  # 对齐周日（前端从周日开始）
    counts: dict[str, int] = {}
    for row in conn.execute("SELECT at FROM usage").fetchall():
        key = _day_key(_parse_at(row["at"]))
        counts[key] = counts.get(key, 0) + 1
    max_count = max(counts.values()) if counts else 0
    day_count = (today - start).days + 1
    total_cells = ((day_count + 6) // 7) * 7
    cells = []
    for index in range(total_cells):
        day = start + timedelta(days=index)
        count = counts.get(_day_key(day), 0)
        level = 0
        if count > 0 and day <= today:
            if count >= max(5, -(-max_count * 3 // 4)):
                level = 4
            elif count >= max(3, -(-max_count // 2)):
                level = 3
            elif count >= 2:
                level = 2
            else:
                level = 1
        cells.append({"date": _day_key(day), "count": count, "level": level if day <= today else 0})
    return {"start": _day_key(start), "cells": cells}


def _rank(conn, rows: list[dict[str, Any]], models: dict[str, dict[str, Any]], rate: float, tab: str) -> dict[str, Any]:
    total = 0
    grouped: dict[str, dict[str, Any]] = {}
    for row in rows:
        key = row["provider_id"] if tab == "provider" else row["character_id"] if tab == "char" else row["model_id"]
        key = key or "未标记"
        tokens = int(row["prompt_tokens"] or 0) + int(row["output_tokens"] or 0)
        item = grouped.setdefault(key, {"key": key, "tokens": 0, "count": 0, "cost": 0.0})
        item["tokens"] += tokens
        item["count"] += 1
        item_cost, _p = _cost(
            int(row["prompt_tokens"] or 0), int(row["cache_tokens"] or 0), int(row["output_tokens"] or 0),
            models.get(row["model_id"]), rate,
            int(row["cache_write_tokens"] or 0) if "cache_write_tokens" in row.keys() else 0,
            _parse_at(row["at"]),
        )
        item["cost"] += item_cost
        total += tokens
    if tab == "provider":
        names = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM providers").fetchall()}
    elif tab == "char":
        names = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM characters").fetchall()}
    else:
        names = {key: value.get("name") or key for key, value in models.items()}
        names.update({r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM models").fetchall()})
    items = []
    for key, item in grouped.items():
        item["label"] = names.get(key) or "未标记"
        item["pct"] = (item["tokens"] / total * 100) if total else 0.0
        item["cost"] = round(item["cost"], 4)
        items.append(item)
    items.sort(key=lambda item: item["tokens"], reverse=True)
    return {"tab": tab, "items": items[:8]}


def _balance(conn, rate: float) -> list[dict[str, Any]]:
    out = []
    for row in conn.execute("SELECT * FROM providers ORDER BY created_at ASC").fetchall():
        provider = db.provider_json(row)
        supported = provider.get("protocol") in ("deepseek", "openrouter")
        balance = provider.get("balance") or {}
        out.append(
            {
                "providerId": provider["id"],
                "name": provider["name"],
                "icon": provider.get("icon") or "",
                "supported": supported,
                "amount": balance.get("amount"),
                "currency": balance.get("currency") or ("$" if provider.get("protocol") == "openrouter" else "¥"),
                "at": balance.get("at") or "",
                "failed": bool(balance.get("failed")),
                "failKind": balance.get("failKind") or "",
            }
        )
    return out


def _days_together(conn) -> int:
    config = db.load_app_settings(conn)
    start_date = (config.get("settings") or {}).get("startDate") or "2024-11-08"
    try:
        start = datetime.strptime(start_date, "%Y-%m-%d")
    except (TypeError, ValueError):
        start = datetime(2024, 11, 8)
    today = datetime.now()
    return max(1, (datetime(today.year, today.month, today.day) - start).days + 1)


def get_stats(conn, range_key: str = "7d", metric: str = "token", rank: str = "model") -> dict[str, Any]:
    if range_key not in RANGES:
        range_key = "7d"
    if metric not in ("token", "cost"):
        metric = "token"
    if rank not in ("model", "provider", "char"):
        rank = "model"
    rate = currency_rate()
    models = _models(conn)
    start = range_start(range_key)
    rows = _rows(conn, start)
    overview = _overview(rows, models, rate)
    conversations = conn.execute(
        "SELECT COUNT(DISTINCT chat_id) AS n FROM messages"
    ).fetchone()["n"]
    messages = conn.execute("SELECT COUNT(*) AS n FROM messages").fetchone()["n"]
    return {
        "range": range_key,
        "rangeLabel": RANGES[range_key],
        "overview": overview,
        "heatmap": _heatmap(conn),
        "chart": _chart(rows, range_key, models, rate, metric),
        "rank": _rank(conn, rows, models, rate, rank),
        "balance": _balance(conn, rate),
        "lite": {
            "conversations": int(conversations or 0),
            "messages": int(messages or 0),
            "daysTogether": _days_together(conn),
        },
        "meta": {
            "currencyRate": rate,
            "note": "数据来自 SQLite 的 usage 表；estimated 的记录表示拿不到 usage 时按字数估算。",
        },
    }


def usage_summary(conn) -> dict[str, Any]:
    """首页 / 我的页的用量卡：今日、本月、近七日柱状。"""
    now = datetime.now()
    today = datetime(now.year, now.month, now.day)
    month_start = datetime(now.year, now.month, 1)
    today_rows = _rows(conn, today)
    month_rows = _rows(conn, month_start)
    days = []
    labels = []
    for offset in range(6, -1, -1):
        day = today - timedelta(days=offset)
        rows = _rows(conn, day)
        rows = [r for r in rows if _parse_at(r["at"]).date() == day.date()]
        days.append(sum(int(r["prompt_tokens"] or 0) + int(r["output_tokens"] or 0) for r in rows))
        labels.append(["一", "二", "三", "四", "五", "六", "日"][(day.weekday())])
    return {
        "today": sum(int(r["prompt_tokens"] or 0) + int(r["output_tokens"] or 0) for r in today_rows),
        "month": sum(int(r["prompt_tokens"] or 0) + int(r["output_tokens"] or 0) for r in month_rows),
        "todayCount": len(today_rows),
        "monthCount": len(month_rows),
        "bars": days,
        "barLabels": labels,
    }
