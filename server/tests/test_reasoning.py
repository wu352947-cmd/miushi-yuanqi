"""思考档位映射 + 请求体断言（依据 2026-11-11 官方文档）。"""

from __future__ import annotations

import pytest

from server.providers import (
    _norm_anthropic_usage, _norm_gemini_usage, _norm_openai_usage, _norm_responses_usage, build_request,
)
from server.reasoning import build_reasoning_params, reasoning_supported

PROMPT = {
    "segments": [{"role": "user", "text": "hi"}],
    "system_text": "sys",
    "sampling": {"temperature": 0.8, "top_p": 0.9, "max_tokens": 500, "presence_penalty": 0.1, "frequency_penalty": 0.1},
}


def model(mode, levels, default="auto", **kwargs):
    mid = kwargs.pop("modelId", "test-model")
    return {"id": "m1", "modelId": mid, "reasoning": {"mode": mode, "levels": levels, "defaultLevel": default, **kwargs}}


def req(model_obj, level, protocol="openai", stream=False):
    provider = {"protocol": protocol, "baseUrl": "https://example.test/v1", "apiPath": "/chat/completions"}
    return build_request(provider, model_obj, PROMPT, "k", stream=stream, reasoning_level=level)


def test_levels_and_defaults():
    m = model("deepseek", ["off", "low", "high", "max"], "high", modelId="deepseek-flash")
    assert reasoning_supported(m)
    assert build_reasoning_params(m, "medium")["level"] == "high"
    none = {"modelId": "x", "reasoning": {"mode": "none", "levels": []}}
    built = build_reasoning_params(none, "high")
    assert built["supported"] is False and built["params"] is None


@pytest.mark.parametrize("level,expected", [
    ("off", {"thinking": {"type": "disabled"}}),
    ("low", {"thinking": {"type": "enabled"}, "reasoning_effort": "low"}),
    ("high", {"thinking": {"type": "enabled"}, "reasoning_effort": "high"}),
    ("max", {"thinking": {"type": "enabled"}, "reasoning_effort": "max"}),
])
def test_deepseek_levels(level, expected):
    m = model("deepseek", ["off", "low", "high", "max"], "high", modelId="deepseek-flash")
    assert build_reasoning_params(m, level)["params"] == expected


@pytest.mark.parametrize("level", ["low", "high", "max"])
def test_deepseek_thinking_drops_sampling(level):
    m = model("deepseek", ["off", "low", "high", "max"], "high", modelId="deepseek-v4-pro")
    body = req(m, level)["body"]
    assert "temperature" not in body and "presence_penalty" not in body and "frequency_penalty" not in body
    assert body["thinking"] == {"type": "enabled"}


def test_deepseek_off_keeps_sampling():
    m = model("deepseek", ["off", "low", "high", "max"], "high", modelId="deepseek-flash")
    assert req(m, "off")["body"]["temperature"] == 0.8


@pytest.mark.parametrize("level,expected", [
    ("low", {"reasoning_effort": "low"}), ("medium", {"reasoning_effort": "medium"}),
    ("high", {"reasoning_effort": "high"}), ("xhigh", {"reasoning_effort": "xhigh"}),
    ("max", {"reasoning_effort": "max"}), ("off", {"reasoning_effort": "none"}),
])
def test_openai_chat_effort(level, expected):
    m = model("openai_effort", ["off", "auto", "low", "medium", "high", "xhigh", "max"], "medium", modelId="gpt-6-luna")
    assert build_reasoning_params(m, level)["params"] == expected


def test_openai_responses_effort_and_summary():
    m = model("openai_effort", ["low", "medium", "high"], "medium", modelId="gpt-6-astra")
    assert build_reasoning_params(m, "high", "openai_responses")["params"] == {"reasoning": {"effort": "high", "summary": "auto"}}
    assert build_reasoning_params(m, "auto", "openai_responses")["params"] == {"reasoning": {"summary": "auto"}}


def test_openai_chat_uses_max_completion_tokens():
    m = model("openai_effort", ["low", "high"], "low", modelId="gpt-6-astra")
    body = req(m, "low")["body"]
    assert "max_completion_tokens" in body and "max_tokens" not in body


