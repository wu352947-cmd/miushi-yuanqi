"""usage 保留期清理：超期明细被删掉，近期记录原样保留。"""

from datetime import datetime, timedelta

from server import db, usage


def _insert(conn, at, name="m"):
    return usage.record_usage(
        conn,
        at=at,
        conversation_id="c1",
        character_id="miao",
        provider_id="p1",
        model_id="model-1",
        model_key="k",
        model_name=name,
        prompt_tokens=10,
        output_tokens=5,
        ok=True,
    )


def test_prune_removes_only_expired(client):
    with db.get_db() as conn:
        old_at = (datetime.now() - timedelta(days=500)).strftime("%Y-%m-%dT%H:%M:%S")
        new_at = (datetime.now() - timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%S")
        _insert(conn, old_at, "old-1")
        _insert(conn, old_at, "old-2")
        _insert(conn, new_at, "new-1")

        before = conn.execute("SELECT COUNT(*) AS n FROM usage").fetchone()["n"]
        removed = usage.prune_usage(conn, keep_days=400)
        after = conn.execute("SELECT COUNT(*) AS n FROM usage").fetchone()["n"]

    assert removed == 2, "应当删掉 2 条超期记录"
    assert after == before - 2
    with db.get_db() as conn:
        names = [r["model_name"] for r in conn.execute("SELECT model_name FROM usage").fetchall()]
    assert "new-1" in names
    assert "old-1" not in names and "old-2" not in names


def test_prune_keeps_everything_when_all_fresh(client):
    with db.get_db() as conn:
        for days in (1, 10, 100, 399):
            _insert(conn, (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S"))
        removed = usage.prune_usage(conn, keep_days=400)
        count = conn.execute("SELECT COUNT(*) AS n FROM usage").fetchone()["n"]
    assert removed == 0
    assert count == 4


def test_prune_ignores_empty_at(client):
    """at 为空的脏数据不该被这条规则误删（它没有时间，判断不了年龄）。"""
    with db.get_db() as conn:
        conn.execute(
            "INSERT INTO usage (at, conversation_id, character_id) VALUES ('', 'c', 'miao')"
        )
        removed = usage.prune_usage(conn, keep_days=30)
        count = conn.execute("SELECT COUNT(*) AS n FROM usage WHERE at = ''").fetchone()["n"]
    assert removed == 0
    assert count == 1


def test_keep_days_env_override(client, monkeypatch):
    monkeypatch.setenv("MSYQ_USAGE_KEEP_DAYS", "60")
    assert usage.usage_keep_days() == 60
    monkeypatch.setenv("MSYQ_USAGE_KEEP_DAYS", "5")
    assert usage.usage_keep_days() == 30, "低于 30 天的设置按 30 天算，防止误删"
    monkeypatch.setenv("MSYQ_USAGE_KEEP_DAYS", "abc")
    assert usage.usage_keep_days() == 400, "非法值退回默认"