"""整体状态：启动快照（bootstrap）与整体同步（state）。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from .. import auth, db, usage
from ..schemas import SettingsIn, StateIn
from .deps import get_conn

router = APIRouter(prefix="/api", tags=["state"])


@router.get("/bootstrap")
def bootstrap(request: Request, conn=Depends(get_conn)) -> dict:
    state = db.get_state(conn)
    return {
        "server": {
            "app": "miushi-yuanqi",
            "version": "0.1.0",
            "authRequired": auth.auth_required(),
            "devMode": auth.dev_mode(),
            "mockModel": _mock(),
            "dbPath": str(db.db_path()),
            "dataDir": str(db.data_dir()),
        },
        "user": {"name": auth.user_name()},
        "state": state,
        "usage": usage.usage_summary(conn),
    }


def _mock() -> bool:
    from .. import providers

    return providers.mock_enabled()


@router.put("/state")
def sync_state(payload: StateIn, conn=Depends(get_conn)) -> dict:
    if not payload.state:
        return {"ok": False, "message": "没有收到状态。"}
    db.sync_state(conn, payload.state)
    return {"ok": True, "syncedAt": db.now_iso()}


@router.get("/settings")
def get_settings(conn=Depends(get_conn)) -> dict:
    return {"settings": db.load_app_settings(conn)}


@router.put("/settings")
def put_settings(payload: SettingsIn, conn=Depends(get_conn)) -> dict:
    config = db.load_app_settings(conn)
    incoming = payload.settings or {}
    for key in ("theme", "overrides", "listen", "backupAt", "modelId", "currentCharacterId"):
        if key in incoming:
            config[key] = incoming[key]
    if isinstance(incoming.get("settings"), dict):
        config["settings"].update(incoming["settings"])
    db.save_app_settings(conn, config)
    return {"ok": True, "settings": config}