def test_gpt6_astra_never_sends_none_and_gpt5_off_minimal():
    m = model("openai_effort", ["low", "medium", "high", "xhigh", "max"], "medium", modelId="gpt-6-astra")
    assert "off" not in m["reasoning"]["levels"]
    assert "none" not in str(build_reasoning_params(m, "off")["params"])
    g5 = model("openai_effort", ["off", "low", "medium", "high"], "auto", modelId="gpt-5")
    assert build_reasoning_params(g5, "off")["params"] == {"reasoning_effort": "minimal"}


@pytest.mark.parametrize("level,effort", [("low", "low"), ("medium", "medium"), ("high", "high"), ("xhigh", "xhigh"), ("max", "max")])
def test_anthropic_effort(level, effort):
    m = model("anthropic_effort", ["off", "auto", "low", "medium", "high", "xhigh", "max"], "high", modelId="claude-sonnet-5-5", offMode="between_tools")
    built = build_reasoning_params(m, level)
    assert built["params"]["output_config"] == {"effort": effort}
    assert built["params"]["thinking"] == {"type": "adaptive", "display": "summarized"}


def test_anthropic_off_modes():
    between = model("anthropic_effort", ["off", "auto", "high"], "high", modelId="claude-sonnet-5-5", offMode="between_tools")
    assert build_reasoning_params(between, "off")["params"] == {"thinking": {"type": "between_tools"}}
    disabled = model("anthropic_effort", ["off", "auto", "high"], "high", modelId="claude-haiku-5-5", offMode="disabled")
    assert build_reasoning_params(disabled, "off")["params"] == {"thinking": {"type": "disabled"}}
    no_off = model("anthropic_effort", ["auto", "low", "high"], "high", modelId="claude-opus-5-5", offMode="none")
    built = build_reasoning_params(no_off, "off")
    assert built["supported"] is False and "只能调深浅" in built["note"]


@pytest.mark.parametrize("level", ["low", "high", "xhigh", "max"])
def test_anthropic_never_sends_temperature_or_budget(level):
    m = model("anthropic_effort", ["off", "auto", "low", "medium", "high", "xhigh", "max"], "high", modelId="claude-sonnet-5-5")
    body = req(m, level, protocol="anthropic")["body"]
    assert "temperature" not in body and "top_p" not in body and "top_k" not in body
    assert "budget_tokens" not in str(body.get("thinking") or {})
    assert body["thinking"]["type"] == "adaptive"


def test_anthropic_xhigh_lifts_max_tokens():
    m = model("anthropic_effort", ["low", "high", "xhigh", "max"], "high", modelId="claude-opus-5")
    assert req(m, "xhigh", protocol="anthropic")["body"]["max_tokens"] >= 64000


def test_anthropic_usage_cache_split():
    usage = _norm_anthropic_usage({"input_tokens": 100, "cache_read_input_tokens": 50, "cache_creation_input_tokens": 20, "output_tokens": 30})
    assert usage["prompt_tokens"] == 170
    assert usage["cache_tokens"] == 50 and usage["cache_write_tokens"] == 20 and usage["output_tokens"] == 30


@pytest.mark.parametrize("level,thinking", [("low", "low"), ("medium", "medium"), ("high", "high")])
def test_gemini_level(level, thinking):
    m = model("gemini_level", ["auto", "low", "medium", "high"], "auto", modelId="gemini-4-argon")
    params = build_reasoning_params(m, level, "gemini")["params"]
    assert params == {"generationConfig": {"thinkingConfig": {"thinkingLevel": thinking, "includeThoughts": True}}}
    assert "thinkingBudget" not in str(params)


def test_gemini_off_and_no_mixed_fields():
    minimal = model("gemini_level", ["off", "auto", "low"], "auto", modelId="gemini-3.5-flash-lite", supportsMinimal=True)
    assert build_reasoning_params(minimal, "off", "gemini")["params"]["generationConfig"]["thinkingConfig"]["thinkingLevel"] == "minimal"
    no = model("gemini_level", ["auto", "low"], "auto", modelId="gemini-4-argon", supportsMinimal=False)
    assert build_reasoning_params(no, "off", "gemini")["supported"] is False
    m = model("gemini_level", ["auto", "low", "high"], "auto", modelId="gemini-3.8-flash")
    body = req(m, "high", protocol="gemini")["body"]
    gen = body.get("generationConfig", {})
    assert "temperature" not in gen and "topP" not in gen
    assert "thinkingLevel" in gen["thinkingConfig"] and "thinkingBudget" not in gen["thinkingConfig"]


