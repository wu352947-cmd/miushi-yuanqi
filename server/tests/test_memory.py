"""记忆库：新增 / 软遗忘 / 恢复 / 钉住 / 搜索 / 现在卡 / 去重。"""

from server import db, memory


def test_create_search_forget_restore(client):
    response = client.post(
        "/api/memories",
        json={"title": "睡前温水", "body": "她睡前喝半杯温水", "category": "喜好", "importance": 8, "tags": ["日常"]},
    )
    assert response.status_code == 200
    memory_id = response.json()["memory"]["id"]

    found = client.get("/api/memories/search", params={"q": "温水"}).json()["memories"]
    assert any(item["id"] == memory_id for item in found)

    forgotten = client.post("/api/memories/" + memory_id + "/forget").json()["memory"]
    assert forgotten["forgotten"] is True
    # 软遗忘：记录还在，可恢复
    listed = client.get("/api/memories", params={"includeForgotten": 1}).json()["memories"]
    assert any(item["id"] == memory_id for item in listed)
    restored = client.post("/api/memories/" + memory_id + "/restore").json()["memory"]
    assert restored["forgotten"] is False

    pinned = client.post("/api/memories/" + memory_id + "/pin", json={"pinned": True}).json()["memory"]
    assert pinned["pinned"] is True
    updated = client.put("/api/memories/" + memory_id, json={"body": "改过的正文"}).json()["memory"]
    assert updated["body"] == "改过的正文"


def test_now_card(client):
    assert client.put("/api/memories/now", json={"body": "在图书馆三楼。"}).json()["now"]["body"] == "在图书馆三楼。"
    assert client.get("/api/memories/now").json()["now"]["body"] == "在图书馆三楼。"


def test_remember_and_dedupe(client):
    first = client.post("/api/memories/remember", json={"text": "她怕冷", "title": "怕冷"}).json()
    assert first["ok"] is True
    second = client.post("/api/memories/remember", json={"text": "她怕冷", "title": "怕冷"}).json()
    assert second["ok"] is False  # 已存在，不重复写


def test_detect_remember_sentence():
    assert memory.detect_remember("记住这个") == ""
    assert memory.detect_remember("记住：她怕冷") == "她怕冷"
    assert memory.detect_remember("今天下雨。记住这个，伞放门边") == "伞放门边"
    assert memory.detect_remember("我记住了") is None
    assert memory.detect_remember("今天有点累") is None


def test_memory_now_card_and_pinned_notes_enter_prompt(client):
    with db.get_db() as conn:
        memory.set_now(conn, "雨刚停。")
        memory.create_memory(conn, {"title": "钉住的", "body": "钉住的正文", "pinned": True})
        prompt_notes = memory.pinned_for_prompt(conn)
        now = memory.now_card(conn)
    assert now["body"] == "雨刚停。"
    assert any(note["pinned"] for note in prompt_notes)
