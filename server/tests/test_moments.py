"""朋友圈：发帖、评论、角色隔离、NPC 去重。

最要紧的一条：**每个角色的朋友圈是一套独立世界**。
温羽蓉那边发生的事，不应该在云诗蘩的动态里出现。
"""

import asyncio

from server import db, moments

from conftest import chat_events


def _bond(cid="miao"):
    """这段对话实际绑定的那条关系。必须跟着 chat 的 persona 走，
    否则测试拿到的是另一个人设的世界，断言会莫名其妙地空。"""
    with db.get_db() as conn:
        chat = conn.execute(
            "SELECT persona_id FROM chats WHERE character_id = ? ORDER BY created_at ASC LIMIT 1",
            (cid,),
        ).fetchone()
        pid = (chat["persona_id"] if chat else "") or ""
        row = conn.execute(
            "SELECT id FROM bonds WHERE character_id = ? AND persona_id = ?",
            (cid, pid),
        ).fetchone()
        if row:
            return row["id"]
        bid = "bond-" + cid
        conn.execute(
            "INSERT OR IGNORE INTO bonds (id, persona_id, character_id, started_at, nickname, "
            "note, created_at, updated_at) VALUES (?, ?, ?, '', '', '', ?, ?)",
            (bid, pid, cid, "2026-01-01T00:00:00", "2026-01-01T00:00:00"),
        )
        return bid


def _prime(client):
    """先聊一句，让 mock 模型有上下文可用。"""
    chat_events(client, "今天有点累。")


def test_post_and_reply(client, monkeypatch):
    monkeypatch.setenv("MSYQ_MOCK", "1")
    _prime(client)

    r = client.post(
        "/api/moments", json={"bondId": _bond("miao"), "text": "今天下了很大的雨。"}
    )
    assert r.status_code == 200, r.text
    pid = r.json()["post"]["id"]
    assert r.json()["post"]["authorKind"] == "persona"

    feed = client.get("/api/moments?bond_id=" + _bond("miao")).json()
    assert len(feed["posts"]) == 1
    assert feed["posts"][0]["text"] == "今天下了很大的雨。"
    assert feed["posts"][0]["replies"] == []

    rr = client.post("/api/moments/%s/replies" % pid, json={"text": "记得带伞。"})
    assert rr.status_code == 200, rr.text

    feed = client.get("/api/moments?bond_id=" + _bond("miao")).json()
    assert len(feed["posts"][0]["replies"]) == 1
    assert feed["posts"][0]["replies"][0]["text"] == "记得带伞。"


def test_characters_are_isolated(client, monkeypatch):
    """两个角色的朋友圈互不可见——这是设计里最关键的一条。"""
    monkeypatch.setenv("MSYQ_MOCK", "1")
    _prime(client)

    client.post("/api/moments", json={"bondId": _bond("miao"), "text": "只属于 miao 的"})
    client.post("/api/moments", json={"bondId": _bond("qi"), "text": "只属于 qi 的"})

    a = client.get("/api/moments?bond_id=" + _bond("miao")).json()
    b = client.get("/api/moments?bond_id=" + _bond("qi")).json()
    assert [p["text"] for p in a["posts"]] == ["只属于 miao 的"]
    assert [p["text"] for p in b["posts"]] == ["只属于 qi 的"]


def test_bonds_are_isolated(client, monkeypatch):
    """同一个角色、换一个人设聊，就是另一个世界。

    这是这一版最重要的隔离：温羽蓉面对杭杭、和面对另一个人，
    朋友圈、NPC 都不该互通。
    """
    monkeypatch.setenv("MSYQ_MOCK", "1")
    _prime(client)
    b1 = _bond("miao")
    b2 = "bond-miao-other"
    with db.get_db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO bonds (id, persona_id, character_id, started_at, nickname, "
            "note, created_at, updated_at) "
            "VALUES (?, 'persona-other', 'miao', '', '', '', '2026-01-01T00:00:00', "
            "'2026-01-01T00:00:00')",
            (b2,),
        )

    client.post("/api/moments", json={"bondId": b1, "text": "杭杭看得到"})
    client.post("/api/moments", json={"bondId": b2, "text": "另一个人看得到"})

    a = client.get("/api/moments?bond_id=" + b1).json()
    b = client.get("/api/moments?bond_id=" + b2).json()
    assert [p["text"] for p in a["posts"]] == ["杭杭看得到"]
    assert [p["text"] for p in b["posts"]] == ["另一个人看得到"]

    # NPC 也一样
    with db.get_db() as conn:
        db.upsert_npc(conn, b1, "miao", "小周", "室友")
        assert len(db.list_npcs(conn, b1)) == 1
        assert db.list_npcs(conn, b2) == []


