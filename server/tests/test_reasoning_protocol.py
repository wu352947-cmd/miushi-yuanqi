"""gemini_level 的思考参数必须按协议分流。

线上故障（2026-11-12）：把 gemini-4-argon 的档位从「自动」调到「高」之后，
所有请求 400 —— openai 兼容端点收到了 Gemini 原生的 generationConfig。
上游原话：cannot be represented by google; use scoped provider_options
"""
from __future__ import annotations

from server.reasoning import build_reasoning_params


def _model(levels=None):
    return {
        "id": "m1",
        "modelId": "gemini-4-argon",
        "reasoning": {
            "mode": "gemini_level",
            "levels": levels or ["auto", "low", "medium", "high"],
            "defaultLevel": "auto",
            "supportsMinimal": False,
            "note": "thinkingLevel；无免费档、不提供 off",
        },
    }


def test_native_gemini_uses_generation_config():
    built = build_reasoning_params(_model(), "high", "gemini")
    assert built["params"]["generationConfig"]["thinkingConfig"]["thinkingLevel"] == "high"


def test_openai_gateway_uses_reasoning_effort():
    built = build_reasoning_params(_model(), "high", "openai")
    assert built["params"] == {"reasoning_effort": "high"}


def test_openai_gateway_never_sends_gemini_native_keys():
    """任何档位都不能把 Gemini 原生字段塞进 OpenAI 请求体，否则 400。"""
    for lv in ("low", "medium", "high"):
        built = build_reasoning_params(_model(), lv, "openai")
        blob = str(built["params"])
        for bad in ("generationConfig", "thinkingConfig", "thinkingLevel"):
            assert bad not in blob, "档位 %s 里混进了 %s" % (lv, bad)


def test_auto_sends_nothing_on_both_protocols():
    for proto in ("gemini", "openai"):
        built = build_reasoning_params(_model(), "auto", proto)
        assert built["params"] is None


def test_unknown_level_falls_back_without_crashing():
    built = build_reasoning_params(_model(), "最低", "openai")
    assert built.get("params") is None or "reasoning_effort" in built["params"]


def test_gemini_drops_penalty():
    """Gemini 没有 penalty 概念，带了直接 400：Penalty is not enabled for this model。

    预设「细腻散文」设了 presence_penalty=0.1 / frequency_penalty=0.2，
    所以切 Gemini 必挂、切 DeepSeek 正常 —— 这是很容易漏的一对参数。
    """
    for level in ("auto", "low", "medium", "high"):
        drop = build_reasoning_params(_model(), level, "openai").get("dropSampling") or []
        assert "presence_penalty" in drop, "档位 %s 没 drop presence_penalty" % level
        assert "frequency_penalty" in drop, "档位 %s 没 drop frequency_penalty" % level
