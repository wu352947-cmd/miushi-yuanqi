"""错误分类：把上游/网络错误翻译成中文 kind + 短提示。

前端 classifyApiError 的服务器版。任何情况下都不把英文原始报错直接交给界面，
只保留一小段被截断的 detail 给日志/调试小字使用。
"""

from __future__ import annotations

import re
from typing import Any

import httpx

# kind -> 中文短提示（与 PROVIDERS_DESIGN 第 4 节、前端 classifyApiError 保持一致）
MESSAGES: dict[str, str] = {
    "auth": "Key 不对：这家拒绝了这次请求，检查 API Key 有没有填错。",
    "quota": "额度用完了：这家账户没有余额，充值或换一家再试。",
    "notfound": "地址或路径不对：Base URL / API 路径和这家的接口对不上。",
    "ratelimit": "请求太频繁：等一会儿再试，或换一家。",
    "badrequest": "请求参数不对：这家的接口不认这个模型或这些参数。",
    "server": "服务器错误：这家暂时不稳定，过一会儿再试。",
    "timeout": "超时了：这家在限定时间内没有响应，可能是网络慢或地址不对。",
    "network": "网络不通：服务器连不上这家，检查网络或地址。",
    "nokey": "先到「我的 → 模型与提供商」里填写 API Key，再发消息。",
    "noprovider": "还没有可用的模型：先在「模型与提供商」里添加一家并选一个模型。",
    "badresponse": "这家返回的内容看不懂：可能不是兼容的接口，检查协议与路径。",
    "http": "连接失败：这家返回了异常状态，换个地址再试。",
    "internal": "服务器这边出了点问题，稍后再试。",
}

KIND_LABELS: dict[str, str] = {
    "auth": "Key 不对",
    "notfound": "地址或路径不对",
    "quota": "额度用完",
    "ratelimit": "请求太频繁",
    "server": "服务器错误",
    "timeout": "超时",
    "network": "网络不通",
    "badrequest": "参数不支持",
    "badresponse": "返回格式不对",
    "nokey": "还没填 Key",
    "noprovider": "还没选模型",
    "http": "连接失败",
    "internal": "服务器内部错误",
}

_REASONING_RE = re.compile(
    r"(think|reason|budget|effort|thinking[_ ]?budget|reasoning_effort|max_tokens.*budget"
    r"|temperature|top[ _]?p|top[ _]?k|presence_penalty|frequency_penalty"
    r"|unsupported|not supported|invalid.?parameter|unknown.?parameter)",
    re.IGNORECASE,
)


class ApiError(Exception):
    """带中文 kind/message 的业务异常，routers 统一转成 JSON。"""

    def __init__(self, kind: str, message: str | None = None, status: int = 400, detail: str = ""):
        self.kind = kind
        self.status = status
        self.message = message or MESSAGES.get(kind, "请求没成功，稍后再试。")
        self.detail = _clip(detail)
        super().__init__(self.message)

    def payload(self) -> dict[str, Any]:
        out: dict[str, Any] = {"kind": self.kind, "message": self.message}
        if self.detail:
            out["detail"] = self.detail
        return {"error": out}


def _clip(text: str, limit: int = 240) -> str:
    text = (text or "").strip().replace("\n", " ")
    if len(text) > limit:
        return text[:limit] + "…"
    return text


def classify_api_error(
    status: int | None = None, exc: BaseException | None = None, detail: str = ""
) -> dict[str, Any]:
    """返回 {kind, message, detail?}。不抛异常，给测试/路由共用。"""
    if status:
        if status in (401, 403):
            kind = "auth"
        elif status == 402:
            kind = "quota"
        elif status == 404:
            kind = "notfound"
        elif status == 429:
            kind = "ratelimit"
        elif status in (400, 422):
            kind = "badrequest"
        elif status >= 500:
            kind = "server"
        else:
            kind = "http"
        message = MESSAGES[kind]
        if kind == "http":
            message = f"连接失败：这家返回了 {status}，换个地址再试。"
        return {"kind": kind, "message": message, "detail": _clip(detail)}

    if isinstance(exc, (httpx.TimeoutException, TimeoutError)):
        return {"kind": "timeout", "message": MESSAGES["timeout"], "detail": _clip(detail)}
    if isinstance(exc, httpx.HTTPError):
        return {"kind": "network", "message": MESSAGES["network"], "detail": _clip(detail)}
    return {"kind": "network", "message": MESSAGES["network"], "detail": _clip(detail)}


def kind_label(kind: str) -> str:
    return KIND_LABELS.get(kind, "连接失败")


def reasoning_related_error(status: int | None, detail: str) -> bool:
    """400/422 的错误信息看起来是在说思考参数时，允许去掉参数重试一次。"""
    if status not in (400, 422):
        return False
    return bool(_REASONING_RE.search(detail or ""))
