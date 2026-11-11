"""第三块 · 聊天记录管理：多对话 CRUD / 分支 / 搜索 / 导入导出 / 消息编辑删除 / 绑定。"""

from __future__ import annotations

import json
import re

import pytest

from server import db
from conftest import parse_sse


def _chars(client):
    return client.get("/api/bootstrap").json()["state"]["characters"]


def _new_chat(client, character_id="miao", **extra):
    payload = {"characterId": character_id, **extra}
    response = client.post("/api/chats", json=payload)
    assert response.status_code == 200, response.text
    return response.json()["chat"]


def _send(client, character_id, text, **extra):
    with client.stream("POST", "/api/chats/" + character_id + "/messages", json={"text": text, **extra}) as response:
        assert response.status_code == 200, response.read()
        return parse_sse(response)


def _mock(monkeypatch):
    monkeypatch.setenv("MSYQ_MOCK", "1")


# --------------------------------------------------------------------------- 列表 / 新建 / 改名 / 置顶 / 删除
def test_create_chat_default_title_and_first_message(client):
    chat = _new_chat(client)
    assert re.match(r"^缪诗 - \d{4}-\d{2}-\d{2} \d{2}:\d{2}$", chat["title"]), chat["title"]
    assert len(chat["messages"]) >= 1
    assert chat["messages"][0]["role"] == "ai"


def test_list_chats_filter_and_summary(client, monkeypatch):
    _mock(monkeypatch)
    first = _new_chat(client)
    _send(client, "miao", "今天下雨了", chatId=first["id"])
    listing = client.get("/api/chats", params={"characterId": "miao"}).json()["chats"]
    target = next(item for item in listing if item["id"] == first["id"])
    assert target["messageCount"] >= 2
    assert "今天下雨了" in target["preview"]
    assert target["title"]
    assert target["lastAt"]
    # 其它角色不应混进来
    assert all(item["characterId"] == "miao" for item in listing)


def test_rename_and_pin_and_delete(client):
    chat = _new_chat(client)
    renamed = client.patch("/api/chats/id/" + chat["id"], json={"title": "雨天的信"}).json()["chat"]
    assert renamed["title"] == "雨天的信"
    # 用户改过的标题要上锁，AI 不再覆盖
    with db.get_db() as conn:
        row = conn.execute("SELECT settings_json FROM chats WHERE id = ?", (chat["id"],)).fetchone()
    assert json.loads(row["settings_json"]).get("titleLocked") is True

    pinned = client.patch("/api/chats/id/" + chat["id"], json={"pinned": True}).json()["chat"]
    assert pinned["pinned"] is True
    listing = client.get("/api/chats", params={"characterId": "miao"}).json()["chats"]
    assert listing[0]["id"] == chat["id"]  # 置顶排最前

    deleted = client.delete("/api/chats/id/" + chat["id"]).json()
    assert deleted["ok"] is True
    with db.get_db() as conn:
        assert conn.execute("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?", (chat["id"],)).fetchone()["n"] == 0
    assert client.get("/api/chats/id/" + chat["id"]).status_code == 404


def test_get_and_patch_bindings(client):
    chat = _new_chat(client)
    patched = client.patch(
        "/api/chats/id/" + chat["id"],
        json={"personaId": "persona-2", "worldBookId": "book-1", "presetId": "preset-default", "modelId": "model-deepseek-flash", "reasoningLevel": "high"},
    ).json()["chat"]
    assert patched["personaId"] == "persona-2"
    assert patched["worldBookId"] == "book-1"
    full = client.get("/api/chats/id/" + chat["id"]).json()["chat"]
    assert full["reasoningLevel"] == "high"
    assert full["messages"]


