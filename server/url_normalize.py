"""提供商网址自动补全与拆分（纯函数，不发任何网络请求）。

需求（第 D2 轮第一块第 3 条）：
- 去掉首尾空格；没写 http(s):// 的自动补上 https://；
- 用户把完整地址（…/v1/chat/completions、…/v1/messages、…/v1/models、…:generateContent）
  粘进 Base URL 时，自动拆成 Base URL + API 路径；
- 只填域名、没带 /v1 时，依次免费试 {base}/v1/models 和 {base}/models，用能通的那个并改写 Base URL
  （网络探测在 providers.probe_models 里做，这里只给候选）；
- 防止 /v1/v1、//、路径重复拼接，Anthropic 和 Gemini 同样处理。

返回结构：
  {"baseUrl": str, "apiPath": str, "protocol": str,
   "changes": [{"field": "baseUrl"|"apiPath"|"protocol", "from": str, "to": str,
                "label": "已自动改为 …"}]}
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit, urlunsplit

DEFAULT_PATHS = {
    "openai": "/chat/completions",
    "openai_responses": "/responses",
    "anthropic": "/v1/messages",
    "gemini": "/v1beta/models/{model}:generateContent",
}

# 完整生成地址拆出来的路径（Base URL 里保留用户写的前缀）
_ENDPOINT_RULES: list[tuple[re.Pattern[str], str, str | None]] = [
    (re.compile(r"^(?P<base>.+?)/chat/completions/?$", re.I), "openai", "/chat/completions"),
    (re.compile(r"^(?P<base>.+?)/responses/?$", re.I), "openai_responses", "/responses"),
    (re.compile(r"^(?P<base>.+?)/messages/?$", re.I), "anthropic", "/v1/messages"),
    # Gemini 的完整生成地址：/v1beta/models/<model>:generateContent
    (
        re.compile(
            r"^(?P<base>.+?)(?:/v1beta)?/models/[^/:\s]+:(?:stream)?generateContent/?$",
            re.I,
        ),
        "gemini",
        None,
    ),
]

# 只贴了模型列表地址的情况：拆掉 /models，但保留 /v1 前缀（OpenAI 兼容 base 一般带 /v1）
_MODELS_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^(?P<base>.+?)/v1/models/?$", re.I), "/v1"),
    (re.compile(r"^(?P<base>.+?)/models/?$", re.I), ""),
]

_PROTOCOL_LABELS = {
    "openai": "OpenAI 兼容",
    "openai_responses": "OpenAI Responses",
    "deepseek": "DeepSeek",
    "anthropic": "Anthropic",
    "gemini": "Gemini",
    "openrouter": "OpenRouter",
}


def _ensure_scheme(raw: str) -> tuple[str, bool]:
    s = (raw or "").strip()
    if not s:
        return "", False
    if re.match(r"^https?://", s, re.I):
        return s, False
    if re.match(r"^[a-z]+://", s, re.I):
        # 其它协议（ftp:// 之类）按需求统一补 https，避免 typo
        return "https://" + re.sub(r"^[a-z]+://", "", s, flags=re.I), True
    return "https://" + s.lstrip("/"), True


def _clean_url(url: str) -> str:
    """压缩多余斜杠、去掉末尾斜杠、修正 /v1/v1。"""
    parts = urlsplit(url)
    scheme = parts.scheme or "https"
    netloc = parts.netloc
    path = re.sub(r"/{2,}", "/", parts.path or "")
    path = re.sub(r"/v1/v1(?=/|$)", "/v1", path, flags=re.I)
    path = path.rstrip("/")
    return urlunsplit((scheme, netloc, path, parts.query, parts.fragment))


def _looks_bare_domain(base: str) -> bool:
    parts = urlsplit(base)
    return (parts.path or "") in ("", "/")


def _strip_v1(base: str) -> str:
    return re.sub(r"/v1$", "", base, flags=re.I)


def join_base_path(base: str, path: str) -> str:
    """把 base + apiPath 拼起来，避免 /v1/v1、//、重复路径。"""
    base = (base or "").rstrip("/")
    path = (path or "").strip()
    if not path:
        return base
    if not path.startswith("/"):
        path = "/" + path
    if base.endswith("/v1") and re.match(r"^/v1(/|$)", path, re.I):
        path = path[3:]
    return base + path


