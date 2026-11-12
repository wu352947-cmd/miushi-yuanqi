"""首页：今日记住 / 生日 / 便条。

规矩只有一条：**拿不到就返回 None**，前端整块藏起来。
以前这四处全是写死的（福州小雨 18°C、还有 12 天生日），看两次就穿帮。
"""
from datetime import date

from server import db, home


def test_birthday_days():
    today = date(2026, 11, 12)
    assert home.birthday_days("11-12", today) == 0
    assert home.birthday_days("11-20", today) == 8
    assert home.birthday_days("05-13", today) == 182
    assert home.birthday_days("01-01", date(2026, 12, 31)) == 1
    assert home.birthday_days("", today) is None
    assert home.birthday_days(None, today) is None
    assert home.birthday_days("abc", today) is None
    assert home.birthday_days("02-30", today) is None


def _seed(conn, cid, title, importance=7, kind="note"):
    conn.execute(
        "INSERT INTO memories (id, kind, category, title, body, importance, tags_json, "
        "source, source_chat_id, status, protected, scope, character_id, persona_id, "
        "created_at, updated_at, last_used_at) "
        "VALUES (?, ?, '日常', ?, ?, ?, '[]', '', '', 'normal', 0, 'pair', ?, '', "
        "'2026-11-12T02:00:00', '2026-11-12T02:00:00', '')",
        (cid + "-" + title, kind, title, "正文 " + title, importance, cid),
    )


def test_pick_memory_stable_within_a_day(client):
    """同一天反复刷新首页，看到的必须是同一条——不然像有人在背后换。"""
    with db.get_db() as conn:
        conn.execute("DELETE FROM memories")
        _seed(conn, "c1", "A")
        _seed(conn, "c1", "B")
        _seed(conn, "c1", "C")
        first = home.pick_memory(conn, "c1", "2026-11-12")
        again = home.pick_memory(conn, "c1", "2026-11-12")
    assert first and again
    assert first["title"] == again["title"]


def test_pick_memory_is_scoped_by_character(client):
    with db.get_db() as conn:
        conn.execute("DELETE FROM memories")
        _seed(conn, "c1", "只看这句")
        _seed(conn, "c2", "另一个人的")
        mine = home.pick_memory(conn, "c1", "2026-11-12")
        other = home.pick_memory(conn, "c2", "2026-11-12")
        empty = home.pick_memory(conn, "", "2026-11-12")
    assert mine["title"] == "只看这句"
    assert other["title"] == "另一个人的"
    assert empty is None


def test_pick_memory_prefers_important(client):
    """importance < 6 的不配上首页，除非库里一条够格的都没有。"""
    with db.get_db() as conn:
        conn.execute("DELETE FROM memories")
        _seed(conn, "c1", "小事", importance=2)
        _seed(conn, "c1", "要紧的事", importance=9)
        for day in ("2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"):
            assert home.pick_memory(conn, "c1", day)["title"] == "要紧的事"


def test_clean_note():
    assert home._clean_note("「记得带伞。」") == "记得带伞。"
    assert home._clean_note("```\n门外有伞\n```") == "门外有伞"
    assert home._clean_note("汤在锅里——我先睡了") == "汤在锅里"
    assert home._clean_note("") == ""
    assert len(home._clean_note("啊" * 100)) <= home.NOTE_MAX_CHARS + 1


def test_note_endpoint_writes_and_caches(client, monkeypatch):
    monkeypatch.setenv("MSYQ_MOCK", "1")
    from conftest import chat_events

    chat_events(client, "我回来了。")
    with db.get_db() as conn:
        row = conn.execute("SELECT id FROM chats ORDER BY created_at ASC LIMIT 1").fetchone()
        chat_id = row["id"]
    r = client.post("/api/home/note?chat_id=" + chat_id)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True, body
    text = body["note"]["text"]
    assert text
    again = client.post("/api/home/note?chat_id=" + chat_id).json()
    assert again["note"]["text"] == text


def test_default_settings_have_home_fields(client):
    """前端 baseState 和后端 DEFAULT_SETTINGS 的默认值必须一致，
    否则后端根本不知道有城市，天气永远显示不出来。"""
    with db.get_db() as conn:
        cfg = db.load_app_settings(conn)
    s = cfg["settings"]
    assert s["homeCity"] == "福州"
    assert s["birthday"] == ""
    assert s["homeNoteEnabled"] is True


def test_home_payload_hides_missing(client):
    """城市留空、没设生日、也没有便条 → 各块都是 null，前端负责藏。

    这里必须先把城市清掉：默认值是「福州」，不清就会真的去问天气。
    """
    with db.get_db() as conn:
        cfg = db.load_app_settings(conn)
        cfg["settings"]["homeCity"] = ""
        cfg["settings"]["birthday"] = ""
        db.save_app_settings(conn, cfg)

    r = client.get("/api/home?character_id=miao&chat_id=nope")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["ok"] is True
    assert d["weather"] is None
    assert d["birthday"] is None
    assert d["note"] is None
    assert d["day"]