# --------------------------------------------------------------------------- 消息编辑 / 删除
def test_edit_and_delete_message(client, monkeypatch):
    _mock(monkeypatch)
    chat = _new_chat(client)
    _send(client, "miao", "这句要改", chatId=chat["id"])
    full = client.get("/api/chats/id/" + chat["id"]).json()["chat"]
    target = [m for m in full["messages"] if m["role"] == "me"][-1]
    edited = client.patch("/api/chats/id/" + chat["id"] + "/messages/" + str(target["id"]), json={"text": "改好了"}).json()["message"]
    assert edited["text"] == "改好了"
    assert edited.get("edited") is True
    removed = client.delete("/api/chats/id/" + chat["id"] + "/messages/" + str(target["id"])).json()
    assert removed["ok"] is True
    full = client.get("/api/chats/id/" + chat["id"]).json()["chat"]
    assert all(m["id"] != target["id"] for m in full["messages"])


# --------------------------------------------------------------------------- 分支
def test_branch_copies_messages_and_bindings(client, monkeypatch):
    _mock(monkeypatch)
    chat = _new_chat(client)
    client.patch("/api/chats/id/" + chat["id"], json={"personaId": "persona-2", "title": "原对话"})
    _send(client, "miao", "第一句", chatId=chat["id"])
    _send(client, "miao", "第二句", chatId=chat["id"])
    full = client.get("/api/chats/id/" + chat["id"]).json()["chat"]
    cut = full["messages"][1]["id"]  # 从第二条消息（含）分支
    branch = client.post("/api/chats/id/" + chat["id"] + "/branch", json={"messageId": cut}).json()["chat"]
    assert branch["id"] != chat["id"]
    assert "分支" in branch["title"]
    assert branch["personaId"] == "persona-2"
    assert len(branch["messages"]) == 2
    assert [m["id"] for m in branch["messages"]] != [m["id"] for m in full["messages"]]


# --------------------------------------------------------------------------- 搜索
def test_search_messages_and_title(client, monkeypatch):
    _mock(monkeypatch)
    chat = _new_chat(client)
    _send(client, "miao", "我们去看海吧", chatId=chat["id"])
    results = client.get("/api/chats/search", params={"q": "看海", "characterId": "miao"}).json()["results"]
    assert results
    hit = next(item for item in results if item["messageId"])
    assert hit["chatId"] == chat["id"]
    assert "看海" in hit["text"]
    client.patch("/api/chats/id/" + chat["id"], json={"title": "海边的约定"})
    title_results = client.get("/api/chats/search", params={"q": "海边"}).json()["results"]
    assert any(item["chatId"] == chat["id"] and item["messageId"] is None for item in title_results)


# --------------------------------------------------------------------------- 导出 / 导入
def test_export_import_json_roundtrip(client, monkeypatch):
    _mock(monkeypatch)
    chat = _new_chat(client)
    _send(client, "miao", "导出这句话", chatId=chat["id"])
    exported = client.get("/api/chats/id/" + chat["id"] + "/export").json()
    assert exported["kind"] == "chat"
    assert exported["bindings"]["modelId"] is not None
    assert exported["character"]["name"]
    payload = client.post("/api/chats/import", json={"format": "json", "content": json.dumps(exported)}).json()
    assert payload["ok"] is True
    assert payload["messageCount"] >= 1
    assert payload["chat"]["id"] != chat["id"]
    texts = [m["text"] for m in payload["chat"]["messages"]]
    assert "导出这句话" in texts


def test_import_sillytavern_jsonl_by_name(client):
    lines = [
        json.dumps({"user_name": "芴", "character_name": "缪诗", "create_date": "2026-11-11T06:03:00.000Z"}, ensure_ascii=False),
        json.dumps({"name": "缪诗", "is_user": False, "is_system": False, "mes": "窗上起了雾。", "send_date": "2026-11-11T06:03:10Z"}, ensure_ascii=False),
        json.dumps({"name": "芴", "is_user": True, "is_system": False, "mes": "嗯，我在。", "send_date": "2026-11-11T06:04:00Z"}, ensure_ascii=False),
        json.dumps({"name": "系统", "is_user": False, "is_system": True, "mes": "（跳过这条系统消息）"}, ensure_ascii=False),
    ]
    payload = client.post("/api/chats/import", json={"format": "jsonl", "content": "\n".join(lines)}).json()
    assert payload["ok"] is True
    assert payload["matchedBy"] == "name"
    assert payload["characterId"] == "miao"
    assert payload["messageCount"] == 2
    roles = [m["role"] for m in payload["chat"]["messages"]]
    assert roles == ["ai", "me"]


