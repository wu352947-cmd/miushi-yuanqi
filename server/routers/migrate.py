"""从浏览器 localStorage 一次性迁移（幂等：按 id 去重）。"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from .. import db
from ..schemas import MigrateIn
from .deps import get_conn

router = APIRouter(prefix="/api/migrate", tags=["migrate"])


@router.get("/status")
def status(conn=Depends(get_conn)) -> dict:
    config = db.load_app_settings(conn)
    return {
        "migrated": bool(config.get("migratedAt")),
        "migratedAt": config.get("migratedAt") or "",
        "counts": {
            "characters": conn.execute("SELECT COUNT(*) AS n FROM characters").fetchone()["n"],
            "chats": conn.execute("SELECT COUNT(*) AS n FROM chats").fetchone()["n"],
            "memories": conn.execute("SELECT COUNT(*) AS n FROM memories WHERE kind = 'note'").fetchone()["n"],
        },
    }


@router.post("/local")
def migrate_local(payload: MigrateIn, conn=Depends(get_conn)) -> dict:
    include_keys = payload.includeApiKeys or bool(payload.includeKeys)
    result = db.migrate_local_state(conn, payload.state, include_keys=include_keys)
    config = db.load_app_settings(conn)
    config["migratedAt"] = db.now_iso()
    db.save_app_settings(conn, config)
    return {
        "ok": True,
        "imported": result,
        "includeApiKeys": include_keys,
        "message": "迁移完成。浏览器里的明文 Key 可以清掉了。",
    }
