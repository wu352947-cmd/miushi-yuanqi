"""登录 / 登出 / 未设置密码时的开发模式提示。"""


def test_dev_mode_without_password(client):
    payload = client.get("/api/auth/me").json()
    assert payload["authRequired"] is False
    assert payload["devMode"] is True
    assert client.get("/api/bootstrap").status_code == 200
    health = client.get("/api/health").json()
    assert health["devMode"] is True


def test_password_login_and_session(client, monkeypatch):
    monkeypatch.setenv("APP_PASSWORD", "correct-password")
    me = client.get("/api/auth/me").json()
    assert me["authRequired"] is True
    assert me["authenticated"] is False
    assert client.get("/api/bootstrap").status_code == 401

    assert client.post("/api/auth/login", json={"password": "wrong"}).status_code == 401
    login = client.post("/api/auth/login", json={"password": "correct-password"})
    assert login.status_code == 200
    assert login.json()["ok"] is True
    assert client.get("/api/bootstrap").status_code == 200
    assert client.get("/api/auth/me").json()["authenticated"] is True

    assert client.post("/api/auth/logout").status_code == 200
    assert client.get("/api/bootstrap").status_code == 401
