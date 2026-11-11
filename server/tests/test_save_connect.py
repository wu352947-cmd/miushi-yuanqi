"""第一块 · 保存自动连通 / 网址补全 / 真实测试连接。

重点断言：
- 点保存的自动识别流程**零生成请求**（只有免费 GET 模型列表 / 余额）；
- 测试连接默认**只发一条**最小生成请求（单条 "hi"，max_tokens 很小）；
- 网址补全规则逐条覆盖；
- /models 不可用时只保存配置并给中文提示；
- 家族识别 / 图标 / 已知价格 / 思考档位预设。
"""

from __future__ import annotations

import json

import pytest

from server import providers as adapter
from server import url_normalize
from server.model_family import detect_family, family_reasoning


# --------------------------------------------------------------------------- 假 httpx
class _FakeResponse:
    def __init__(self, status_code=200, payload=None, lines=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self._lines = lines or []
        self.text = text or (json.dumps(payload, ensure_ascii=False) if payload is not None else "")

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload

    async def aread(self):
        return self.text.encode("utf-8")

    async def aiter_lines(self):
        for line in self._lines:
            yield line


class _FakeStreamCM:
    def __init__(self, response):
        self._response = response

    async def __aenter__(self):
        return self._response

    async def __aexit__(self, *exc):
        return False


class _FakeHTTP:
    """记录所有请求；get / stream 由 handler 决定返回。"""

    state: dict = {}

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, headers=None, **kwargs):
        _FakeHTTP.state.setdefault("requests", []).append(("GET", url))
        handler = _FakeHTTP.state.get("get")
        if handler:
            return handler(url, headers or {})
        return _FakeResponse(404, payload={"error": "not found"})

    def stream(self, method, url, headers=None, json=None):
        _FakeHTTP.state.setdefault("requests", []).append((method, url))
        _FakeHTTP.state.setdefault("bodies", []).append(json or {})
        lines = _FakeHTTP.state.get("stream_lines") or [
            'data: {"id":"x","choices":[{"delta":{"role":"assistant"}}]}',
            'data: {"id":"x","choices":[{"delta":{"content":"hi"}}]}',
            "data: [DONE]",
        ]
        return _FakeStreamCM(_FakeResponse(200, lines=lines))


@pytest.fixture()
def fake_http(monkeypatch):
    _FakeHTTP.state = {}
    monkeypatch.setattr(adapter.httpx, "AsyncClient", _FakeHTTP)
    return _FakeHTTP.state


def _models_of(client, provider_id):
    models = client.get("/api/models").json()["models"]
    return [item for item in models if item["providerId"] == provider_id]


def _create_provider(client, **overrides):
    payload = {"name": "白露中转", "protocol": "openai", "baseUrl": "https://relay.example.com", "apiPath": ""}
    payload.update(overrides)
    response = client.post("/api/providers", json=payload)
    assert response.status_code == 200, response.text
    return response.json()["provider"]["id"]


def _models_handler(ids):
    def handler(url, headers):
        if url.rstrip("/").endswith("/v1/models") or url.rstrip("/").endswith("/models"):
            return _FakeResponse(200, payload={"data": [{"id": item} for item in ids]})
        return _FakeResponse(404, payload={"error": "not found"})

    return handler


# --------------------------------------------------------------------------- URL 补全规则
@pytest.mark.parametrize(
    "base,path,protocol,want_base,want_path,want_proto",
    [
        ("  api.deepseek.com  ", "", "openai", "https://api.deepseek.com", "/chat/completions", "openai"),
        ("api.example.com", "", "openai", "https://api.example.com", "/chat/completions", "openai"),
        ("https://api.deepseek.com/v1/chat/completions", "", "openai", "https://api.deepseek.com/v1", "/chat/completions", "openai"),
        ("https://api.openai.com/v1/chat/completions", "", "openai", "https://api.openai.com/v1", "/chat/completions", "openai"),
        ("https://api.anthropic.com/v1/messages", "", "openai", "https://api.anthropic.com", "/v1/messages", "anthropic"),
        ("https://api.anthropic.com", "", "anthropic", "https://api.anthropic.com", "/v1/messages", "anthropic"),
        (
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
            "",
            "openai",
            "https://generativelanguage.googleapis.com",
            "/v1beta/models/{model}:generateContent",
            "gemini",
        ),
        ("https://example.com/v1/models", "", "openai", "https://example.com/v1", "/chat/completions", "openai"),
        ("https://example.com//v1//chat//completions", "", "openai", "https://example.com/v1", "/chat/completions", "openai"),
        ("https://relay.example.com/v1/v1/chat/completions", "", "openai", "https://relay.example.com/v1", "/chat/completions", "openai"),
        ("https://api.example.com", "/my/own/path", "openai", "https://api.example.com", "/my/own/path", "openai"),
        ("https://api.example.com/v1", "/v1/chat/completions", "openai", "https://api.example.com/v1", "/chat/completions", "openai"),
    ],
)
def test_normalize_rules(base, path, protocol, want_base, want_path, want_proto):
    out = url_normalize.normalize_provider(base, path, protocol)
    assert out["baseUrl"] == want_base
    assert out["apiPath"] == want_path
    assert out["protocol"] == want_proto
    # 每个被改过的字段都要有「已自动改为 …」提示
    for change in out["changes"]:
        assert change["label"].startswith("已自动改为")


