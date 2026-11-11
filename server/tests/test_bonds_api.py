"""bonds 接口：关系列表（带记忆条数）与「在一起」开始日期。"""
from __future__ import annotations

from server import db, memory


def _add(title, body, char, persona, scope="pair"):
    with db.get_db() as conn:
        return memory.create_memory(
            conn,
            {
                "title": title,
                "body": body,
                "scope": scope,
                "characterId": char,
                "personaId": persona,
            },
        )


def test_list_bonds_starts_empty(client):
    data = client.get("/api/bonds").json()
    assert data["bonds"] == []
    assert data["worldCount"] == 0


def test_bond_reports_only_its_own_memories(client):
    with db.get_db() as conn:
        db.ensure_bond(conn, "persona-wu", "miao", "2024-11-08")
    _add("a", "x", "miao", "persona-wu")
    _add("b", "y", "miao", "persona-wu")
    _add("c", "z", "qi", "persona-wu")

    data = client.get("/api/bonds").json()
    assert len(data["bonds"]) == 1
    bond = data["bonds"][0]
    assert bond["memoryCount"] == 2
    assert bond["startedAt"] == "2024-11-08"
    assert bond["characterName"]
    assert bond["personaName"]


def test_world_count_is_separate(client):
    _add("福州入秋多雨", "十月的福州几乎天天下雨。", "", "", scope="world")
    _add("你怕冷", "芴怕冷。", "miao", "persona-wu")

    data = client.get("/api/bonds").json()
    assert data["worldCount"] == 1


def test_update_started_at_and_nickname(client):
    with db.get_db() as conn:
        bond = db.ensure_bond(conn, "persona-wu", "miao")
        bond_id = bond["id"]

    resp = client.put("/api/bonds/" + bond_id, json={"startedAt": "2025-01-01", "nickname": "阿芴"})
    assert resp.status_code == 200
    fresh = resp.json()["bond"]
    assert fresh["startedAt"] == "2025-01-01"
    assert fresh["nickname"] == "阿芴"

    # 再取一次列表，确认落库
    listed = client.get("/api/bonds").json()["bonds"][0]
    assert listed["startedAt"] == "2025-01-01"


def test_update_unknown_bond_returns_404(client):
    resp = client.put("/api/bonds/nope", json={"startedAt": "2025-01-01"})
    assert resp.status_code == 404