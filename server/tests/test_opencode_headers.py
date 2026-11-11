"""OpenCode Go 出站头：User-Agent 与稳定的 x-opencode-session。

不使用真实 Key，也不访问外网。httpx 只走假客户端或 MockTransport。
"""

from __future__ import annotations

import json

import httpx
import pytest

from server import __version__
from server import providers
from server.providers import (
    OPENCODE_SESSION_BALANCE,
    OPENCODE_SESSION_CHAT,
    OPENCODE_SESSION_MODELS,
    OPENCODE_SESSION_TEST,
    OPENCODE_USER_AGENT,
    build_request,
    is_opencode_url,
    opencode_request_headers,
)

PROMPT = {
    "segments": [{"role": "user", "text": "hi"}],
    "sampling": {"max_tokens": 8, "temperature": 0.2},
    "system_text": "",
}
MODEL = {
    "id": "m1",
    "modelId": "glm-5.2",
    "reasoning": {"mode": "openai_effort", "levels": ["off", "low", "high"], "defaultLevel": "high"},
}


def _provider(protocol: str, base: str, path: str) -> dict:
    return {"protocol": protocol, "baseUrl": base, "apiPath": path, "advanced": {}}


def _header_map(headers: dict) -> dict[str, str]:
    return {str(key).lower(): value for key, value in (headers or {}).items()}


# --------------------------------------------------------------------------- 假 httpx
class _Resp:
    def __init__(self, status_code=200, payload=None, text="", lines=None):
        self.status_code = status_code
        self._payload = payload
        self.text = text if text or payload is None else json.dumps(payload)
        self._lines = lines or []

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload

    async def aread(self):
        return self.text.encode("utf-8")

    async def aiter_lines(self):
        for line in self._lines:
            yield line


class _Stream:
    def __init__(self, response):
        self._response = response

    async def __aenter__(self):
        return self._response

    async def __aexit__(self, *exc):
        return False


class _FakeHTTP:
    calls: list[dict] = []
    script: list = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def _take(self, method, url, headers):
        _FakeHTTP.calls.append({"method": method, "url": url, "headers": dict(headers or {})})
        if _FakeHTTP.script:
            return _FakeHTTP.script.pop(0)
        return _Resp(
            200,
            payload={"data": [{"id": "glm-5.2"}], "choices": [{"message": {"content": "ok"}}], "balance_infos": [{"total_balance": "1.2", "currency": "CNY"}]},
            lines=[
                'data: {"choices":[{"delta":{"content":"hi"}}]}',
                "data: [DONE]",
            ],
        )

    async def get(self, url, headers=None, **kwargs):
        return self._take("GET", url, headers)

    async def post(self, url, headers=None, json=None, **kwargs):
        return self._take("POST", url, headers)

    def stream(self, method, url, headers=None, json=None, **kwargs):
        return _Stream(self._take(method, url, headers))


@pytest.fixture()
def fake_http(monkeypatch):
    _FakeHTTP.calls = []
    _FakeHTTP.script = []
    monkeypatch.setattr(providers.httpx, "AsyncClient", _FakeHTTP)
    return _FakeHTTP