def test_import_auto_detects_multiline_jsonl(client):
    lines = [
        json.dumps({"user_name": "芴", "character_name": "缪诗", "create_date": "2026-11-11T06:03:00.000Z"}, ensure_ascii=False),
        json.dumps({"name": "缪诗", "is_user": False, "is_system": False, "mes": "窗上起了雾。"}, ensure_ascii=False),
        json.dumps({"name": "芴", "is_user": True, "is_system": False, "mes": "嗯，我在。"}, ensure_ascii=False),
    ]
    payload = client.post("/api/chats/import", json={"format": "auto", "content": "\n".join(lines)}).json()
    assert payload["ok"] is True
    assert payload["messageCount"] == 2
    assert payload["matchedBy"] == "name"


def test_import_requires_character_when_cannot_match(client):
    lines = [json.dumps({"name": "路人", "is_user": True, "mes": "你好"}, ensure_ascii=False)]
    response = client.post("/api/chats/import", json={"format": "jsonl", "content": "\n".join(lines)})
    assert response.status_code == 400
    assert "角色" in response.json()["error"]["message"]


def test_bulk_delete_and_export(client):
    chat_a = _new_chat(client)
    chat_b = _new_chat(client)
    exported = client.post("/api/chats/bulk-export", json={"chatIds": [chat_a["id"], chat_b["id"]]}).json()
    assert exported["kind"] == "chats"
    assert len(exported["chats"]) == 2
    deleted = client.post("/api/chats/bulk-delete", json={"chatIds": [chat_a["id"], chat_b["id"]]}).json()
    assert deleted["deleted"] == 2


# --------------------------------------------------------------------------- AI 起名 / AI 帮答
def test_auto_title_mock_and_locked(client, monkeypatch):
    _mock(monkeypatch)
    chat = _new_chat(client)
    first = client.post("/api/chats/id/" + chat["id"] + "/auto-title").json()
    assert first["ok"] is True
    assert first["title"]
    client.patch("/api/chats/id/" + chat["id"], json={"title": "我自己起的"})
    second = client.post("/api/chats/id/" + chat["id"] + "/auto-title").json()
    assert second["ok"] is False
    assert "你自己改的" in second["message"]
    assert client.get("/api/chats/id/" + chat["id"]).json()["chat"]["title"] == "我自己起的"


def test_impersonate_does_not_persist(client, monkeypatch):
    _mock(monkeypatch)
    chat = _new_chat(client)
    before = len(client.get("/api/chats/id/" + chat["id"]).json()["chat"]["messages"])
    payload = client.post("/api/chats/miao/impersonate", json={}).json()
    assert payload["ok"] is True
    assert payload["text"]
    after = len(client.get("/api/chats/id/" + chat["id"]).json()["chat"]["messages"])
    assert after == before


# --------------------------------------------------------------------------- 续写 / 重新生成
def test_continue_does_not_add_user_message(client, monkeypatch):
    _mock(monkeypatch)
    chat = _new_chat(client)
    events = _send(client, "miao", "开始", chatId=chat["id"])
    assert any(kind == "user" for kind, _ in events)
    full_before = client.get("/api/chats/id/" + chat["id"]).json()["chat"]
    user_count_before = sum(1 for m in full_before["messages"] if m["role"] == "me")
    events = _send(client, "miao", "", chatId=chat["id"], mode="continue")
    assert not any(kind == "user" for kind, _ in events)
    full_after = client.get("/api/chats/id/" + chat["id"]).json()["chat"]
    assert sum(1 for m in full_after["messages"] if m["role"] == "me") == user_count_before
    assert len(full_after["messages"]) == len(full_before["messages"]) + 1


