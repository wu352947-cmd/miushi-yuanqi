"""思考参数预览接口：必须与 server/reasoning.py 的计算结果完全一致。

前端那份重复的映射已经删除，这个测试用来锁住「唯一事实来源」，
以后改档位规则只要改 reasoning.py，这里会保证接口如实反映。
"""

from server import providers, reasoning


def _make_model(client, **extra):
    body = {
        "providerId": "prov-deepseek",
        "name": "预览测试模型",
        "modelId": "deepseek-v4",
        "reasoning": {
            "mode": "deepseek",
            "levels": ["off", "low", "medium", "high"],
            "defaultLevel": "medium",
        },
    }
    body.update(extra)
    response = client.post("/api/models", json=body)
    assert response.status_code == 200, response.text
    return response.json()["model"]


def test_preview_matches_backend_mapping(client):
    """接口返回的 params / level / dropSampling 跟后端函数逐字段一致。"""
    provider = client.post(
        "/api/providers",
        json={"name": "预览用 OpenAI 中转", "protocol": "openai", "baseUrl": "https://example.com/v1"},
    ).json()["provider"]
    protocol = providers.protocol_of(provider)
    model = _make_model(client, providerId=provider["id"])
    for level in ("off", "high"):
        response = client.get(
            "/api/models/" + model["id"] + "/reasoning-preview", params={"level": level}
        )
        assert response.status_code == 200, response.text
        data = response.json()
        expected = reasoning.build_reasoning_params(model, level, protocol)
        assert data["reasoning"]["params"] == expected["params"]
        assert data["reasoning"]["level"] == expected["level"]
        assert data["reasoning"]["dropSampling"] == expected["dropSampling"]
        assert data["reasoning"]["supported"] == expected["supported"]
        assert data["protocol"] == protocol
        # 有参数时 text 是 JSON 文本，没参数时是中文说明
        if expected["params"]:
            assert data["text"].lstrip().startswith("{")
        else:
            assert data["text"]


def test_preview_supports_openai_responses_protocol(client):
    """openai_responses 下 reasoning 参数要变成 reasoning.effort 形态。"""
    provider = client.post(
        "/api/providers",
        json={
            "name": "预览用 Responses 中转",
            "protocol": "openai",
            "baseUrl": "https://example.com/v1",
            "advanced": {"responseApi": True},
        },
    ).json()["provider"]
    model = client.post(
        "/api/models",
        json={
            "providerId": provider["id"],
            "name": "GPT 预览",
            "modelId": "gpt-6-astra",
            "reasoning": {
                "mode": "openai_effort",
                "levels": ["off", "low", "medium", "high", "xhigh"],
                "defaultLevel": "medium",
            },
        },
    ).json()["model"]
    data = client.get(
        "/api/models/" + model["id"] + "/reasoning-preview", params={"level": "high"}
    ).json()
    assert data["protocol"] == "openai_responses"
    assert data["reasoning"]["params"]["reasoning"]["effort"] == "high"
    assert data["reasoning"]["params"]["reasoning"]["summary"] == "auto"


def test_preview_without_reasoning_returns_note(client):
    """模型不能调思考时，params 为空，text 给出中文说明。"""
    model = _make_model(client, modelId="plain-model", reasoning={"mode": "none", "levels": []})
    data = client.get(
        "/api/models/" + model["id"] + "/reasoning-preview", params={"level": "high"}
    ).json()
    assert data["reasoning"]["supported"] is False
    assert data["reasoning"]["params"] is None
    assert data["text"]


def test_preview_defaults_to_model_default_level(client):
    """不传 level 时按模型默认档位算。"""
    model = _make_model(client)
    data = client.get("/api/models/" + model["id"] + "/reasoning-preview").json()
    assert data["reasoning"]["level"] == "medium"


def test_preview_unknown_model_is_404(client):
    response = client.get("/api/models/model-does-not-exist/reasoning-preview")
    assert response.status_code == 404
    assert response.json()["error"]["kind"] == "notfound"