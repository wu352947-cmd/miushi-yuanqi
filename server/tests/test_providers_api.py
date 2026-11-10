"""提供商：Key 只进不出、接口只回掩码、导出默认不带 Key、状态同步忽略明文 Key。"""

from server import db


def test_key_is_encrypted_and_never_returned_in_clear(client):
    plain = "sk-very-secret-test-key-9876"
    response = client.post("/api/providers/prov-deepseek/key", json={"apiKey": plain})
    assert response.status_code == 200
    assert response.json() == {"ok": True, "hasKey": True, "keyMasked": "sk-••••••••9876"}

    listing = client.get("/api/providers")
    assert plain not in listing.text
    provider = next(item for item in listing.json()["providers"] if item["id"] == "prov-deepseek")
    assert provider["hasKey"] is True
    assert provider["keyMasked"] == "sk-••••••••9876"
    assert "apiKey" not in provider

    bootstrap = client.get("/api/bootstrap")
    assert plain not in bootstrap.text
    with db.get_db() as conn:
        row = conn.execute("SELECT api_key_enc FROM providers WHERE id = 'prov-deepseek'").fetchone()
    assert plain not in row["api_key_enc"]
    assert row["api_key_enc"]


def test_export_default_without_key_and_risk_flag_with_key(client):
    client.post("/api/providers/prov-deepseek/key", json={"apiKey": "sk-very-secret-test-key-9876"})
    plain_export = client.get("/api/providers/export").json()
    assert plain_export["includeApiKey"] is False
    assert "sk-very-secret" not in str(plain_export)
    with_key = client.get("/api/providers/export", params={"includeApiKey": 1}).json()
    assert with_key["includeApiKey"] is True
    assert with_key["risk"]
    exported = next(item for item in with_key["providers"] if item["id"] == "prov-deepseek")
    assert exported["apiKey"] == "sk-very-secret-test-key-9876"


def test_state_sync_ignores_plaintext_api_key(client):
    state = client.get("/api/bootstrap").json()["state"]
    for provider in state["providers"]:
        provider["apiKey"] = "sk-should-be-ignored"
    client.put("/api/state", json={"state": state})
    with db.get_db() as conn:
        row = conn.execute("SELECT api_key_enc FROM providers WHERE id = 'prov-deepseek'").fetchone()
    assert "sk-should-be-ignored" not in (row["api_key_enc"] or "")
    assert client.get("/api/providers").text.find("sk-should-be-ignored") == -1


def test_provider_update_key_endpoint_clear(client):
    client.post("/api/providers/prov-deepseek/key", json={"apiKey": "sk-clear-test-1234"})
    response = client.post("/api/providers/prov-deepseek/key", json={"apiKey": ""})
    assert response.json()["hasKey"] is False


def test_test_connection_without_key_returns_chinese(client):
    response = client.post("/api/providers/prov-deepseek/test")
    payload = response.json()
    assert payload["ok"] is False
    assert payload["kind"] == "nokey"
    assert "API Key" in payload["message"]


def test_provider_crud_and_cascade(client):
    created = client.post("/api/providers", json={"name": "测试中转", "protocol": "openai", "baseUrl": "https://example.com/v1", "apiPath": "/chat/completions"}).json()
    provider_id = created["provider"]["id"]
    assert any(p["id"] == provider_id for p in client.get("/api/providers").json()["providers"])
    deleted = client.delete("/api/providers/" + provider_id)
    assert deleted.json()["ok"] is True
    assert all(p["id"] != provider_id for p in client.get("/api/providers").json()["providers"])
