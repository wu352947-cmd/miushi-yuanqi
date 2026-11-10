"""错误分类：中文 kind + 短提示。"""

import httpx

from server.errors import classify_api_error, kind_label, reasoning_related_error


def test_status_mapping():
    expected = {
        401: "auth",
        403: "auth",
        402: "quota",
        404: "notfound",
        429: "ratelimit",
        400: "badrequest",
        422: "badrequest",
        500: "server",
        503: "server",
    }
    for status, kind in expected.items():
        result = classify_api_error(status)
        assert result["kind"] == kind
        assert result["message"]
        # 不把英文原始报错交给界面
        assert "Error" not in result["message"]
        assert "Traceback" not in result["message"]


def test_exception_mapping():
    assert classify_api_error(None, httpx.ConnectTimeout("x"))["kind"] == "timeout"
    assert classify_api_error(None, httpx.ConnectError("x"))["kind"] == "network"
    assert classify_api_error(None, RuntimeError("boom"))["kind"] == "network"


def test_reasoning_related_detection():
    assert reasoning_related_error(400, "thinking budget too large")
    assert reasoning_related_error(422, "unsupported parameter reasoning_effort")
    assert not reasoning_related_error(400, "model not found")
    assert not reasoning_related_error(500, "thinking failed")


def test_kind_label_chinese():
    assert kind_label("auth") == "Key 不对"
    assert kind_label("whatever") == "连接失败"
