"""上下文压缩：计划、注入、撤销。

重点不是「能不能压」，而是「压完还能不能接上」：
被折叠的消息必须由摘要代表，没折叠的必须原样留着。
"""

from server import db, digest, prompts

from conftest import chat_events


def msgs(*specs):
    return [{"id": i + 1, "role": r, "text": t} for i, (r, t) in enumerate(specs)]


# ---------- 纯函数 ----------


def test_pending_skips_covered_messages():
    all_msgs = msgs(("ai", "a"), ("user", "b"), ("ai", "c"), ("user", "d"))
    pending = digest.pending_messages(all_msgs, {"uptoMessageId": 2, "text": "之前的事"})
    assert [m["id"] for m in pending] == [3, 4]


def test_pending_without_digest_returns_all():
    all_msgs = msgs(("ai", "a"), ("user", "b"))
    assert len(digest.pending_messages(all_msgs, None)) == 2
    assert len(digest.pending_messages(all_msgs, {"uptoMessageId": 0, "text": ""})) == 2


def test_pending_keeps_messages_without_id():
    """开场白是即时合成的占位、没有 id，不能因为 0 <= upto 就被吞掉。"""
    all_msgs = [
        {"role": "ai", "text": "开场白"},
        {"id": 5, "role": "user", "text": "好久不见"},
    ]
    pending = digest.pending_messages(all_msgs, {"uptoMessageId": 3, "text": "旧摘要"})
    assert len(pending) == 2


def test_plan_below_threshold_does_nothing():
    """短对话不该压：压了只丢细节，省不下什么。"""
    many = [{"id": i + 1, "role": "ai", "text": "很短"} for i in range(10)]
    p = digest.plan(many, None, 32000, force=False)
    assert p["needed"] is False
    assert "才用了" in p["reason"] or "太短" in p["reason"]


def test_plan_too_few_messages_does_nothing():
    four = [{"id": i + 1, "role": "ai", "text": "很长的内容" * 200} for i in range(3)]
    p = digest.plan(four, None, 1000, force=True)
    assert p["needed"] is False


def test_plan_splits_by_budget():
    many = [
        {"id": i + 1, "role": "ai" if i % 2 else "user", "text": "这是一句足够长的内容。" * 10}
        for i in range(20)
    ]
    p = digest.plan(many, None, 2000, trigger=0.5, keep_ratio=0.5)
    assert p["needed"] is True
    assert len(p["toSummarize"]) + len(p["keep"]) == 20
    # 切点就是「最后一条要被折叠的消息」
    assert p["targetUpto"] == p["toSummarize"][-1]["id"]
    # 保留的都在折叠点之后
    assert min(m["id"] for m in p["keep"]) > p["targetUpto"]


def test_plan_respects_previous_digest():
    """已经压过一次的，第二次只从上次的切点往后算，不重复读老消息。"""
    many = [
        {"id": i + 1, "role": "ai", "text": "这是一句足够长的内容。" * 10} for i in range(24)
    ]
    first = digest.plan(many, None, 2000, trigger=0.5)
    assert first["needed"] is True
    digest_state = {"uptoMessageId": first["targetUpto"], "text": "第一次的摘要"}

    second = digest.plan(many, digest_state, 2000, trigger=0.5)
    if second["needed"]:
        assert min(m["id"] for m in second["toSummarize"]) > first["targetUpto"]
    else:
        # 剩下的不够压也算正确
        assert second["pendingTokens"] < first["pendingTokens"]


def test_clean_digest_strips_fences_and_lead():
    raw = "```markdown\n以下是合并后的摘要：\n【时间线】到了家。\n```"
    out = digest.clean_digest(raw)
    assert "```" not in out
    assert "以下是" not in out
    assert out.startswith("【时间线】")


def test_clean_digest_keeps_plain_text():
    assert digest.clean_digest("  【时间线】下雨了。  ") == "【时间线】下雨了。"


# ---------- 注入 ----------


def _assemble(messages, digest_state=None):
    return prompts.assemble(
        {
            "character": {"name": "羽蓉", "description": "她是个嘴硬心软的人。"},
            "persona": {"name": "杭舟", "description": "我。"},
            "books": [],
            "preset": None,
            "model": {"context": 32768},
            "messages": messages,
            "user_text": "嗯。",
            "digest": digest_state,
        }
    )


def test_assemble_injects_digest_block():
    messages = msgs(("ai", "旧一号"), ("user", "旧二号"), ("ai", "新的"))
    out = _assemble(messages, {"text": "【时间线】以前发生过的事。", "uptoMessageId": 2})
    kinds = [b["kind"] for b in out["blocks"]]
    assert "digest" in kinds
    assert "前情摘要" in out["text"]
    assert "以前发生过的事" in out["text"]
    chat_texts = [b["text"] for b in out["blocks"] if b["kind"] == "chat"]
    assert "旧一号" not in chat_texts
    assert "旧二号" not in chat_texts
    assert "新的" in chat_texts
    assert out["meta"]["digest"] is True