def test_npc_is_scoped_and_deduped(client):
    with db.get_db() as conn:
        n1 = db.upsert_npc(conn, _bond("miao"), "miao", "小周", "她的室友")
        n2 = db.upsert_npc(conn, _bond("miao"), "miao", "小周", "室友")  # 同名不再加一条
        assert n1["id"] == n2["id"]
        assert len(db.list_npcs(conn, _bond("miao"))) == 1
        # 换一个角色，是另一个世界的人
        assert db.list_npcs(conn, _bond("qi")) == []
        db.upsert_npc(conn, _bond("qi"), "qi", "老陈", "她的老板")
        assert len(db.list_npcs(conn, _bond("qi"))) == 1
        assert db.list_npcs(conn, _bond("miao"))[0]["name"] == "小周"


def test_bad_npc_is_deletable(client):
    """抽错了（把地点当成人），用户能删。"""
    with db.get_db() as conn:
        npc = db.upsert_npc(conn, _bond("miao"), "miao", "小卖部", "")
    r = client.delete("/api/moments/npcs/%s" % npc["id"])
    assert r.status_code == 200
    assert r.json()["ok"] is True
    with db.get_db() as conn:
        assert db.list_npcs(conn, _bond("miao")) == []


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
    bid = _bond("miao")
    with db.get_db() as conn:
        db.create_post(conn, "miao", "character", "miao", "她", "她发的一条", bond_id=bid)
        db.create_post(conn, "miao", "persona", "p1", "我", "我发的一条", bond_id=bid)
        db.create_post(conn, "miao", "npc", "npc1", "小周", "路人发的一条", bond_id=bid)
        rows = moments.recent_for_prompt(conn, "miao", limit=5)
    texts = [r["text"] for r in rows]
    assert "她发的一条" in texts
    assert "我发的一条" in texts
    assert "路人发的一条" not in texts


def test_delete_post_removes_replies(client, monkeypatch):
    monkeypatch.setenv("MSYQ_MOCK", "1")
    r = client.post("/api/moments", json={"bondId": _bond("miao"), "text": "会被删掉的一条"})
    pid = r.json()["post"]["id"]
    client.post("/api/moments/%s/replies" % pid, json={"text": "评论一句"})
    assert client.delete("/api/moments/%s" % pid).status_code == 200
    feed = client.get("/api/moments?bond_id=" + _bond("miao")).json()
    assert feed["posts"] == []



def test_reply_author_matches(client, monkeypatch):
    """评论作者必须和发帖作者一致。"""
    monkeypatch.setenv("MSYQ_MOCK", "1")
    r = client.post("/api/moments", json={"bondId": _bond("miao"), "text": "x"})
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
        "/api/moments", json={"bondId": _bond("miao"), "text": "今天的光"}
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
    feed = client.get("/api/moments?bond_id=" + _bond("miao")).json()
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

def test_character_reacts_to_my_post(client, monkeypatch):
    """我发一条，她本人会来评论——不是 NPC，是她的名字。"""
    monkeypatch.setenv("MSYQ_MOCK", "1")
    _prime(client)
    pid = client.post(
        "/api/moments", json={"bondId": _bond("miao"), "text": "今天走了很远的路。"}
    ).json()["post"]["id"]

    res = asyncio.run(moments.character_react(pid))
    assert res["ok"], res
    assert res["reply"]["authorKind"] == "character"

    feed = client.get("/api/moments?bond_id=" + _bond("miao")).json()
    kinds = [r["authorKind"] for r in feed["posts"][0]["replies"]]
    assert "character" in kinds


