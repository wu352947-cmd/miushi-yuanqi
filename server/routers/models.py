"""模型 CRUD 与收藏。"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Body, Depends

from .. import db, providers, reasoning
from ..errors import ApiError
from .deps import get_conn

router = APIRouter(prefix="/api/models", tags=["models"])


def _body_model(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict) and isinstance(payload.get("model"), dict):
        return payload["model"]
    return payload if isinstance(payload, dict) else {}


def _get_or_404(conn, model_id: str):
    item = db.get_model(conn, model_id)
    if not item:
        raise ApiError("notfound", "这个模型已经不在列表里了。", status=404)
    return item


@router.get("")
def list_models(conn=Depends(get_conn)) -> dict:
    rows = conn.execute("SELECT * FROM models ORDER BY created_at ASC").fetchall()
    return {"models": [db.model_json(r) for r in rows]}


@router.post("")
def create_model(payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    item = _body_model(payload)
    if not item.get("providerId"):
        raise ApiError("badrequest", "模型需要属于一家提供商。")
    item = dict(item)
    item.setdefault("id", db.new_id("model"))
    if not db.get_provider_row(conn, item["providerId"]):
        raise ApiError("notfound", "这家提供商已经不在列表里了。", status=404)
    db._upsert_model(conn, item, db.now_iso())
    return {"ok": True, "model": db.get_model(conn, item["id"])}


@router.get("/{model_id}/reasoning-preview")
def reasoning_preview(model_id: str, level: str = "", conn=Depends(get_conn)) -> dict:
    """这个模型在指定档位下会带什么思考参数。

    唯一事实来源是 server/reasoning.py；前端只做展示，不再自己算一套映射，
    避免前后端慢慢漂移（前端那份已删除）。
    """
    model = _get_or_404(conn, model_id)
    provider = db.get_provider(conn, str(model.get("providerId") or "")) or {}
    protocol = providers.protocol_of(provider)
    built = reasoning.build_reasoning_params(model, level or None, protocol)
    params = built.get("params")
    text = (
        json.dumps(params, ensure_ascii=False, indent=2)
        if params
        else str(built.get("note") or "这次请求不带思考参数")
    )
    return {"reasoning": built, "text": text, "protocol": protocol}


@router.get("/{model_id}")
def get_model(model_id: str, conn=Depends(get_conn)) -> dict:
    return {"model": _get_or_404(conn, model_id)}


@router.put("/{model_id}")
def update_model(model_id: str, payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    current = _get_or_404(conn, model_id)
    item = _body_model(payload)
    item = dict(item)
    item["id"] = model_id
    item.setdefault("providerId", current["providerId"])
    db._upsert_model(conn, item, db.now_iso())
    return {"ok": True, "model": db.get_model(conn, model_id)}


@router.delete("/{model_id}")
def delete_model(model_id: str, conn=Depends(get_conn)) -> dict:
    _get_or_404(conn, model_id)
    conn.execute("DELETE FROM models WHERE id = ?", (model_id,))
    config = db.load_app_settings(conn)
    if config.get("modelId") == model_id:
        first = conn.execute("SELECT id FROM models ORDER BY created_at ASC LIMIT 1").fetchone()
        config["modelId"] = first["id"] if first else ""
        db.save_app_settings(conn, config)
    return {"ok": True}


@router.post("/{model_id}/favorite")
def favorite_model(model_id: str, payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    _get_or_404(conn, model_id)
    conn.execute(
        "UPDATE models SET favorite = ?, updated_at = ? WHERE id = ?",
        (db._bool(payload.get("favorite")), db.now_iso(), model_id),
    )
    return {"ok": True, "model": db.get_model(conn, model_id)}