# --------------------------------------------------------------------------- 地址识别
@pytest.mark.parametrize(
    "url",
    [
        "https://opencode.ai/inference/go",
        "https://opencode.ai/inference/go/",
        "https://opencode.ai/inference/go/v1/models",
        "https://opencode.ai/inference/go/openai/v1/chat/completions",
        "https://opencode.ai/inference/go/openai/v1/responses",
        "https://opencode.ai/inference/go/anthropic/v1/messages",
        "https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon:generateContent",
        "https://opencode.ai/inference",
        "https://opencode.ai/inference/v1/chat/completions",
        "https://opencode.ai/zen/go",
        "https://opencode.ai/zen/go/v1/models",
        "https://OpenCode.AI/Inference/Go/v1/models",
        "https://opencode.ai:443/inference/go/v1/models",
        "https://user:secret@opencode.ai/inference/go/v1/models?foo=1",
        "http://opencode.ai/inference/go/models",
        "https://opencode.ai./inference/go",
        "  https://opencode.ai/zen/GO/v1/chat/completions  ",
    ],
)
def test_opencode_urls_match(url):
    assert is_opencode_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "",
        "not a url",
        "https://api.openai.com/v1/chat/completions",
        "https://api.anthropic.com/v1/messages",
        "https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent",
        "https://openrouter.ai/api/v1/chat/completions",
        "https://api.deepseek.com/chat/completions",
        "https://example.com/inference/go",
        "https://opencode.ai.evil.com/inference/go",
        "https://evilopencode.ai/inference/go",
        "https://not-opencode.ai/inference/go",
        "https://evil.com/opencode.ai/inference/go",
        "https://opencode.ai/docs/go",
        "https://opencode.ai/zen",
        "https://opencode.ai/zen/google",
        "https://opencode.ai/zen/goodies",
        "https://opencode.ai/inferencefoo",
        "https://opencode.ai/inferences/go",
        "https://opencode.ai/",
        "https://opencode.ai/v1/models",
        "https://opencode.ai/v1/chat/completions",
    ],
)
def test_non_opencode_urls_do_not_match(url):
    assert not is_opencode_url(url)


# --------------------------------------------------------------------------- 请求头
@pytest.mark.parametrize(
    "protocol,base,path",
    [
        ("openai", "https://opencode.ai/inference/go/openai/v1", "/chat/completions"),
        ("openai_responses", "https://opencode.ai/inference/go/openai/v1", "/responses"),
        ("anthropic", "https://opencode.ai/inference/go/anthropic", "/v1/messages"),
        ("gemini", "https://opencode.ai/inference/go/google", "/v1beta/models/{model}:generateContent"),
        ("openai", "https://opencode.ai/zen/go/v1", "/chat/completions"),
        ("openai", "https://opencode.ai/inference/v1", "/chat/completions"),
    ],
)
def test_opencode_build_request_sets_both_headers(protocol, base, path):
    first = build_request(
        _provider(protocol, base, path), MODEL, PROMPT, "sk-test", stream=False, session_id="chat-aaa", reasoning_level="off"
    )
    second = build_request(
        _provider(protocol, base, path), MODEL, PROMPT, "sk-test", stream=False, session_id="chat-aaa", reasoning_level="off"
    )
    other = build_request(
        _provider(protocol, base, path), MODEL, PROMPT, "sk-test", stream=False, session_id="chat-bbb", reasoning_level="off"
    )
    headers = _header_map(first["headers"])
    assert headers["user-agent"] == OPENCODE_USER_AGENT == "miushi-yuanqi/" + __version__
    assert "python-httpx" not in headers["user-agent"]
    assert headers["x-opencode-session"] == "chat-aaa"
    assert _header_map(second["headers"])["x-opencode-session"] == headers["x-opencode-session"]
    assert _header_map(other["headers"])["x-opencode-session"] == "chat-bbb"
    assert _header_map(other["headers"])["x-opencode-session"] != headers["x-opencode-session"]
    assert "sk-test" not in headers["user-agent"]
    assert "sk-test" not in headers["x-opencode-session"]
    if protocol == "anthropic":
        assert headers["x-api-key"] == "sk-test"
        assert "authorization" not in headers
    elif protocol == "gemini":
        assert "authorization" not in headers
        assert "x-api-key" not in headers
    else:
        assert headers["authorization"] == "Bearer sk-test"


def test_same_chat_is_stable_and_empty_session_is_not_random():
    url = "https://opencode.ai/inference/go/v1/chat/completions"
    one = opencode_request_headers(url, "chat-same")
    two = opencode_request_headers(url, "chat-same")
    assert one == two
    assert one["x-opencode-session"] == "chat-same"
    blank_a = opencode_request_headers(url, None)
    blank_b = opencode_request_headers(url, "   ")
    assert blank_a["x-opencode-session"] == blank_b["x-opencode-session"] == OPENCODE_SESSION_CHAT
    injected = opencode_request_headers(url, "chat-1\r\nX-Injected: yes")
    assert "\r" not in injected["x-opencode-session"]
    assert "\n" not in injected["x-opencode-session"]
    assert ":" not in injected["x-opencode-session"]


