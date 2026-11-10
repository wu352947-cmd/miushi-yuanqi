"""聊天链路：mock 流式、400 改参数重试、无 Key 中文提示、usage 落库。"""

import json

from server import db
from conftest import chat_events, parse_sse


def test_stream_with_mock(client, monkeypatch):
    monkeypatch.setenv("MSYQ_MOCK", "1")
    events = chat_events(client, "今晚下雨了，我有点累。")
    kinds = [kind for kind, _ in events]
    assert kinds[0] == "user"
    assert "meta" in kinds
    assert "delta" in kinds
    assert "done" in kinds
    reply = "".join(data["text"] for kind, data in events if kind == "delta")
    assert reply.strip()
    done = next(data for kind, data in events if kind == "done")
    assert done["message"]["role"] == "ai"
    assert done["usage"]["prompt_tokens"] > 0
    assert done["usage"]["completion_tokens"] > 0
    # usage 表里有记录，统计页能汇总
    with db.get_db() as conn:
        rows = conn.execute("SELECT * FROM usage").fetchall()
    assert len(rows) == 1
    assert rows[0]["model_id"]
    assert rows[0]["model_name"]
    assert rows[0]["kind"] == "chat"


def test_400_reasoning_fallback_retry(client, monkeypatch):
    monkeypatch.setenv("MSYQ_MOCK", "1")
    monkeypatch.setenv("MSYQ_MOCK_400", "1")
    with client.stream(
        "POST", "/api/chats/miao/messages", json={"text": "再坐一会儿", "reasoningLevel": "high"}
    ) as response:
        events = parse_sse(response)
    fallback = [data for kind, data in events if kind == "fallback"]
    assert fallback and "不支持调思考深度" in fallback[0]["message"]
    done = next(data for kind, data in events if kind == "done")
    assert done["fallback"]
    # 聊天没有因此失败：回复照常产生
    assert "".join(data["text"] for kind, data in events if kind == "delta").strip()
    with db.get_db() as conn:
        row = conn.execute("SELECT * FROM usage ORDER BY id DESC LIMIT 1").fetchone()
    assert row["fallback_reasoning"] == 1
    assert row["ok"] == 1


def test_no_key_returns_chinese_hint(client):
    # 没有 mock、没有 Key：返回 400 + 中文提示，而不是 500 / 英文堆栈
    response = client.post("/api/chats/miao/messages", json={"text": "在吗"})
    assert response.status_code == 400
    payload = response.json()
    assert payload["error"]["kind"] == "nokey"
    assert "API Key" in payload["error"]["message"]
    assert "Traceback" not in response.text


def test_model_not_reasoning_never_sends_params(client, monkeypatch):
    monkeypatch.setenv("MSYQ_MOCK", "1")
    events = chat_events(client, "用不会思考的模型", modelId="model-bailu-lite")
    meta = next(data for kind, data in events if kind == "meta")
    assert meta["reasoning"]["supported"] is False
    assert meta["reasoning"]["params"] is None


def test_prompt_preview_from_backend(client):
    payload = client.get("/api/chats/miao/prompt-preview", params={"text": "下一句"}).json()
    assert payload["blocks"]
    assert payload["tokens"] > 0
    kinds = [block["kind"] for block in payload["blocks"]]
    assert kinds[0] == "preset"
    assert kinds[-1] == "current"
    assert payload["meta"]["model"]