def test_regenerate_replaces_last_ai_message(client, monkeypatch):
    _mock(monkeypatch)
    chat = _new_chat(client)
    _send(client, "miao", "写一句", chatId=chat["id"])
    full_before = client.get("/api/chats/id/" + chat["id"]).json()["chat"]
    last_ai = [m for m in full_before["messages"] if m["role"] == "ai"][-1]
    events = _send(client, "miao", "", chatId=chat["id"], mode="regenerate")
    full_after = client.get("/api/chats/id/" + chat["id"]).json()["chat"]
    last_ai_after = [m for m in full_after["messages"] if m["role"] == "ai"][-1]
    assert last_ai_after["id"] != last_ai["id"]
    user_count = sum(1 for m in full_after["messages"] if m["role"] == "me")
    assert user_count == sum(1 for m in full_before["messages"] if m["role"] == "me")
    done = next(data for kind, data in events if kind == "done")
    assert done.get("chatId") == chat["id"]


# --------------------------------------------------------------------------- 作者注释 / 人设三层
def test_author_note_enters_prompt(client):
    chat = _new_chat(client)
    client.patch("/api/chats/id/" + chat["id"], json={"settings": {"authorNote": {"text": "这段对话里她说话更轻一点。", "depth": 0}}})
    # prompt-preview 取的是角色的 active chat；先把这条设为最近
    with db.get_db() as conn:
        conn.execute("UPDATE chats SET last_at = ? WHERE id = ?", ("2999-01-01T00:00:00+00:00", chat["id"]))
    preview = client.get("/api/chats/miao/prompt-preview", params={"text": "下一句"}).json()
    kinds = [block["kind"] for block in preview["blocks"]]
    assert "author_note" in kinds
    note = next(block for block in preview["blocks"] if block["kind"] == "author_note")
    assert "更轻一点" in note["text"]


def test_persona_three_layers_chat_wins(client):
    state = client.get("/api/bootstrap").json()["state"]
    personas = state["userPersonas"]
    if len(personas) < 2:
        pytest.skip("演示数据里只有一套用户设定")
    character = next(c for c in state["characters"] if c["id"] == "miao")
    client.put("/api/characters/miao", json={"character": {**character, "defaultPersonaId": personas[0]["id"]}})
    chat = _new_chat(client, personaId=personas[1]["id"])
    preview = client.get("/api/chats/miao/prompt-preview", params={"text": "下一句"}).json()
    assert preview["meta"]["personaId"] == personas[1]["id"]
    assert preview["meta"]["personaSource"] == "chat"
    # 没有聊天绑定时退回角色默认
    client.delete("/api/chats/id/" + chat["id"])
    empty = client.post("/api/chats", json={"characterId": "miao", "personaId": ""}).json()["chat"]
    preview = client.get("/api/chats/miao/prompt-preview", params={"text": "下一句"}).json()
    assert preview["meta"]["personaId"] == personas[0]["id"]
    assert preview["meta"]["personaSource"] == "char"
    client.delete("/api/chats/id/" + empty["id"])


def test_state_sync_respects_chat_id(client):
    chat_a = _new_chat(client, title="对话甲")
    _new_chat(client, title="对话乙")
    state = client.get("/api/bootstrap").json()["state"]
    chats = state["chats"]
    chats["miao"] = {**chats["miao"], "id": chat_a["id"], "title": "同步改名"}
    client.put("/api/state", json={"state": state})
    with db.get_db() as conn:
        rows = {row["id"]: row["title"] for row in conn.execute("SELECT id, title FROM chats").fetchall()}
    assert rows[chat_a["id"]] == "同步改名"
    # 另一段对话的标题没有被整体同步覆盖
    assert any(title == "对话乙" for title in rows.values())


def test_legacy_ensure_still_works(client):
    payload = client.post("/api/chats/miao/ensure").json()
    assert payload["chat"]["characterId"] == "miao"
    assert payload["chat"]["messages"]
    legacy = client.get("/api/chats/miao").json()
    assert legacy["chat"]["id"] == payload["chat"]["id"]


def test_schema_has_edited_column(client):
    with db.get_db() as conn:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(messages)").fetchall()}
        version = conn.execute("SELECT MAX(version) AS v FROM schema_migrations").fetchone()["v"]
    assert "edited" in columns
    assert version >= 3
