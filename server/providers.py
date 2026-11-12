"""协议适配：把内部消息结构翻译成各家的请求体，转发流式响应并解析。

支持协议：openai（OpenAI 兼容 / DeepSeek / OpenRouter / 中转站）、
openai_responses、anthropic、gemini。浏览器不再直连任何模型接口。

安全：API Key 只在服务端使用；日志 / 返回给前端的 URL 一律脱敏。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from typing import Any, AsyncIterator
from urllib.parse import quote, urlsplit

import httpx

from . import __version__ as APP_VERSION
from .errors import classify_api_error, reasoning_related_error
from .prompts import estimate_tokens
from .reasoning import build_reasoning_params, default_level
from .url_normalize import base_from_models_url, join_base_path, models_candidates

TEST_TIMEOUT = 8.0

# OpenCode Go / 按量 Console 要求自报身份，并在每次请求带稳定会话头。
# https://opencode.ai/docs/go — User-Agent 不能是 HTTP 库默认名，
# x-opencode-session 同一段对话必须复用，不能每次随机。
OPENCODE_USER_AGENT = "miushi-yuanqi/" + str(APP_VERSION or "0.1.0")
OPENCODE_SESSION_MODELS = "miushi-yuanqi-models"
OPENCODE_SESSION_TEST = "miushi-yuanqi-test"
OPENCODE_SESSION_BALANCE = "miushi-yuanqi-balance"
OPENCODE_SESSION_CHAT = "miushi-yuanqi-chat"
_SESSION_UNSAFE = re.compile(r"[^A-Za-z0-9._~+-]")

# 中转站转发方式（第 D2 轮第一块第 5 条）：默认 auto，可在高级设置里改
FORWARD_MODES = (
    "auto",
    "openai_compat_translate",
    "openai_compat_passthrough",
    "native_anthropic",
    "native_gemini",
    "model_suffix",
)

MOCK_PULL: dict[str, list[str]] = {
    "deepseek": ["deepseek-flash", "deepseek-v4-pro"],
    "openai": ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra", "gpt-6.1-terra"],
    "openai_responses": ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"],
    "anthropic": ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5", "claude-opus-5-5"],
    "gemini": ["gemini-3.8-flash", "gemini-4-argon", "gemini-3.5-flash-lite"],
    "openrouter": ["openai/gpt-6.1-sol", "anthropic/claude-sonnet-5.5", "moonshotai/kimi-k3", "x-ai/grok-4.7"],
    "xai": ["grok-4.7", "grok-4.6", "grok-4.5"],
    "qwen": ["qwen3.8-max", "qwen3.7-plus", "qwen3.5-flash"],
    "kimi": ["kimi-k3", "kimi-k3.1-pro"],
    "zhipu": ["glm-5.3", "glm-5.3-flash", "glm-5.2"],
    "ark": ["doubao-seed-2.1", "doubao-seed-2.1-flash"],
    "siliconflow": ["deepseek-ai/DeepSeek-V4", "Qwen/Qwen3-235B-A22B", "zai-org/GLM-5.2"],
}


def mock_enabled() -> bool:
    return (os.environ.get("MSYQ_MOCK") or "").strip().lower() in ("1", "true", "yes", "on")


def mock_400_enabled() -> bool:
    return (os.environ.get("MSYQ_MOCK_400") or "").strip().lower() in ("1", "true", "yes", "on")


# --------------------------------------------------------------------------- URL / 头
def _join(base: str, path: str) -> str:
    base = (base or "").rstrip("/")
    path = path or ""
    if not path:
        return base
    if not path.startswith("/"):
        path = "/" + path
    return base + path


def redact_url(url: str) -> str:
    """把 URL 里的 key=xxx 替换掉，避免把 Key 带进日志或响应。"""
    return re.sub(r"([?&](?:key|api_key|apiKey)=)[^&]+", r"\1••••", url or "")


def forward_mode(provider: dict[str, Any]) -> str:
    """中转站转发方式：默认 auto（按协议 + 模型家族自动判断）。"""
    mode = str(((provider or {}).get("advanced") or {}).get("forwardMode") or "auto").strip()
    return mode if mode in FORWARD_MODES else "auto"


def protocol_of(provider: dict[str, Any]) -> str:
    mode = forward_mode(provider)
    if mode == "native_anthropic":
        return "anthropic"
    if mode == "native_gemini":
        return "gemini"
    proto = (provider or {}).get("protocol") or "openai"
    advanced = (provider or {}).get("advanced") or {}
    if proto == "openai" and advanced.get("responseApi"):
        return "openai_responses"
    return proto


def _forward_model(provider: dict[str, Any], model: dict[str, Any], level: str | None) -> dict[str, Any]:
    """按转发方式调整模型（模型名区分档位 / 翻译成 OpenAI 参数）。"""
    mode = forward_mode(provider)
    item = dict(model or {})
    reasoning = dict(item.get("reasoning") or {})
    levels = [lv for lv in (reasoning.get("levels") or []) if lv]
    if mode == "model_suffix":
        suffix = str(((provider or {}).get("advanced") or {}).get("suffix") or "-thinking")
        extra_map = dict(reasoning.get("map") or {})
        mapping: dict[str, str] = {}
        for lv in levels:
            mapping[lv] = item.get("modelId") or ""
        mapping["off"] = item.get("modelId") or ""
        mapping["auto"] = item.get("modelId") or ""
        for lv in levels:
            if lv not in ("off", "auto"):
                mapping[lv] = str(item.get("modelId") or "") + suffix
        mapping.update(extra_map)
        item["reasoning"] = {
            "mode": "relay_suffix",
            "levels": levels or ["off", "auto"],
            "defaultLevel": reasoning.get("defaultLevel") or "off",
            "map": mapping,
            "note": "中转站用模型名区分档位（model_suffix）",
        }
        return item
    if mode == "openai_compat_translate":
        translated = [lv for lv in ("off", "auto", "low", "medium", "high", "xhigh", "max") if lv in levels]
        if not translated:
            translated = ["low", "medium", "high"]
        item["reasoning"] = {
            "mode": "openai_effort",
            "levels": translated,
            "defaultLevel": reasoning.get("defaultLevel") if reasoning.get("defaultLevel") in translated else translated[0],
            "note": "中转站只吃 OpenAI 参数：思考档位翻译成 reasoning_effort",
        }
        return item
    # auto / passthrough / native_*：按模型家族原生参数；native_* 的协议已由 protocol_of 处理
    return item


def models_url(provider: dict[str, Any], api_key: str = "") -> str:
    base = str((provider or {}).get("baseUrl") or "").rstrip("/")
    proto = protocol_of(provider)
    if proto == "gemini":
        path = "/v1beta/models" if not base.endswith("/v1beta") else "/models"
        if api_key:
            path += "?key=" + quote(api_key, safe="")
        return base + path
    if proto == "anthropic":
        return join_base_path(base, "/v1/models")
    return join_base_path(base, "/models")


def models_url_candidates(provider: dict[str, Any], api_key: str = "") -> list[str]:
    """按协议优先 + 只填域名时 /v1/models 与 /models 都试，用于自动识别接口格式。"""
    base = str((provider or {}).get("baseUrl") or "").rstrip("/")
    if not base:
        return []
    urls: list[str] = []

    def push(url: str) -> None:
        if url and url not in urls:
            urls.append(url)

    push(models_url(provider, api_key))
    proto = protocol_of(provider)
    for alt in ("openai", "anthropic", "gemini"):
        if alt == proto:
            continue
        if alt == "gemini":
            path = "/v1beta/models" if not base.endswith("/v1beta") else "/models"
            if api_key:
                path += "?key=" + quote(api_key, safe="")
            push(base + path)
        elif alt == "anthropic":
            push(join_base_path(base, "/v1/models"))
        else:
            push(join_base_path(base, "/models"))
    # 只填域名（没有 /vN 路径）时按需求依次免费试 {base}/v1/models 和 {base}/models
    for url in models_candidates(base, proto):
        push(url)
    return urls


def chat_url(provider: dict[str, Any], model: dict[str, Any], stream: bool, api_key: str = "") -> str:
    base = str((provider or {}).get("baseUrl") or "").rstrip("/")
    proto = protocol_of(provider)
    path = str((provider or {}).get("apiPath") or "")
    if proto == "openai_responses" and path in ("", "/chat/completions", "/v1/chat/completions"):
        path = "/responses"
    if not path:
        path = {
            "openai_responses": "/responses",
            "anthropic": "/v1/messages",
            "gemini": "/v1beta/models/{model}:generateContent",
        }.get(proto, "/chat/completions")
    model_key = str((model or {}).get("modelId") or "")
    if "{model}" in path:
        path = path.replace("{model}", model_key)
    if proto == "gemini":
        if stream:
            path = path.replace(":generateContent", ":streamGenerateContent")
            sep = "&" if "?" in path else "?"
            path = path + sep + "alt=sse"
            if api_key:
                path += "&key=" + quote(api_key, safe="")
    return _join(base, path)


def is_opencode_url(url: str) -> bool:
    """是否为 OpenCode Console / Go 的出站地址。

    只认主机 opencode.ai，且路径以 /inference（含 /inference/go 与按量 /inference）
    或 /zen/go 开头。其它主机、文档页、以及只是路径里碰巧出现这些词的地址都不算。
    """
    raw = (url or "").strip()
    if not raw:
        return False
    try:
        parts = urlsplit(raw)
    except ValueError:
        return False
    host = (parts.hostname or "").rstrip(".").lower()
    if host != "opencode.ai":
        return False
    segments = [segment for segment in (parts.path or "").split("/") if segment]
    if not segments:
        return False
    head = segments[0].casefold()
    if head == "inference":
        return True
    return head == "zen" and len(segments) > 1 and segments[1].casefold() == "go"


def _stable_session(session_id: str | None, fallback: str) -> str:
    """会话头要稳定，且不能带换行。空的用固定兜底，不每次新造一个。"""
    raw = str(session_id or "")
    raw = raw.split("\r", 1)[0].split("\n", 1)[0].strip()
    cleaned = _SESSION_UNSAFE.sub("", raw)
    if not cleaned:
        return fallback
    return cleaned[:128]


def opencode_request_headers(
    url: str,
    session_id: str | None = None,
    fallback: str = OPENCODE_SESSION_CHAT,
) -> dict[str, str]:
    """OpenCode 地址才加 User-Agent 与 x-opencode-session；其它地址不加。"""
    if not is_opencode_url(url):
        return {}
    return {
        "User-Agent": OPENCODE_USER_AGENT,
        "x-opencode-session": _stable_session(session_id, fallback),
    }


def _headers(
    provider: dict[str, Any],
    api_key: str,
    url: str = "",
    session_id: str | None = None,
    session_fallback: str = OPENCODE_SESSION_CHAT,
) -> dict[str, str]:
    proto = protocol_of(provider)
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if proto == "anthropic":
        headers["x-api-key"] = api_key
        headers["anthropic-version"] = "2023-06-01"
    elif proto != "gemini":
        headers["Authorization"] = "Bearer " + api_key
        if proto == "openrouter":
            headers["HTTP-Referer"] = "http://localhost/"
            headers["X-Title"] = "miushi-yuanqi"
    headers.update(opencode_request_headers(url, session_id, session_fallback))
    return headers


def _provider_timeout(provider: dict[str, Any], fallback: float = 60.0) -> float:
    adv = (provider or {}).get("advanced") or {}
    try:
        value = float(adv.get("timeout") or fallback)
    except (TypeError, ValueError):
        value = fallback
    return max(5.0, min(value, 600.0))


# --------------------------------------------------------------------------- 请求体
def _sampling_fields(sampling: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if sampling.get("temperature") is not None:
        out["temperature"] = float(sampling["temperature"])
    if sampling.get("top_p") is not None:
        out["top_p"] = float(sampling["top_p"])
    if sampling.get("max_tokens") is not None:
        out["max_tokens"] = int(sampling["max_tokens"])
    if sampling.get("frequency_penalty") is not None:
        out["frequency_penalty"] = float(sampling["frequency_penalty"])
    if sampling.get("presence_penalty") is not None:
        out["presence_penalty"] = float(sampling["presence_penalty"])
    return out


def _merge_messages(segments: list[dict[str, Any]], start_with_user: bool = True) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for seg in segments:
        text = str(seg.get("text") or "")
        if not text.strip():
            continue
        role = seg.get("role") or "user"
        if out and out[-1]["role"] == role:
            out[-1]["content"] += "\n\n" + text
        else:
            out.append({"role": role, "content": text})
    if start_with_user and out and out[0]["role"] == "assistant":
        out.insert(0, {"role": "user", "content": "（开始）"})
    return out


def build_request(
    provider: dict[str, Any],
    model: dict[str, Any],
    prompt: dict[str, Any],
    api_key: str,
    stream: bool = True,
    disable_reasoning: bool = False,
    reasoning_level: str | None = None,
    drop_sampling: list[str] | None = None,
    session_id: str | None = None,
) -> dict[str, Any]:
    """返回 {url, headers, body, kind, model_key, reasoning}。

    session_id 是这段对话的稳定 id（一般用聊天 id）。OpenCode 会把它放进
    x-opencode-session；其它提供商忽略。
    """
    proto = protocol_of(provider)
    segments = prompt.get("segments") or []
    sampling = prompt.get("sampling") or {}
    level = reasoning_level if reasoning_level is not None else default_level(model)
    # 中转站转发方式：model_suffix 换模型 ID / translate 翻译成 OpenAI 参数
    model = _forward_model(provider, model, level)
    model_key = str(model.get("modelId") or "")
    built = build_reasoning_params(model, level, proto)
    params = None if disable_reasoning else built.get("params")
    drop = set(drop_sampling if drop_sampling is not None else (built.get("dropSampling") or []))
    if disable_reasoning:
        drop |= set(built.get("dropSampling") or [])
    url = chat_url(provider, model, stream, api_key)
    body: dict[str, Any] = {}

    if proto == "anthropic":
        system_text = prompt.get("system_text") or ""
        messages = _merge_messages([s for s in segments if s.get("role") != "system"], start_with_user=True)
        max_tokens = int(sampling.get("max_tokens") or 1200)
        body = {
            "model": model_key,
            "messages": messages,
            "max_tokens": max_tokens,
            "stream": stream,
        }
        if system_text:
            body["system"] = system_text
        if sampling.get("temperature") is not None and "temperature" not in drop:
            body["temperature"] = float(sampling["temperature"])
        if sampling.get("top_p") is not None and "top_p" not in drop:
            body["top_p"] = float(sampling["top_p"])
        if params:
            if params.get("max_tokens"):
                body["max_tokens"] = int(params["max_tokens"])
            for key in ("thinking", "output_config"):
                if params.get(key):
                    body[key] = params[key]
        if built.get("maxTokensMin"):
            body["max_tokens"] = min(128000, max(int(body.get("max_tokens") or 1200), int(built["maxTokensMin"])))
        if "thinking" in body and body["thinking"].get("type") in ("enabled", "adaptive") and "display" not in body["thinking"]:
            body["thinking"]["display"] = "summarized"
        for field in drop:
            body.pop(field, None)
        return {"url": url, "headers": _headers(provider, api_key, url, session_id), "body": body, "kind": "anthropic", "model_key": model_key, "reasoning": built}

    if proto == "gemini":
        system_text = prompt.get("system_text") or ""
        contents: list[dict[str, Any]] = []
        for msg in _merge_messages([s for s in segments if s.get("role") != "system"], start_with_user=True):
            role = "model" if msg["role"] == "assistant" else "user"
            if contents and contents[-1]["role"] == role:
                contents[-1]["parts"].append({"text": msg["content"]})
            else:
                contents.append({"role": role, "parts": [{"text": msg["content"]}]})
        gen: dict[str, Any] = {}
        if sampling.get("temperature") is not None and "temperature" not in drop:
            gen["temperature"] = float(sampling["temperature"])
        if sampling.get("top_p") is not None and "topP" not in drop and "top_p" not in drop:
            gen["topP"] = float(sampling["top_p"])
        if sampling.get("max_tokens") is not None:
            gen["maxOutputTokens"] = int(sampling["max_tokens"])
        if params and isinstance(params.get("generationConfig"), dict):
            gen.update(params["generationConfig"])
        tc = gen.get("thinkingConfig")
        if isinstance(tc, dict):
            if "thinkingLevel" in tc:
                tc.pop("thinkingBudget", None)
            elif "thinkingBudget" in tc:
                tc.pop("thinkingLevel", None)
        if contents and contents[-1].get("role") == "model":
            contents.append({"role": "user", "parts": [{"text": "（继续）"}]})
        body = {"contents": contents, "generationConfig": gen}
        if system_text:
            body["systemInstruction"] = {"parts": [{"text": system_text}]}
        return {"url": url, "headers": _headers(provider, api_key, url, session_id), "body": body, "kind": "gemini", "model_key": model_key, "reasoning": built}

    if proto == "openai_responses":
        system_text = prompt.get("system_text") or ""
        input_items = []
        for seg in segments:
            if seg.get("role") == "system":
                continue
            role = "assistant" if seg.get("role") == "assistant" else "user"
            input_items.append({"role": role, "content": str(seg.get("text") or "")})
        body = {"model": model_key, "input": input_items, "stream": stream, "store": False}
        if system_text:
            body["instructions"] = system_text
        for key, value in _sampling_fields(sampling).items():
            if key in drop:
                continue
            if key == "max_tokens":
                body["max_output_tokens"] = value
            elif key in ("temperature", "top_p"):
                body[key] = value
        if params:
            body.update(params)
            if params.get("model"):
                body["model"] = params["model"]
                model_key = str(params["model"])
        return {"url": url, "headers": _headers(provider, api_key, url, session_id), "body": body, "kind": "responses", "model_key": model_key, "reasoning": built}

    # OpenAI 兼容 / DeepSeek / OpenRouter / 中转站
    messages = []
    for seg in segments:
        text = str(seg.get("text") or "")
        if not text.strip():
            continue
        messages.append({"role": seg.get("role") or "user", "content": text})
    body = {"model": model_key, "messages": messages, "stream": stream}
    if stream:
        body["stream_options"] = {"include_usage": True}
    for key, value in _sampling_fields(sampling).items():
        if key in drop:
            continue
        body[key] = value
    if built.get("dropStop"):
        body.pop("stop", None)
    if params:
        body.update(params)
        if params.get("model"):
            body["model"] = params["model"]
            model_key = str(params["model"])
    if built.get("useMaxCompletionTokens") and "max_tokens" in body:
        body["max_completion_tokens"] = body.pop("max_tokens")
    return {"url": url, "headers": _headers(provider, api_key, url, session_id), "body": body, "kind": "openai", "model_key": model_key, "reasoning": built}


# --------------------------------------------------------------------------- 响应解析
def _norm_openai_usage(usage: dict[str, Any]) -> dict[str, int]:
    prompt = int(usage.get("prompt_tokens") or 0)
    output = int(usage.get("completion_tokens") or 0)
    cached = 0
    details = usage.get("prompt_tokens_details") or {}
    if isinstance(details, dict):
        cached = int(details.get("cached_tokens") or 0)
    if not cached:
        cached = int(usage.get("prompt_cache_hit_tokens") or 0)
    reasoning = 0
    odetails = usage.get("completion_tokens_details") or {}
    if isinstance(odetails, dict):
        reasoning = int(odetails.get("reasoning_tokens") or 0)
    return {
        "prompt_tokens": prompt,
        "cache_tokens": cached,
        "cache_write_tokens": 0,
        "output_tokens": output,
        "reasoning_tokens": reasoning,
        "total_tokens": int(usage.get("total_tokens") or (prompt + output)),
    }


def _norm_responses_usage(usage: dict[str, Any]) -> dict[str, int]:
    """OpenAI Responses：input_tokens / output_tokens / input_tokens_details.cached_tokens。"""
    prompt = int(usage.get("input_tokens") or usage.get("prompt_tokens") or 0)
    output = int(usage.get("output_tokens") or usage.get("completion_tokens") or 0)
    cached = 0
    details = usage.get("input_tokens_details") or {}
    if isinstance(details, dict):
        cached = int(details.get("cached_tokens") or 0)
    reasoning = 0
    odetails = usage.get("output_tokens_details") or {}
    if isinstance(odetails, dict):
        reasoning = int(odetails.get("reasoning_tokens") or 0)
    return {
        "prompt_tokens": prompt,
        "cache_tokens": cached,
        "cache_write_tokens": 0,
        "output_tokens": output,
        "reasoning_tokens": reasoning,
        "total_tokens": int(usage.get("total_tokens") or (prompt + output)),
    }


def _norm_anthropic_usage(usage: dict[str, Any]) -> dict[str, int]:
    """Anthropic：input_tokens 不含缓存；prompt = input + cache_read + cache_creation。"""
    raw_input = int(usage.get("input_tokens") or 0)
    cache_read = int(usage.get("cache_read_input_tokens") or 0)
    cache_write = int(usage.get("cache_creation_input_tokens") or 0)
    prompt = raw_input + cache_read + cache_write
    output = int(usage.get("output_tokens") or 0)
    return {
        "prompt_tokens": prompt,
        "cache_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "output_tokens": output,
        "reasoning_tokens": 0,
        "total_tokens": prompt + output,
    }


def _norm_gemini_usage(usage: dict[str, Any]) -> dict[str, int]:
    prompt = int(usage.get("promptTokenCount") or 0)
    output = int(usage.get("candidatesTokenCount") or 0)
    cached = int(usage.get("cachedContentTokenCount") or 0)
    thoughts = int(usage.get("thoughtsTokenCount") or 0)
    return {
        "prompt_tokens": prompt,
        "cache_tokens": cached,
        "cache_write_tokens": 0,
        "output_tokens": output + thoughts,
        "reasoning_tokens": thoughts,
        "total_tokens": prompt + output + thoughts,
    }


def parse_model_ids(payload: Any) -> list[str]:
    out: list[str] = []

    def push(value: Any) -> None:
        if not value:
            return
        text = str(value)
        if text.startswith("models/"):
            text = text[len("models/"):]
        if text and text not in out:
            out.append(text)

    if isinstance(payload, list):
        for item in payload:
            push(item if isinstance(item, str) else (item.get("id") or item.get("name")))
    if isinstance(payload, dict):
        for item in payload.get("data") or []:
            push(item if isinstance(item, str) else (item.get("id") or item.get("name")))
        for item in payload.get("models") or []:
            push(item if isinstance(item, str) else (item.get("name") or item.get("id")))
    return out[:500]


async def _sse(resp: httpx.Response) -> AsyncIterator[tuple[str, str]]:
    """逐行解析 SSE，产出 (event, data)。"""
    event = ""
    async for line in resp.aiter_lines():
        if line is None:
            continue
        line = line.strip("\r")
        if not line:
            event = ""
            continue
        if line.startswith("event:"):
            event = line[len("event:"):].strip()
            continue
        if line.startswith("data:"):
            yield event, line[len("data:"):].strip()


async def _stream_openai(resp) -> AsyncIterator[dict[str, Any]]:
    async for _event, data in _sse(resp):
        if not data or data == "[DONE]":
            continue
        try:
            obj = json.loads(data)
        except ValueError:
            continue
        usage = obj.get("usage")
        if usage:
            yield {"type": "usage", "usage": _norm_openai_usage(usage), "estimated": False}
        for choice in obj.get("choices") or []:
            delta = choice.get("delta") or {}
            text = delta.get("content")
            if text:
                yield {"type": "delta", "text": text}
            reasoning = delta.get("reasoning_content") or delta.get("reasoning") or delta.get("thinking")
            if isinstance(reasoning, dict):
                reasoning = reasoning.get("text") or reasoning.get("summary") or ""
            if not reasoning and isinstance(delta.get("reasoning_details"), list):
                parts = []
                for item in delta["reasoning_details"]:
                    if isinstance(item, dict):
                        parts.append(str(item.get("text") or item.get("summary") or ""))
                reasoning = "".join(parts)
            if reasoning:
                yield {"type": "thinking", "text": str(reasoning)}
            finish = choice.get("finish_reason")
            if finish:
                yield {"type": "finish", "reason": str(finish)}


async def _stream_anthropic(resp) -> AsyncIterator[dict[str, Any]]:
    merged_usage: dict[str, int] = {}
    async for event, data in _sse(resp):
        if not data:
            continue
        try:
            obj = json.loads(data)
        except ValueError:
            continue
        etype = obj.get("type") or event
        if etype == "message_start":
            usage = (obj.get("message") or {}).get("usage") or {}
            if usage:
                _merge_usage_max(merged_usage, _norm_anthropic_usage(usage))
        elif etype == "content_block_delta":
            delta = obj.get("delta") or {}
            if delta.get("type") == "text_delta" and delta.get("text"):
                yield {"type": "delta", "text": delta["text"]}
            elif delta.get("type") == "thinking_delta" and delta.get("thinking"):
                yield {"type": "thinking", "text": delta["thinking"]}
        elif etype == "message_delta":
            usage = obj.get("usage") or {}
            if usage:
                _merge_usage_max(merged_usage, _norm_anthropic_usage(usage))
            if merged_usage:
                yield {"type": "usage", "usage": dict(merged_usage), "estimated": False}
            stop = (obj.get("delta") or {}).get("stop_reason")
            if stop:
                # max_tokens 和 OpenAI 的 length 是同一件事，统一成一个词
                yield {"type": "finish", "reason": "length" if stop == "max_tokens" else str(stop)}
        elif etype == "error":
            err = obj.get("error") or {}
            yield {
                "type": "error",
                "kind": "badresponse",
                "message": classify_api_error(None, detail=str(err))["message"],
                "detail": str(err)[:200],
            }


async def _stream_gemini(resp) -> AsyncIterator[dict[str, Any]]:
    async for _event, data in _sse(resp):
        if not data or data == "[DONE]":
            continue
        try:
            obj = json.loads(data)
        except ValueError:
            continue
        usage = obj.get("usageMetadata")
        if usage:
            yield {"type": "usage", "usage": _norm_gemini_usage(usage), "estimated": False}
        for candidate in obj.get("candidates") or []:
            finish = candidate.get("finishReason")
            if finish:
                yield {"type": "finish", "reason": "length" if finish == "MAX_TOKENS" else str(finish)}
            for part in (candidate.get("content") or {}).get("parts") or []:
                text = part.get("text")
                if not text:
                    continue
                if part.get("thought"):
                    yield {"type": "thinking", "text": text}
                else:
                    yield {"type": "delta", "text": text}


async def _stream_responses(resp) -> AsyncIterator[dict[str, Any]]:
    async for _event, data in _sse(resp):
        if not data or data == "[DONE]":
            continue
        try:
            obj = json.loads(data)
        except ValueError:
            continue
        etype = obj.get("type") or ""
        if etype == "response.output_text.delta" and obj.get("delta"):
            yield {"type": "delta", "text": obj["delta"]}
        elif etype in ("response.reasoning_summary_text.delta", "response.reasoning_text.delta") and obj.get("delta"):
            yield {"type": "thinking", "text": obj["delta"]}
        elif etype == "response.completed":
            usage = ((obj.get("response") or {}).get("usage")) or {}
            if usage:
                yield {"type": "usage", "usage": _norm_responses_usage(usage), "estimated": False}
        elif etype in ("response.failed", "error"):
            yield {"type": "error", "kind": "server", "message": "服务器错误：这家暂时不稳定，过一会儿再试。"}


_STREAM_PARSERS = {
    "openai": _stream_openai,
    "anthropic": _stream_anthropic,
    "gemini": _stream_gemini,
    "responses": _stream_responses,
}


def _merge_usage_max(base: dict[str, int], extra: dict[str, int]) -> dict[str, int]:
    """流式 usage 多次到达时逐字段取最大，不后覆盖前。"""
    for key, value in extra.items():
        try:
            value = int(value or 0)
        except (TypeError, ValueError):
            value = 0
        if value > int(base.get(key) or 0):
            base[key] = value
    return base


async def _stream_events(resp, kind: str, model: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
    parser = _STREAM_PARSERS.get(kind, _stream_openai)
    async for event in parser(resp):
        yield event


# --------------------------------------------------------------------------- 对外：流式聊天
def _mock_reply(prompt: dict[str, Any]) -> tuple[str, str]:
    last_user = ""
    for seg in reversed(prompt.get("segments") or []):
        if seg.get("role") == "user":
            last_user = str(seg.get("text") or "")
            break
    last_user = last_user.strip()
    if any(word in last_user for word in ("累", "困", "忙")):
        text = "那就先不说话。把肩膀放下来一点，我在这里。\n\n等你想说的时候，我还在。"
    elif "雨" in last_user:
        text = "雨还在下。伞放门边，别把水带进屋里。\n\n灯我留着，慢慢走。"
    elif last_user.endswith("？") or last_user.endswith("?"):
        text = "我想一想再回答你。先坐一会儿，好吗。"
    else:
        text = "嗯，我在。慢慢说，不着急。"
    if last_user:
        snippet = last_user[:24].replace("\n", " ")
        text += "\n\n你刚才说的「" + snippet + "」，我记着了。"
    thinking = "先看她这句话里的情绪，再把要接的部分放在前面。\n不要追问，留一点空白。\n语气放轻，句子短一点。"
    return text, thinking


async def _mock_stream(prompt: dict[str, Any], built: dict[str, Any], api_key: str) -> AsyncIterator[dict[str, Any]]:
    yield {"type": "start", "url": "mock://local", "modelKey": "mock-model"}
    if built.get("params") and mock_400_enabled():
        yield {"type": "fallback", "message": "这家不支持调思考深度，已按默认回复。"}
    text, thinking = _mock_reply(prompt)
    if built.get("params"):
        for chunk in [thinking[i:i + 8] for i in range(0, len(thinking), 8)]:
            yield {"type": "thinking", "text": chunk}
            await asyncio.sleep(0.01)
    for chunk in [text[i:i + 4] for i in range(0, len(text), 4)]:
        yield {"type": "delta", "text": chunk}
        await asyncio.sleep(0.012)
    prompt_chars = len(prompt.get("text") or "")
    usage = {
        "prompt_tokens": max(1, int(prompt_chars / 2.2)),
        "cache_tokens": 0,
        "output_tokens": max(1, int(len(text) / 2.2)),
        "total_tokens": 0,
    }
    usage["total_tokens"] = usage["prompt_tokens"] + usage["output_tokens"]
    yield {"type": "usage", "usage": usage, "estimated": False}


async def chat_stream(
    provider: dict[str, Any],
    model: dict[str, Any],
    prompt: dict[str, Any],
    api_key: str,
    reasoning_level: str | None = None,
    session_id: str | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """流式聊天。事件：start / delta / thinking / usage / fallback / error。

    session_id 在同一次对话的重试里保持不变（OpenCode 的 x-opencode-session）。
    """
    proto = protocol_of(provider)
    level = reasoning_level if reasoning_level is not None else default_level(model)
    built = build_reasoning_params(model, level, proto)

    if mock_enabled():
        async for event in _mock_stream(prompt, built, api_key):
            yield event
        return

    timeout = _provider_timeout(provider)
    can_retry = bool(built.get("params")) or bool(built.get("dropSampling")) or built.get("mode") != "none"
    attempt = 0
    while attempt < 2:
        attempt += 1
        disable_reasoning = attempt > 1
        drop_sampling = list(built.get("dropSampling") or []) if disable_reasoning else None
        req = build_request(
            provider,
            model,
            prompt,
            api_key,
            stream=True,
            disable_reasoning=disable_reasoning,
            reasoning_level=level,
            drop_sampling=drop_sampling,
            session_id=session_id,
        )
        started = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=min(10.0, timeout))) as client:
                async with client.stream(
                    "POST", req["url"], headers=req["headers"], json=req["body"]
                ) as resp:
                    if resp.status_code >= 400:
                        raw = (await resp.aread()).decode("utf-8", "replace")[:800]
                        if attempt == 1 and can_retry and reasoning_related_error(resp.status_code, raw):
                            removed = ["思考参数"]
                            if drop := list(built.get("dropSampling") or []):
                                removed += drop
                            yield {
                                "type": "fallback",
                                "message": "这家不支持这组参数，已去掉 " + "、".join(removed) + " 后按默认重试。",
                                "removed": removed,
                            }
                            continue
                        error = classify_api_error(resp.status_code, detail=raw)
                        yield {"type": "error", **error}
                        return
                    yield {
                        "type": "start",
                        "url": redact_url(req["url"]),
                        "modelKey": req["model_key"],
                        "duration_ms": int((time.monotonic() - started) * 1000),
                    }
                    async for event in _stream_events(resp, req["kind"], model):
                        yield event
                    return
        except httpx.TimeoutException as exc:
            error = classify_api_error(None, exc, detail=redact_url(req["url"]))
            yield {"type": "error", **error}
            return
        except httpx.HTTPError as exc:
            error = classify_api_error(None, exc, detail=redact_url(req["url"]))
            yield {"type": "error", **error}
            return
        except Exception as exc:  # noqa: BLE001 - 不让任何上游异常把聊天打断
            yield {
                "type": "error",
                "kind": "internal",
                "message": "服务器这边出了点问题，稍后再试。",
                "detail": str(exc)[:200],
            }
            return


# --------------------------------------------------------------------------- 非流式（记忆抽取）
async def complete(
    provider: dict[str, Any],
    model: dict[str, Any],
    prompt: dict[str, Any],
    api_key: str,
    reasoning_level: str | None = None,
    session_id: str | None = None,
) -> dict[str, Any]:
    if mock_enabled():
        last_user = ""
        for seg in reversed(prompt.get("segments") or []):
            if seg.get("role") == "user":
                last_user = str(seg.get("text") or "")
                break
        if "MEMORY_EXTRACT" in last_user:
            return {"text": _mock_extract_json(last_user), "usage": None, "thinking": ""}
        if "[CIRCLE_NPC]" in last_user:
            return {"text": '{"npcs": [{"name": "小周", "relation": "她的室友"}]}', "usage": None, "thinking": ""}
        if "[CIRCLE_NPC_POST]" in last_user:
            return {"text": "这个季节的橘子便宜得离谱，买了两斤。", "usage": None, "thinking": ""}
        if "[CIRCLE_POST]" in last_user:
            return {"text": "今天把借了很久的那本书看完了，窗外的雨下了一整天。", "usage": None, "thinking": ""}
        if "[CIRCLE_COMMENT]" in last_user:
            return {"text": "这么晚还不睡？", "usage": None, "thinking": ""}
        if "CONTEXT_DIGEST" in last_user:
            return {"text": _mock_digest_text(), "usage": None, "thinking": ""}
        text, _thinking = _mock_reply(prompt)
        return {"text": text, "usage": None, "thinking": ""}

    req = build_request(
        provider, model, prompt, api_key, stream=False, reasoning_level=reasoning_level, session_id=session_id
    )
    timeout = _provider_timeout(provider)
    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=min(10.0, timeout))) as client:
        resp = await client.post(req["url"], headers=req["headers"], json=req["body"])
        raw = resp.text
        if resp.status_code >= 400:
            error = classify_api_error(resp.status_code, detail=raw[:800])
            raise RuntimeError(error["message"])
        try:
            payload = resp.json()
        except ValueError:
            return {"text": raw, "usage": None, "thinking": ""}
    kind = req["kind"]
    text = ""
    usage = None
    if kind == "anthropic":
        for block in payload.get("content") or []:
            if block.get("type") == "text":
                text += block.get("text") or ""
        usage = _norm_anthropic_usage(payload.get("usage") or {}) if payload.get("usage") else None
    elif kind == "gemini":
        for candidate in payload.get("candidates") or []:
            for part in (candidate.get("content") or {}).get("parts") or []:
                if part.get("thought"):
                    continue
                text += part.get("text") or ""
        usage = _norm_gemini_usage(payload.get("usageMetadata") or {}) if payload.get("usageMetadata") else None
    elif kind == "responses":
        text = payload.get("output_text") or ""
        if not text:
            for item in payload.get("output") or []:
                if item.get("type") not in (None, "message"):
                    continue
                for part in item.get("content") or []:
                    if part.get("type") in (None, "output_text"):
                        text += part.get("text") or ""
        usage = _norm_responses_usage(payload.get("usage") or {}) if payload.get("usage") else None
    else:
        choices = payload.get("choices") or []
        if choices:
            text = (choices[0].get("message") or {}).get("content") or ""
        usage = _norm_openai_usage(payload.get("usage") or {}) if payload.get("usage") else None
    return {"text": text, "usage": usage, "thinking": ""}


def _mock_digest_text() -> str:
    """测试用的假摘要：结构照抄真实要求，长度足够过最短校验。"""
    return (
        "【时间线】\n"
        "两人在雨天相遇，随后一起走回家。路上聊到最近的工作和睡眠。\n"
        "当天晚上一起吃了饭，气氛轻松。\n"
        "\n【关系】\n"
        "已经很熟，称呼上不再客气，但还没把话说破。\n"
        "\n【没讲完的事】\n"
        "她答应过要给他看一样东西，一直没拿出来。"
    )


def _mock_extract_json(marker_text: str) -> str:
    import hashlib

    seed = hashlib.sha256(marker_text.encode("utf-8")).hexdigest()
    user_lines = [ln for ln in marker_text.splitlines() if ln.startswith("用户") or ln.startswith("她")]
    last = user_lines[-1] if user_lines else "最近的一句话"
    last = last[:60]
    note = {
        "title": "最近说过的话",
        "body": ("她提到：" + last).strip()[:180],
        "category": "日常",
        "importance": 5,
        "tags": ["自动抽取"],
    }
    now_update = "她刚才说到：" + last[:80]
    return json.dumps({"notes": [note], "now": now_update}, ensure_ascii=False)


# --------------------------------------------------------------------------- 测试 / 拉模型 / 余额
def _error_payload(status: int | None, exc: BaseException | None, raw: str, url: str) -> dict[str, Any]:
    error = classify_api_error(status, exc, detail=redact_url(url))
    return {
        "ok": False,
        "kind": error["kind"],
        "message": error["message"],
        "status": status or 0,
        "url": redact_url(url),
    }


async def test_connection(provider: dict[str, Any], api_key: str) -> dict[str, Any]:
    url = models_url(provider, api_key)
    if mock_enabled():
        return {"ok": True, "kind": "ok", "message": "连上了（演示模式，没有真的请求外部接口）。", "status": 200, "ms": 12, "url": redact_url(url)}
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=TEST_TIMEOUT) as client:
            resp = await client.get(url, headers=_headers(provider, api_key, url, OPENCODE_SESSION_TEST))
        ms = int((time.monotonic() - started) * 1000)
        if resp.status_code >= 400:
            payload = _error_payload(resp.status_code, None, resp.text[:500], url)
            payload["ms"] = ms
            return payload
        return {"ok": True, "kind": "ok", "message": "连上了：这家能正常响应。", "status": resp.status_code, "ms": ms, "url": redact_url(url)}
    except Exception as exc:  # noqa: BLE001
        payload = _error_payload(None, exc, str(exc), url)
        payload["ms"] = int((time.monotonic() - started) * 1000)
        return payload


async def pull_models(provider: dict[str, Any], api_key: str) -> dict[str, Any]:
    url = models_url(provider, api_key)
    if mock_enabled():
        proto = protocol_of(provider)
        return {"ok": True, "ids": list(MOCK_PULL.get(proto, MOCK_PULL["openai"])), "url": redact_url(url), "status": 200, "demo": True}
    try:
        async with httpx.AsyncClient(timeout=TEST_TIMEOUT) as client:
            resp = await client.get(url, headers=_headers(provider, api_key, url, OPENCODE_SESSION_MODELS))
        if resp.status_code >= 400:
            payload = _error_payload(resp.status_code, None, resp.text[:500], url)
            payload["ids"] = []
            return payload
        try:
            ids = parse_model_ids(resp.json())
        except ValueError:
            ids = parse_model_ids(resp.text)
        if not ids:
            return {
                "ok": False,
                "kind": "badresponse",
                "message": "这家没有返回模型列表：地址或 Key 可能不对。",
                "ids": [],
                "status": resp.status_code,
                "url": redact_url(url),
            }
        return {"ok": True, "ids": ids, "url": redact_url(url), "status": resp.status_code}
    except Exception as exc:  # noqa: BLE001
        payload = _error_payload(None, exc, str(exc), url)
        payload["ids"] = []
        return payload



MINIMAL_PROMPT: dict[str, Any] = {
    "segments": [{"role": "user", "text": "hi"}],
    "sampling": {"max_tokens": 8, "temperature": None, "stream": True},
    "system_text": "",
}


async def probe_models(provider: dict[str, Any], api_key: str) -> dict[str, Any]:
    """只用免费 GET 模型列表接口识别接口格式并拉模型，不发任何生成请求。

    依次试：协议对应的规范地址 → 其它原生格式 → 只填域名时的 /v1/models、/models。
    """
    candidates = models_url_candidates(provider, api_key)
    if not candidates:
        return {
            "ok": False,
            "kind": "badrequest",
            "message": "先填一个网址：还不知道要连哪里。",
            "ids": [],
            "url": "",
            "status": 0,
            "ms": 0,
        }
    if mock_enabled():
        proto = protocol_of(provider)
        return {
            "ok": True,
            "kind": proto,
            "ids": list(MOCK_PULL.get(proto, MOCK_PULL["openai"])),
            "url": redact_url(candidates[0]),
            "status": 200,
            "ms": 12,
            "demo": True,
        }
    started = time.monotonic()
    last: dict[str, Any] = {
        "ok": False,
        "kind": "network",
        "message": "连不上这个地址：检查网址和网络，再试一次。",
        "ids": [],
        "url": redact_url(candidates[0]),
        "status": 0,
    }
    for url in candidates:
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(TEST_TIMEOUT, connect=5.0)) as client:
                resp = await client.get(url, headers=_headers(provider, api_key, url, OPENCODE_SESSION_MODELS))
        except Exception as exc:  # noqa: BLE001
            info = classify_api_error(None, exc, detail=redact_url(url))
            last = {"ok": False, **info, "ids": [], "url": redact_url(url), "status": 0, "ms": int((time.monotonic() - started) * 1000)}
            continue
        ms = int((time.monotonic() - started) * 1000)
        if resp.status_code >= 400:
            info = _error_payload(resp.status_code, None, resp.text[:500], url)
            last = {"ok": False, **info, "ids": [], "url": redact_url(url), "status": resp.status_code, "ms": ms}
            continue
        try:
            ids = parse_model_ids(resp.json())
        except ValueError:
            ids = parse_model_ids(resp.text)
        if not ids:
            last = {
                "ok": False,
                "kind": "badresponse",
                "message": "这个地址没有返回模型列表：换个网址再试，或手动添加模型。",
                "ids": [],
                "url": redact_url(url),
                "status": resp.status_code,
                "ms": ms,
            }
            continue
        kind = _kind_from_models_url(url, provider)
        return {
            "ok": True,
            "kind": kind,
            "ids": ids[:200],
            "url": redact_url(url),
            "status": resp.status_code,
            "ms": ms,
        }
    return last


def _kind_from_models_url(url: str, provider: dict[str, Any]) -> str:
    lowered = (url or "").lower()
    if "/v1beta/models" in lowered:
        return "gemini"
    if re.search(r"/v1/models", lowered):
        return "anthropic" if protocol_of(provider) == "anthropic" else protocol_of(provider)
    return protocol_of(provider)


async def test_generation(
    provider: dict[str, Any],
    model: dict[str, Any],
    api_key: str,
    level: str | None = None,
) -> dict[str, Any]:
    """测试连接：只发一条真实的最小生成请求（单条 "hi"，max_tokens 很小）。"""
    started = time.monotonic()
    if mock_enabled():
        return {
            "ok": True,
            "kind": "ok",
            "message": "测试连接成功：模型能正常回复（演示模式，没有真的请求外部接口）。",
            "streamSupported": True,
            "responseText": "hi",
            "ms": 12,
            "status": 200,
        }
    text_parts: list[str] = []
    stream_supported = False
    error_payload: dict[str, Any] | None = None
    try:
        async with asyncio.timeout(25):
            async for event in chat_stream(
                provider, model, MINIMAL_PROMPT, api_key, level, session_id=OPENCODE_SESSION_TEST
            ):
                etype = event.get("type")
                if etype == "start":
                    stream_supported = True
                elif etype == "delta":
                    stream_supported = True
                    chunk = str(event.get("text") or "")
                    if chunk:
                        text_parts.append(chunk)
                elif etype == "error":
                    error_payload = event
                    break
    except asyncio.TimeoutError:
        return {
            "ok": False,
            "kind": "timeout",
            "message": "等太久没回音：检查网络或换一个模型，再试一次。",
            "streamSupported": False,
            "responseText": "",
            "ms": int((time.monotonic() - started) * 1000),
            "status": 0,
        }
    except Exception as exc:  # noqa: BLE001
        info = classify_api_error(None, exc, detail=str(exc)[:200])
        return {
            "ok": False,
            "kind": info.get("kind") or "network",
            "message": info.get("message") or "没连上：检查网址和网络，再试一次。",
            "streamSupported": False,
            "responseText": "",
            "ms": int((time.monotonic() - started) * 1000),
            "status": 0,
        }
    ms = int((time.monotonic() - started) * 1000)
    if error_payload:
        return {
            "ok": False,
            "kind": error_payload.get("kind") or "network",
            "message": error_payload.get("message") or "没连上：检查网址和 Key，再试一次。",
            "streamSupported": False,
            "responseText": "",
            "ms": ms,
            "status": 0,
        }
    return {
        "ok": True,
        "kind": "ok",
        "message": "测试连接成功：模型能正常回复。",
        "streamSupported": stream_supported,
        "responseText": "".join(text_parts)[:80],
        "ms": ms,
        "status": 200,
    }


def balance_supported(provider: dict[str, Any]) -> bool:
    return protocol_of(provider) in ("deepseek", "openrouter")


async def query_balance(provider: dict[str, Any], api_key: str) -> dict[str, Any]:
    proto = protocol_of(provider)
    base = str((provider or {}).get("baseUrl") or "").rstrip("/")
    if proto == "deepseek":
        url = base + "/user/balance"
    elif proto == "openrouter":
        url = base + ("/credits" if base.endswith("/api/v1") else "/api/v1/credits")
    else:
        return {"supported": False, "amount": None, "currency": "¥", "at": "", "message": "这家不支持查询余额"}
    if mock_enabled():
        amount = 12.4 if proto == "deepseek" else 8.2
        currency = "¥" if proto == "deepseek" else "$"
        return {"supported": True, "amount": amount, "currency": currency, "at": time.strftime("%m月%d日 %H:%M"), "ok": True, "url": redact_url(url)}
    try:
        async with httpx.AsyncClient(timeout=TEST_TIMEOUT) as client:
            resp = await client.get(url, headers=_headers(provider, api_key, url, OPENCODE_SESSION_BALANCE))
        if resp.status_code >= 400:
            error = classify_api_error(resp.status_code, detail=resp.text[:300])
            return {
                "supported": True,
                "amount": None,
                "currency": "$" if proto == "openrouter" else "¥",
                "at": "",
                "failed": True,
                "failKind": error["kind"],
                "message": "余额暂不可查",
            }
        payload = resp.json()
        amount = None
        currency = "$" if proto == "openrouter" else "¥"
        if proto == "deepseek":
            info = (payload.get("balance_infos") or [{}])[0] or {}
            try:
                amount = float(info.get("total_balance"))
            except (TypeError, ValueError):
                amount = None
            currency = "¥" if (info.get("currency") or "CNY") == "CNY" else "$"
        else:
            data = payload.get("data") or {}
            try:
                total = float(data.get("total_credits"))
                used = float(data.get("total_usage") or 0)
                amount = total - used
            except (TypeError, ValueError):
                amount = None
        if amount is None:
            return {
                "supported": True,
                "amount": None,
                "currency": currency,
                "at": "",
                "failed": True,
                "failKind": "badresponse",
                "message": "余额暂不可查",
            }
        return {
            "supported": True,
            "amount": round(amount, 2),
            "currency": currency,
            "at": time.strftime("%m月%d日 %H:%M"),
            "ok": True,
        }
    except Exception as exc:  # noqa: BLE001
        error = classify_api_error(None, exc, detail=str(exc))
        return {
            "supported": True,
            "amount": None,
            "currency": "$" if proto == "openrouter" else "¥",
            "at": "",
            "failed": True,
            "failKind": error["kind"],
            "message": "余额暂不可查",
        }
