"""导入角色卡时的世界书去重：内容相同就复用，不同才新建。"""

import json


def _payload(name="林雾", book_name="旧书店", entries=None):
    if entries is None:
        entries = [
            {
                "keys": ["书"],
                "comment": "书目",
                "content": "书按颜色排一遍。",
                "constant": False,
                "insertion_order": 10,
                "enabled": True,
            }
        ]
    return {
        "spec": "chara_card_v2",
        "spec_version": "2.0",
        "data": {
            "name": name,
            "description": "在旧书店做书目整理。",
            "personality": "耐心。",
            "scenario": "雨天的旧书店。",
            "first_mes": "你来得正好。",
            "mes_example": "",
            "character_book": {"name": book_name, "entries": entries},
        },
    }


def _import(client, payload, filename="card.json"):
    return client.post(
        "/api/characters/import",
        files={"file": (filename, json.dumps(payload).encode("utf-8"), "application/json")},
        data={"mode": "auto"},
    )


def _book_count(client):
    return len(client.get("/api/worldbooks").json()["books"])


def test_same_card_twice_reuses_worldbook(client):
    before = _book_count(client)

    first = _import(client, _payload())
    assert first.status_code == 200, first.text
    body1 = first.json()
    assert body1["book"] is not None
    assert body1["book"]["reused"] is False, "第一次应当是新建"
    after_first = _book_count(client)
    assert after_first == before + 1

    second = _import(client, _payload())
    assert second.status_code == 200, second.text
    body2 = second.json()
    assert body2["book"]["reused"] is True, "第二次应当复用"
    assert body2["book"]["id"] == body1["book"]["id"], "复用的必须是同一本"
    assert _book_count(client) == after_first, "世界书数量不该增长"
    assert "复用" in body2["note"]

    # 角色本身还是各建一份（种子数据里本来就有「林雾」，所以只会更多）
    assert body2["character"]["id"] != body1["character"]["id"], "角色应当各建一份"
    names = [c["name"] for c in client.get("/api/characters").json()["characters"]]
    assert len([n for n in names if n.startswith("林雾")]) >= 2


def test_different_content_still_creates_new_book(client):
    before = _book_count(client)
    _import(client, _payload(name="甲"))
    _import(
        client,
        _payload(
            name="乙",
            entries=[
                {
                    "keys": ["灯"],
                    "comment": "夜灯",
                    "content": "门灯留到听见「到了」。",
                    "constant": True,
                    "insertion_order": 20,
                    "enabled": True,
                }
            ],
        ),
    )
    assert _book_count(client) == before + 2, "内容不同应当各建一本"


def test_entry_order_and_constant_count_in_fingerprint(client):
    """同样的文字但 constant / 顺序不同，算不同的书（避免张冠李戴）。"""
    before = _book_count(client)
    _import(client, _payload(name="甲"), "a.json")
    _import(
        client,
        _payload(
            name="甲二",
            entries=[
                {
                    "keys": ["书"],
                    "comment": "书目",
                    "content": "书按颜色排一遍。",
                    "constant": True,  # 从 False 改成 True
                    "insertion_order": 10,
                    "enabled": True,
                }
            ],
        ),
        "b.json",
    )
    assert _book_count(client) == before + 2


def test_card_without_book_returns_none(client):
    payload = _payload()
    payload["data"].pop("character_book")
    response = _import(client, payload)
    assert response.status_code == 200, response.text
    assert response.json()["book"] is None