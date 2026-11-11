"""自动记忆抽取：extract_memories 的解析 / 入库 / 去重，schedule_extract_after_reply 的节流。

这段代码在 2026-11-11 之前完全没有测试覆盖（memory.py 的 347-411、431-452），
也没有任何日志 —— 也就是说它要么正常工作，要么静默报废，两种情况都看不出来。
这一轮补上测试，同时那两处已经加了 LOG.warning。
"""
from __future__ import annotations

import asyncio
import json
import logging

from server import db, memory


# ---------------------------------------------------------------- 造数据的小工具

def _make_chat(character_id: str = "miao", turns: int = 1) -> str:
    """确保这个角色有一场聊天，塞进 turns 轮「用户 + 回复」，返回 chat_id。"""
    with db.get_db() as conn:
        row = db.ensure_chat(conn, character_id)
        chat_id = row["id"]
        for i in range(turns):
            db.append_message(conn, chat_id, "me", "第 %d 轮用户消息" % (i + 1))
            db.append_message(conn, chat_id, "ai", "第 %d 轮回复" % (i + 1))
    return chat_id


def _patch_model(monkeypatch) -> None:
    """绕过「必须填 API Key」的检查：直接给一个假模型 + 假 key。"""
    with db.get_db() as conn:
        model = db.get_model(conn, "model-deepseek-flash")
        provider = db.provider_json(db.get_provider_row(conn, "prov-deepseek"))
    monkeypatch.setattr(memory, "_resolve_model", lambda conn: (model, provider, "fake-key"))


def _patch_complete(monkeypatch, payload, usage=None):
    """让 providers.complete 直接返回给定 JSON（不联网）。"""
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    seen = {}

    async def fake_complete(provider, model, prompt, api_key, reasoning_level=None, session_id=None):
        seen["prompt"] = prompt
        seen["reasoning_level"] = reasoning_level
        seen["session_id"] = session_id
        return {"text": text, "usage": usage}

    monkeypatch.setattr(memory.providers, "complete", fake_complete)
    return seen


def _note_titles():
    with db.get_db() as conn:
        rows = conn.execute(
            "SELECT title FROM memories WHERE kind = 'note' AND status != 'forgotten' ORDER BY created_at"
        ).fetchall()
    return [r["title"] for r in rows]


# ---------------------------------------------------------------- 前置条件

async def test_extract_rejects_unknown_character(client):
    result = await memory.extract_memories("no-such-character")
    assert result["ok"] is False
    assert "角色不存在" in result["message"]
    assert result["created"] == []


async def test_extract_rejects_chat_without_messages(client):
    with db.get_db() as conn:
        db.ensure_chat(conn, "miao")  # 建了聊天，但一条消息都没有
    result = await memory.extract_memories("miao")
    assert result["ok"] is False
    assert "还没有内容" in result["message"]


async def test_extract_rejects_missing_api_key(client):
    """种子里没有 API Key，且不是 mock 模式 —— 应该提示去填 Key，而不是抛异常。"""
    _make_chat()
    result = await memory.extract_memories("miao")
    assert result["ok"] is False
    assert "API Key" in result["message"]


# ---------------------------------------------------------------- 主路径

async def test_extract_creates_notes_and_updates_now(client, monkeypatch):
    _make_chat()
    _patch_model(monkeypatch)
    seen = _patch_complete(
        monkeypatch,
        {
            "now": "在图书馆三楼靠窗，雨刚停。",
            "notes": [
                {"title": "怕冷", "body": "她一降温就手脚冰凉。", "category": "关于我", "importance": 7},
                {"title": "伞放门边", "body": "伞不要塞进包里。", "category": "日常", "importance": 5},
            ],
        },
        usage={"prompt_tokens": 900, "cache_tokens": 0, "output_tokens": 60, "total_tokens": 960},
    )

    result = await memory.extract_memories("miao")

    assert result["ok"] is True
    assert result["nowUpdated"] is True
    assert [m["title"] for m in result["created"]] == ["怕冷", "伞放门边"]
    assert result["skipped"] == 0

    # 真的入库了，而且来源标成「自动抽取 · 角色名」
    with db.get_db() as conn:
        rows = conn.execute(
            "SELECT title, category, importance, source, source_chat_id, character_id, persona_id "
            "FROM memories WHERE kind = 'note' AND title IN ('怕冷', '伞放门边')"
        ).fetchall()
        rel = conn.execute(
            "SELECT character_id, persona_id FROM memories WHERE kind = 'note' AND title = '怕冷'"
        ).fetchone()
        now = memory.now_card(conn, rel["character_id"], rel["persona_id"])
    assert len(rows) == 2
    sources = {r["title"]: r["source"] for r in rows}
    assert sources["怕冷"].startswith("自动抽取")
    assert "缪诗" in sources["怕冷"]
    assert now["body"] == "在图书馆三楼靠窗，雨刚停。"

    # 抽取走的是「不思考」档位，并且把 chat_id 传给了 session
    assert seen["reasoning_level"] == "off"
    assert seen["session_id"]


