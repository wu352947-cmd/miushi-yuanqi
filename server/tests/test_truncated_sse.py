"""截断 / 空回复：done 里必须如实报告，前端才好提示。

以前这两种情况前端都当成正常回复：
- 截断 → 话说到一半没了，用户以为是她不想说
- 空回复 → 留一个空气泡，用户完全不知道发生了什么
"""
from __future__ import annotations

from conftest import chat_events
from server import providers


def _patch_stream(monkeypatch, events):
    async def fake_stream(*args, **kwargs):
        for event in events:
            yield event

    monkeypatch.setattr(providers, "chat_stream", fake_stream)


def test_done_marks_truncated_when_length(client, monkeypatch):
    monkeypatch.setenv("MSYQ_MOCK", "1")
    _patch_stream(
        monkeypatch,
        [
            {"type": "start", "duration_ms": 3},
            {"type": "delta", "text": "话说到一半"},
            {"type": "finish", "reason": "length"},
        ],
    )

    events = chat_events(client, "接着说")
    done = next(data for kind, data in events if kind == "done")
    assert done["truncated"] is True
    assert done["finishReason"] == "length"
    # 正文照常保留，不能因为截断就把内容丢掉
    assert "话说到一半" in done["message"]["text"]


def test_done_marks_not_truncated_when_stop(client, monkeypatch):
    monkeypatch.setenv("MSYQ_MOCK", "1")
    _patch_stream(
        monkeypatch,
        [
            {"type": "start", "duration_ms": 3},
            {"type": "delta", "text": "说完了"},
            {"type": "finish", "reason": "stop"},
        ],
    )

    events = chat_events(client, "随便聊聊")
    done = next(data for kind, data in events if kind == "done")
    assert done["truncated"] is False
    assert done["finishReason"] == "stop"


def test_done_marks_not_truncated_when_no_finish_event(client, monkeypatch):
    """有些上游不给结束信号，不能因此误报成截断。"""
    monkeypatch.setenv("MSYQ_MOCK", "1")
    _patch_stream(
        monkeypatch,
        [
            {"type": "delta", "text": "没给结束信号"},
        ],
    )

    events = chat_events(client, "再说一句")
    done = next(data for kind, data in events if kind == "done")
    assert done["truncated"] is False
    assert done["finishReason"] == ""


def test_done_reports_empty_text(client, monkeypatch):
    """模型一个字都没吐：done 里的正文为空，前端据此提示，而不是留空气泡。"""
    monkeypatch.setenv("MSYQ_MOCK", "1")
    _patch_stream(
        monkeypatch,
        [
            {"type": "start", "duration_ms": 1},
            {"type": "finish", "reason": "stop"},
        ],
    )

    events = chat_events(client, "你说句话")
    done = next(data for kind, data in events if kind == "done")
    # 一个字都没有时后端不会造消息对象，前端拿到的正文就是空
    assert not str((done.get("message") or {}).get("text") or "").strip()