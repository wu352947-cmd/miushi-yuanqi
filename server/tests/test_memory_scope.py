"""记忆按关系隔离：pair / character / world 三层，外加 now 卡与去重。

最关键的一条：同一个角色 + 两个用户设定 = 两段不同的关系，
记忆不能互相看见（这是这类产品最容易被忽略的串台）。
"""
from __future__ import annotations

import pytest

from server import db, memory


# ---------------------------------------------------------------- 小工具
def _add(title, body, char="", persona="", scope="pair", **extra):
    with db.get_db() as conn:
        return memory.create_memory(
            conn,
            {
                "title": title,
                "body": body,
                "scope": scope,
                "characterId": char,
                "personaId": persona,
                **extra,
            },
        )


def _titles(char="", persona="", **extra):
    with db.get_db() as conn:
        return [m["title"] for m in memory.list_memories(conn, character_id=char, persona_id=persona, **extra)]


# ---------------------------------------------------------------- 隔离：关系对
def test_pair_memory_hidden_from_other_persona(client):
    _add("你怕冷", "芴一到冬天就手脚冰凉。", char="miao", persona="persona-wu")
    _add("你爱跑步", "岑每天早上跑五公里。", char="miao", persona="persona-cen")

    assert _titles(char="miao", persona="persona-wu") == ["你怕冷"]
    assert _titles(char="miao", persona="persona-cen") == ["你爱跑步"]


def test_pair_memory_hidden_from_other_character(client):
    _add("你怕冷", "芴一到冬天就手脚冰凉。", char="miao", persona="persona-wu")

    assert _titles(char="qi", persona="persona-wu") == []


def test_character_memory_visible_to_all_its_pairs_only(client):
    _add("她讨厌下雨", "缪诗一到阴天就没什么精神。", char="miao", persona="", scope="character")

    assert _titles(char="miao", persona="persona-wu") == ["她讨厌下雨"]
    assert _titles(char="miao", persona="persona-cen") == ["她讨厌下雨"]
    assert _titles(char="qi", persona="persona-wu") == []


def test_world_memory_visible_everywhere(client):
    _add("福州入秋多雨", "十月的福州几乎天天下雨。", scope="world")

    assert _titles(char="miao", persona="persona-wu") == ["福州入秋多雨"]
    assert _titles(char="qi", persona="persona-cen") == ["福州入秋多雨"]
    assert "福州入秋多雨" in _titles()


def test_list_by_character_shows_all_its_pairs(client):
    _add("你怕冷", "……", char="miao", persona="persona-wu")
    _add("你爱跑步", "……", char="miao", persona="persona-cen")
    _add("别人的事", "……", char="qi", persona="persona-wu")

    titles = _titles(char="miao", persona="")
    assert set(titles) == {"你怕冷", "你爱跑步"}


def test_no_filter_returns_everything(client):
    _add("你怕冷", "……", char="miao", persona="persona-wu")
    _add("你爱跑步", "……", char="qi", persona="persona-cen")

    assert {"你怕冷", "你爱跑步"} <= set(_titles())


# ---------------------------------------------------------------- 提示词注入
def test_pinned_for_prompt_isolated(client):
    _add("你怕冷", "……", char="miao", persona="persona-wu", pinned=True)
    _add("你爱跑步", "……", char="qi", persona="persona-wu", pinned=True)

    with db.get_db() as conn:
        miao = memory.pinned_for_prompt(conn, character_id="miao", persona_id="persona-wu")
        qi = memory.pinned_for_prompt(conn, character_id="qi", persona_id="persona-wu")

    assert [m["title"] for m in miao] == ["你怕冷"]
    assert [m["title"] for m in qi] == ["你爱跑步"]


def test_pinned_skips_forgotten(client):
    _add("你怕冷", "……", char="miao", persona="persona-wu", pinned=True)
    with db.get_db() as conn:
        mid = conn.execute("SELECT id FROM memories WHERE title = '你怕冷'").fetchone()["id"]
        memory.set_status(conn, mid, "forgotten")
        rows = memory.pinned_for_prompt(conn, character_id="miao", persona_id="persona-wu")
    assert rows == []


# ---------------------------------------------------------------- 现在卡
def test_now_card_per_relationship(client):
    with db.get_db() as conn:
        memory.set_now(conn, "缪诗这边：图书馆三楼，雨刚停。", "miao", "persona-wu")
        memory.set_now(conn, "阿杞这边：操场上风很大。", "qi", "persona-wu")

        assert memory.now_card(conn, "miao", "persona-wu")["body"] == "缪诗这边：图书馆三楼，雨刚停。"
        assert memory.now_card(conn, "qi", "persona-wu")["body"] == "阿杞这边：操场上风很大。"


def test_now_card_never_falls_back_to_other_relationship(client):
    """空参数只能拿到世界层，不能拿到某个角色的 now。"""
    with db.get_db() as conn:
        memory.set_now(conn, "缪诗这边：图书馆三楼。", "miao", "persona-wu")
        world = memory.now_card(conn)
        own = memory.now_card(conn, "miao", "persona-wu")
    assert own["body"] == "缪诗这边：图书馆三楼。"
    assert world["body"] != own["body"]