async def test_extract_skips_note_with_similar_title(client, monkeypatch):
    _make_chat()
    _patch_model(monkeypatch)
    with db.get_db() as conn:
        memory.create_memory(conn, {"title": "怕冷", "body": "她一降温就手脚冰凉。"})
    _patch_complete(
        monkeypatch,
        {"notes": [{"title": "怕冷", "body": "换了个写法的同一件事。"}]},
    )

    result = await memory.extract_memories("miao")

    assert result["ok"] is True
    assert result["created"] == []
    assert result["skipped"] == 1
    assert _note_titles().count("怕冷") == 1


async def test_extract_ignores_note_without_body(client, monkeypatch):
    _make_chat()
    _patch_model(monkeypatch)
    _patch_complete(monkeypatch, {"notes": [{"title": "没有正文"}, {"body": ""}]})

    result = await memory.extract_memories("miao")

    assert result["ok"] is True
    assert result["created"] == []


async def test_extract_marks_manual_source(client, monkeypatch):
    _make_chat()
    _patch_model(monkeypatch)
    _patch_complete(monkeypatch, {"notes": [{"title": "手动整理的一条", "body": "正文"}]})

    result = await memory.extract_memories("miao", manual=True)

    assert result["ok"] is True
    with db.get_db() as conn:
        row = conn.execute(
            "SELECT source FROM memories WHERE title = '手动整理的一条'"
        ).fetchone()
    assert row["source"].startswith("手动整理")


async def test_extract_records_usage_row(client, monkeypatch):
    _make_chat()
    _patch_model(monkeypatch)
    _patch_complete(
        monkeypatch,
        {"notes": [{"title": "记账用", "body": "正文"}]},
        usage={"prompt_tokens": 800, "cache_tokens": 0, "output_tokens": 40, "total_tokens": 840},
    )

    await memory.extract_memories("miao")

    with db.get_db() as conn:
        rows = conn.execute(
            "SELECT prompt_tokens, output_tokens, kind, ok, estimated FROM usage "
            "WHERE kind = 'memory'"
        ).fetchall()
    assert len(rows) == 1
    assert rows[0]["prompt_tokens"] == 800
    assert rows[0]["output_tokens"] == 40
    assert rows[0]["ok"] == 1
    assert rows[0]["estimated"] == 0


async def test_extract_estimates_usage_when_model_omits_it(client, monkeypatch):
    _make_chat()
    _patch_model(monkeypatch)
    _patch_complete(monkeypatch, {"notes": [{"title": "没给 usage", "body": "正文"}]}, usage=None)

    await memory.extract_memories("miao")

    with db.get_db() as conn:
        row = conn.execute(
            "SELECT prompt_tokens, output_tokens, estimated FROM usage WHERE kind = 'memory'"
        ).fetchone()
    assert row["estimated"] == 1
    assert row["prompt_tokens"] > 0
    assert row["output_tokens"] > 0


# ---------------------------------------------------------------- 失败路径

async def test_extract_handles_unparsable_reply(client, monkeypatch):
    _make_chat()
    _patch_model(monkeypatch)
    _patch_complete(monkeypatch, "这次我什么也没抽出来，就说了句人话。")

    result = await memory.extract_memories("miao")

    assert result["ok"] is False
    assert "没有给出可读的记忆内容" in result["message"]
    assert result["created"] == []


async def test_extract_handles_provider_exception(client, monkeypatch):
    """上游炸了也不能把异常抛出去 —— 聊天正在另一个请求里跑。"""
    _make_chat()
    _patch_model(monkeypatch)

    async def boom(*args, **kwargs):
        raise RuntimeError("上游 502")

    monkeypatch.setattr(memory.providers, "complete", boom)

    result = await memory.extract_memories("miao")

    assert result["ok"] is False
    assert result["message"]
    assert result["created"] == []


# ---------------------------------------------------------------- 节流

