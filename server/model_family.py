"""模型家族识别：官方图标 / 能力标签 / 已知价格 / 思考档位预设。

需求（第 D2 轮第一块第 2.c/2.d 条）：按模型 ID 识别家族
（deepseek / claude / gemini / gpt 与 o 系列 / grok / kimi / glm / qwen / doubao），
匹配官方图标、能力标签和已知价格，并按已有思考档位规则预设可用档位。

价格只复用目录里**已经核实的同 modelId**；没核实的一律 None（前端显示「价格待确认」），
不编造任何价格。
"""

from __future__ import annotations

import re
from typing import Any

# 家族识别顺序有讲究：先匹配更具体的
_FAMILY_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("claude", re.compile(r"claude|anthropic", re.I)),
    ("gemini", re.compile(r"gemini|palm|learnlm", re.I)),
    ("deepseek", re.compile(r"deepseek", re.I)),
    ("grok", re.compile(r"\bgrok\b|grok-", re.I)),
    ("kimi", re.compile(r"kimi|moonshot", re.I)),
    ("glm", re.compile(r"\bglm|chatglm|z-ai|zhipu", re.I)),
    ("qwen", re.compile(r"qwen|qwq|tongyi", re.I)),
    ("doubao", re.compile(r"doubao|seed-|volc", re.I)),
    ("gpt", re.compile(r"^gpt|^o\d|openai|^chatgpt|\bgpt-", re.I)),
]

FAMILY_ICONS = {
    "deepseek": "deepseek",
    "claude": "claude",
    "gemini": "gemini",
    "gpt": "openai",
    "grok": "grok",
    "kimi": "kimi",
    "glm": "glm",
    "qwen": "qwen",
    "doubao": "doubao",
    "unknown": "",
}

# 能力标签只按家族给「通行能力」，不编造具体上下文长度；视觉能力按家族主流型号判断。
_VISION_FAMILIES = {"claude", "gemini", "gpt"}


def detect_family(model_id: str) -> str:
    s = str(model_id or "").strip()
    if not s:
        return "unknown"
    for family, pattern in _FAMILY_RULES:
        if pattern.search(s):
            return family
    return "unknown"


def family_icon(model_id: str) -> str:
    return FAMILY_ICONS.get(detect_family(model_id), "")


def family_caps(model_id: str, reasoning: dict | None = None) -> dict[str, Any]:
    family = detect_family(model_id)
    levels = (reasoning or {}).get("levels") or []
    return {
        "vision": family in _VISION_FAMILIES,
        "tools": True,
        "reasoning": bool(levels),
    }


def _levels_model(model_id: str) -> str:
    return str(model_id or "").lower()


def family_reasoning(model_id: str) -> dict[str, Any]:
    """与前端 defaultReasoningFor() 同一套规则（第一块已完成，别另起一套）。"""
    s = _levels_model(model_id)
    if "claude" in s:
        return {
            "mode": "anthropic_effort",
            "levels": ["off", "auto", "low", "medium", "high", "xhigh", "max"],
            "defaultLevel": "high",
            "offMode": "disabled",
            "note": "Anthropic output_config.effort（5.x）",
        }
    if "gemini-2.5" in s:
        return {
            "mode": "gemini_budget",
            "levels": ["off", "auto", "low", "medium", "high"],
            "defaultLevel": "auto",
            "note": "2.5 用 thinkingBudget",
        }
    if "gemini" in s:
        return {
            "mode": "gemini_level",
            "levels": ["auto", "low", "medium", "high"],
            "defaultLevel": "auto",
            "supportsMinimal": bool(re.search(r"flash-lite|3\.6|3\.5-flash", s)),
            "note": "Gemini 3+ 用 thinkingLevel",
        }
    if "deepseek" in s:
        return {
            "mode": "deepseek",
            "levels": ["off", "low", "high", "max"],
            "defaultLevel": "high",
            "note": "DeepSeek thinking + reasoning_effort",
        }
    if "grok" in s:
        return {
            "mode": "xai",
            "levels": ["auto", "low", "medium", "high"] if "4.5" in s else ["auto", "low", "medium", "high", "xhigh"],
            "defaultLevel": "high",
            "note": "grok 推理模型用 reasoning_effort，不能关闭",
        }
    if "kimi" in s or "moonshot" in s:
        if "k2" in s:
            return {"mode": "kimi", "levels": ["off", "on"], "defaultLevel": "on", "note": "K2 系用 thinking 开关"}
        return {
            "mode": "kimi",
            "levels": ["auto", "low", "high", "max"],
            "defaultLevel": "max",
            "note": "Kimi K3 reasoning_effort，不能关闭",
        }
    if "glm" in s:
        return {"mode": "zhipu", "levels": ["low", "high", "max"], "defaultLevel": "max", "note": "GLM 默认 max，不能关闭"}
    if "qwen" in s or "qwq" in s:
        return {
            "mode": "qwen_thinking",
            "levels": ["off", "auto", "low", "medium", "high"],
            "defaultLevel": "auto",
            "note": "通义千问 enable_thinking",
        }
    if "doubao" in s or s.startswith("seed-"):
        return {
            "mode": "ark",
            "levels": ["off", "auto", "low", "medium", "high"],
            "defaultLevel": "auto",
            "note": "豆包 thinking / reasoning_effort",
        }
    if re.search(r"^o\d", s):
        return {
            "mode": "openai_effort",
            "levels": ["off", "auto", "low", "medium", "high", "xhigh"],
            "defaultLevel": "auto",
            "note": "o 系列 reasoning effort",
        }
    if "gpt-6" in s:
        no_off = bool(re.search(r"astra|sol", s))
        return {
            "mode": "openai_effort",
            "levels": (["low", "medium", "high", "xhigh", "max"] if no_off else ["off", "auto", "low", "medium", "high", "xhigh", "max"]),
            "defaultLevel": "medium",
            "note": "OpenAI reasoning effort",
        }
    if "gpt-5" in s or "gpt5" in s:
        return {
            "mode": "openai_effort",
            "levels": ["off", "auto", "low", "medium", "high"],
            "defaultLevel": "auto",
            "note": "gpt-5：off 映射 minimal",
        }
    return {"mode": "none", "levels": [], "defaultLevel": "off", "note": "未识别的模型：默认不带思考参数（只保留自动）"}


def infer_model(model_id: str, known: dict[str, Any] | None = None) -> dict[str, Any]:
    """按模型 ID 生成一条模型记录（不含 id / providerId）。

    known：目录里同 modelId 的已核实条目（有就复用图标 / 能力 / 已知价格 / 档位）。
    """
    model_id = str(model_id or "").strip()
    if known:
        price = known.get("price")
        reasoning = known.get("reasoning") or family_reasoning(model_id)
        return {
            "name": known.get("name") or model_id,
            "modelId": model_id,
            "icon": known.get("icon") or family_icon(model_id),
            "caps": known.get("caps") or family_caps(model_id, reasoning),
            "context": known.get("context") or 0,
            "favorite": False,
            "price": price,
            "reasoning": reasoning,
            "source": "detected",
        }
    reasoning = family_reasoning(model_id)
    return {
        "name": model_id,
        "modelId": model_id,
        "icon": family_icon(model_id),
        "caps": family_caps(model_id, reasoning),
        "context": 0,
        "favorite": False,
        "price": None,
        "reasoning": reasoning,
        "source": "detected",
    }
