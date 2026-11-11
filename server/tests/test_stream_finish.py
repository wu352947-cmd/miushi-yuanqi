"""截断检测：三个协议各自的结束信号要能归一到 finish 事件。

这块以前完全没有——被 max_tokens 截断时前端会当成「她说完了」，
用户看到话说到一半，会以为是她不想说了。
"""
from __future__ import annotations

import json

import pytest

from server import providers


class FakeResp:
    """假的 httpx 流式响应：只提供 aiter_lines。"""

    def __init__(self, lines):
        self._lines = lines

    async def aiter_lines(self):
        for line in self._lines:
            yield line


def _sse_lines(payloads, event_name=None):
    lines = []
    for p in payloads:
        if event_name:
            lines.append("event: " + event_name)
        lines.append("data: " + (p if isinstance(p, str) else json.dumps(p, ensure_ascii=False)))
        lines.append("")
    return lines


async def _collect(gen):
    return [e async for e in gen]


@pytest.mark.asyncio
async def test_openai_finish_length():
    lines = _sse_lines(
        [
            {"choices": [{"delta": {"content": "话说到一半"}}]},
            {"choices": [{"delta": {}, "finish_reason": "length"}]},
        ]
    )
    events = await _collect(providers._stream_openai(FakeResp(lines)))
    kinds = [e["type"] for e in events]
    assert "delta" in kinds
    finish = [e for e in events if e["type"] == "finish"]
    assert finish and finish[0]["reason"] == "length"


@pytest.mark.asyncio
async def test_openai_finish_stop_is_normal():
    lines = _sse_lines([{"choices": [{"delta": {"content": "完整的话"}, "finish_reason": "stop"}]}])
    events = await _collect(providers._stream_openai(FakeResp(lines)))
    finish = [e for e in events if e["type"] == "finish"]
    assert finish and finish[0]["reason"] == "stop"


@pytest.mark.asyncio
async def test_anthropic_max_tokens_maps_to_length():
    lines = _sse_lines(
        [
            {"type": "message_start", "message": {"usage": {"input_tokens": 10}}},
            {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "半句话"}},
            {"type": "message_delta", "delta": {"stop_reason": "max_tokens"}, "usage": {"output_tokens": 5}},
        ]
    )
    events = await _collect(providers._stream_anthropic(FakeResp(lines)))
    finish = [e for e in events if e["type"] == "finish"]
    assert finish and finish[0]["reason"] == "length"


@pytest.mark.asyncio
async def test_anthropic_end_turn_is_normal():
    lines = _sse_lines(
        [
            {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "说完了"}},
            {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 3}},
        ]
    )
    events = await _collect(providers._stream_anthropic(FakeResp(lines)))
    finish = [e for e in events if e["type"] == "finish"]
    assert finish and finish[0]["reason"] == "end_turn"


@pytest.mark.asyncio
async def test_gemini_max_tokens_maps_to_length():
    lines = _sse_lines(
        [
            {"candidates": [{"content": {"parts": [{"text": "半句"}]}}]},
            {"candidates": [{"finishReason": "MAX_TOKENS", "content": {"parts": []}}]},
        ]
    )
    events = await _collect(providers._stream_gemini(FakeResp(lines)))
    finish = [e for e in events if e["type"] == "finish"]
    assert finish and finish[0]["reason"] == "length"


@pytest.mark.asyncio
async def test_gemini_stop_is_normal():
    lines = _sse_lines([{"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "好"}]}}]}])
    events = await _collect(providers._stream_gemini(FakeResp(lines)))
    finish = [e for e in events if e["type"] == "finish"]
    assert finish and finish[0]["reason"] == "STOP"