@pytest.mark.parametrize(
    "protocol,base,path",
    [
        ("openai", "https://api.openai.com/v1", "/chat/completions"),
        ("openai_responses", "https://api.openai.com/v1", "/responses"),
        ("anthropic", "https://api.anthropic.com", "/v1/messages"),
        ("gemini", "https://generativelanguage.googleapis.com", "/v1beta/models/{model}:generateContent"),
        ("openrouter", "https://openrouter.ai/api/v1", "/chat/completions"),
        ("openai", "https://relay.example.com/inference/go/v1", "/chat/completions"),
        ("openai", "https://opencode.ai.evil.com/inference/go/v1", "/chat/completions"),
        ("openai", "https://opencode.ai/docs", "/go"),
        ("openai", "https://opencode.ai", "/v1/chat/completions"),
    ],
)
def test_other_providers_do_not_get_opencode_headers(protocol, base, path):
    built = build_request(
        _provider(protocol, base, path), MODEL, PROMPT, "sk-test", stream=False, session_id="chat-aaa", reasoning_level="low"
    )
    headers = _header_map(built["headers"])
    assert "x-opencode-session" not in headers
    assert "user-agent" not in headers
    if protocol == "openrouter":
        assert headers["http-referer"] == "http://localhost/"
        assert headers["x-title"] == "miushi-yuanqi"
    if protocol == "anthropic":
        assert headers["x-api-key"] == "sk-test"
        assert headers["anthropic-version"] == "2023-06-01"


async def test_httpx_sends_app_user_agent_not_library_default():
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["ua"] = request.headers["user-agent"]
        captured["session"] = request.headers["x-opencode-session"]
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    req = build_request(
        _provider("openai", "https://opencode.ai/inference/go/openai/v1", "/chat/completions"),
        MODEL,
        PROMPT,
        "sk-test",
        stream=False,
        session_id="chat-aaa",
        reasoning_level="off",
    )
    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        response = await client.post(req["url"], headers=req["headers"], json=req["body"])
    assert response.status_code == 200
    assert captured["ua"] == "miushi-yuanqi/" + __version__
    assert "python-httpx" not in captured["ua"].lower()
    assert captured["session"] == "chat-aaa"

    captured.clear()

    def other(request: httpx.Request) -> httpx.Response:
        captured["ua"] = request.headers["user-agent"]
        captured["has_session"] = "x-opencode-session" in request.headers
        return httpx.Response(200, json={"ok": True})

    plain = build_request(
        _provider("openai", "https://api.openai.com/v1", "/chat/completions"),
        MODEL,
        PROMPT,
        "sk-test",
        stream=False,
        session_id="chat-aaa",
        reasoning_level="off",
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(other)) as client:
        await client.post(plain["url"], headers=plain["headers"], json=plain["body"])
    assert captured["ua"].startswith("python-httpx/")
    assert captured["has_session"] is False


async def test_two_chat_requests_share_session_and_retry_does_too(fake_http):
    provider = _provider("openai", "https://opencode.ai/inference/go/openai/v1", "/chat/completions")

    async def drain(session_id: str) -> None:
        async for _event in providers.chat_stream(provider, MODEL, PROMPT, "sk-test", "off", session_id=session_id):
            pass

    await drain("chat-aaa")
    await drain("chat-aaa")
    await drain("chat-bbb")
    sessions = [_header_map(call["headers"])["x-opencode-session"] for call in fake_http.calls]
    agents = [_header_map(call["headers"])["user-agent"] for call in fake_http.calls]
    assert sessions == ["chat-aaa", "chat-aaa", "chat-bbb"]
    assert agents == [OPENCODE_USER_AGENT, OPENCODE_USER_AGENT, OPENCODE_USER_AGENT]

    fake_http.calls = []
    fake_http.script = [
        _Resp(400, text='{"error":{"message":"reasoning_effort is not supported"}}'),
        _Resp(200, lines=['data: {"choices":[{"delta":{"content":"ok"}}]}', "data: [DONE]"]),
    ]
    async for _event in providers.chat_stream(provider, MODEL, PROMPT, "sk-test", "high", session_id="chat-aaa"):
        pass
    assert len(fake_http.calls) == 2
    retried = [_header_map(call["headers"])["x-opencode-session"] for call in fake_http.calls]
    assert retried == ["chat-aaa", "chat-aaa"]


