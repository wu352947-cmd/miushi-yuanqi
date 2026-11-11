"""提供商：CRUD、Key（只进不出）、测试连接、拉模型、余额、导入导出。"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Body, Depends, Query

from .. import auth, db, model_family, providers as adapter, url_normalize
from ..errors import ApiError
from ..reasoning import default_level as reasoning_default_level, reasoning_levels
from .deps import get_conn

router = APIRouter(prefix="/api/providers", tags=["providers"])

BALANCE_TTL = 300  # 余额缓存 5 分钟


def _body_provider(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict) and isinstance(payload.get("provider"), dict):
        return payload["provider"]
    return payload if isinstance(payload, dict) else {}


def _get_or_404(conn, provider_id: str):
    row = db.get_provider_row(conn, provider_id)
    if not row:
        raise ApiError("notfound", "这家提供商已经不在列表里了。", status=404)
    return row


def _public(conn, row) -> dict[str, Any]:
    models = [db.model_json(m) for m in conn.execute("SELECT * FROM models WHERE provider_id = ? ORDER BY created_at ASC", (row["id"],)).fetchall()]
    return db.provider_json(row, {row["id"]: models})


def _key_for(conn, provider_id: str) -> str:
    return auth.provider_api_key(conn, provider_id)


def _require_key(conn, provider_id: str) -> str:
    key = _key_for(conn, provider_id)
    if not key and not adapter.mock_enabled():
        raise ApiError("nokey", "先到「我的 → 模型与提供商」里填写 API Key。", status=400)
    return key


@router.get("")
def list_providers(conn=Depends(get_conn)) -> dict:
    rows = conn.execute("SELECT * FROM providers ORDER BY created_at ASC").fetchall()
    return {"providers": [_public(conn, row) for row in rows]}


@router.get("/export")
def export_providers(
    includeApiKey: int = Query(0),
    id: str = Query(""),
    conn=Depends(get_conn),
) -> dict:
    rows = [_get_or_404(conn, id)] if id else conn.execute("SELECT * FROM providers ORDER BY created_at ASC").fetchall()
    provider_list = []
    model_ids: set[str] = set()
    for row in rows:
        item = _public(conn, row)
        if includeApiKey:
            plain = _key_for(conn, row["id"])
            item["apiKey"] = plain
        for model_id in item.get("models") or []:
            model_ids.add(model_id)
        provider_list.append(item)
    models = [
        db.model_json(r)
        for r in conn.execute("SELECT * FROM models ORDER BY created_at ASC").fetchall()
        if r["id"] in model_ids
    ]
    return {
        "app": "miushi-yuanqi",
        "kind": "providers",
        "version": 1,
        "exportedAt": db.now_iso(),
        "includeApiKey": bool(includeApiKey),
        "risk": "这份文件带着 API Key 的明文，只放在自己设备里，别发给别人。" if includeApiKey else "",
        "providers": provider_list,
        "models": models,
    }


@router.post("/import")
def import_providers(payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    raw = payload.get("payload") if isinstance(payload.get("payload"), dict) else payload
    provider_items = raw.get("providers") if isinstance(raw.get("providers"), list) else [raw] if raw.get("baseUrl") else []
    model_items = raw.get("models") if isinstance(raw.get("models"), list) else []
    if not provider_items:
        raise ApiError("badrequest", "读到了文件，但里面没有提供商。")
    now = db.now_iso()
    model_map: dict[str, str] = {}
    for model in model_items:
        if not isinstance(model, dict) or not model.get("id"):
            continue
        new_id = model["id"] if not db.get_model(conn, model["id"]) else db.new_id("model")
        item = dict(model)
        item["id"] = new_id
        item["source"] = "imported"
        model_map[model["id"]] = new_id
        db._upsert_model(conn, item, now)
    added = 0
    for provider in provider_items:
        if not isinstance(provider, dict) or not (provider.get("baseUrl") or provider.get("name")):
            continue
        item = dict(provider)
        item["id"] = provider["id"] if not db.get_provider_row(conn, provider.get("id") or "") else db.new_id("prv")
        item["name"] = _unique_name(conn, item.get("name") or "导入的提供商")
        item["source"] = "imported"
        item.pop("apiKey", None)  # 文件里的 Key 一律不接收
        item["models"] = [model_map.get(mid, mid) for mid in (provider.get("models") or []) if db.get_model(conn, model_map.get(mid, mid))]
        db._upsert_provider(conn, item, now)
        added += 1
    return {"ok": True, "imported": added, "models": len(model_map), "note": "文件里的 API Key 一律没有接收。"}


def _unique_name(conn, base: str) -> str:
    name = base
    index = 1
    while conn.execute("SELECT 1 FROM providers WHERE name = ?", (name,)).fetchone():
        index += 1
        name = base + "（" + str(index) + "）"
    return name


@router.post("")
def create_provider(payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    item = _body_provider(payload)
    if not item.get("name"):
        raise ApiError("badrequest", "先给这家提供商起个名字。")
    item = dict(item)
    item.setdefault("id", db.new_id("prv"))
    item.setdefault("source", "user")
    db._upsert_provider(conn, item, db.now_iso())
    return {"ok": True, "provider": _public(conn, _get_or_404(conn, item["id"]))}


@router.get("/{provider_id}")
def get_provider(provider_id: str, conn=Depends(get_conn)) -> dict:
    return {"provider": _public(conn, _get_or_404(conn, provider_id))}


@router.put("/{provider_id}")
def update_provider(provider_id: str, payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    row = _get_or_404(conn, provider_id)
    item = _body_provider(payload)
    item = dict(item)
    item["id"] = provider_id
    # Key 只能走 /key 接口：这里一律忽略任何 Key 字段
    for key in ("apiKey", "hasKey", "keyMasked"):
        item.pop(key, None)
    db._upsert_provider(conn, item, db.now_iso())
    return {"ok": True, "provider": _public(conn, _get_or_404(conn, provider_id))}


@router.delete("/{provider_id}")
def delete_provider(provider_id: str, conn=Depends(get_conn)) -> dict:
    _get_or_404(conn, provider_id)
    conn.execute("DELETE FROM providers WHERE id = ?", (provider_id,))
    conn.execute("DELETE FROM models WHERE provider_id = ?", (provider_id,))
    config = db.load_app_settings(conn)
    if config.get("modelId") and not db.get_model(conn, config["modelId"]):
        first = conn.execute("SELECT id FROM models ORDER BY created_at ASC LIMIT 1").fetchone()
        config["modelId"] = first["id"] if first else ""
        db.save_app_settings(conn, config)
    return {"ok": True}


@router.post("/{provider_id}/key")
def set_provider_key(provider_id: str, payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    _get_or_404(conn, provider_id)
    plain = str(payload.get("apiKey") or "").strip()
    has_key, masked = auth.store_key(conn, provider_id, plain)
    return {"ok": True, "hasKey": has_key, "keyMasked": masked}


@router.post("/{provider_id}/key/reveal")
def reveal_key(provider_id: str, conn=Depends(get_conn)) -> dict:
    """只回掩码：设计上不允许把完整 Key 回显给浏览器。"""
    row = _get_or_404(conn, provider_id)
    return {"hasKey": bool(row["api_key_enc"]), "keyMasked": row["api_key_mask"] or ""}


@router.post("/normalize-url")
def normalize_url(payload: dict = Body(default={})) -> dict:
    """网址 / 路径自动补全（纯函数，不发网络请求，保存前就能给界面提示）。"""
    result = url_normalize.normalize_provider(
        str(payload.get("baseUrl") or ""),
        str(payload.get("apiPath") or ""),
        str(payload.get("protocol") or "openai"),
    )
    return {
        "ok": True,
        **result,
        "candidates": url_normalize.models_candidates(result["baseUrl"], result["protocol"]),
    }


def _apply_forward_mode(provider: dict, advance: dict | None) -> list[dict]:
    """把前端高级设置里的转发方式写回 advanced。"""
    changes: list[dict] = []
    if not isinstance(advance, dict):
        return changes
    advanced = dict(provider.get("advanced") or {})
    mode = str(advance.get("forwardMode") or "").strip()
    if mode and mode != advanced.get("forwardMode"):
        advanced["forwardMode"] = mode
        changes.append(
            {
                "field": "forwardMode",
                "from": advanced.get("forwardMode") or "auto",
                "to": mode,
                "label": "转发方式已改为 " + mode,
            }
        )
    if "responseApi" in advance:
        advanced["responseApi"] = bool(advance.get("responseApi"))
    provider["advanced"] = advanced
    return changes


@router.post("/{provider_id}/save-connect")
async def save_connect(
    provider_id: str,
    payload: dict = Body(default={}),
    conn=Depends(get_conn),
) -> dict:
    """保存配置后自动连通：只走免费接口（模型列表 / 余额），绝不发生成请求。"""
    row = _get_or_404(conn, provider_id)
    provider = _public(conn, row)
    override = _body_provider(payload) if isinstance(payload.get("provider"), dict) else {}
    proxy_keys = ("name", "baseUrl", "apiPath", "protocol", "enabled", "icon")
    for key in proxy_keys:
        if key in override and override[key] is not None:
            provider[key] = override[key]
    advance = payload.get("advanced")
    changes: list[dict] = _apply_forward_mode(provider, advance)

    # a. 网址 / 路径自动补全
    norm = url_normalize.normalize_provider(
        str(provider.get("baseUrl") or ""),
        str(provider.get("apiPath") or ""),
        str(provider.get("protocol") or "openai"),
    )
    original_base = str(provider.get("baseUrl") or "")
    original_protocol = str(provider.get("protocol") or "openai")
    provider["baseUrl"] = norm["baseUrl"]
    provider["apiPath"] = norm["apiPath"]
    provider["protocol"] = norm["protocol"]
    changes = norm["changes"] + changes

    key = _key_for(conn, provider_id)
    need_key = not key and not adapter.mock_enabled()
    probe: dict[str, Any] = {"ok": False, "kind": "nokey", "message": "先填 API Key，再自动识别模型。", "ids": [], "url": "", "status": 0}
    connected = False
    if not need_key:
        # b/c. 只用 GET 模型列表接口识别格式并拉模型名单
        probe = await adapter.probe_models(provider, key)
        if probe.get("ok") and probe.get("ids"):
            connected = True
            # 只填域名时用能通的那个地址改写 Base URL
            probed_base = url_normalize.base_from_models_url(str(probe.get("url") or ""))
            if probed_base and probed_base.rstrip("/") != str(provider.get("baseUrl") or "").rstrip("/"):
                changes.append(
                    {
                        "field": "baseUrl",
                        "from": str(provider.get("baseUrl") or ""),
                        "to": probed_base,
                        "label": "已自动改为 " + probed_base,
                    }
                )
                provider["baseUrl"] = probed_base
            kind = str(probe.get("kind") or "")
            if kind in ("anthropic", "gemini") and provider.get("protocol") != kind:
                provider["protocol"] = kind
                changes.append(
                    {
                        "field": "protocol",
                        "from": str(provider.get("protocol") or ""),
                        "to": kind,
                        "label": "已自动识别为 " + ("Anthropic" if kind == "anthropic" else "Gemini") + " 格式",
                    }
                )
    provider["extras"] = dict(provider.get("extras") or {})
    provider["extras"]["autoConnect"] = {
        "at": db.now_iso(),
        "ok": connected,
        "modelCount": len(probe.get("ids") or []),
    }
    # 先保存配置：即使识别失败，配置也一直保存、可直接用
    db._upsert_provider(conn, provider, db.now_iso())

    models_out: list[dict] = []
    if connected:
        catalog = [db.model_json(r) for r in conn.execute("SELECT * FROM models").fetchall()]
        known_by_model_id: dict[str, dict] = {}
        for item in catalog:
            known_by_model_id.setdefault(str(item.get("modelId") or "").lower(), item)
        own = [db.model_json(r) for r in conn.execute("SELECT * FROM models WHERE provider_id = ?", (provider_id,)).fetchall()]
        own_by_model_id = {str(item.get("modelId") or "").lower(): item for item in own}
        model_ids: list[str] = []
        for model_id in probe.get("ids") or []:
            model_id = str(model_id).strip()
            if not model_id:
                continue
            known = known_by_model_id.get(model_id.lower())
            info = model_family.infer_model(model_id, known)
            existing = own_by_model_id.get(model_id.lower())
            info["id"] = existing["id"] if existing else db.new_id("model")
            info["providerId"] = provider_id
            db._upsert_model(conn, info, db.now_iso())
            model_ids.append(info["id"])
            stored = db.get_model(conn, info["id"])
            if stored:
                models_out.append(stored)
        provider["models"] = model_ids
        db._upsert_provider(conn, provider, db.now_iso())

    # e. 能查余额就查，查不到就不显示、不报错
    balance = None
    # 演示模式不查余额：避免把演示数字显示成真实余额
    if adapter.balance_supported(provider) and not adapter.mock_enabled():
        try:
            result = await adapter.query_balance(provider, key)
        except Exception:  # noqa: BLE001 - 余额失败不能影响保存
            result = {"supported": True, "amount": None}
        if result.get("amount") is not None and not result.get("failed"):
            stored_balance = {
                "supported": True,
                "amount": result.get("amount"),
                "currency": result.get("currency") or "¥",
                "at": result.get("at") or "",
                "failed": False,
                "failKind": "",
                "cachedAt": time.time(),
            }
            conn.execute(
                "UPDATE providers SET balance_json = ?, updated_at = ? WHERE id = ?",
                (db.jdumps(stored_balance), db.now_iso(), provider_id),
            )
            balance = {key: stored_balance[key] for key in ("supported", "amount", "currency", "at")}
        else:
            conn.execute(
                "UPDATE providers SET balance_json = ?, updated_at = ? WHERE id = ?",
                (db.jdumps({"amount": None, "currency": "¥", "failed": True, "cachedAt": time.time()}), db.now_iso(), provider_id),
            )

    model_count = len(models_out)
    if connected:
        message = "已连接，识别到 " + str(model_count) + " 个模型"
    elif need_key:
        message = "已保存，暂时无法自动识别模型，可手动添加，或点测试连接确认"
    else:
        message = "已保存，暂时无法自动识别模型，可手动添加，或点测试连接确认"
    response: dict[str, Any] = {
        "ok": connected,
        "saved": True,
        "connected": connected,
        "modelCount": model_count,
        "message": message,
        "provider": _public(conn, _get_or_404(conn, provider_id)),
        "models": models_out,
        "changes": changes,
        "probe": {
            "kind": probe.get("kind") or "",
            "url": str(probe.get("url") or ""),
            "status": int(probe.get("status") or 0),
            "ms": int(probe.get("ms") or 0),
            "ok": bool(probe.get("ok")),
        },
    }
    if balance:
        response["balance"] = balance
    if not connected and probe.get("message"):
        response["message"] = "已保存，" + str(probe["message"]).rstrip("。") + "，可手动添加，或点测试连接确认"
    return response


@router.post("/{provider_id}/test")
async def test_provider(provider_id: str, payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    row = _get_or_404(conn, provider_id)
    provider = _public(conn, row)
    key = _key_for(conn, provider_id)
    if not key and not adapter.mock_enabled():
        return {
            "ok": False,
            "kind": "nokey",
            "message": "先到「我的 → 模型与提供商」里填写 API Key，再测试连接。",
            "status": 0,
            "url": adapter.redact_url(adapter.models_url(provider)),
        }
    model_rows = [db.get_model(conn, mid) for mid in (provider.get("models") or [])]
    models = [m for m in model_rows if m]
    target_id = str(payload.get("modelId") or "")
    model = next((m for m in models if m["id"] == target_id), None)
    if not model and models:
        model = models[0]
    if not model:
        return {
            "ok": False,
            "kind": "nomodel",
            "message": "这家还没有模型：先拉取模型或手动添加一个，再测试连接。",
            "status": 0,
        }
    levels = reasoning_levels(model)
    level = reasoning_default_level(model)
    main = await adapter.test_generation(provider, model, key, level)
    reasoning_result: dict[str, Any] = {"checked": False, "results": []}
    if payload.get("checkReasoning") and levels:
        results = []
        for lv in levels:
            item = await adapter.test_generation(provider, model, key, lv)
            results.append(
                {
                    "level": lv,
                    "ok": bool(item.get("ok")),
                    "ms": int(item.get("ms") or 0),
                    "message": "" if item.get("ok") else str(item.get("message") or ""),
                }
            )
        reasoning_result = {"checked": True, "results": results}
    at = time.strftime("%m月%d日 %H:%M")
    response: dict[str, Any] = {
        "ok": bool(main.get("ok")),
        "kind": str(main.get("kind") or "ok"),
        "message": str(main.get("message") or ("测试连接成功：模型能正常回复。" if main.get("ok") else "没连上：检查网址和 Key，再试一次。")),
        "modelId": model.get("id"),
        "modelName": model.get("name"),
        "stream": True,
        "streamSupported": bool(main.get("streamSupported")),
        "reasoning": reasoning_result,
        "status": int(main.get("status") or (200 if main.get("ok") else 0)),
        "ms": int(main.get("ms") or 0),
        "at": at,
        "responseText": str(main.get("responseText") or "")[:80],
    }
    return response


@router.post("/{provider_id}/pull-models")
async def pull_provider_models(provider_id: str, conn=Depends(get_conn)) -> dict:
    row = _get_or_404(conn, provider_id)
    provider = _public(conn, row)
    key = _key_for(conn, provider_id)
    if not key and not adapter.mock_enabled():
        raise ApiError("nokey", "先到「我的 → 模型与提供商」里填写 API Key，再拉取模型。", status=400)
    return await adapter.pull_models(provider, key)


@router.post("/{provider_id}/balance")
async def provider_balance(provider_id: str, force: int = Query(0), conn=Depends(get_conn)) -> dict:
    row = _get_or_404(conn, provider_id)
    provider = _public(conn, row)
    if not adapter.balance_supported(provider):
        return {"supported": False, "amount": None, "currency": "¥", "at": "", "message": "这家不支持查询余额"}
    cached = provider.get("balance") or {}
    cached_at = float(cached.get("cachedAt") or 0)
    if not force and cached_at and time.time() - cached_at < BALANCE_TTL and (cached.get("amount") is not None or cached.get("failed")):
        return {"supported": True, **{key: cached.get(key) for key in ("amount", "currency", "at", "failed", "failKind")}, "cached": True}
    key = _key_for(conn, provider_id)
    if not key and not adapter.mock_enabled():
        return {"supported": True, "amount": None, "currency": "¥", "at": "", "failed": True, "failKind": "nokey", "message": "余额暂不可查"}
    result = await adapter.query_balance(provider, key)
    result["cachedAt"] = time.time()
    balance = {
        "supported": result.get("supported", True),
        "amount": result.get("amount"),
        "currency": result.get("currency") or "¥",
        "at": result.get("at") or "",
        "failed": bool(result.get("failed")),
        "failKind": result.get("failKind") or "",
        "cachedAt": result["cachedAt"],
    }
    conn.execute(
        "UPDATE providers SET balance_json = ?, updated_at = ? WHERE id = ?",
        (db.jdumps(balance), db.now_iso(), provider_id),
    )
    return result