def test_set_now_updates_same_relationship_only(client):
    with db.get_db() as conn:
        memory.set_now(conn, "第一版", "miao", "persona-wu")
        memory.set_now(conn, "第二版", "miao", "persona-wu")
        rows = conn.execute(
            "SELECT body FROM memories WHERE kind = 'now' AND character_id = 'miao'"
        ).fetchall()
    assert [r["body"] for r in rows] == ["第二版"]


# ---------------------------------------------------------------- 写入字段
def test_create_memory_records_scope_fields(client):
    item = _add("你怕冷", "……", char="miao", persona="persona-wu", scope="pair")
    assert item["scope"] == "pair"
    assert item["characterId"] == "miao"
    assert item["personaId"] == "persona-wu"


def test_invalid_scope_falls_back_to_pair(client):
    item = _add("随便", "……", char="miao", persona="persona-wu", scope="乱写的")
    assert item["scope"] == "pair"


# ---------------------------------------------------------------- 孤儿记忆
def test_orphan_memory_hidden_but_counts_for_dedupe(client):
    """没归属的记忆不显示在任何一段关系里，但去重时要算「已经有了」。"""
    _add("怕冷", "她一降温就手脚冰凉。", char="", persona="")

    assert _titles(char="miao", persona="persona-wu") == []
    with db.get_db() as conn:
        assert memory._find_duplicate(conn, "怕冷", "她一降温就手脚冰凉。", "miao", "persona-wu") is True


def test_same_title_different_relationship_not_duplicate(client):
    """两个角色可以各自记一件同名但不同的事，不能互相压制。"""
    _add("怕冷", "芴怕冷。", char="miao", persona="persona-wu")
    _add("怕冷", "阿杞也怕冷。", char="qi", persona="persona-wu")

    assert _titles(char="miao", persona="persona-wu") == ["怕冷"]
    assert _titles(char="qi", persona="persona-wu") == ["怕冷"]


# ---------------------------------------------------------------- _visible 形状
def test_visible_clause_empty_without_args():
    assert memory._visible("", "") == ("", [])


def test_visible_clause_with_pair():
    clause, params = memory._visible("miao", "persona-wu")
    assert "scope = 'world'" in clause
    assert "scope = 'character'" in clause
    assert "scope = 'pair'" in clause
    assert params == ["miao", "miao", "persona-wu"]


def test_visible_clause_with_character_only():
    clause, params = memory._visible("miao", "")
    assert "scope IN ('character', 'pair')" in clause
    assert params == ["miao"]


# ---------------------------------------------------------------- bonds
def test_ensure_bond_is_idempotent(client):
    with db.get_db() as conn:
        first = db.ensure_bond(conn, "persona-wu", "miao", "2024-11-08")
        again = db.ensure_bond(conn, "persona-wu", "miao", "2030-01-01")

        assert first["id"] == again["id"]
        assert again["started_at"] == "2024-11-08"  # 已存在就不覆盖
        db.ensure_bond(conn, "persona-cen", "miao")
        assert len(db.list_bonds(conn)) == 2


def test_ensure_bond_requires_character(client):
    with db.get_db() as conn:
        assert db.ensure_bond(conn, "persona-wu", "") is None


def test_bond_json_shape(client):
    with db.get_db() as conn:
        row = db.ensure_bond(conn, "persona-wu", "miao", "2024-11-08")
        data = db.bond_json(row)
    assert data["personaId"] == "persona-wu"
    assert data["characterId"] == "miao"
    assert data["startedAt"] == "2024-11-08"
    assert data["nickname"] == ""


# ---------------------------------------------------------------- 迁移建关系
def test_migration_creates_bond_from_existing_chat(tmp_path, monkeypatch):
    """老库升级：已有 chat 的 (persona, character) 要自动补一条 bond。"""
    import sqlite3

    db_file = tmp_path / "old.db"
    con = sqlite3.connect(db_file)
    con.executescript(
        """
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO schema_migrations VALUES (3, '2026-01-01T00:00:00');
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE chats (
          id TEXT PRIMARY KEY, character_id TEXT NOT NULL, persona_id TEXT NOT NULL DEFAULT '',
          world_book_id TEXT NOT NULL DEFAULT '', preset_id TEXT NOT NULL DEFAULT '',
          model_id TEXT NOT NULL DEFAULT '', reasoning_level TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '', pinned INTEGER NOT NULL DEFAULT 0,
          settings_json TEXT NOT NULL DEFAULT '{}', last_at TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        INSERT INTO chats VALUES ('chat-old','miao','persona-wu','','','','','旧对话',0,'{}','',
          '2026-01-01T00:00:00','2026-01-01T00:00:00');
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, role TEXT NOT NULL,
          text TEXT NOT NULL, created_at TEXT NOT NULL, edited INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO messages (chat_id, role, text, created_at) VALUES ('chat-old','ai','旧消息','2026-01-01T00:00:00');
        """
    )
    con.commit()
    con.close()

    monkeypatch.setenv("MSYQ_DB_PATH", str(db_file))
    monkeypatch.setenv("MSYQ_SEED", "0")
    db.init_db()

    with db.get_db() as conn:
        bonds = db.list_bonds(conn)
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(memories)").fetchall()}
    assert len(bonds) == 1
    assert bonds[0]["character_id"] == "miao"
    assert bonds[0]["persona_id"] == "persona-wu"
    assert {"scope", "character_id", "persona_id"} <= cols