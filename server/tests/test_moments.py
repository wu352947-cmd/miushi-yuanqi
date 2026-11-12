"""朋友圈：发帖、评论、角色隔离、NPC 去重。

最要紧的一条：**每个角色的朋友圈是一套独立世界**。
温羽蓉那边发生的事，不应该在云诗蘩的动态里出现。
"""

import asyncio

from server import db, moments

from conftest import chat_events


def _prime(client):
    """先聊一句，让 mock 模型有上下文可用。"""
    chat_events(client, "今天有点累。")


def test_post_and_reply(client, monkeypatch):
    monkeypatch.setenv("MSYQ_MOCK", "1")
    _prime(client)

    r = client.post(
        "/api/moments", json={"characterId": "miao", "text": "今天下了很大的雨。"}
    )
    assert r.status_code == 200, r.text
    pid = r.json()["post"]["id"]
    assert r.json()["post"]["authorKind"] == "persona"

    feed = client.get("/api/moments?character_id=miao").json()
    assert len(feed["posts"]) == 1
    assert feed["posts"][0]["text"] == "今天下了很大的雨。"
    assert feed["posts"][0]["replies"] == []

    rr = client.post("/api/moments/%s/replies" % pid, json={"text": "记得带伞。"})
    assert rr.status_code == 200, rr.text

    feed = client.get("/api/moments?character_id=miao").json()
    assert len(feed["posts"][0]["replies"]) == 1
    assert feed["posts"][0]["replies"][0]["text"] == "记得带伞。"


def test_characters_are_isolated(client, monkeypatch):
    """两个角色的朋友圈互不可见——这是设计里最关键的一条。"""
    monkeypatch.setenv("MSYQ_MOCK", "1")
    _prime(client)

    client.post("/api/moments", json={"characterId": "miao", "text": "只属于 miao 的"})
    client.post("/api/moments", json={"characterId": "qi", "text": "只属于 qi 的"})

    a = client.get("/api/moments?character_id=miao").json()
    b = client.get("/api/moments?character_id=qi").json()
    assert [p["text"] for p in a["posts"]] == ["只属于 miao 的"]
    assert [p["text"] for p in b["posts"]] == ["只属于 qi 的"]


def test_npc_is_scoped_and_deduped(client):
    with db.get_db() as conn:
        n1 = db.upsert_npc(conn, "miao", "小周", "她的室友")
        n2 = db.upsert_npc(conn, "miao", "小周", "室友")  # 同名不再加一条
        assert n1["id"] == n2["id"]
        assert len(db.list_npcs(conn, "miao")) == 1
        # 换一个角色，是另一个世界的人
        assert db.list_npcs(conn, "qi") == []
        db.upsert_npc(conn, "qi", "老陈", "她的老板")
        assert len(db.list_npcs(conn, "qi")) == 1
        assert db.list_npcs(conn, "miao")[0]["name"] == "小周"


def test_bad_npc_is_deletable(client):
    """抽错了（把地点当成人），用户能删。"""
    with db.get_db() as conn:
        npc = db.upsert_npc(conn, "miao", "小卖部", "")
    r = client.delete("/api/moments/npcs/%s" % npc["id"])
    assert r.status_code == 200
    assert r.json()["ok"] is True
    with db.get_db() as conn:
        assert db.list_npcs(conn, "miao") == []


def test_generate_character_post_and_throttle(client, monkeypatch):
    monkeypatch.setenv("MSYQ_MOCK", "1")
    _prime(client)

    r = client.post("/api/moments/generate?character_id=miao")
    assert r.status_code == 200, r.text
    post = r.json()["post"]
    assert post["authorKind"] == "character"
    assert post["text"]
    # 发出去即事实，之后不能被覆盖
    assert post["locked"] is True

    # 同一天第二次被节流
    r2 = client.post("/api/moments/generate?character_id=miao")
    assert r2.status_code == 400


def test_npc_extraction_with_mock(client, monkeypatch):
    monkeypatch.setenv("MSYQ_MOCK", "1")
    _prime(client)
    with db.get_db() as conn:
        row = conn.execute("SELECT id FROM chats WHERE character_id = 'miao'").fetchone()
    assert row
    added = asyncio.run(moments.extract_circle_npcs(row["id"]))
    assert any(n["name"] == "小周" for n in added)
    # 再抽一次不会重复加
    again = asyncio.run(moments.extract_circle_npcs(row["id"]))
    assert again == []


def test_prompt_gets_only_self_posts(client, monkeypatch):
    """进上下文的只有「她和我」发的，NPC 的不带。"""
    monkeypatch.setenv("MSYQ_MOCK", "1")
    with db.get_db() as conn:
        db.create_post(conn, "miao", "character", "miao", "她", "她发的一条")
        db.create_post(conn, "miao", "persona", "p1", "我", "我发的一条")
        db.create_post(conn, "miao", "npc", "npc1", "小周", "路人发的一条")
        rows = moments.recent_for_prompt(conn, "miao", limit=5)
    texts = [r["text"] for r in rows]
    assert "她发的一条" in texts
    assert "我发的一条" in texts
    assert "路人发的一条" not in texts


def test_delete_post_removes_replies(client, monkeypatch):
    monkeypatch.setenv("MSYQ_MOCK", "1")
    r = client.post("/api/moments", json={"characterId": "miao", "text": "会被删掉的一条"})
    pid = r.json()["post"]["id"]
    client.post("/api/moments/%s/replies" % pid, json={"text": "评论一句"})
    assert client.delete("/api/moments/%s" % pid).status_code == 200
    feed = client.get("/api/moments?character_id=miao").json()
    assert feed["posts"] == []



def test_reply_author_matches(client, monkeypatch):
    """评论作者必须和发帖作者一致。"""
    monkeypatch.setenv("MSYQ_MOCK", "1")
    r = client.post("/api/moments", json={"characterId": "miao", "text": "x"})
    pid = r.json()["post"]["id"]
    name = r.json()["post"]["authorName"]
    rr = client.post("/api/moments/%s/replies" % pid, json={"text": "y"})
    assert rr.json()["reply"]["authorName"] == name

PNG_1PX = (
    b"\x89PNG\r\n\x1a\n"
    b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
    b"\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01"
    b"\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)


def test_post_images_upload_list_delete(client, monkeypatch):
    """配图：只收图片、路径进库、文件落盘、能删。"""
    monkeypatch.setenv("MSYQ_MOCK", "1")
    _prime(client)
    pid = client.post(
        "/api/moments", json={"characterId": "miao", "text": "今天的光"}
    ).json()["post"]["id"]

    r = client.post(
        "/api/moments/%s/images" % pid,
        files=[
            ("files", ("a.png", PNG_1PX, "image/png")),
            ("files", ("b.png", PNG_1PX, "image/png")),
        ],
    )
    assert r.status_code == 200, r.text
    imgs = r.json()["images"]
    assert len(imgs) == 2
    assert imgs[0]["path"].startswith("/uploads/posts/")

    # 列表里每条动态都带着图
    feed = client.get("/api/moments?character_id=miao").json()
    assert len(feed["posts"][0]["images"]) == 2

    # 不是图片的直接拒掉
    bad = client.post(
        "/api/moments/%s/images" % pid,
        files=[("files", ("x.txt", b"not an image", "text/plain"))],
    )
    assert bad.status_code == 400

    # 删掉第一张，剩下的重新编号前仍指向原文件
    gone = client.delete("/api/moments/%s/images/0" % pid)
    assert gone.status_code == 200, gone.text
    left = gone.json()["images"]
    assert len(left) == 1
    assert left[0]["path"].endswith("02.png")