def test_normalize_marks_changes_for_ui():
    out = url_normalize.normalize_provider("api.deepseek.com", "", "openai")
    assert {c["field"] for c in out["changes"]} >= {"baseUrl", "apiPath"}


def test_models_candidates_for_bare_domain():
    assert url_normalize.models_candidates("https://api.example.com", "openai") == [
        "https://api.example.com/v1/models",
        "https://api.example.com/models",
    ]
    assert url_normalize.models_candidates("https://api.example.com/v1", "openai") == ["https://api.example.com/v1/models"]


def test_normalize_endpoint_api(client):
    payload = client.post("/api/providers/normalize-url", json={"baseUrl": "api.deepseek.com/v1/chat/completions", "apiPath": "", "protocol": "openai"}).json()
    assert payload["ok"] is True
    assert payload["baseUrl"] == "https://api.deepseek.com/v1"
    assert payload["apiPath"] == "/chat/completions"
    assert payload["changes"]


# --------------------------------------------------------------------------- 保存自动连通：零生成请求
def test_save_connect_makes_zero_generation_requests(client, fake_http, monkeypatch):
    # 一旦保存流程误调生成接口，这里立刻失败
    monkeypatch.setattr(adapter, "chat_stream", lambda *a, **kw: (_ for _ in ()).throw(AssertionError("保存流程不允许调用生成接口")))
    monkeypatch.setattr(adapter, "complete", lambda *a, **kw: (_ for _ in ()).throw(AssertionError("保存流程不允许调用生成接口")))
    fake_http["get"] = _models_handler(["deepseek-chat", "claude-sonnet-5-5", "gpt-6.1-sol"])
    provider_id = _create_provider(client)
    client.post("/api/providers/" + provider_id + "/key", json={"apiKey": "sk-test-123456"})
    response = client.post("/api/providers/" + provider_id + "/save-connect", json={"provider": {"baseUrl": "https://relay.example.com"}})
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["ok"] is True
    assert payload["saved"] is True
    assert payload["connected"] is True
    assert payload["modelCount"] == 3
    assert payload["message"].startswith("已连接，识别到 3 个模型")
    # 全部请求都是 GET，且只打免费模型列表 / 余额接口
    methods = [method for method, _ in fake_http["requests"]]
    assert methods and all(method == "GET" for method in methods)
    for _, url in fake_http["requests"]:
        lowered = url.lower()
        assert "chat/completions" not in lowered
        assert "/messages" not in lowered
        assert "generatecontent" not in lowered
        assert "/responses" not in lowered
        assert "/completions" not in lowered
    # 模型识别：图标 / 思考档位 / 已知价格
    models = {m["modelId"]: m for m in payload["models"]}
    assert models["deepseek-chat"]["icon"] == "deepseek"
    assert models["claude-sonnet-5-5"]["icon"] == "claude"
    assert models["gpt-6.1-sol"]["icon"] == "openai"
    assert models["deepseek-chat"]["reasoning"]["levels"]
    assert models["claude-sonnet-5-5"]["reasoning"]["levels"]
    # 已知模型用目录里已核实的价格；没核实的写 null（不编造）
    assert models["claude-sonnet-5-5"]["price"] is not None
    assert models["deepseek-chat"]["price"] is None


def test_save_connect_saves_config_even_when_models_unavailable(client, fake_http):
    fake_http["get"] = lambda url, headers: _FakeResponse(404, payload={"error": "not found"})
    provider_id = _create_provider(client)
    client.post("/api/providers/" + provider_id + "/key", json={"apiKey": "sk-test-123456"})
    response = client.post("/api/providers/" + provider_id + "/save-connect", json={})
    payload = response.json()
    assert payload["saved"] is True
    assert payload["connected"] is False
    assert payload["modelCount"] == 0
    assert "已保存" in payload["message"]
    assert "手动添加" in payload["message"]
    provider = client.get("/api/providers/" + provider_id).json()["provider"]
    assert provider["baseUrl"] == "https://relay.example.com"
    assert provider["extras"]["autoConnect"]["ok"] is False


def test_save_connect_without_key_saves_chinese_hint(client, fake_http):
    provider_id = _create_provider(client)
    payload = client.post("/api/providers/" + provider_id + "/save-connect", json={}).json()
    assert payload["saved"] is True
    assert payload["connected"] is False
    assert "已保存" in payload["message"]
    assert "Traceback" not in json.dumps(payload, ensure_ascii=False)