def test_gemini25_budget_and_pro_off():
    m = model("gemini_budget", ["off", "auto", "low", "medium", "high"], "auto", modelId="gemini-2.5-flash")
    assert build_reasoning_params(m, "off")["params"]["generationConfig"]["thinkingConfig"]["thinkingBudget"] == 0
    pro = model("gemini_budget", ["auto", "low"], "auto", modelId="gemini-2.5-pro", offUnsupported=True)
    assert build_reasoning_params(pro, "off")["supported"] is False


def test_openrouter_efforts_and_mandatory():
    m = model("openrouter", ["off", "auto", "low", "medium", "high", "xhigh", "max"], "high", modelId="moonshotai/kimi-k3",
              supportedEfforts=["none", "low", "medium", "high", "xhigh", "max"], mandatory=False)
    assert build_reasoning_params(m, "off")["params"] == {"reasoning": {"effort": "none"}}
    assert build_reasoning_params(m, "auto")["params"] is None
    assert build_reasoning_params(m, "max")["params"] == {"reasoning": {"effort": "max"}}
    mandatory = dict(m)
    mandatory["reasoning"] = dict(m["reasoning"], mandatory=True)
    assert build_reasoning_params(mandatory, "off")["supported"] is False


@pytest.mark.parametrize("mode,mid,levels,level,key,value", [
    ("xai", "grok-4.7", ["auto", "low", "medium", "high", "xhigh"], "high", "reasoning_effort", "high"),
    ("qwen_thinking", "Qwen/Qwen3-235B-A22B", ["off", "auto", "low", "medium", "high"], "high", "thinking_budget", 32768),
    ("qwen_thinking", "qwen3.8-max", ["off", "auto", "low", "medium", "high", "xhigh"], "xhigh", "reasoning_effort", "xhigh"),
    ("kimi", "kimi-k3", ["auto", "low", "high", "max"], "max", "reasoning_effort", "max"),
    ("zhipu", "glm-5.3", ["low", "high", "max"], "max", "reasoning_effort", "max"),
    ("ark", "doubao-seed-2.1", ["off", "auto", "low", "medium", "high"], "low", "reasoning_effort", "low"),
    ("siliconflow_thinking", "DeepSeek-V4", ["off", "auto", "low", "high", "max"], "max", "reasoning_effort", "max"),
])
def test_other_providers(mode, mid, levels, level, key, value):
    m = model(mode, levels, "high", modelId=mid)
    assert build_reasoning_params(m, level)["params"][key] == value


def test_xai_kimi_never_send_sampling():
    x = model("xai", ["auto", "high"], "high", modelId="grok-4.7")
    xb = req(x, "high")["body"]
    assert "presence_penalty" not in xb and "frequency_penalty" not in xb
    k = model("kimi", ["auto", "low", "high", "max"], "max", modelId="kimi-k3")
    kb = req(k, "max")["body"]
    assert "temperature" not in kb and "top_p" not in kb and "presence_penalty" not in kb


def test_relay_suffix_switches_model_id():
    m = model("relay_suffix", ["off", "high"], "off", map={"off": "x", "high": "x-thinking"})
    m["modelId"] = "x"
    assert build_reasoning_params(m, "high")["params"] == {"model": "x-thinking"}


def test_usage_normalizers():
    o = _norm_openai_usage({"prompt_tokens": 100, "completion_tokens": 40, "prompt_tokens_details": {"cached_tokens": 30}, "completion_tokens_details": {"reasoning_tokens": 12}})
    assert (o["prompt_tokens"], o["cache_tokens"], o["output_tokens"], o["reasoning_tokens"]) == (100, 30, 40, 12)
    r = _norm_responses_usage({"input_tokens": 90, "output_tokens": 20, "input_tokens_details": {"cached_tokens": 10}, "output_tokens_details": {"reasoning_tokens": 7}})
    assert (r["prompt_tokens"], r["cache_tokens"], r["output_tokens"], r["reasoning_tokens"]) == (90, 10, 20, 7)
    g = _norm_gemini_usage({"promptTokenCount": 10, "candidatesTokenCount": 5, "thoughtsTokenCount": 3})
    assert g["output_tokens"] == 8 and g["reasoning_tokens"] == 3