async def test_utility_calls_use_dedicated_stable_sessions(fake_http):
    go = _provider("openai", "https://opencode.ai/inference/go/v1", "/chat/completions")
    probed = await providers.probe_models(go, "sk-test")
    assert probed["ok"] is True
    pulled = await providers.pull_models(go, "sk-test")
    assert pulled["ok"] is True
    connected = await providers.test_connection(go, "sk-test")
    assert connected["ok"] is True
    generated = await providers.test_generation(go, MODEL, "sk-test", "off")
    assert generated["ok"] is True
    balance = await providers.query_balance(
        {"protocol": "deepseek", "baseUrl": "https://opencode.ai/inference/go", "apiPath": "/chat/completions"},
        "sk-test",
    )
    assert balance.get("ok") is True

    by_session = [_header_map(call["headers"])["x-opencode-session"] for call in fake_http.calls]
    assert by_session[:3] == [OPENCODE_SESSION_MODELS, OPENCODE_SESSION_MODELS, OPENCODE_SESSION_TEST]
    assert by_session[3] == OPENCODE_SESSION_TEST
    assert by_session[4] == OPENCODE_SESSION_BALANCE
    assert all(_header_map(call["headers"])["user-agent"] == OPENCODE_USER_AGENT for call in fake_http.calls)

    fake_http.calls = []
    await providers.pull_models(_provider("openai", "https://api.openai.com/v1", "/chat/completions"), "sk-test")
    await providers.test_generation(_provider("anthropic", "https://api.anthropic.com", "/v1/messages"), MODEL, "sk-test", "off")
    plain = [_header_map(call["headers"]) for call in fake_http.calls]
    assert plain
    for headers in plain:
        assert "x-opencode-session" not in headers
        assert "user-agent" not in headers


def test_chat_routes_reuse_chat_id_and_branch_gets_a_new_one(client, monkeypatch):
    monkeypatch.setenv("MSYQ_MOCK", "1")
    seen: list[str | None] = []

    async def fake_stream(provider, model, prompt, api_key, reasoning_level=None, session_id=None):
        seen.append(session_id)
        yield {"type": "delta", "text": "在"}
        yield {
            "type": "usage",
            "usage": {"prompt_tokens": 1, "output_tokens": 1, "total_tokens": 2, "cache_tokens": 0},
            "estimated": False,
        }

    monkeypatch.setattr(providers, "chat_stream", fake_stream)
    from conftest import chat_events

    first = chat_events(client, "第一句")
    chat_id = next(data["chatId"] for kind, data in first if kind == "done")
    chat_events(client, "第二句", chatId=chat_id)
    chat_events(client, "", mode="regenerate", chatId=chat_id)
    chat_events(client, "", mode="continue", chatId=chat_id)
    assert seen == [chat_id, chat_id, chat_id, chat_id]

    completed: list[str | None] = []

    async def fake_complete(*args, **kwargs):
        completed.append(kwargs.get("session_id"))
        return {"text": "雨夜", "usage": None, "thinking": ""}

    monkeypatch.setattr(providers, "complete", fake_complete)
    titled = client.post("/api/chats/id/" + chat_id + "/auto-title")
    assert titled.status_code == 200
    assert titled.json()["ok"] is True
    impersonated = client.post("/api/chats/miao/impersonate", json={})
    assert impersonated.status_code == 200
    extracted = client.post("/api/memories/extract", json={"characterId": "miao"})
    assert extracted.status_code == 200
    assert completed == [chat_id, chat_id, chat_id]

    full = client.get("/api/chats/id/" + chat_id).json()["chat"]
    cut = full["messages"][-1]["id"]
    branch = client.post("/api/chats/id/" + chat_id + "/branch", json={"messageId": cut}).json()["chat"]
    chat_events(client, "分支上的一句", chatId=branch["id"])
    assert seen[-1] == branch["id"]
    assert branch["id"] != chat_id