def base_from_models_url(models_url: str) -> str:
    """从探测成功的模型列表地址反推 Base URL。"""
    url = (models_url or "").split("?")[0].rstrip("/")
    url = re.sub(r"/v1beta/models/?$", "", url, flags=re.I)
    url = re.sub(r"/v1/models/?$", "", url, flags=re.I)
    url = re.sub(r"/models/?$", "", url, flags=re.I)
    return url.rstrip("/")


def models_candidates(base: str, protocol: str = "openai") -> list[str]:
    """只填域名时按顺序免费试的模型列表地址。"""
    base = (base or "").rstrip("/")
    if not base:
        return []
    if protocol == "gemini":
        return [base + "/v1beta/models"]
    if base.endswith("/v1"):
        return [base + "/models"]
    return [base + "/v1/models", base + "/models"]


def normalize_provider(
    base_url: str = "",
    api_path: str = "",
    protocol: str = "openai",
) -> dict:
    """补全 / 拆分网址与路径，返回修正后的字段和给界面看的小字。"""
    original_base = (base_url or "").strip()
    original_path = (api_path or "").strip()
    original_protocol = (protocol or "openai").strip() or "openai"

    changes: list[dict] = []
    base, scheme_added = _ensure_scheme(original_base)
    inferred_protocol = ""
    inferred_path: str | None = None

    if base:
        base = _clean_url(base)

        # 1) Base URL 里粘了完整生成地址：拆成 base + path
        for pattern, proto, path in _ENDPOINT_RULES:
            match = pattern.match(base)
            if match:
                base = match.group("base")
                inferred_protocol = proto
                if path:
                    inferred_path = path
                break
        else:
            for pattern, keep in _MODELS_RULES:
                match = pattern.match(base)
                if match:
                    base = match.group("base") + keep
                    break

        if inferred_protocol in ("anthropic", "gemini"):
            base = _strip_v1(base)

        base = _clean_url(base)

    # 2) 协议：拆出来的是更具体的原生协议，就用它；否则保留用户选择
    protocol_out = original_protocol
    if inferred_protocol and original_protocol != inferred_protocol:
        openai_family = {"openai", "openai_responses", "deepseek", "openrouter"}
        if not (inferred_protocol in openai_family and original_protocol in openai_family):
            protocol_out = inferred_protocol
            changes.append(
                {
                    "field": "protocol",
                    "from": original_protocol,
                    "to": inferred_protocol,
                    "label": "已自动改为 " + _PROTOCOL_LABELS.get(inferred_protocol, inferred_protocol),
                }
            )
        else:
            protocol_out = original_protocol if original_protocol not in ("", "openai") else inferred_protocol

    # 3) API 路径：用户手写且不是默认值 → 以用户为准；否则自动填
    default_path = DEFAULT_PATHS.get(protocol_out, "/chat/completions")
    protocol_defaults = set(DEFAULT_PATHS.values())
    user_custom_path = bool(original_path) and original_path not in protocol_defaults
    if inferred_path is not None:
        path = inferred_path
    elif user_custom_path:
        path = original_path
    else:
        path = default_path

    if path:
        if not path.startswith("/"):
            path = "/" + path
        path = re.sub(r"/{2,}", "/", path)
        if base.endswith("/v1") and re.match(r"^/v1(/|$)", path, re.I):
            path = path[3:]

    if base != original_base:
        changes.append(
            {
                "field": "baseUrl",
                "from": original_base,
                "to": base,
                "label": "已自动改为 " + base,
            }
        )
    elif scheme_added and base:
        changes.append(
            {
                "field": "baseUrl",
                "from": original_base,
                "to": base,
                "label": "已自动改为 " + base,
            }
        )
    if path != original_path:
        changes.append(
            {
                "field": "apiPath",
                "from": original_path,
                "to": path,
                "label": "已自动改为 " + path,
            }
        )

    return {"baseUrl": base, "apiPath": path, "protocol": protocol_out, "changes": changes}


def needs_domain_probe(base_url: str) -> bool:
    """只填了域名（没有版本路径）时需要网络探测 /v1/models 还是 /models。"""
    base, _ = _ensure_scheme(base_url)
    return bool(base) and _looks_bare_domain(base)
