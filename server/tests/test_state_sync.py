"""整体状态同步：集合增删改、聊天元数据、主题、壁纸。"""


def test_sync_collections_and_settings(client):
    state = client.get("/api/bootstrap").json()["state"]
    state["characters"].append({"id": "char-new", "name": "新角色", "desc": "简介", "description": "正文", "personality": "", "scenario": "", "first_mes": "", "mes_example": "", "avatar": "", "worldBookId": "", "defaultPersonaId": "", "source": "user", "extras": {}})
    state["worldBooks"][0]["entries"].append({"id": "e-new", "title": "新条目", "content": "新内容", "keys": ["新"], "constant": False, "enabled": True, "order": 99})
    state["settings"]["notify"] = False
    state["theme"] = "ice"
    state["modelId"] = "model-claude-sonnet"
    state["chats"].setdefault("miao", {"personaId": "", "worldBookId": "", "presetId": "", "modelId": "", "reasoningLevel": "", "lastAt": "", "messages": []})
    state["chats"]["miao"]["personaId"] = "persona-cen"
    state["chats"]["miao"]["reasoningLevel"] = "low"
    response = client.put("/api/state", json={"state": state})
    assert response.status_code == 200

    refreshed = client.get("/api/bootstrap").json()["state"]
    assert any(c["id"] == "char-new" for c in refreshed["characters"])
    book = next(b for b in refreshed["worldBooks"] if b["id"] == state["worldBooks"][0]["id"])
    assert any(entry["id"] == "e-new" for entry in book["entries"])
    assert refreshed["theme"] == "ice"
    assert refreshed["settings"]["notify"] is False
    assert refreshed["modelId"] == "model-claude-sonnet"
    assert refreshed["chats"]["miao"]["personaId"] == "persona-cen"
    assert refreshed["chats"]["miao"]["reasoningLevel"] == "low"

    # 删除角色会级联删掉它的聊天
    state = refreshed
    state["characters"] = [c for c in state["characters"] if c["id"] != "char-new"]
    client.put("/api/state", json={"state": state})
    final = client.get("/api/bootstrap").json()["state"]
    assert all(c["id"] != "char-new" for c in final["characters"])


def test_compression_settings_roundtrip(client):
    """压缩设置必须能存进后端。

    之前 sync_state 用白名单列举 settings 的 key，压缩那四项
    （contextAuto / contextThreshold / compressModelId / contextBudget）
    不在名单里，导致界面上配了也永远存不进去、后端一直用默认值。
    """
    payload = {
        "state": {
            "settings": {
                "contextBudget": 8000,
                "contextThreshold": 90,
                "contextAuto": False,
                "compressModelId": "model-test-123",
            }
        }
    }
    r = client.put("/api/state", json=payload)
    assert r.status_code == 200, r.text

    st = client.get("/api/bootstrap").json()["state"]["settings"]
    assert st["contextBudget"] == 8000
    assert st["contextThreshold"] == 90
    assert st["contextAuto"] is False
    assert st["compressModelId"] == "model-test-123"