async def test_schedule_skips_when_disabled(client, monkeypatch):
    _make_chat(turns=4)
    with db.get_db() as conn:
        config = db.load_app_settings(conn)
        config.setdefault("settings", {})["memoryExtractEnabled"] = False
        db.save_app_settings(conn, config)

    called = []
    monkeypatch.setattr(
        memory, "extract_memories",
        lambda *a, **k: called.append(a) or asyncio.sleep(0),
    )
    memory.schedule_extract_after_reply("miao")
    await asyncio.sleep(0.05)
    assert called == []


async def test_schedule_only_runs_every_n_turns(client, monkeypatch):
    _make_chat(turns=3)  # 默认每 4 轮抽一次，3 轮不该触发

    called = []

    async def fake_extract(cid, manual=False):
        called.append(cid)
        return {"ok": True, "created": []}

    monkeypatch.setattr(memory, "extract_memories", fake_extract)
    memory.schedule_extract_after_reply("miao")
    await asyncio.sleep(0.05)
    assert called == []


async def test_schedule_runs_extract_when_due(client, monkeypatch):
    _make_chat(turns=4)

    called = []

    async def fake_extract(cid, manual=False):
        called.append(cid)
        return {"ok": True, "created": []}

    monkeypatch.setattr(memory, "extract_memories", fake_extract)
    memory.schedule_extract_after_reply("miao")
    await asyncio.sleep(0.05)
    assert called == ["miao"]


async def test_schedule_does_not_repeat_same_turn(client, monkeypatch):
    """同一轮次只抽一次 —— memoryMarks 记住已经抽过的 user_turns。"""
    _make_chat(turns=4)

    called = []

    async def fake_extract(cid, manual=False):
        called.append(cid)
        return {"ok": True, "created": []}

    monkeypatch.setattr(memory, "extract_memories", fake_extract)

    memory.schedule_extract_after_reply("miao")
    await asyncio.sleep(0.05)
    memory.schedule_extract_after_reply("miao")
    await asyncio.sleep(0.05)

    assert called == ["miao"]
    with db.get_db() as conn:
        marks = db.load_app_settings(conn).get("memoryMarks") or {}
    assert sum(marks.values()) == 4


async def test_schedule_respects_custom_interval(client, monkeypatch):
    _make_chat(turns=2)
    with db.get_db() as conn:
        config = db.load_app_settings(conn)
        config.setdefault("settings", {})["memoryExtractEvery"] = 2
        db.save_app_settings(conn, config)

    called = []

    async def fake_extract(cid, manual=False):
        called.append(cid)
        return {"ok": True, "created": []}

    monkeypatch.setattr(memory, "extract_memories", fake_extract)
    memory.schedule_extract_after_reply("miao")
    await asyncio.sleep(0.05)
    assert called == ["miao"]


# ---------------------------------------------------------------- 我们补的那两处日志

async def test_schedule_logs_when_extract_fails(client, monkeypatch, caplog):
    """抽取抛异常时必须留下 WARNING —— 这正是这轮补的那行日志。"""
    _make_chat(turns=4)

    async def boom(cid, manual=False):
        raise RuntimeError("抽取炸了")

    monkeypatch.setattr(memory, "extract_memories", boom)

    with caplog.at_level(logging.WARNING, logger="msyq"):
        memory.schedule_extract_after_reply("miao")
        await asyncio.sleep(0.05)

    assert any("自动记忆抽取失败" in record.message for record in caplog.records), \
        "抽取失败没有留下日志，这正是当初「记忆怎么不长了」查不出来的原因"
    assert any("miao" in str(record.args) for record in caplog.records if record.args)


async def test_schedule_logs_when_precheck_fails(client, monkeypatch, caplog):
    """前置检查读库失败也要留 WARNING，而不是静默跳过。"""

    def boom_get_db():
        raise RuntimeError("库读不了")

    monkeypatch.setattr(memory.db, "get_db", boom_get_db)

    with caplog.at_level(logging.WARNING, logger="msyq"):
        memory.schedule_extract_after_reply("miao")

    assert any("前置检查失败" in record.message for record in caplog.records)


def test_schedule_without_event_loop_does_not_raise(client, monkeypatch):
    """同步上下文（没有 running loop）里调用不能抛 —— 聊天主流程可能不在协程里。"""
    _make_chat(turns=4)

    called = []

    async def fake_extract(cid, manual=False):
        called.append(cid)
        return {"ok": True, "created": []}

    monkeypatch.setattr(memory, "extract_memories", fake_extract)

    memory.schedule_extract_after_reply("miao")  # 不应该抛 RuntimeError
    assert called == []  # 没有 loop 就没法起 task，但也不该炸