# --------------------------------------------------------------------------- 测试连接：只发一条生成请求
def _provider_with_models(client, fake_http):
    fake_http["get"] = _models_handler(["deepseek-flash", "deepseek-v4-pro"])
    provider_id = _create_provider(client, protocol="deepseek", baseUrl="https://api.deepseek.com", apiPath="/chat/completions")
    client.post("/api/providers/" + provider_id + "/key", json={"apiKey": "sk-test-123456"})
    client.post("/api/providers/" + provider_id + "/save-connect", json={})
    return provider_id


def test_test_connection_sends_exactly_one_generation_request(client, fake_http):
    provider_id = _provider_with_models(client, fake_http)
    fake_http["requests"] = []
    fake_http["bodies"] = []
    payload = client.post("/api/providers/" + provider_id + "/test", json={}).json()
    assert payload["ok"] is True
    assert payload["streamSupported"] is True
    assert payload["message"]
    post_requests = [(m, u) for m, u in fake_http["requests"] if m == "POST"]
    assert len(post_requests) == 1, post_requests
    assert "/chat/completions" in post_requests[0][1]
    body = fake_http["bodies"][0]
    assert body["messages"] == [{"role": "user", "content": "hi"}]
    assert int(body.get("max_tokens") or body.get("max_completion_tokens") or 999) <= 16


def test_test_connection_check_reasoning_sends_extra_requests(client, fake_http):
    provider_id = _provider_with_models(client, fake_http)
    level_count = len(next(m for m in _models_of(client, provider_id) if m["modelId"] == "deepseek-flash")["reasoning"]["levels"])
    fake_http["requests"] = []
    fake_http["bodies"] = []
    payload = client.post("/api/providers/" + provider_id + "/test", json={"checkReasoning": True}).json()
    assert payload["ok"] is True
    assert payload["reasoning"]["checked"] is True
    assert len(payload["reasoning"]["results"]) == level_count
    post_requests = [m for m, _ in fake_http["requests"] if m == "POST"]
    # 1 条主测试 + 每个档位各 1 条（前端已提示会额外产生费用）
    assert len(post_requests) == level_count + 1


def test_test_connection_without_key_is_chinese(client):
    response = client.post("/api/providers/prov-deepseek/test")
    payload = response.json()
    assert payload["ok"] is False
    assert payload["kind"] == "nokey"
    assert "API Key" in payload["message"]


# --------------------------------------------------------------------------- 家族 / 档位
@pytest.mark.parametrize(
    "model_id,family",
    [
        ("deepseek-v4-pro", "deepseek"),
        ("claude-sonnet-5-5", "claude"),
        ("gemini-3.8-flash", "gemini"),
        ("gpt-6.1-sol", "gpt"),
        ("o4-mini", "gpt"),
        ("grok-4.7", "grok"),
        ("kimi-k3", "kimi"),
        ("glm-5.2", "glm"),
        ("qwen3-max", "qwen"),
        ("doubao-seed-2", "doubao"),
        ("llama-3", "unknown"),
    ],
)
def test_family_detection(model_id, family):
    assert detect_family(model_id) == family


def test_every_family_has_reasoning_levels():
    for model_id in ("deepseek-v4-pro", "claude-sonnet-5-5", "gemini-3.8-flash", "gpt-6.1-sol", "grok-4.7", "kimi-k3", "glm-5.2", "qwen3-max", "doubao-seed-2"):
        assert family_reasoning(model_id)["levels"]


def test_forward_mode_model_suffix_changes_model_id(client, fake_http):
    """model_suffix：切档位等于换成对应模型 ID（-thinking）。"""
    fake_http["get"] = _models_handler(["deepseek-flash"])
    provider_id = _create_provider(client, protocol="openai", baseUrl="https://relay.example.com/v1", apiPath="/chat/completions")
    client.post("/api/providers/" + provider_id + "/key", json={"apiKey": "sk-test-123456"})
    client.post("/api/providers/" + provider_id + "/save-connect", json={})
    model = next(m for m in _models_of(client, provider_id) if m["modelId"] == "deepseek-flash")
    provider = client.get("/api/providers/" + provider_id).json()["provider"]
    provider["advanced"] = dict(provider.get("advanced") or {})
    provider["advanced"]["forwardMode"] = "model_suffix"
    built = adapter.build_request(provider, model, {"segments": [{"role": "user", "text": "hi"}], "sampling": {"max_tokens": 8}}, "sk", stream=False, reasoning_level="high")
    assert built["body"]["model"].endswith("-thinking")
    auto = adapter.build_request(provider, model, {"segments": [{"role": "user", "text": "hi"}], "sampling": {"max_tokens": 8}}, "sk", stream=False, reasoning_level="auto")
    assert not auto["body"]["model"].endswith("-thinking")
