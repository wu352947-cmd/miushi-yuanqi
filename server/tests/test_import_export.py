"""角色 / 世界书 / 用户设定 / 预设的导入导出（JSON 与 PNG）。"""

import base64
import json

from server import cards


def card_payload():
    return {
        "spec": "chara_card_v2",
        "spec_version": "2.0",
        "data": {
            "name": "林雾",
            "description": "在旧书店做书目整理。",
            "personality": "耐心。",
            "scenario": "雨天的旧书店。",
            "first_mes": "你来得正好。",
            "mes_example": "",
            "character_book": {
                "name": "旧书店",
                "entries": [
                    {"keys": ["书"], "comment": "书目", "content": "书按颜色排一遍。", "constant": False, "insertion_order": 10, "enabled": True}
                ],
            },
        },
    }


def test_import_json_character_with_embedded_book(client):
    response = client.post(
        "/api/characters/import",
        files={"file": ("card.json", json.dumps(card_payload()).encode("utf-8"), "application/json")},
        data={"mode": "auto"},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    character = payload["character"]
    assert character["name"].startswith("林雾")
    assert character["worldBookId"]
    assert payload["book"]["entryCount"] == 1
    books = client.get("/api/worldbooks").json()["books"]
    imported_book = next(b for b in books if b["id"] == character["worldBookId"])
    assert imported_book["entries"][0]["title"] == "书目"


def test_import_png_character_uses_avatar_and_reads_card(client):
    png = cards.png_with_card(None, card_payload())
    response = client.post(
        "/api/characters/import",
        files={"file": ("card.png", png, "image/png")},
        data={"mode": "auto"},
    )
    assert response.status_code == 200, response.text
    character = response.json()["character"]
    assert character["avatar"].startswith("data:image/png;base64,")
    assert character["name"].startswith("林雾")


def test_export_character_json_and_png_roundtrip(client):
    response = client.post(
        "/api/characters/import",
        files={"file": ("card.json", json.dumps(card_payload()).encode("utf-8"), "application/json")},
        data={"mode": "auto"},
    )
    character_id = response.json()["character"]["id"]
    exported_json = client.get("/api/characters/" + character_id + "/export", params={"format": "json"})
    assert exported_json.status_code == 200
    card = exported_json.json()
    assert card["spec"] == "chara_card_v2"
    assert card["data"]["name"].startswith("林雾")
    assert card["data"]["character_book"]["entries"]

    exported_png = client.get("/api/characters/" + character_id + "/export", params={"format": "png"})
    assert exported_png.status_code == 200
    assert exported_png.content.startswith(cards.PNG_SIG)
    texts = cards.parse_png_text(exported_png.content)
    assert texts["chara"]
    decoded = json.loads(base64.b64decode(texts["chara"]).decode("utf-8"))
    assert decoded["data"]["name"].startswith("林雾")


def test_import_worldbook_tavern_json(client):
    tavern = {
        "name": "雨天的书",
        "entries": {
            "0": {"uid": 0, "key": ["伞"], "comment": "伞", "content": "伞放门边。", "constant": False, "order": 10, "disable": False},
            "1": {"uid": 1, "key": [], "comment": "门灯", "content": "门灯亮着。", "constant": True, "order": 5, "disable": False},
        },
    }
    response = client.post("/api/worldbooks/import", json=tavern)
    assert response.status_code == 200, response.text
    book = response.json()["book"]
    assert len(book["entries"]) == 2
    assert any(entry["constant"] for entry in book["entries"])
    exported = client.get("/api/worldbooks/" + book["id"] + "/export").json()
    assert exported["entries"]


def test_import_tavern_preset(client):
    tavern = {
        "name": "酒馆导入",
        "temperature": 0.7,
        "prompts": [
            {"identifier": "a", "name": "前置", "content": "前置内容", "role": 0, "injection_position": 0},
            {"identifier": "b", "name": "深度", "content": "深度内容", "role": 0, "injection_position": 1, "injection_depth": 2},
        ],
        "prompt_order": [{"order": [{"identifier": "b", "enabled": True}, {"identifier": "a", "enabled": False}]}],
        "unknown_field": {"keep": True},
    }
    response = client.post("/api/presets/import", json=tavern)
    assert response.status_code == 200, response.text
    preset = response.json()["preset"]
    assert preset["source"] == "tavern"
    assert len(preset["fragments"]) == 2
    assert preset["fragments"][0]["position"] == "depth"
    assert preset["fragments"][1]["enabled"] is False
    assert preset["sampling"]["temperature"] == 0.7
    assert preset["extras"]["unknown_field"] == {"keep": True}


def test_import_personas_backup(client):
    payload = {
        "personas": {"a.png": "甲", "b.png": "乙"},
        "persona_descriptions": {"a.png": {"description": "甲的说明"}, "b.png": {"description": "乙的说明"}},
    }
    response = client.post("/api/personas/import", json=payload)
    assert response.status_code == 200, response.text
    assert response.json()["imported"] == 2
    personas = client.get("/api/personas").json()["personas"]
    assert any(p["name"] == "甲" for p in personas)
