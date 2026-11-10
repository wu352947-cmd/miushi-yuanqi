"""浏览器迁移：幂等、按 id 去重、Key 只在确认后上传。"""

LOCAL_STATE = {
    "theme": "ice",
    "overrides": {"pink": {}, "ice": {}},
    "settings": {"notify": False, "startDate": "2024-01-02", "globalBookId": "", "defaultPresetId": "preset-prose"},
    "nowText": "迁移过来的此刻。",
    "characters": [
        {"id": "char-local-1", "name": "迁移角色", "desc": "旧手机里的", "description": "正文", "personality": "", "scenario": "", "first_mes": "", "mes_example": "", "avatar": "", "worldBookId": "", "defaultPersonaId": "", "source": "import", "extras": {}}
    ],
    "userPersonas": [{"id": "persona-local-1", "name": "迁移用户", "description": "说明", "avatar": "", "is_default": False}],
    "worldBooks": [{"id": "wb-local-1", "name": "迁移世界书", "entries": [{"id": "e1", "title": "条目", "content": "内容", "keys": ["雨"], "constant": False, "enabled": True, "order": 10}]}],
    "promptPresets": [{"id": "preset-local-1", "name": "迁移预设", "desc": "", "builtin": False, "source": "tavern", "fragments": [], "sampling": {}, "extras": {}}],
    "providers": [
        {"id": "prov-local-1", "name": "迁移提供商", "icon": "", "protocol": "openai", "baseUrl": "https://example.com/v1", "apiPath": "/chat/completions", "enabled": True, "models": ["model-local-1"], "balance": {}, "advanced": {}, "source": "user", "extras": {}, "apiKey": "sk-migrate-secret-1234"}
    ],
    "models": [{"id": "model-local-1", "providerId": "prov-local-1", "name": "迁移模型", "modelId": "local-model", "icon": "", "caps": {}, "context": 8000, "favorite": False, "price": None, "reasoning": {"mode": "none", "levels": []}, "source": "user"}],
    "chats": {
        "char-local-1": {
            "characterId": "char-local-1", "personaId": "", "worldBookId": "", "presetId": "", "modelId": "", "reasoningLevel": "",
            "lastAt": "",
            "messages": [{"role": "ai", "text": "开场白", "time": "20:00"}, {"role": "me", "text": "你好", "time": "20:01"}],
        }
    },
    "memories": [
        {"id": "mem-local-1", "cat": "日常", "title": "迁移记忆", "body": "旧记忆正文", "importance": 6, "pinned": False, "protected": False, "forgotten": False, "source": "来自本地"}
    ],
}


def test_migration_is_idempotent_and_keeps_keys_off_by_default(client):
    first = client.post("/api/migrate/local", json={"state": LOCAL_STATE}).json()
    assert first["ok"] is True
    imported = first["imported"]
    assert imported["characters"] == 1
    assert imported["chats"] == 1
    assert imported["messages"] == 2
    assert imported["memories"] == 1
    assert imported["keys"] == 0  # 默认不上传明文 Key

    second = client.post("/api/migrate/local", json={"state": LOCAL_STATE}).json()
    assert second["imported"]["characters"] == 0
    assert second["imported"]["chats"] == 0
    assert second["imported"]["memories"] == 0
    assert second["imported"]["skipped"] >= 6

    bootstrap = client.get("/api/bootstrap").json()["state"]
    assert bootstrap["theme"] == "ice"
    assert any(c["id"] == "char-local-1" for c in bootstrap["characters"])
    assert bootstrap["chats"]["char-local-1"]["messages"][1]["text"] == "你好"
    migrated_provider = next(p for p in bootstrap["providers"] if p["id"] == "prov-local-1")
    assert migrated_provider["hasKey"] is False

    status = client.get("/api/migrate/status").json()
    assert status["migrated"] is True


def test_migration_with_keys_when_user_confirms(client):
    payload = {"state": LOCAL_STATE, "includeApiKeys": True}
    client.post("/api/migrate/local", json=payload)
    with_key = client.post("/api/migrate/local", json={"state": LOCAL_STATE})  # 幂等：已存在不会重复写 Key
    assert with_key.json()["ok"] is True
    export = client.get("/api/providers/export", params={"includeApiKey": 1}).json()
    provider = next(p for p in export["providers"] if p["id"] == "prov-local-1")
    assert provider["apiKey"] == "sk-migrate-secret-1234"
