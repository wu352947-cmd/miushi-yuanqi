"""离线续写：她自己开口（mode=proactive）。

和 continue 的区别：continue 是「接着最后一条说完」，proactive 是「主动说一句新的」。
两者都不能写 user 消息，但注入的指令不同——这是最容易搞混的地方。
"""
from __future__ import annotations

import json

from conftest import chat_events
from server import providers


def _patch_stream(monkeypatch, events):
    async def fake_stream(*args, **kwargs):
        for event in events:
            yield event

    monkeypatch.setattr(providers, "chat_stream", fake_stream)


def test_proactive_does_not_write_user_message(client, monkeypatch):
    monkeypatch.setenv("MSYQ_MOCK", "1")
    _patch_stream(
        monkeypatch,
        [
            {"type": "start", "duration_ms": 3},
            {"type": "delta", "text": "她自己在说话。"},
            {"type": "finish", "reason": "stop"},
        ],
    )
    events = chat_events(client, "", mode="proactive")
    assert not [d for kind, d in events if kind == "user"]
    done = next(d for kind, d in events if kind == "done")
    assert "她自己在说话" in done["message"]["text"]


def test_proactive_text_is_optional(client, monkeypatch):
    """normal 模式空文本要报错，proactive 不该报错。"""
    monkeypatch.setenv("MSYQ_MOCK", "1")
    _patch_stream(
        monkeypatch,
        [
            {"type": "start", "duration_ms": 3},
            {"type": "delta", "text": "嗯。"},
            {"type": "finish", "reason": "stop"},
        ],
    )
    events = chat_events(client, "", mode="proactive")
    assert next(d for kind, d in events if kind == "done")


def test_proactive_uses_its_own_nudge(client, monkeypatch):
    """注入的必须是「主动开口」，不能误用 continue 的「接着说」。"""
    seen: dict = {}

    async def fake_stream(provider, model, prompt, api_key, level, **kwargs):
        seen["prompt"] = prompt
        yield {"type": "start", "duration_ms": 1}
        yield {"type": "delta", "text": "嗯。"}
        yield {"type": "finish", "reason": "stop"}

    monkeypatch.setenv("MSYQ_MOCK", "1")
    monkeypatch.setattr(providers, "chat_stream", fake_stream)
    chat_events(client, "", mode="proactive")

    blob = json.dumps(seen["prompt"], ensure_ascii=False)
    assert "现在没有人对你说话" in blob
    assert "请顺着上面最后一条" not in blob


def test_continue_still_uses_its_own_nudge(client, monkeypatch):
    """反过来也要成立：continue 不能被 proactive 顶掉。"""
    seen: dict = {}

    async def fake_stream(provider, model, prompt, api_key, level, **kwargs):
        seen["prompt"] = prompt
        yield {"type": "start", "duration_ms": 1}
        yield {"type": "delta", "text": "嗯。"}
        yield {"type": "finish", "reason": "stop"}

    monkeypatch.setenv("MSYQ_MOCK", "1")
    monkeypatch.setattr(providers, "chat_stream", fake_stream)
    chat_events(client, "", mode="continue")

    blob = json.dumps(seen["prompt"], ensure_ascii=False)
    assert "请顺着上面最后一条" in blob
    assert "现在没有人对你说话" not in blob


def test_unknown_mode_falls_back_to_normal(client, monkeypatch):
    """瞎传 mode 不能绕过「必须先说点什么」的校验。"""
    monkeypatch.setenv("MSYQ_MOCK", "1")
    _patch_stream(monkeypatch, [{"type": "start", "duration_ms": 1}])
    resp = client.post("/api/chats/miao/messages", json={"text": "", "mode": "telepathy"})
    assert resp.status_code >= 400
