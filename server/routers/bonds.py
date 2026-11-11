"""关系（bonds）：一段关系 = 用户设定 × 角色。

记忆按 (persona, character) 隔离之后，「我有几段关系、每段多少条记忆」
需要一个能直接取的地方 —— 就是这个接口。
"""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends

from .. import db
from ..errors import ApiError
from .deps import get_conn

router = APIRouter(prefix="/api/bonds", tags=["bonds"])


def _memory_counts(conn) -> dict[tuple[str, str], int]:
    rows = conn.execute(
        "SELECT character_id, persona_id, COUNT(*) AS n FROM memories "
        "WHERE kind = 'note' AND status != 'forgotten' "
        "GROUP BY character_id, persona_id"
    ).fetchall()
    return {(r["character_id"], r["persona_id"]): r["n"] for r in rows}


@router.get("")
def list_bonds(conn=Depends(get_conn)) -> dict:
    personas = {
        p["id"]: p
        for p in (
            db.persona_json(r)
            for r in conn.execute("SELECT * FROM user_personas ORDER BY created_at ASC").fetchall()
        )
    }
    chars = {
        c["id"]: c
        for c in (
            db.character_json(r)
            for r in conn.execute("SELECT * FROM characters ORDER BY created_at ASC").fetchall()
        )
    }
    counts = _memory_counts(conn)

    items = []
    for row in db.list_bonds(conn):
        bond = db.bond_json(row)
        bond["personaName"] = (personas.get(bond["personaId"]) or {}).get("name") or "未指定设定"
        bond["characterName"] = (chars.get(bond["characterId"]) or {}).get("name") or "已删除的角色"
        bond["memoryCount"] = counts.get((bond["characterId"], bond["personaId"]), 0)
        items.append(bond)

    world = conn.execute(
        "SELECT COUNT(*) AS n FROM memories "
        "WHERE kind = 'note' AND scope = 'world' AND status != 'forgotten'"
    ).fetchone()["n"]
    return {"bonds": items, "worldCount": world}


@router.put("/{bond_id}")
def update_bond(bond_id: str, payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    row = conn.execute("SELECT * FROM bonds WHERE id = ?", (bond_id,)).fetchone()
    if not row:
        raise ApiError("notfound", "这段关系已经不在了。", status=404)

    patch: dict[str, str] = {}
    if "startedAt" in payload:
        patch["started_at"] = str(payload.get("startedAt") or "")
    if "nickname" in payload:
        patch["nickname"] = str(payload.get("nickname") or "")
    if "note" in payload:
        patch["note"] = str(payload.get("note") or "")
    if patch:
        sets = ", ".join(key + " = ?" for key in patch)
        conn.execute(
            "UPDATE bonds SET " + sets + ", updated_at = ? WHERE id = ?",
            (*patch.values(), db.now_iso(), bond_id),
        )
    fresh = conn.execute("SELECT * FROM bonds WHERE id = ?", (bond_id,)).fetchone()
    return {"ok": True, "bond": db.bond_json(fresh)}