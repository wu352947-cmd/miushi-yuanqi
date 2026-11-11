"""思考档位的唯一实现（依据 2026-11-11 官方文档）。

前端不再自己算这套映射，只通过 GET /api/models/{id}/reasoning-preview 展示这里的结果。
每个模型由 reasoning 配置决定可用档位：
  mode / levels / defaultLevel / note
可选：offMode（anthropic 5.x 的关闭方式）、supportsMinimal（gemini off）、map（relay_suffix）、
      supportedEfforts / mandatory（openrouter）。

返回：
  { supported, mode, level, params, note, dropSampling, dropStop, maxTokensMin, useMaxCompletionTokens }
"""

from __future__ import annotations

from typing import Any

REASON_TEXT = {
    "off": "关闭", "auto": "自动", "low": "低", "medium": "中",
    "high": "高", "xhigh": "很高", "max": "最高", "on": "开启", "minimal": "几乎不思考",
}
LEVEL_ORDER = ["off", "auto", "low", "medium", "high", "xhigh", "max"]


def reasoning_config(model: dict[str, Any] | None) -> dict[str, Any]:
    return dict((model or {}).get("reasoning") or {})


def reasoning_levels(model: dict[str, Any] | None) -> list[str]:
    r = reasoning_config(model)
    if r.get("mode") in (None, "", "none"):
        return []
    return [lv for lv in (r.get("levels") or []) if lv in REASON_TEXT]


def reasoning_supported(model: dict[str, Any] | None) -> bool:
    return bool(reasoning_levels(model))


def default_level(model: dict[str, Any] | None) -> str:
    levels = reasoning_levels(model)
    if not levels:
        return "off"
    d = reasoning_config(model).get("defaultLevel") or levels[0]
    return d if d in levels else levels[0]


def _base(model: dict[str, Any] | None, level: str | None) -> dict[str, Any]:
    return {
        "supported": False, "mode": "none", "level": level or "off", "params": None, "note": "",
        "dropSampling": [], "dropStop": False, "maxTokensMin": None, "useMaxCompletionTokens": False,
    }


def _effort(level: str, supported: list[str] | None = None) -> str:
    order = supported or ["low", "medium", "high", "xhigh", "max"]
    lv = level
    if lv == "max" and "max" not in order:
        lv = "xhigh" if "xhigh" in order else "high"
    if lv == "xhigh" and "xhigh" not in order:
        lv = "high"
    if lv not in order:
        lv = order[-1] if order else "high"
    return lv