def test_assemble_without_digest_keeps_everything():
    messages = msgs(("ai", "第一条"), ("user", "第二条"))
    out = _assemble(messages, None)
    chat_texts = [b["text"] for b in out["blocks"] if b["kind"] == "chat"]
    assert chat_texts == ["第一条", "第二条"]
    assert "前情摘要" not in out["text"]
    assert out["meta"]["digest"] is False


def test_assemble_digest_goes_before_history():
    """摘要是「更早的事」，位置必须在聊天记录前面，否则会读成刚发生的。"""
    messages = msgs(("ai", "新的"))
    out = _assemble(messages, {"text": "【时间线】很早以前。", "uptoMessageId": 0})
    kinds = [b["kind"] for b in out["blocks"]]
    assert "digest" not in kinds or kinds.index("digest") < kinds.index("chat")


# ---------- API ----------


def _latest_chat_id():
    with db.get_db() as conn:
        row = conn.execute("SELECT id FROM chats ORDER BY created_at DESC LIMIT 1").fetchone()
    return row["id"] if row else ""


def test_compress_api_roundtrip(client, monkeypatch):
    monkeypatch.setenv("MSYQ_MOCK", "1")
    # 把预算压小，否则 32K 预算下测试要写几万字才到阈值
    monkeypatch.setattr("server.prompts.history_budget", lambda model, sampling, override=0: 3000)

    for i in range(6):
        chat_events(client, ("第%d句 " % i) + "把这段对话撑长一点，好让压缩有东西可压。" * 25)

    chat_id = _latest_chat_id()
    assert chat_id

    preview = client.post("/api/chats/id/%s/compress-preview" % chat_id).json()
    assert preview["ok"] is True
    assert preview["needed"] is True, preview
    before_pending = preview["pendingTokens"]

    r = client.post("/api/chats/id/%s/compress" % chat_id, json={})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["ok"] is True
    assert out["digest"]["text"]
    assert out["digest"]["uptoMessageId"] > 0
    assert out["usage"]["freedTokens"] > 0

    saved = client.get("/api/chats/id/%s/digest" % chat_id).json()["digest"]
    assert saved["text"] == out["digest"]["text"]
    assert saved["messageCount"] > 0

    # 再预览：待压的部分明显变小了
    again = client.post("/api/chats/id/%s/compress-preview" % chat_id).json()
    assert again["pendingTokens"] < before_pending

    # 手改摘要
    edited = client.patch(
        "/api/chats/id/%s/digest" % chat_id, json={"text": "【时间线】手改过的摘要。"}
    ).json()
    assert edited["digest"]["text"] == "【时间线】手改过的摘要。"
    # 手改不改变覆盖范围
    assert edited["digest"]["uptoMessageId"] == saved["uptoMessageId"]

    # 空摘要要被拒
    bad = client.patch("/api/chats/id/%s/digest" % chat_id, json={"text": "   "})
    assert bad.status_code == 400

    # 撤销
    dropped = client.delete("/api/chats/id/%s/digest" % chat_id).json()
    assert dropped["ok"] is True
    assert client.get("/api/chats/id/%s/digest" % chat_id).json()["digest"] is None


def test_compress_rejects_short_chat(client, monkeypatch):
    """短对话不该被压——不能为了让功能「有反应」就硬压。"""
    monkeypatch.setenv("MSYQ_MOCK", "1")
    monkeypatch.setattr("server.prompts.history_budget", lambda model, sampling, override=0: 3000)
    chat_events(client, "就说一句。")
    chat_id = _latest_chat_id()
    r = client.post("/api/chats/id/%s/compress" % chat_id, json={})
    assert r.status_code == 400
    assert "短" in r.json()["error"]["message"] or "才用了" in r.json()["error"]["message"]


def test_compress_preserves_messages(client, monkeypatch):
    """压缩只改「发给模型什么」，聊天记录一条都不能少。"""
    monkeypatch.setenv("MSYQ_MOCK", "1")
    monkeypatch.setattr("server.prompts.history_budget", lambda model, sampling, override=0: 3000)
    for i in range(6):
        chat_events(client, ("第%d句 " % i) + "把这段对话撑长一点，好让压缩有东西可压。" * 25)
    chat_id = _latest_chat_id()

    with db.get_db() as conn:
        before = conn.execute(
            "SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?", (chat_id,)
        ).fetchone()["n"]

    client.post("/api/chats/id/%s/compress" % chat_id, json={})

    with db.get_db() as conn:
        after = conn.execute(
            "SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?", (chat_id,)
        ).fetchone()["n"]
    assert after == before


def test_digest_endpoints_404_on_missing_chat(client):
    assert client.get("/api/chats/id/nope/digest").status_code == 404
    assert client.post("/api/chats/id/nope/compress-preview").status_code == 404
    assert client.post("/api/chats/id/nope/compress", json={}).status_code == 404
    assert client.delete("/api/chats/id/nope/digest").status_code == 404