"""提供商：CRUD、Key（只进不出）、测试连接、拉模型、余额、导入导出。"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Body, Depends, Query

from .. import auth, db, providers as adapter
from ..errors import ApiError
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
    return await adapter.test_connection(provider, key)


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
