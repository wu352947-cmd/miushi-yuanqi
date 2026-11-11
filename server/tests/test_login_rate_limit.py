"""登录限流：同一来源 5 分钟内失败 10 次即 429，成功登录清零。"""

from server import auth


def _reset():
    auth._login_fails.clear()


def test_rate_limited_after_max_failures(client, monkeypatch):
    monkeypatch.setenv("APP_PASSWORD", "correct-horse-battery")
    _reset()

    for i in range(auth.LOGIN_MAX_FAILS):
        response = client.post("/api/auth/login", json={"password": "wrong"})
        assert response.status_code == 401, "第 %d 次应当是 401，实际 %s" % (i + 1, response.status_code)
        assert response.json()["error"]["kind"] == "auth"
        if i == 0:
            assert "还可以试" in response.json()["error"]["message"]

    # 第 11 次：即便密码还是错的，也应当直接 429
    blocked = client.post("/api/auth/login", json={"password": "wrong"})
    assert blocked.status_code == 429
    payload = blocked.json()["error"]
    assert payload["kind"] == "ratelimit"
    assert "秒后再试" in payload["message"]

    # 锁定期内即使密码正确也不放行
    still_blocked = client.post("/api/auth/login", json={"password": "correct-horse-battery"})
    assert still_blocked.status_code == 429

    _reset()


def test_success_clears_failure_counter(client, monkeypatch):
    monkeypatch.setenv("APP_PASSWORD", "correct-horse-battery")
    _reset()

    for _ in range(3):
        assert client.post("/api/auth/login", json={"password": "nope"}).status_code == 401
    assert auth._login_fails, "失败应当被记下来"

    ok = client.post("/api/auth/login", json={"password": "correct-horse-battery"})
    assert ok.status_code == 200
    assert ok.json()["authenticated"] is True
    assert auth._login_fails == {}, "成功登录后计数器应当清空"

    _reset()


def test_dev_mode_without_password_is_not_limited(client, monkeypatch):
    """没设 APP_PASSWORD 时是开发模式，登录直接放行，不参与限流。"""
    monkeypatch.delenv("APP_PASSWORD", raising=False)
    _reset()

    for _ in range(auth.LOGIN_MAX_FAILS + 3):
        response = client.post("/api/auth/login", json={"password": "whatever"})
        assert response.status_code == 200
        assert response.json().get("devMode") is True
    assert auth._login_fails == {}

    _reset()


def test_block_expires_after_window(client, monkeypatch):
    """窗口过期后应当重新允许尝试（用改时间戳模拟，不真等 5 分钟）。"""
    monkeypatch.setenv("APP_PASSWORD", "correct-horse-battery")
    _reset()

    key = "testclient"
    now = auth.time.time()
    auth._login_fails[key] = [now - auth.LOGIN_WINDOW - 1] * auth.LOGIN_MAX_FAILS
    assert auth.login_blocked(key) == 0, "超出窗口的失败记录不该继续挡人"

    _reset()