def build_reasoning_params(model: dict[str, Any] | None, level: str | None, protocol: str = "openai") -> dict[str, Any]:
    out = _base(model, level)
    if not model:
        out["note"] = "还没有选模型"
        return out
    r = reasoning_config(model)
    levels = reasoning_levels(model)
    mode = r.get("mode") or "none"
    if mode in ("none", "") or not levels:
        out["note"] = "这个模型不能调思考深度，请求里不会带任何思考参数"
        return out
    lv = level if level in levels else (level if level in ("auto", "off") else default_level(model))
    if lv == "off" and "off" not in levels:
        out["supported"] = False
        out["note"] = "这个模型没有关闭档：思考默认开着，只能调深浅"
        return out
    out.update(supported=True, mode=mode, level=lv)
    mid = str(model.get("modelId") or "").lower()

    if mode == "deepseek":
        if lv == "off":
            out["params"] = {"thinking": {"type": "disabled"}}
            out["note"] = "thinking.type = disabled（关闭思考）"
        else:
            out["params"] = {"thinking": {"type": "enabled"}, "reasoning_effort": lv}
            out["dropSampling"] = ["temperature", "presence_penalty", "frequency_penalty"]
            out["note"] = "thinking.type = enabled，reasoning_effort = " + lv + "；官方说明开启思考时这 3 个参数无效，已不发"
        return out

    if mode == "openai_effort":
        if lv == "auto":
            if protocol == "openai_responses":
                out["params"] = {"reasoning": {"summary": "auto"}}
            out["note"] = "自动：不带 effort，交给模型默认值"
            return out
        if lv == "off":
            if "gpt-5" in mid and "gpt-6" not in mid:
                eff = "minimal"
                out["note"] = "gpt-5 不支持 none，关闭时发 minimal"
            else:
                eff = "none"
                out["note"] = "reasoning effort = none"
        else:
            eff = lv
            out["note"] = "reasoning effort = " + eff
        if protocol == "openai_responses":
            out["params"] = {"reasoning": {"effort": eff, "summary": "auto"}}
        else:
            out["params"] = {"reasoning_effort": eff}
            out["useMaxCompletionTokens"] = True
        return out

    if mode == "anthropic_effort":
        out["dropSampling"] = ["temperature", "top_p", "top_k"]
        if lv == "auto":
            out["note"] = "自动：不发 output_config，交给模型默认值"
            return out
        if lv == "off":
            off_mode = r.get("offMode") or "disabled"
            if off_mode == "disabled":
                out["params"] = {"thinking": {"type": "disabled"}}
                out["note"] = "thinking.type = disabled（关闭思考）"
            elif off_mode == "between_tools":
                out["params"] = {"thinking": {"type": "between_tools"}}
                out["note"] = "thinking.type = between_tools（这家不允许 disabled）"
            else:
                out["supported"] = False
                out["params"] = None
                out["note"] = "这个模型思考一直开着，不能关闭，只能调深浅"
            return out
        eff = _effort(lv, ["low", "medium", "high", "xhigh", "max"])
        out["params"] = {"output_config": {"effort": eff}, "thinking": {"type": "adaptive", "display": "summarized"}}
        if eff in ("xhigh", "max"):
            out["maxTokensMin"] = 64000
            out["note"] = "output_config.effort = " + eff + "，max_tokens 至少提到 64000"
        else:
            out["note"] = "output_config.effort = " + eff
        return out

    if mode == "anthropic_budget":
        if lv in ("off", "auto"):
            out["note"] = "关闭或不带 budget：请求里不发送 thinking"
            return out
        budget = {"low": 2048, "medium": 8192, "high": 24576}.get(lv, 8192)
        out["params"] = {"thinking": {"type": "enabled", "budget_tokens": budget}}
        out["maxTokensMin"] = budget + 4096
        out["note"] = f"thinking.budget_tokens = {budget}，max_tokens 至少要大于 budget"
        return out

    if mode == "gemini_level":
        # Gemini 没有 penalty 概念，带了会直接 400：Penalty is not enabled for this model
        out["dropSampling"] = [
            "temperature", "top_p", "top_k", "presence_penalty", "frequency_penalty",
        ]
        gl = [x for x in ["low", "medium", "high"] if x in (r.get("levels") or ["low", "medium", "high"])]
        # 原生 Gemini API 用 generationConfig.thinkingConfig；
        # OpenAI 兼容网关（OpenCode Go 等）不认这个名字，会把整包当参数校验失败：
        #   400 generationConfig: cannot be represented by google
        # 这些网关只接受 reasoning_effort，所以必须按协议分流。
        native = protocol == "gemini"
        if lv == "auto":
            out["note"] = "自动：不发 thinkingLevel，交给模型默认值"
            return out
        if lv == "off":
            if r.get("supportsMinimal"):
                if native:
                    out["params"] = {"generationConfig": {"thinkingConfig": {"thinkingLevel": "minimal", "includeThoughts": True}}}
                    out["note"] = "thinkingLevel = minimal（几乎不思考）"
                else:
                    out["params"] = {"reasoning_effort": "minimal"}
                    out["note"] = "reasoning_effort = minimal（几乎不思考）"
            else:
                out["supported"] = False
                out["params"] = None
                out["note"] = "这个 Gemini 模型不提供关闭：minimal 会报错，只能选自动 / 低 / 中 / 高"
            return out
        lv2 = _effort(lv, gl or ["low", "medium", "high"])
        if native:
            out["params"] = {"generationConfig": {"thinkingConfig": {"thinkingLevel": lv2, "includeThoughts": True}}}
            out["note"] = "thinkingConfig.thinkingLevel = " + lv2 + "（只发 level，不发 budget）"
        else:
            out["params"] = {"reasoning_effort": lv2}
            out["note"] = "reasoning_effort = " + lv2 + "（OpenAI 兼容网关不认 Gemini 原生字段）"
        return out

    if mode == "gemini_budget":
        if lv == "off" and r.get("offUnsupported"):
            out["supported"] = False
            out["params"] = None
            out["note"] = "2.5 Pro 不能关闭思考（budget=0 会 400）"
            return out
        budget = {"off": 0, "auto": -1, "low": 1024, "medium": 8192, "high": 24576}.get(lv, -1)
        if lv in ("xhigh", "max"):
            budget = 24576
        out["params"] = {"generationConfig": {"thinkingConfig": {"thinkingBudget": budget}}}
        out["note"] = f"thinkingConfig.thinkingBudget = {budget}（只发 budget，不发 level）"
        return out

    if mode == "openrouter":
        efforts = [str(x) for x in (r.get("supportedEfforts") or [])]
        mandatory = bool(r.get("mandatory"))
        if lv == "off":
            if "none" in efforts and not mandatory:
                out["params"] = {"reasoning": {"effort": "none"}}
                out["note"] = "reasoning.effort = none"
            else:
                out["supported"] = False
                out["note"] = "这个模型默认就在思考，不能关闭"
            return out
        if lv == "auto":
            out["note"] = "自动：不发 reasoning（enabled=true 官方定义是 medium，不是自动）"
            return out
        eff = _effort(lv, efforts or ["low", "medium", "high", "xhigh", "max"])
        out["params"] = {"reasoning": {"effort": eff}}
        out["note"] = "reasoning.effort = " + eff
        return out

    if mode == "xai":
        if lv == "auto":
            out["note"] = "自动：不发 reasoning_effort"
            return out
        eff = _effort(lv, [x for x in ["low", "medium", "high", "xhigh"] if x in levels] or ["low", "medium", "high"])
        out["params"] = {"reasoning_effort": eff}
        out["dropSampling"] = ["presence_penalty", "frequency_penalty"]
        out["dropStop"] = True
        out["note"] = "reasoning_effort = " + eff + "；grok 推理模型不发 penalty / stop"
        return out

    if mode == "qwen_thinking":
        if lv == "off":
            out["params"] = {"enable_thinking": False}
            out["note"] = "enable_thinking = false"
            return out
        if lv == "auto":
            out["note"] = "自动：不发 enable_thinking，交给模型默认"
            return out
        if "qwen3.8-max" in mid:
            eff = _effort(lv, ["low", "medium", "high", "xhigh"])
            out["params"] = {"enable_thinking": True, "reasoning_effort": eff}
            out["note"] = "enable_thinking = true，reasoning_effort = " + eff + "（不同时发 thinking_budget）"
        else:
            budget = {"low": 2048, "medium": 8192, "high": 32768}.get(lv, 8192)
            if lv in ("xhigh", "max"):
                budget = 32768
            out["params"] = {"enable_thinking": True, "thinking_budget": budget}
            out["note"] = "enable_thinking = true，thinking_budget = " + str(budget)
        return out

    if mode == "kimi":
        out["dropSampling"] = ["temperature", "top_p", "presence_penalty", "frequency_penalty"]
        if "k2" in mid:
            enabled = lv not in ("off",)
            out["params"] = {"thinking": {"type": "enabled" if enabled else "disabled"}}
            out["note"] = "thinking.type = " + ("enabled" if enabled else "disabled") + "（K2 系 12 月底下线）"
            return out
        if lv == "auto":
            out["note"] = "自动：不发 reasoning_effort，Kimi 默认最高"
            return out
        eff = _effort(lv, [x for x in ["low", "high", "max"] if x in levels] or ["low", "high", "max"])
        out["params"] = {"reasoning_effort": eff}
        out["note"] = "reasoning_effort = " + eff + "；Kimi 固定采样参数，一律不发"
        return out

    if mode == "zhipu":
        if lv == "off":
            out["params"] = {"thinking": {"type": "disabled"}}
            out["note"] = "thinking.type = disabled"
            return out
        eff = _effort(lv, [x for x in ["low", "high", "max"] if x in levels] or ["low", "high", "max"])
        out["params"] = {"thinking": {"type": "enabled"}, "reasoning_effort": eff}
        out["note"] = "thinking.type = enabled，reasoning_effort = " + eff
        return out

    if mode == "ark":
        if lv == "off":
            out["params"] = {"thinking": {"type": "disabled"}}
            out["note"] = "thinking.type = disabled"
            return out
        if lv == "auto":
            out["note"] = "自动：不发 thinking / reasoning_effort"
            return out
        eff = "high" if lv in ("xhigh", "max") else _effort(lv, ["low", "medium", "high"])
        out["params"] = {"reasoning_effort": eff}
        out["note"] = "reasoning_effort = " + eff + ("（Seed 2.1 上 xhigh/max 收敛为 high）" if lv in ("xhigh", "max") else "")
        return out

    if mode == "siliconflow_thinking":
        if lv == "off":
            out["params"] = {"enable_thinking": False}
            out["note"] = "enable_thinking = false"
            return out
        if lv == "auto":
            out["note"] = "自动：不发 enable_thinking"
            return out
        if ("deepseek-v4" in mid) or ("glm-5.2" in mid) or ("glm-5-2" in mid):
            eff = "max" if lv in ("max", "xhigh") else "high"
            out["params"] = {"reasoning_effort": eff}
            out["note"] = "DeepSeek-V4 / GLM-5.2 用 reasoning_effort = " + eff
            return out
        budget = {"low": 2048, "medium": 8192, "high": 32768}.get(lv, 8192)
        if lv in ("xhigh", "max"):
            budget = 32768
        out["params"] = {"enable_thinking": True, "thinking_budget": budget}
        out["note"] = "enable_thinking = true，thinking_budget = " + str(budget) + "（范围 128–32768）"
        return out

    if mode == "relay_suffix":
        target = (r.get("map") or {}).get(lv) or model.get("modelId")
        out["params"] = {"model": target}
        out["note"] = "这家用模型名区分档位：切到 " + str(target)
        return out

    out["note"] = "未知的思考方式，先不带参数"
    return out