def test_character_replies_to_my_comment(client, monkeypatch):
    """我在她的动态下面评论，她会回我。"""
    monkeypatch.setenv("MSYQ_MOCK", "1")
    _prime(client)
    bid = _bond("miao")
    with db.get_db() as conn:
        post = db.create_post(
            conn, "miao", "character", "miao", "缪诗", "晚饭做了两个菜。", bond_id=bid
        )

    res = asyncio.run(moments.character_react(post["id"], my_text="看起来很好吃"))
    assert res["ok"], res
    assert res["reply"]["authorKind"] == "character"

    feed = client.get("/api/moments?bond_id=" + _bond("miao")).json()
    assert len(feed["posts"][0]["replies"]) == 1


def test_character_speaks_at_most_twice_per_post(client, monkeypatch):
    """同一个帖子下面她最多两句，不然刷屏。"""
    monkeypatch.setenv("MSYQ_MOCK", "1")
    _prime(client)
    pid = client.post(
        "/api/moments", json={"bondId": _bond("miao"), "text": "在窗边坐了一会儿。"}
    ).json()["post"]["id"]

    results = [asyncio.run(moments.character_react(pid)) for _ in range(3)]
    assert results[0]["ok"] and results[1]["ok"]
    assert results[2].get("skipped") is True

    feed = client.get("/api/moments?bond_id=" + _bond("miao")).json()
    mine = [r for r in feed["posts"][0]["replies"] if r["authorKind"] == "character"]
    assert len(mine) == 2

def test_like_and_unlike(client, monkeypatch):
    """点赞：点一次一个，重复点不会多，取消就没了。"""
    monkeypatch.setenv("MSYQ_MOCK", "1")
    _prime(client)
    pid = client.post(
        "/api/moments", json={"bondId": _bond("miao"), "text": "赞一下试试。"}
    ).json()["post"]["id"]

    r = client.post("/api/moments/%s/like" % pid)
    assert r.status_code == 200, r.text
    likes = r.json()["likes"]
    assert len(likes) == 1
    assert likes[0]["authorKind"] == "persona"

    # 再点一次不该多出来
    again = client.post("/api/moments/%s/like" % pid)
    assert len(again.json()["likes"]) == 1

    feed = client.get("/api/moments?bond_id=" + _bond("miao")).json()
    assert len(feed["posts"][0]["likes"]) == 1

    gone = client.delete("/api/moments/%s/like" % pid)
    assert gone.status_code == 200
    assert gone.json()["likes"] == []


def test_like_is_scoped_to_post(client, monkeypatch):
    """两个帖子的赞互不影响。"""
    monkeypatch.setenv("MSYQ_MOCK", "1")
    _prime(client)
    a = client.post("/api/moments", json={"bondId": _bond("miao"), "text": "第一条。"}).json()["post"]["id"]
    b = client.post("/api/moments", json={"bondId": _bond("miao"), "text": "第二条。"}).json()["post"]["id"]

    client.post("/api/moments/%s/like" % a)
    feed = client.get("/api/moments?bond_id=" + _bond("miao")).json()
    by_id = {p["id"]: p for p in feed["posts"]}
    assert len(by_id[a]["likes"]) == 1
    assert len(by_id[b]["likes"]) == 0


def test_deleting_post_clears_its_likes(client, monkeypatch):
    monkeypatch.setenv("MSYQ_MOCK", "1")
    _prime(client)
    pid = client.post(
        "/api/moments", json={"bondId": _bond("miao"), "text": "删掉看看。"}
    ).json()["post"]["id"]
    client.post("/api/moments/%s/like" % pid)
    client.delete("/api/moments/%s" % pid)

    with db.get_db() as conn:
        left = conn.execute(
            "SELECT COUNT(*) AS n FROM post_likes WHERE post_id = ?", (pid,)
        ).fetchone()["n"]
    assert left == 0
