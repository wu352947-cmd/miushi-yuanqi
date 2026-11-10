"""角色卡 / 世界书的 JSON 与 PNG 解析写出（不依赖 Pillow）。

PNG 角色卡格式与前端 A 阶段逻辑一致：tEXt 文字块里找 ccv3，再找 chara，
内容是 Base64 编码的 JSON。导出时至少写 chara（v2 JSON）。

只实现本应用认识的字段；不认识的扩展原样收进 extras，界面不展开。
"""

from __future__ import annotations

import base64
import json
import struct
import zlib
from typing import Any

PNG_SIG = b"\x89PNG\r\n\x1a\n"


# --------------------------------------------------------------------------- PNG 读写
def _chunks(data: bytes):
    if not data.startswith(PNG_SIG):
        return
    offset = 8
    while offset + 12 <= len(data):
        (length,) = struct.unpack(">I", data[offset:offset + 4])
        ctype = data[offset + 4:offset + 8]
        start = offset + 8
        end = start + length
        if end + 4 > len(data):
            return
        yield ctype, data[start:end]
        if ctype == b"IEND":
            return
        offset = end + 4


def _make_chunk(ctype: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + ctype + payload + struct.pack(">I", zlib.crc32(ctype + payload) & 0xFFFFFFFF)


def parse_png_text(data: bytes) -> dict[str, str]:
    out = {"ccv3": "", "chara": ""}
    for ctype, payload in _chunks(data) or []:
        if ctype != b"tEXt":
            continue
        if b"\x00" not in payload:
            continue
        keyword, _, value = payload.partition(b"\x00")
        key = keyword.decode("latin-1", "ignore").lower()
        if key in out:
            out[key] = value.decode("latin-1", "ignore")
    return out


def decode_base64_text(value: str) -> str:
    try:
        raw = base64.b64decode((value or "").strip(), validate=False)
        return raw.decode("utf-8", "replace")
    except (ValueError, TypeError):
        return ""


def card_from_png(data: bytes) -> dict[str, Any] | None:
    texts = parse_png_text(data)
    payload = texts.get("ccv3") or texts.get("chara")
    if not payload:
        return None
    text = decode_base64_text(payload)
    try:
        obj = json.loads(text)
    except ValueError:
        return None
    return obj if isinstance(obj, dict) else None


def _strip_card_chunks(data: bytes) -> list[tuple[bytes, bytes]]:
    kept: list[tuple[bytes, bytes]] = []
    for ctype, payload in _chunks(data) or []:
        if ctype == b"tEXt" and b"\x00" in payload:
            keyword = payload.partition(b"\x00")[0].decode("latin-1", "ignore").lower()
            if keyword in ("ccv3", "chara"):
                continue
        kept.append((ctype, payload))
    return kept


def png_with_card(base_png: bytes | None, card: dict[str, Any]) -> bytes:
    text_value = base64.b64encode(json.dumps(card, ensure_ascii=False).encode("utf-8")).decode("ascii")
    tEXt = _make_chunk(b"tEXt", b"chara\x00" + text_value.encode("latin-1"))
    if base_png and base_png.startswith(PNG_SIG):
        chunks = _strip_card_chunks(base_png)
        if chunks:
            out = bytearray(PNG_SIG)
            for index, (ctype, payload) in enumerate(chunks):
                out += _make_chunk(ctype, payload)
                if index == 0 and ctype == b"IHDR":
                    out += tEXt
            return bytes(out)
    return solid_png(320, 320, (232, 214, 220), tEXt)


def solid_png(width: int, height: int, rgb: tuple[int, int, int], extra_chunk: bytes = b"") -> bytes:
    row = bytes(rgb) * width
    raw = b"".join(b"\x00" + row for _ in range(height))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    out = bytearray(PNG_SIG)
    out += _make_chunk(b"IHDR", ihdr)
    if extra_chunk:
        out += extra_chunk
    out += _make_chunk(b"IDAT", zlib.compress(raw, 9))
    out += _make_chunk(b"IEND", b"")
    return bytes(out)


def data_url_to_png(data_url: str) -> bytes | None:
    value = (data_url or "").strip()
    if not value.startswith("data:image/png;base64,"):
        return None
    try:
        return base64.b64decode(value.split(",", 1)[1])
    except (ValueError, IndexError):
        return None


# --------------------------------------------------------------------------- 角色卡 JSON
KNOWN_TOP = {
    "spec", "spec_version", "data", "name", "description", "personality", "scenario", "first_mes",
    "mes_example", "creatorcomment", "creator_notes", "tags", "char_name", "char_persona",
    "char_greeting", "example_dialogue", "world_scenario", "avatar",
}
KNOWN_DATA = {
    "name", "description", "personality", "scenario", "first_mes", "mes_example", "creator_notes",
    "system_prompt", "post_history_instructions", "alternate_greetings", "character_book", "tags",
    "creator", "character_version", "extensions",
}


def _text(*values: Any) -> str:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def first_sentence(text: str, limit: int = 38) -> str:
    clean = " ".join(str(text or "").split())
    if not clean:
        return ""
    for mark in ("。", "！", "？", "!", "?"):
        index = clean.find(mark)
        if 0 < index <= limit + 8:
            return clean[: index + 1]
    return clean[:limit]


def normalize_character_card(raw: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {"error": "not-card"}
    data = raw.get("data") if isinstance(raw.get("data"), dict) else raw
    cardish = ("name", "description", "personality", "scenario", "first_mes", "char_name", "char_persona", "spec", "data")
    if not any(key in raw or key in data for key in cardish):
        return {"error": "not-card"}
    name = _text(data.get("name"), raw.get("name"), data.get("char_name"), raw.get("char_name"))
    if not name:
        return {"error": "no-name"}
    extras: dict[str, Any] = {"top": {}, "data": {}}
    for key, value in raw.items():
        if key != "data" and key not in KNOWN_TOP:
            extras["top"][key] = value
    if data is not raw:
        for key, value in data.items():
            if key not in KNOWN_DATA:
                extras["data"][key] = value
    if isinstance(data.get("extensions"), dict):
        extras["extensions"] = data["extensions"]
    description = _text(data.get("description"), data.get("char_persona"), raw.get("char_persona"), raw.get("description"))
    book = data.get("character_book") if isinstance(data.get("character_book"), dict) else None
    return {
        "name": name,
        "desc": first_sentence(description),
        "description": description,
        "personality": _text(data.get("personality"), raw.get("personality")),
        "scenario": _text(data.get("scenario"), data.get("world_scenario"), raw.get("scenario"), raw.get("world_scenario")),
        "first_mes": _text(data.get("first_mes"), data.get("char_greeting"), raw.get("first_mes"), raw.get("char_greeting")),
        "mes_example": _text(data.get("mes_example"), data.get("example_dialogue"), raw.get("mes_example"), raw.get("example_dialogue")),
        "character_book": book,
        "extras": extras,
    }


def convert_book_entries(source: Any) -> list[dict[str, Any]]:
    if isinstance(source, list):
        items = source
    elif isinstance(source, dict):
        items = list(source.values())
    else:
        items = []
    out: list[dict[str, Any]] = []
    for index, entry in enumerate(items):
        if not isinstance(entry, dict):
            continue
        content = _text(entry.get("content"), entry.get("entry"), entry.get("text"))
        title = _text(entry.get("comment"), entry.get("name"), entry.get("title")) or ("条目 " + str(index + 1))
        if not content and not title:
            continue
        keys = entry.get("keys", entry.get("key", entry.get("keywords")))
        if isinstance(keys, str):
            keys = [item.strip() for item in keys.replace("，", ",").replace("、", ",").split(",") if item.strip()]
        elif not isinstance(keys, list):
            keys = []
        order = entry.get("insertion_order")
        if not isinstance(order, int):
            order = entry.get("order") if isinstance(entry.get("order"), int) else (index + 1) * 10
        out.append(
            {
                "title": title,
                "content": content,
                "keys": [str(item).strip() for item in keys if str(item).strip()],
                "constant": bool(entry.get("constant")),
                "enabled": entry.get("enabled", True) is not False and entry.get("disable") is not True,
                "order": order,
            }
        )
    return out


def build_v2_character(character: dict[str, Any], book: dict[str, Any] | None = None) -> dict[str, Any]:
    extensions: dict[str, Any] = {}
    extras = character.get("extras") or {}
    if isinstance(extras.get("extensions"), dict):
        extensions.update(extras["extensions"])
    extensions["world"] = (book or {}).get("name") or ""
    extensions["msyq_extras"] = {"top": extras.get("top") or {}, "data": extras.get("data") or {}}
    data: dict[str, Any] = {
        "name": character.get("name") or "",
        "description": character.get("description") or "",
        "personality": character.get("personality") or "",
        "scenario": character.get("scenario") or "",
        "first_mes": character.get("first_mes") or "",
        "mes_example": character.get("mes_example") or "",
        "creator_notes": "",
        "system_prompt": "",
        "post_history_instructions": "",
        "alternate_greetings": [],
        "tags": [],
        "creator": "",
        "character_version": "",
        "extensions": extensions,
    }
    if book:
        data["character_book"] = {
            "name": book.get("name") or "",
            "entries": [
                {
                    "keys": entry.get("keys") or [],
                    "secondary_keys": [],
                    "comment": entry.get("title") or "",
                    "content": entry.get("content") or "",
                    "constant": bool(entry.get("constant")),
                    "selective": True,
                    "insertion_order": entry.get("order") if isinstance(entry.get("order"), int) else (index + 1) * 10,
                    "enabled": entry.get("enabled", True) is not False,
                    "position": "after_char",
                }
                for index, entry in enumerate(book.get("entries") or [])
            ],
        }
    card: dict[str, Any] = {"spec": "chara_card_v2", "spec_version": "2.0", "data": data}
    for key in ("name", "description", "personality", "scenario", "first_mes", "mes_example"):
        card[key] = data[key]
    card["creatorcomment"] = ""
    card["tags"] = []
    return card


def book_to_tavern(book: dict[str, Any]) -> dict[str, Any]:
    entries: dict[str, Any] = {}
    for index, entry in enumerate(book.get("entries") or []):
        entries[str(index)] = {
            "uid": index,
            "key": entry.get("keys") or [],
            "keysecondary": [],
            "comment": entry.get("title") or "",
            "content": entry.get("content") or "",
            "constant": bool(entry.get("constant")),
            "selective": True,
            "order": entry.get("order") if isinstance(entry.get("order"), int) else (index + 1) * 10,
            "position": 0,
            "disable": entry.get("enabled", True) is False,
        }
    return {"name": book.get("name") or "世界书", "entries": entries, "extensions": {}}


def card_from_json_bytes(raw: bytes) -> dict[str, Any]:
    try:
        obj = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        raise ValueError("这不是一份能读的角色卡文件。")
    card = normalize_character_card(obj)
    if card.get("error"):
        raise ValueError("这不是一份能读的角色卡文件。" if card["error"] != "no-name" else "读到了文件，但缺少角色名字。")
    return card
