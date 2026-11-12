"""SQLite 数据库：建表、迁移、演示数据、序列化与整体状态同步。

设计要点
- 后端是权威：前端通过 GET /api/bootstrap 拿快照，编辑后 PUT /api/state 整体同步
  （聊天消息和记忆走各自的专用接口，不参与整体同步，避免互相覆盖）。
- 只有一张数据库文件（默认 data/miushi.db），不需要 ORM。
- 迁移用 schema_migrations 表记录版本，启动时自动执行。
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator

try:  # 兼容 python -m server.app 与直接 import
    from . import auth
except ImportError:  # pragma: no cover - 兜底
    import auth  # type: ignore

BASE_DIR = Path(__file__).resolve().parent
ROOT_DIR = BASE_DIR.parent

SCHEMA_VERSION = 10


# --------------------------------------------------------------------------- 路径
def data_dir() -> Path:
    raw = (os.environ.get("MSYQ_DATA_DIR") or "").strip()
    path = Path(raw).expanduser() if raw else (ROOT_DIR / "data")
    path.mkdir(parents=True, exist_ok=True)
    return path


def db_path() -> Path:
    raw = (os.environ.get("MSYQ_DB_PATH") or "").strip()
    if raw:
        path = Path(raw).expanduser()
        path.parent.mkdir(parents=True, exist_ok=True)
        return path
    return data_dir() / "miushi.db"


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def today_str() -> str:
    return time.strftime("%Y-%m-%d")


def new_id(prefix: str) -> str:
    return prefix + "-" + uuid.uuid4().hex[:12]


# --------------------------------------------------------------------------- 连接
def connect() -> sqlite3.Connection:
    # check_same_thread=False：同步依赖可能在线程池里建连接，而异步路由在事件循环里用；
    # 每个请求仍然是独立连接、串行使用，不存在并发共享。
    # isolation_level=None：SQLite 自动提交。这样接口一返回，后端立刻能读到自己的写入，
    # 前端紧接着 GET /api/bootstrap 不会读到旧快照（单用户场景，不追求多语句事务）。
    conn = sqlite3.connect(str(db_path()), timeout=20, check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=OFF")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


@contextmanager
def get_db() -> Iterator[sqlite3.Connection]:
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# --------------------------------------------------------------------------- JSON 小工具
def jloads(text: Any, default: Any = None) -> Any:
    if text is None or text == "":
        return default
    if isinstance(text, (dict, list)):
        return text
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return default


def jdumps(value: Any) -> str:
    return json.dumps(value if value is not None else {}, ensure_ascii=False)


def _bool(value: Any) -> int:
    return 1 if value else 0


def _int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


# --------------------------------------------------------------------------- 建表
SCHEMA: list[str] = [
    """
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '',
      protocol TEXT NOT NULL DEFAULT 'openai',
      base_url TEXT NOT NULL DEFAULT '',
      api_path TEXT NOT NULL DEFAULT '',
      api_key_enc TEXT NOT NULL DEFAULT '',
      api_key_mask TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      balance_json TEXT NOT NULL DEFAULT '{}',
      advanced_json TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL DEFAULT 'user',
      extras_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '',
      caps_json TEXT NOT NULL DEFAULT '{}',
      context INTEGER NOT NULL DEFAULT 0,
      favorite INTEGER NOT NULL DEFAULT 0,
      price_json TEXT,
      reasoning_json TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS prompt_presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      desc TEXT NOT NULL DEFAULT '',
      builtin INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'user',
      fragments_json TEXT NOT NULL DEFAULT '[]',
      sampling_json TEXT NOT NULL DEFAULT '{}',
      extras_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      desc TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      personality TEXT NOT NULL DEFAULT '',
      scenario TEXT NOT NULL DEFAULT '',
      first_mes TEXT NOT NULL DEFAULT '',
      mes_example TEXT NOT NULL DEFAULT '',
      avatar TEXT NOT NULL DEFAULT '',
      world_book_id TEXT NOT NULL DEFAULT '',
      default_persona_id TEXT NOT NULL DEFAULT '',
      default_preset_id TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'user',
      extras_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS user_personas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      avatar TEXT NOT NULL DEFAULT '',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS world_books (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS world_book_entries (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      keys_json TEXT NOT NULL DEFAULT '[]',
      constant INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      ord INTEGER NOT NULL DEFAULT 10,
      extras_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      persona_id TEXT NOT NULL DEFAULT '',
      world_book_id TEXT NOT NULL DEFAULT '',
      preset_id TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL DEFAULT '',
      reasoning_level TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0,
      settings_json TEXT NOT NULL DEFAULT '{}',
      last_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      thinking_json TEXT,
      usage_json TEXT,
      ms INTEGER NOT NULL DEFAULT 0,
      fallback TEXT NOT NULL DEFAULT '',
      aside TEXT NOT NULL DEFAULT '',
      tool_json TEXT,
      error_kind TEXT NOT NULL DEFAULT '',
      time TEXT NOT NULL DEFAULT '',
      edited INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'note',
      category TEXT NOT NULL DEFAULT '日常',
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      importance INTEGER NOT NULL DEFAULT 5,
      tags_json TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT '',
      source_chat_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'normal',
      protected INTEGER NOT NULL DEFAULT 0,
      scope TEXT NOT NULL DEFAULT 'pair',
      character_id TEXT NOT NULL DEFAULT '',
      persona_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL DEFAULT ''
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS bonds (
      id TEXT PRIMARY KEY,
      persona_id TEXT NOT NULL DEFAULT '',
      character_id TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT '',
      nickname TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(persona_id, character_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      conversation_id TEXT NOT NULL DEFAULT '',
      character_id TEXT NOT NULL DEFAULT '',
      provider_id TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL DEFAULT '',
      model_key TEXT NOT NULL DEFAULT '',
      model_name TEXT NOT NULL DEFAULT '',
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      cache_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      first_token_ms INTEGER NOT NULL DEFAULT 0,
      ok INTEGER NOT NULL DEFAULT 1,
      error_kind TEXT,
      estimated INTEGER NOT NULL DEFAULT 0,
      fallback_reasoning INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'chat'
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS chat_digests (
      chat_id TEXT PRIMARY KEY,
      text TEXT NOT NULL DEFAULT '',
      upto_message_id INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      source_tokens INTEGER NOT NULL DEFAULT 0,
      digest_tokens INTEGER NOT NULL DEFAULT 0,
      model_key TEXT NOT NULL DEFAULT '',
      manual INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL DEFAULT '',
      bond_id TEXT NOT NULL DEFAULT '',
      author_kind TEXT NOT NULL DEFAULT 'character',
      author_id TEXT NOT NULL DEFAULT '',
      author_name TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      at TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      locked INTEGER NOT NULL DEFAULT 0,
      images_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS post_replies (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      author_kind TEXT NOT NULL DEFAULT 'character',
      author_id TEXT NOT NULL DEFAULT '',
      author_name TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )
    """,
    # v9：点赞。谁给谁点过，一个帖子下同一个人只能有一条。
    """
    CREATE TABLE IF NOT EXISTS post_likes (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      author_kind TEXT NOT NULL DEFAULT 'persona',
      author_id TEXT NOT NULL DEFAULT '',
      author_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS circle_npcs (
      id TEXT PRIMARY KEY,
      bond_id TEXT NOT NULL DEFAULT '',
      character_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      relation TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      last_seen_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )
    """,
    # v7：首页「她留给你的那句话」按天缓存。
    # 一天一条，生成过就不再改；同一天刷新首页不会反复花钱。
    """
    CREATE TABLE IF NOT EXISTS home_notes (
      chat_id TEXT NOT NULL,
      day TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY (chat_id, day)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_usage_at ON usage(at)",
    "CREATE INDEX IF NOT EXISTS idx_usage_model ON usage(model_id)",
    "CREATE INDEX IF NOT EXISTS idx_usage_char ON usage(character_id)",
    "CREATE INDEX IF NOT EXISTS idx_posts_char ON posts(character_id, at)",
    "CREATE INDEX IF NOT EXISTS idx_replies_post ON post_replies(post_id, created_at)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_likes_unique "
    "ON post_likes(post_id, author_kind, author_id)",
    "CREATE INDEX IF NOT EXISTS idx_npcs_char ON circle_npcs(character_id)",
    "CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id)",
    "CREATE INDEX IF NOT EXISTS idx_entries_book ON world_book_entries(book_id, ord)",
    "CREATE INDEX IF NOT EXISTS idx_chats_char ON chats(character_id)",
    "CREATE INDEX IF NOT EXISTS idx_chats_character_lookup ON chats(character_id)",
    "CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status, updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_bonds_pair ON bonds(persona_id, character_id)",
]


def _columns(conn, table: str) -> set[str]:
    try:
        return {r["name"] for r in conn.execute("PRAGMA table_info(" + table + ")").fetchall()}
    except sqlite3.Error:
        return set()


def _migrate(conn, current: int) -> None:
    """v2：多对话（去掉角色唯一索引）+ usage 新增思考 / 缓存写入列 + 对话置顶 / 附加设置。
    v3：多对话管理（messages.edited 标记「编辑过」）。"""
    if current < 2:
        usage_cols = _columns(conn, "usage")
        if "cache_write_tokens" not in usage_cols:
            conn.execute("ALTER TABLE usage ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0")
        if "reasoning_tokens" not in usage_cols:
            conn.execute("ALTER TABLE usage ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0")
        chat_cols = _columns(conn, "chats")
        if "pinned" not in chat_cols:
            conn.execute("ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")
        if "settings_json" not in chat_cols:
            conn.execute("ALTER TABLE chats ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'")
        conn.execute("DROP INDEX IF EXISTS idx_chats_character_unique")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_chats_character_lookup ON chats(character_id)")
    if current < 3:
        message_cols = _columns(conn, "messages")
        if "edited" not in message_cols:
            conn.execute("ALTER TABLE messages ADD COLUMN edited INTEGER NOT NULL DEFAULT 0")
    if current < 4:
        # v4：记忆按关系隔离（世界 / 角色 / 关系对），并引入 bonds（一段关系）
        mem_cols = _columns(conn, "memories")
        if "scope" not in mem_cols:
            conn.execute("ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'pair'")
        if "character_id" not in mem_cols:
            conn.execute("ALTER TABLE memories ADD COLUMN character_id TEXT NOT NULL DEFAULT ''")
        if "persona_id" not in mem_cols:
            conn.execute("ALTER TABLE memories ADD COLUMN persona_id TEXT NOT NULL DEFAULT ''")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_memories_scope "
            "ON memories(scope, character_id, persona_id, kind, status)"
        )
        # 历史记忆全部归到最早的那段关系上，避免凭空多出「无主记忆」
        first = conn.execute(
            "SELECT character_id, persona_id FROM chats ORDER BY created_at ASC LIMIT 1"
        ).fetchone()
        if first:
            conn.execute(
                "UPDATE memories SET character_id = ?, persona_id = ? "
                "WHERE character_id = '' AND persona_id = '' AND kind IN ('note', 'now')",
                (first["character_id"], first["persona_id"] or ""),
            )
        # 每一段已有的 (persona, character) 建一条关系
        started = ""
        try:
            row = conn.execute("SELECT value FROM settings WHERE key = 'app_state'").fetchone()
            if row:
                cfg = jloads(row["value"], {})
                started = str(cfg.get("startDate") or "")
        except sqlite3.Error:
            started = ""
        now = now_iso()
        seen = set()
        for row in conn.execute("SELECT DISTINCT character_id, persona_id FROM chats").fetchall():
            cid, pid = row["character_id"] or "", row["persona_id"] or ""
            if not cid or (cid, pid) in seen:
                continue
            seen.add((cid, pid))
            exists = conn.execute(
                "SELECT 1 FROM bonds WHERE character_id = ? AND persona_id = ?", (cid, pid)
            ).fetchone()
            if not exists:
                conn.execute(
                    "INSERT INTO bonds (id, persona_id, character_id, started_at, nickname, note, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, '', '', ?, ?)",
                    (new_id("bond"), pid, cid, started, now, now),
                )
    if current < 10:
        # v10：朋友圈的隔离单位从「角色」改成「这段关系」。
        # 温羽蓉面对杭杭、和面对岑，是两个世界：记忆、NPC、动态都该分开。
        npc_cols = _columns(conn, "circle_npcs")
        if "bond_id" not in npc_cols:
            conn.execute("ALTER TABLE circle_npcs ADD COLUMN bond_id TEXT NOT NULL DEFAULT ''")
        # 老 NPC 按角色的第一条关系回填（当时没有 persona 维度，只能这么估）
        for npc in conn.execute(
            "SELECT id, character_id FROM circle_npcs WHERE bond_id = ''"
        ).fetchall():
            bond = conn.execute(
                "SELECT id FROM bonds WHERE character_id = ? ORDER BY created_at ASC LIMIT 1",
                (npc["character_id"],),
            ).fetchone()
            if bond:
                conn.execute(
                    "UPDATE circle_npcs SET bond_id = ? WHERE id = ?", (bond["id"], npc["id"])
                )
        # 我的帖子当年没记 bond，按角色补上
        for post in conn.execute(
            "SELECT id, character_id FROM posts WHERE bond_id = '' AND character_id != ''"
        ).fetchall():
            bond = conn.execute(
                "SELECT id FROM bonds WHERE character_id = ? ORDER BY created_at ASC LIMIT 1",
                (post["character_id"],),
            ).fetchone()
            if bond:
                conn.execute("UPDATE posts SET bond_id = ? WHERE id = ?", (bond["id"], post["id"]))
        # 索引必须等列加好之后再建（所以不能放在 SCHEMA 里）
        conn.execute("CREATE INDEX IF NOT EXISTS idx_npcs_bond ON circle_npcs(bond_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_posts_bond ON posts(bond_id, at)")
    if current < 8:
        # v8：朋友圈配图。库里只留路径数组，图片本体在 data/uploads/ 下，
        # 这样每 5 分钟整体复制的同步层不会因为图片变重。
        post_cols = _columns(conn, "posts")
        if "images_json" not in post_cols:
            conn.execute(
                "ALTER TABLE posts ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]'"
            )


def init_db() -> None:
    with get_db() as conn:
        for sql in SCHEMA:
            conn.execute(sql)
        row = conn.execute("SELECT MAX(version) AS v FROM schema_migrations").fetchone()
        current = _int(row["v"], 0) if row else 0
        _migrate(conn, current)
        if current < SCHEMA_VERSION:
            conn.execute(
                "INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
                (SCHEMA_VERSION, now_iso()),
            )
        conn.execute(
            "INSERT OR IGNORE INTO users (id, name, created_at) VALUES ('local', ?, ?)",
            (auth.user_name(), now_iso()),
        )
        if _get_setting(conn, "seeded", None) is None:
            seed_database(conn)
            _set_setting(conn, "seeded", "1")


# --------------------------------------------------------------------------- settings
def _get_setting(conn, key: str, default: Any = None) -> Any:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    if not row:
        return default
    return jloads(row["value"], default)


def _set_setting(conn, key: str, value: Any) -> None:
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        (key, jdumps(value), now_iso()),
    )


DEFAULT_SETTINGS: dict[str, Any] = {
    "theme": "pink",
    "overrides": {"pink": {}, "ice": {}},
    "listen": {"playlist": 0, "song": 0},
    "modelId": "",
    "currentCharacterId": "",
    "backupAt": "",
    "settings": {
        "notify": True,
        "splashAlways": True,
        "startDate": "2024-11-08",
        "globalBookId": "",
        "defaultPresetId": "",
        "memoryExtractEnabled": True,
        "memoryExtractEvery": 4,
        # 历史最多带多少 token。超过这个数，老消息会被挤出上下文；
        # 压缩也以它为基准算百分比。0 = 用默认 32000。
        "contextBudget": 32000,
        # 她要不要在你进聊天页时自己开口。默认关：
        # 她只认上下文、没有时间感，隔久了会在原地接着说，看着奇怪。
        "proactiveEnabled": False,
        # 首页那几块：城市（留空=不显示天气）/ 生日 MM-DD（留空=不显示倒计时）
        # / 她每天留一句话。默认值要和前端 baseState 保持一致。
        "homeCity": "福州",
        "birthday": "",
        "homeNoteEnabled": True,
    },
}


def load_app_settings(conn) -> dict[str, Any]:
    data = _get_setting(conn, "app_state", None)
    out = json.loads(json.dumps(DEFAULT_SETTINGS))
    if isinstance(data, dict):
        for key, value in data.items():
            if value is None:
                continue
            if key == "settings" and isinstance(value, dict):
                out["settings"].update(value)
            elif key == "overrides" and isinstance(value, dict):
                out["overrides"] = value
            else:
                out[key] = value
    return out


def save_app_settings(conn, data: dict[str, Any]) -> None:
    _set_setting(conn, "app_state", data)


# --------------------------------------------------------------------------- 序列化
def character_json(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "desc": row["desc"],
        "description": row["description"],
        "personality": row["personality"],
        "scenario": row["scenario"],
        "first_mes": row["first_mes"],
        "mes_example": row["mes_example"],
        "avatar": row["avatar"],
        "worldBookId": row["world_book_id"],
        "defaultPersonaId": row["default_persona_id"],
        "defaultPresetId": row["default_preset_id"],
        "source": row["source"],
        "extras": jloads(row["extras_json"], {}),
    }


def persona_json(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "avatar": row["avatar"],
        "is_default": bool(row["is_default"]),
    }


def provider_json(row: sqlite3.Row, models_by_provider: dict[str, list[dict]] | None = None) -> dict[str, Any]:
    pid = row["id"]
    models = list((models_by_provider or {}).get(pid, []))
    return {
        "id": pid,
        "name": row["name"],
        "icon": row["icon"],
        "protocol": row["protocol"],
        "baseUrl": row["base_url"],
        "apiPath": row["api_path"],
        "enabled": bool(row["enabled"]),
        "balance": jloads(row["balance_json"], {}),
        "advanced": jloads(row["advanced_json"], {}),
        "models": [m["id"] for m in models],
        "source": row["source"],
        "extras": jloads(row["extras_json"], {}),
        "hasKey": bool(row["api_key_enc"]),
        "keyMasked": row["api_key_mask"] or "",
    }


def model_json(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "providerId": row["provider_id"],
        "name": row["name"],
        "modelId": row["model_id"],
        "icon": row["icon"],
        "caps": jloads(row["caps_json"], {}),
        "context": row["context"],
        "favorite": bool(row["favorite"]),
        "price": jloads(row["price_json"], None),
        "reasoning": jloads(row["reasoning_json"], {"mode": "none", "levels": []}),
        "source": row["source"],
    }


def preset_json(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "desc": row["desc"],
        "builtin": bool(row["builtin"]),
        "source": row["source"],
        "fragments": jloads(row["fragments_json"], []),
        "sampling": jloads(row["sampling_json"], {}),
        "extras": jloads(row["extras_json"], {}),
    }


def book_json(conn, row: sqlite3.Row) -> dict[str, Any]:
    entries = [
        {
            "id": e["id"],
            "title": e["title"],
            "content": e["content"],
            "keys": jloads(e["keys_json"], []),
            "constant": bool(e["constant"]),
            "enabled": bool(e["enabled"]),
            "order": e["ord"],
            "extras": jloads(e["extras_json"], {}),
        }
        for e in conn.execute(
            "SELECT * FROM world_book_entries WHERE book_id = ? ORDER BY ord ASC, id ASC", (row["id"],)
        ).fetchall()
    ]
    return {"id": row["id"], "name": row["name"], "entries": entries}


def memory_json(row: sqlite3.Row) -> dict[str, Any]:
    status = row["status"] or "normal"
    return {
        "id": row["id"],
        "kind": row["kind"],
        "cat": row["category"],
        "category": row["category"],
        "title": row["title"],
        "body": row["body"],
        "importance": row["importance"],
        "tags": jloads(row["tags_json"], []),
        "source": row["source"],
        "sourceChatId": row["source_chat_id"],
        "scope": (row["scope"] if "scope" in row.keys() else "pair") or "pair",
        "characterId": (row["character_id"] if "character_id" in row.keys() else "") or "",
        "personaId": (row["persona_id"] if "persona_id" in row.keys() else "") or "",
        "pinned": status == "pinned",
        "protected": bool(row["protected"]),
        "forgotten": status == "forgotten",
        "status": status,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def message_json(row: sqlite3.Row) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": row["id"],
        "role": row["role"],
        "text": row["text"],
        "time": row["time"],
    }
    thinking = jloads(row["thinking_json"], None)
    if thinking:
        out["thinking"] = thinking
    usage = jloads(row["usage_json"], None)
    if usage:
        out["usage"] = usage
    if row["ms"]:
        out["ms"] = row["ms"]
    if row["fallback"]:
        out["fallback"] = row["fallback"]
    if row["aside"]:
        out["aside"] = row["aside"]
    tool = jloads(row["tool_json"], None)
    if tool:
        out["tool"] = tool
    if row["error_kind"]:
        out["errorKind"] = row["error_kind"]
    if "edited" in row.keys() and row["edited"]:
        out["edited"] = True
    return out


def chat_json(conn, row: sqlite3.Row, include_messages: bool = True) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": row["id"],
        "characterId": row["character_id"],
        "personaId": row["persona_id"],
        "worldBookId": row["world_book_id"],
        "presetId": row["preset_id"],
        "modelId": row["model_id"],
        "reasoningLevel": row["reasoning_level"],
        "title": row["title"],
        "pinned": bool(row["pinned"]) if "pinned" in row.keys() else False,
        "settings": jloads(row["settings_json"], {}) if "settings_json" in row.keys() else {},
        "lastAt": row["last_at"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "messages": [],
    }
    if include_messages:
        rows = conn.execute(
            "SELECT * FROM messages WHERE chat_id = ? ORDER BY id ASC", (row["id"],)
        ).fetchall()
        out["messages"] = [message_json(r) for r in rows]
    return out


# --------------------------------------------------------------------------- 读取聚合
def get_state(conn) -> dict[str, Any]:
    config = load_app_settings(conn)
    models = [model_json(r) for r in conn.execute("SELECT * FROM models ORDER BY created_at ASC, id ASC").fetchall()]
    models_by_provider: dict[str, list[dict]] = {}
    for m in models:
        models_by_provider.setdefault(m["providerId"], []).append(m)
    providers = [
        provider_json(r, models_by_provider)
        for r in conn.execute("SELECT * FROM providers ORDER BY created_at ASC, id ASC").fetchall()
    ]
    characters = [character_json(r) for r in conn.execute("SELECT * FROM characters ORDER BY created_at ASC, id ASC").fetchall()]
    personas = [persona_json(r) for r in conn.execute("SELECT * FROM user_personas ORDER BY created_at ASC, id ASC").fetchall()]
    books = [book_json(conn, r) for r in conn.execute("SELECT * FROM world_books ORDER BY created_at ASC, id ASC").fetchall()]
    presets = [preset_json(r) for r in conn.execute("SELECT * FROM prompt_presets ORDER BY created_at ASC, id ASC").fetchall()]
    chats: dict[str, Any] = {}
    for character in characters:
        row = get_chat_row(conn, character["id"])
        if row:
            chats[character["id"]] = chat_json(conn, row, include_messages=True)
    memories = [
        memory_json(r)
        for r in conn.execute("SELECT * FROM memories ORDER BY updated_at DESC, created_at DESC").fetchall()
    ]
    now_body = ""
    now_row = get_now_row(conn)
    if now_row:
        now_body = now_row["body"]
    state = {
        "theme": config.get("theme", "pink"),
        "overrides": config.get("overrides", {"pink": {}, "ice": {}}),
        "settings": config.get("settings", {}),
        "listen": config.get("listen", {"playlist": 0, "song": 0}),
        "backupAt": config.get("backupAt", ""),
        "modelId": config.get("modelId", ""),
        "currentCharacterId": config.get("currentCharacterId", ""),
        "model": {"model": ""},
        "providers": providers,
        "models": models,
        "promptPresets": presets,
        "characters": characters,
        "userPersonas": personas,
        "worldBooks": books,
        "chats": chats,
        "memories": memories,
        "nowText": now_body,
    }
    if not state["currentCharacterId"] and characters:
        state["currentCharacterId"] = characters[0]["id"]
    if not state["modelId"] and models:
        state["modelId"] = models[0]["id"]
    return state


def get_character(conn, character_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM characters WHERE id = ?", (character_id,)).fetchone()
    return character_json(row) if row else None


def get_persona(conn, persona_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM user_personas WHERE id = ?", (persona_id,)).fetchone()
    return persona_json(row) if row else None


def get_book(conn, book_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM world_books WHERE id = ?", (book_id,)).fetchone()
    return book_json(conn, row) if row else None


def get_provider_row(conn, provider_id: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM providers WHERE id = ?", (provider_id,)).fetchone()


def get_provider(conn, provider_id: str) -> dict[str, Any] | None:
    row = get_provider_row(conn, provider_id)
    return provider_json(row) if row else None


def get_model(conn, model_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM models WHERE id = ?", (model_id,)).fetchone()
    return model_json(row) if row else None


def get_preset(conn, preset_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM prompt_presets WHERE id = ?", (preset_id,)).fetchone()
    return preset_json(row) if row else None


def get_chat_row(conn, character_id: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM chats WHERE character_id = ? ORDER BY pinned DESC, last_at DESC, created_at DESC LIMIT 1",
        (character_id,),
    ).fetchone()


def get_chat_row_by_id(conn, chat_id: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM chats WHERE id = ?", (chat_id,)).fetchone()


def list_chat_rows(conn, character_id: str | None = None) -> list[sqlite3.Row]:
    if character_id:
        return conn.execute(
            "SELECT * FROM chats WHERE character_id = ? ORDER BY pinned DESC, last_at DESC, created_at DESC",
            (character_id,),
        ).fetchall()
    return conn.execute("SELECT * FROM chats ORDER BY pinned DESC, last_at DESC, created_at DESC").fetchall()


def create_chat(conn, character_id: str, title: str = "", **bindings: Any) -> sqlite3.Row:
    now = now_iso()
    chat_id = new_id("chat")
    conn.execute(
        "INSERT INTO chats (id, character_id, persona_id, world_book_id, preset_id, model_id, reasoning_level, title, pinned, settings_json, last_at, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            chat_id,
            character_id,
            bindings.get("persona_id") or "",
            bindings.get("world_book_id") or "",
            bindings.get("preset_id") or "",
            bindings.get("model_id") or "",
            bindings.get("reasoning_level") or "",
            title or "",
            1 if bindings.get("pinned") else 0,
            jdumps(bindings.get("settings") or {}),
            now,
            now,
            now,
        ),
    )
    return get_chat_row_by_id(conn, chat_id)  # type: ignore[return-value]


def get_chat(conn, character_id: str, include_messages: bool = True) -> dict[str, Any] | None:
    row = get_chat_row(conn, character_id)
    return chat_json(conn, row, include_messages) if row else None


def ensure_chat(conn, character_id: str) -> sqlite3.Row:
    row = get_chat_row(conn, character_id)
    if row:
        # 老数据可能只有聊天没有关系记录，顺手补齐（幂等）
        ensure_bond(conn, row["persona_id"] or "", character_id)
        return row
    config = load_app_settings(conn)
    now = now_iso()
    # 建聊天就把「这段关系是谁」固化下来：否则 persona 靠运行时解析，
    # 一旦默认设定变了，已经积累的记忆就会挂在另一个人名下。
    prow = conn.execute(
        "SELECT id FROM user_personas ORDER BY is_default DESC, created_at ASC LIMIT 1"
    ).fetchone()
    persona_id = prow["id"] if prow else ""
    conn.execute(
        "INSERT INTO chats (id, character_id, persona_id, world_book_id, preset_id, model_id, reasoning_level, title, last_at, created_at, updated_at) "
        "VALUES (?, ?, ?, '', '', ?, '', '', '', ?, ?)",
        (new_id("chat"), character_id, persona_id, config.get("modelId", ""), now, now),
    )
    # 新的一段关系从今天开始算
    ensure_bond(conn, persona_id, character_id, now[:10])
    return get_chat_row(conn, character_id)  # type: ignore[return-value]


def default_chat_title(conn, character_id: str) -> str:
    """默认标题：角色名 - YYYY-MM-DD HH:mm（不调用模型）。"""
    character = get_character(conn, character_id)
    name = (character or {}).get("name") or "新对话"
    return name + " - " + time.strftime("%Y-%m-%d %H:%M")


def chat_summary(conn, row: sqlite3.Row) -> dict[str, Any]:
    """对话列表行：标题 + 最后一句预览 + 时间 + 条数 + 绑定。"""
    out = chat_json(conn, row, include_messages=False)
    last = conn.execute(
        "SELECT role, text, time, created_at FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1",
        (row["id"],),
    ).fetchone()
    count = conn.execute("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?", (row["id"],)).fetchone()["n"]
    out["messageCount"] = count
    preview = ""
    if last:
        preview = (("我：" if last["role"] == "me" else "") + str(last["text"] or "")).replace("\n", " ")
    out["preview"] = preview[:80]
    if not out.get("lastAt") and last:
        out["lastAt"] = last["created_at"]
    return out


def list_chat_summaries(conn, character_id: str | None = None, q: str = "") -> list[dict[str, Any]]:
    rows = list_chat_rows(conn, character_id)
    out = [chat_summary(conn, row) for row in rows]
    needle = str(q or "").strip().lower()
    if needle:
        out = [
            item
            for item in out
            if needle in str(item.get("title") or "").lower() or needle in str(item.get("preview") or "").lower()
        ]
    return out


def search_chat_messages(conn, q: str, character_id: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    """搜索消息内容（可跳到对应位置）；标题命中的对话也返回一条（messageId=None）。"""
    needle = str(q or "").strip()
    if not needle:
        return []
    like = "%" + needle + "%"
    results: list[dict[str, Any]] = []
    sql = (
        "SELECT m.*, c.title AS chat_title, c.character_id AS character_id FROM messages m "
        "JOIN chats c ON c.id = m.chat_id WHERE m.text LIKE ?"
    )
    params: list[Any] = [like]
    if character_id:
        sql += " AND c.character_id = ?"
        params.append(character_id)
    sql += " ORDER BY m.id DESC LIMIT ?"
    params.append(int(limit))
    for row in conn.execute(sql, params).fetchall():
        results.append(
            {
                "chatId": row["chat_id"],
                "characterId": row["character_id"],
                "chatTitle": row["chat_title"],
                "messageId": row["id"],
                "role": row["role"],
                "text": str(row["text"] or "")[:160],
                "time": row["time"],
                "createdAt": row["created_at"],
            }
        )
    title_sql = "SELECT * FROM chats WHERE title LIKE ?"
    title_params: list[Any] = [like]
    if character_id:
        title_sql += " AND character_id = ?"
        title_params.append(character_id)
    title_sql += " ORDER BY last_at DESC LIMIT ?"
    title_params.append(int(limit))
    for row in conn.execute(title_sql, title_params).fetchall():
        results.append(
            {
                "chatId": row["id"],
                "characterId": row["character_id"],
                "chatTitle": row["title"],
                "messageId": None,
                "role": "",
                "text": "",
                "time": "",
                "createdAt": row["created_at"],
            }
        )
    return results[: int(limit)]


def chat_full_by_id(conn, chat_id: str) -> dict[str, Any] | None:
    row = get_chat_row_by_id(conn, chat_id)
    return chat_json(conn, row, include_messages=True) if row else None


def delete_chat_by_id(conn, chat_id: str) -> bool:
    row = get_chat_row_by_id(conn, chat_id)
    if not row:
        return False
    conn.execute("DELETE FROM messages WHERE chat_id = ?", (chat_id,))
    conn.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
    return True


def branch_chat(conn, chat_id: str, message_id: int) -> dict[str, Any] | None:
    """从某一条消息另开分支：新对话复制到这一条（含）为止，绑定全部复制。"""
    row = get_chat_row_by_id(conn, chat_id)
    if not row:
        return None
    target = conn.execute("SELECT * FROM messages WHERE id = ? AND chat_id = ?", (int(message_id), chat_id)).fetchone()
    if not target:
        return None
    title = (row["title"] or default_chat_title(conn, row["character_id"])) + " · 分支"
    new_row = create_chat(
        conn,
        row["character_id"],
        title=title,
        persona_id=row["persona_id"],
        world_book_id=row["world_book_id"],
        preset_id=row["preset_id"],
        model_id=row["model_id"],
        reasoning_level=row["reasoning_level"],
        settings=jloads(row["settings_json"], {}),
    )
    source = conn.execute(
        "SELECT * FROM messages WHERE chat_id = ? AND id <= ? ORDER BY id ASC",
        (chat_id, int(message_id)),
    ).fetchall()
    last_at = ""
    for msg in source:
        conn.execute(
            "INSERT INTO messages (chat_id, role, text, thinking_json, usage_json, ms, fallback, aside, tool_json, error_kind, time, edited, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                new_row["id"],
                msg["role"],
                msg["text"],
                msg["thinking_json"],
                msg["usage_json"],
                msg["ms"],
                msg["fallback"],
                msg["aside"],
                msg["tool_json"],
                msg["error_kind"],
                msg["time"],
                msg["edited"] if "edited" in msg.keys() else 0,
                msg["created_at"],
            ),
        )
        last_at = msg["created_at"]
    if last_at:
        conn.execute("UPDATE chats SET last_at = ?, updated_at = ? WHERE id = ?", (last_at, now_iso(), new_row["id"]))
    return chat_full_by_id(conn, new_row["id"])


def update_message_text(conn, chat_id: str, message_id: int, text: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM messages WHERE id = ? AND chat_id = ?", (int(message_id), chat_id)).fetchone()
    if not row:
        return None
    conn.execute("UPDATE messages SET text = ?, edited = 1 WHERE id = ?", (text or "", int(message_id)))
    conn.execute("UPDATE chats SET updated_at = ? WHERE id = ?", (now_iso(), chat_id))
    return message_json(conn.execute("SELECT * FROM messages WHERE id = ?", (int(message_id),)).fetchone())


def delete_message_row(conn, chat_id: str, message_id: int) -> bool:
    row = conn.execute("SELECT id FROM messages WHERE id = ? AND chat_id = ?", (int(message_id), chat_id)).fetchone()
    if not row:
        return False
    conn.execute("DELETE FROM messages WHERE id = ?", (int(message_id),))
    conn.execute("UPDATE chats SET updated_at = ? WHERE id = ?", (now_iso(), chat_id))
    return True


def append_message(conn, chat_id: str, role: str, text: str, **fields: Any) -> dict[str, Any]:
    now = now_iso()
    time_label = fields.pop("time", "") or time.strftime("%H:%M")
    cur = conn.execute(
        "INSERT INTO messages (chat_id, role, text, thinking_json, usage_json, ms, fallback, aside, tool_json, error_kind, time, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            chat_id,
            role,
            text or "",
            jdumps(fields["thinking"]) if fields.get("thinking") else None,
            jdumps(fields["usage"]) if fields.get("usage") else None,
            _int(fields.get("ms"), 0),
            fields.get("fallback") or "",
            fields.get("aside") or "",
            jdumps(fields["tool"]) if fields.get("tool") else None,
            fields.get("error_kind") or "",
            time_label,
            now,
        ),
    )
    conn.execute("UPDATE chats SET last_at = ?, updated_at = ? WHERE id = ?", (now, now, chat_id))
    row = conn.execute("SELECT * FROM messages WHERE id = ?", (cur.lastrowid,)).fetchone()
    return message_json(row)


# --------------------------------------------------------------------------- 现在卡 / 记忆
def get_now_row(conn, character_id: str = "", persona_id: str = "") -> sqlite3.Row | None:
    if character_id:
        return conn.execute(
            "SELECT * FROM memories WHERE kind = 'now' AND character_id = ? AND persona_id = ? "
            "ORDER BY updated_at DESC LIMIT 1",
            (character_id, persona_id),
        ).fetchone()
    # 空参数只返回世界层（没有绑定关系的）那条，绝不回退到某个角色的 now
    return conn.execute(
        "SELECT * FROM memories WHERE kind = 'now' AND character_id = '' AND persona_id = '' "
        "ORDER BY updated_at DESC LIMIT 1"
    ).fetchone()


# --------------------------------------------------------------------------- 关系（bonds）
def bond_json(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "personaId": row["persona_id"],
        "characterId": row["character_id"],
        "startedAt": row["started_at"],
        "nickname": row["nickname"],
        "note": row["note"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def get_bond_row(conn, persona_id: str, character_id: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM bonds WHERE persona_id = ? AND character_id = ?",
        (persona_id or "", character_id or ""),
    ).fetchone()


def ensure_bond(conn, persona_id: str, character_id: str, started_at: str = "") -> sqlite3.Row | None:
    """取这段关系，没有就建一条。角色为空时返回 None。"""
    if not character_id:
        return None
    row = get_bond_row(conn, persona_id, character_id)
    if row:
        return row
    now = now_iso()
    conn.execute(
        "INSERT INTO bonds (id, persona_id, character_id, started_at, nickname, note, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, '', '', ?, ?)",
        (new_id("bond"), persona_id or "", character_id, started_at, now, now),
    )
    return get_bond_row(conn, persona_id, character_id)


def list_bonds(conn) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM bonds ORDER BY updated_at DESC").fetchall()


# --------------------------------------------------------------------------- 同步：整体状态
def _ids(items: Iterable[dict]) -> list[str]:
    return [str(i.get("id")) for i in items if i and i.get("id")]


def sync_state(conn, state: dict[str, Any]) -> None:
    """把前端整体状态写回数据库。聊天消息、记忆、现在卡不在这里处理。"""
    now = now_iso()

    # 角色
    characters = state.get("characters") or []
    for c in characters:
        _upsert_character(conn, c, now)
    keep = _ids(characters)
    if keep:
        conn.execute(
            "DELETE FROM characters WHERE id NOT IN (%s)" % ",".join("?" * len(keep)), keep
        )
        conn.execute(
            "DELETE FROM chats WHERE character_id NOT IN (%s)" % ",".join("?" * len(keep)), keep
        )
        conn.execute(
            "DELETE FROM messages WHERE chat_id NOT IN (SELECT id FROM chats)"
        )

    # 用户设定
    personas = state.get("userPersonas") or []
    for p in personas:
        _upsert_persona(conn, p, now)
    keep = _ids(personas)
    if keep:
        conn.execute(
            "DELETE FROM user_personas WHERE id NOT IN (%s)" % ",".join("?" * len(keep)), keep
        )

    # 世界书 + 条目
    books = state.get("worldBooks") or []
    for b in books:
        _upsert_book(conn, b, now)
    keep = _ids(books)
    if keep:
        conn.execute(
            "DELETE FROM world_books WHERE id NOT IN (%s)" % ",".join("?" * len(keep)), keep
        )
        conn.execute(
            "DELETE FROM world_book_entries WHERE book_id NOT IN (SELECT id FROM world_books)"
        )

    # 提示词预设
    presets = state.get("promptPresets") or []
    for p in presets:
        _upsert_preset(conn, p, now)
    keep = _ids(presets)
    if keep:
        conn.execute(
            "DELETE FROM prompt_presets WHERE id NOT IN (%s)" % ",".join("?" * len(keep)), keep
        )

    # 提供商（保留已有加密 Key；apiKey 字段一律忽略）
    providers = state.get("providers") or []
    for p in providers:
        _upsert_provider(conn, p, now)
    keep = _ids(providers)
    if keep:
        conn.execute(
            "DELETE FROM providers WHERE id NOT IN (%s)" % ",".join("?" * len(keep)), keep
        )
        conn.execute(
            "DELETE FROM models WHERE provider_id NOT IN (SELECT id FROM providers)"
        )

    # 模型
    models = state.get("models") or []
    for m in models:
        _upsert_model(conn, m, now)
    keep = _ids(models)
    if keep:
        conn.execute(
            "DELETE FROM models WHERE id NOT IN (%s)" % ",".join("?" * len(keep)), keep
        )

    # 聊天元数据（不含消息）
    chats = state.get("chats") or {}
    for character_id, chat in chats.items():
        if not chat:
            continue
        row = get_chat_row_by_id(conn, str(chat.get("id") or "")) if chat.get("id") else None
        if row is None:
            row = get_chat_row(conn, character_id)
        if not row:
            conn.execute(
                "INSERT INTO chats (id, character_id, persona_id, world_book_id, preset_id, model_id, reasoning_level, title, last_at, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    chat.get("id") or new_id("chat"),
                    character_id,
                    chat.get("personaId") or "",
                    chat.get("worldBookId") or "",
                    chat.get("presetId") or "",
                    chat.get("modelId") or "",
                    chat.get("reasoningLevel") or "",
                    chat.get("title") or "",
                    chat.get("lastAt") or "",
                    now,
                    now,
                ),
            )
        else:
            conn.execute(
                "UPDATE chats SET persona_id = ?, world_book_id = ?, preset_id = ?, model_id = ?, reasoning_level = ?, title = ?, last_at = ?, updated_at = ? WHERE id = ?",
                (
                    chat.get("personaId") or "",
                    chat.get("worldBookId") or "",
                    chat.get("presetId") or "",
                    chat.get("modelId") or "",
                    chat.get("reasoningLevel") or "",
                    chat.get("title") if chat.get("title") is not None else row["title"],
                    chat.get("lastAt") or row["last_at"],
                    now,
                    row["id"],
                ),
            )

    # 设置 / 主题 / 壁纸 / 当前模型与角色
    config = load_app_settings(conn)
    if state.get("theme") in ("pink", "ice"):
        config["theme"] = state["theme"]
    if isinstance(state.get("overrides"), dict):
        config["overrides"] = state["overrides"]
    if isinstance(state.get("listen"), dict):
        config["listen"] = state["listen"]
    if "backupAt" in state:
        config["backupAt"] = state.get("backupAt") or ""
    new_settings = state.get("settings")
    if isinstance(new_settings, dict):
        # 合并全部传入项，不做白名单：settings 是自由字典，缺的键由
        # DEFAULT_SETTINGS 兜底。之前是列举 key，加一个设置就得记得来这里
        # 补一行——上下文压缩那四项就这么漏掉了，配了永远存不进后端。
        for key, value in new_settings.items():
            if value is None:
                continue
            config["settings"][key] = value
    if state.get("modelId") is not None:
        config["modelId"] = state.get("modelId") or ""
    if state.get("currentCharacterId") is not None:
        config["currentCharacterId"] = state.get("currentCharacterId") or ""
    save_app_settings(conn, config)


def _upsert_character(conn, c: dict, now: str) -> None:
    if not c.get("id"):
        return
    conn.execute(
        "INSERT INTO characters (id, name, desc, description, personality, scenario, first_mes, mes_example, avatar, world_book_id, default_persona_id, default_preset_id, source, extras_json, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET name=excluded.name, desc=excluded.desc, description=excluded.description, "
        "personality=excluded.personality, scenario=excluded.scenario, first_mes=excluded.first_mes, mes_example=excluded.mes_example, "
        "avatar=excluded.avatar, world_book_id=excluded.world_book_id, default_persona_id=excluded.default_persona_id, "
        "default_preset_id=excluded.default_preset_id, source=excluded.source, extras_json=excluded.extras_json, updated_at=excluded.updated_at",
        (
            c["id"],
            c.get("name") or "未命名",
            c.get("desc") or "",
            c.get("description") or "",
            c.get("personality") or "",
            c.get("scenario") or "",
            c.get("first_mes") or "",
            c.get("mes_example") or "",
            c.get("avatar") or "",
            c.get("worldBookId") or "",
            c.get("defaultPersonaId") or "",
            c.get("defaultPresetId") or "",
            c.get("source") or "user",
            jdumps(c.get("extras") or {}),
            now,
            now,
        ),
    )


def _upsert_persona(conn, p: dict, now: str) -> None:
    if not p.get("id"):
        return
    conn.execute(
        "INSERT INTO user_personas (id, name, description, avatar, is_default, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, avatar=excluded.avatar, "
        "is_default=excluded.is_default, updated_at=excluded.updated_at",
        (
            p["id"],
            p.get("name") or "未命名",
            p.get("description") or "",
            p.get("avatar") or "",
            _bool(p.get("is_default")),
            now,
            now,
        ),
    )


def _upsert_book(conn, b: dict, now: str) -> None:
    if not b.get("id"):
        return
    conn.execute(
        "INSERT INTO world_books (id, name, created_at, updated_at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at",
        (b["id"], b.get("name") or "未命名世界书", now, now),
    )
    entries = b.get("entries") or []
    for i, e in enumerate(entries):
        if not e.get("id"):
            e["id"] = new_id("e")
        conn.execute(
            "INSERT INTO world_book_entries (id, book_id, title, content, keys_json, constant, enabled, ord, extras_json, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET book_id=excluded.book_id, title=excluded.title, content=excluded.content, "
            "keys_json=excluded.keys_json, constant=excluded.constant, enabled=excluded.enabled, ord=excluded.ord, "
            "extras_json=excluded.extras_json, updated_at=excluded.updated_at",
            (
                e["id"],
                b["id"],
                e.get("title") or "",
                e.get("content") or "",
                jdumps(e.get("keys") or []),
                _bool(e.get("constant")),
                _bool(e.get("enabled", True)),
                _int(e.get("order"), (i + 1) * 10),
                jdumps(e.get("extras") or {}),
                now,
                now,
            ),
        )
    keep = _ids(entries)
    if keep:
        conn.execute(
            "DELETE FROM world_book_entries WHERE book_id = ? AND id NOT IN (%s)" % ",".join("?" * len(keep)),
            [b["id"]] + keep,
        )
    else:
        conn.execute("DELETE FROM world_book_entries WHERE book_id = ?", (b["id"],))


def _upsert_preset(conn, p: dict, now: str) -> None:
    if not p.get("id"):
        return
    conn.execute(
        "INSERT INTO prompt_presets (id, name, desc, builtin, source, fragments_json, sampling_json, extras_json, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET name=excluded.name, desc=excluded.desc, builtin=excluded.builtin, source=excluded.source, "
        "fragments_json=excluded.fragments_json, sampling_json=excluded.sampling_json, extras_json=excluded.extras_json, updated_at=excluded.updated_at",
        (
            p["id"],
            p.get("name") or "未命名预设",
            p.get("desc") or "",
            _bool(p.get("builtin")),
            p.get("source") or "user",
            jdumps(p.get("fragments") or []),
            jdumps(p.get("sampling") or {}),
            jdumps(p.get("extras") or {}),
            now,
            now,
        ),
    )


def _upsert_provider(conn, p: dict, now: str) -> None:
    if not p.get("id"):
        return
    conn.execute(
        "INSERT INTO providers (id, name, icon, protocol, base_url, api_path, enabled, balance_json, advanced_json, source, extras_json, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET name=excluded.name, icon=excluded.icon, protocol=excluded.protocol, "
        "base_url=excluded.base_url, api_path=excluded.api_path, enabled=excluded.enabled, balance_json=excluded.balance_json, "
        "advanced_json=excluded.advanced_json, source=excluded.source, extras_json=excluded.extras_json, updated_at=excluded.updated_at",
        (
            p["id"],
            p.get("name") or "未命名提供商",
            p.get("icon") or "",
            p.get("protocol") or "openai",
            p.get("baseUrl") or "",
            p.get("apiPath") or "",
            _bool(p.get("enabled", True)),
            jdumps(p.get("balance") or {}),
            jdumps(p.get("advanced") or {}),
            p.get("source") or "user",
            jdumps(p.get("extras") or {}),
            now,
            now,
        ),
    )


def _upsert_model(conn, m: dict, now: str) -> None:
    if not m.get("id") or not m.get("providerId"):
        return
    conn.execute(
        "INSERT INTO models (id, provider_id, name, model_id, icon, caps_json, context, favorite, price_json, reasoning_json, source, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id, name=excluded.name, model_id=excluded.model_id, "
        "icon=excluded.icon, caps_json=excluded.caps_json, context=excluded.context, favorite=excluded.favorite, "
        "price_json=excluded.price_json, reasoning_json=excluded.reasoning_json, source=excluded.source, updated_at=excluded.updated_at",
        (
            m["id"],
            m["providerId"],
            m.get("name") or m.get("modelId") or "未命名模型",
            m.get("modelId") or "",
            m.get("icon") or "",
            jdumps(m.get("caps") or {}),
            _int(m.get("context"), 0),
            _bool(m.get("favorite")),
            jdumps(m.get("price")) if m.get("price") is not None else None,
            jdumps(m.get("reasoning") or {"mode": "none", "levels": []}),
            m.get("source") or "user",
            now,
            now,
        ),
    )


# --------------------------------------------------------------------------- 演示数据
def _seed_path() -> Path:
    return BASE_DIR / "seed_data.json"


def seed_database(conn) -> None:
    if (os.environ.get("MSYQ_SEED") or "1").strip() in ("0", "false", "off"):
        return
    path = _seed_path()
    if not path.exists():
        return
    try:
        seed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    now = now_iso()
    for c in seed.get("characters") or []:
        _upsert_character(conn, c, now)
    for p in seed.get("userPersonas") or []:
        _upsert_persona(conn, p, now)
    for b in seed.get("worldBooks") or []:
        _upsert_book(conn, b, now)
    for p in seed.get("providers") or []:
        _upsert_provider(conn, p, now)
    for m in seed.get("models") or []:
        _upsert_model(conn, m, now)
    for p in seed.get("promptPresets") or []:
        _upsert_preset(conn, p, now)
    for m in seed.get("memories") or []:
        _insert_seed_memory(conn, m, now)
    now_text = seed.get("nowText") or ""
    if now_text:
        conn.execute(
            "INSERT INTO memories (id, kind, category, title, body, importance, tags_json, source, source_chat_id, status, protected, created_at, updated_at) "
            "VALUES ('now-card', 'now', '此刻', '现在卡', ?, 5, '[]', '手动', '', 'normal', 0, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at",
            (now_text, now, now),
        )
    config = load_app_settings(conn)
    settings_seed = seed.get("settings") or {}
    config["theme"] = settings_seed.get("theme", config["theme"])
    config["overrides"] = settings_seed.get("overrides", config["overrides"])
    for key in ("notify", "splashAlways", "startDate", "globalBookId", "defaultPresetId", "memoryExtractEnabled", "memoryExtractEvery"):
        if key in settings_seed:
            config["settings"][key] = settings_seed[key]
    config["modelId"] = settings_seed.get("modelId") or config["modelId"]
    config["currentCharacterId"] = settings_seed.get("currentCharacterId") or config["currentCharacterId"]
    config["listen"] = settings_seed.get("listen") or config["listen"]
    save_app_settings(conn, config)


def _insert_seed_memory(conn, m: dict, now: str) -> None:
    if not m.get("id"):
        return
    status = "pinned" if m.get("pinned") else "normal"
    conn.execute(
        "INSERT OR IGNORE INTO memories (id, kind, category, title, body, importance, tags_json, source, source_chat_id, status, protected, created_at, updated_at) "
        "VALUES (?, 'note', ?, ?, ?, ?, '[]', ?, '', ?, ?, ?, ?)",
        (
            m["id"],
            m.get("cat") or "日常",
            m.get("title") or "",
            m.get("body") or "",
            _int(m.get("importance"), 5),
            m.get("source") or "",
            status,
            _bool(m.get("protected")),
            now,
            now,
        ),
    )


# --------------------------------------------------------------------------- 从浏览器迁移
def migrate_local_state(conn, state: dict[str, Any], include_keys: bool = False) -> dict[str, Any]:
    """把浏览器 localStorage 快照导入数据库；按 id 去重，可重复调用。"""
    now = now_iso()
    result: dict[str, Any] = {
        "characters": 0,
        "personas": 0,
        "books": 0,
        "presets": 0,
        "providers": 0,
        "models": 0,
        "chats": 0,
        "messages": 0,
        "memories": 0,
        "keys": 0,
        "settings": 0,
        "skipped": 0,
    }

    def exists(table: str, item_id: str) -> bool:
        return conn.execute(f"SELECT 1 FROM {table} WHERE id = ?", (item_id,)).fetchone() is not None

    for c in state.get("characters") or []:
        if not c or not c.get("id"):
            continue
        if exists("characters", c["id"]):
            result["skipped"] += 1
            continue
        _upsert_character(conn, c, now)
        result["characters"] += 1

    for p in state.get("userPersonas") or []:
        if not p or not p.get("id"):
            continue
        if exists("user_personas", p["id"]):
            result["skipped"] += 1
            continue
        _upsert_persona(conn, p, now)
        result["personas"] += 1

    for b in state.get("worldBooks") or []:
        if not b or not b.get("id"):
            continue
        if exists("world_books", b["id"]):
            result["skipped"] += 1
            continue
        _upsert_book(conn, b, now)
        result["books"] += 1

    # 预设
    for p in state.get("promptPresets") or []:
        if not p or not p.get("id"):
            continue
        if exists("prompt_presets", p["id"]):
            result["skipped"] += 1
            continue
        _upsert_preset(conn, p, now)
        result["presets"] += 1

    # 提供商 + 模型（Key 只在用户确认后上传）
    for p in state.get("providers") or []:
        if not p or not p.get("id"):
            continue
        if exists("providers", p["id"]):
            result["skipped"] += 1
            continue
        _upsert_provider(conn, p, now)
        plain = (p.get("apiKey") or "").strip() if include_keys else ""
        if plain:
            auth.store_key(conn, p["id"], plain)
            result["keys"] += 1
        result["providers"] += 1
    for m in state.get("models") or []:
        if not m or not m.get("id"):
            continue
        if exists("models", m["id"]):
            result["skipped"] += 1
            continue
        if not conn.execute("SELECT 1 FROM providers WHERE id = ?", (m.get("providerId"),)).fetchone():
            result["skipped"] += 1
            continue
        _upsert_model(conn, m, now)
        result["models"] += 1

    # 聊天与消息
    chats = state.get("chats") or {}
    if isinstance(chats, dict):
        for character_id, chat in chats.items():
            if not chat or not character_id:
                continue
            if not conn.execute("SELECT 1 FROM characters WHERE id = ?", (character_id,)).fetchone():
                continue
            if get_chat_row(conn, character_id):
                result["skipped"] += 1
                continue
            chat_id = new_id("chat")
            conn.execute(
                "INSERT INTO chats (id, character_id, persona_id, world_book_id, preset_id, model_id, reasoning_level, title, last_at, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    chat_id,
                    character_id,
                    chat.get("personaId") or "",
                    chat.get("worldBookId") or "",
                    chat.get("presetId") or "",
                    chat.get("modelId") or "",
                    chat.get("reasoningLevel") or "",
                    chat.get("title") or "",
                    chat.get("lastAt") or "",
                    now,
                    now,
                ),
            )
            result["chats"] += 1
            for m in chat.get("messages") or []:
                if not m:
                    continue
                append_message(
                    conn,
                    chat_id,
                    "ai" if m.get("role") == "ai" else "me",
                    m.get("text") or "",
                    thinking=m.get("thinking"),
                    usage=m.get("usage"),
                    ms=m.get("ms"),
                    fallback=m.get("fallback"),
                    aside=m.get("aside"),
                    tool=m.get("tool"),
                    time=m.get("time"),
                )
                result["messages"] += 1

    # 记忆
    for m in state.get("memories") or []:
        if not m or not m.get("id"):
            continue
        if exists("memories", m["id"]):
            result["skipped"] += 1
            continue
        status = "forgotten" if m.get("forgotten") else ("pinned" if m.get("pinned") else "normal")
        conn.execute(
            "INSERT INTO memories (id, kind, category, title, body, importance, tags_json, source, source_chat_id, status, protected, created_at, updated_at) "
            "VALUES (?, 'note', ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?)",
            (
                m["id"],
                m.get("cat") or "日常",
                m.get("title") or "",
                m.get("body") or "",
                _int(m.get("importance"), 5),
                jdumps(m.get("tags") or []),
                m.get("source") or "从浏览器迁移",
                status,
                _bool(m.get("protected")),
                now,
                now,
            ),
        )
        result["memories"] += 1

    # 设置 / 主题 / 当前绑定（以浏览器为准，保持幂等）
    config = load_app_settings(conn)
    if state.get("theme") in ("pink", "ice"):
        config["theme"] = state["theme"]
    if isinstance(state.get("overrides"), dict):
        config["overrides"] = state["overrides"]
    if isinstance(state.get("listen"), dict):
        config["listen"] = state["listen"]
    if state.get("modelId"):
        config["modelId"] = state["modelId"]
    if state.get("currentCharacterId") and conn.execute(
        "SELECT 1 FROM characters WHERE id = ?", (state["currentCharacterId"],)
    ).fetchone():
        config["currentCharacterId"] = state["currentCharacterId"]
    incoming_settings = state.get("settings") or {}
    for key in ("notify", "splashAlways", "startDate", "globalBookId", "defaultPresetId"):
        if key in incoming_settings and not (key == "globalBookId" and not incoming_settings[key]):
            config["settings"][key] = incoming_settings[key]
    save_app_settings(conn, config)
    now_text = state.get("nowText")
    if isinstance(now_text, str) and now_text.strip():
        row = get_now_row(conn)
        if row:
            conn.execute(
                "UPDATE memories SET body = ?, updated_at = ? WHERE id = ?", (now_text.strip(), now, row["id"])
            )
        else:
            conn.execute(
                "INSERT INTO memories (id, kind, category, title, body, importance, tags_json, source, source_chat_id, status, protected, created_at, updated_at) "
                "VALUES ('now-card', 'now', '此刻', '现在卡', ?, 5, '[]', '从浏览器迁移', '', 'normal', 0, ?, ?)",
                (now_text.strip(), now, now),
            )
    result["settings"] = 1
    return result


# ---------- 上下文压缩：滚动摘要 ----------
# 摘要覆盖 upto_message_id（含）之前的所有消息：
# 这些消息不再发给模型，改成一条 system 块。
# 用 id 而不是「条数」记录进度，是因为消息可能被删、被分支，
# 条数会错位，id 不会。


def digest_json(row) -> dict[str, Any]:
    if not row:
        return {}
    return {
        "chatId": row["chat_id"],
        "text": row["text"],
        "uptoMessageId": int(row["upto_message_id"] or 0),
        "messageCount": int(row["message_count"] or 0),
        "sourceTokens": int(row["source_tokens"] or 0),
        "digestTokens": int(row["digest_tokens"] or 0),
        "modelKey": row["model_key"],
        "manual": bool(row["manual"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def get_digest(conn, chat_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT * FROM chat_digests WHERE chat_id = ?", (chat_id,)
    ).fetchone()
    if not row:
        return None
    out = digest_json(row)
    return out if out.get("text") else None


def save_digest(
    conn,
    chat_id: str,
    text: str,
    upto_message_id: int,
    message_count: int = 0,
    source_tokens: int = 0,
    digest_tokens: int = 0,
    model_key: str = "",
    manual: bool = False,
) -> dict[str, Any]:
    now = now_iso()
    existing = conn.execute(
        "SELECT created_at FROM chat_digests WHERE chat_id = ?", (chat_id,)
    ).fetchone()
    created = existing["created_at"] if existing else now
    conn.execute(
        "INSERT OR REPLACE INTO chat_digests "
        "(chat_id, text, upto_message_id, message_count, source_tokens, "
        " digest_tokens, model_key, manual, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            chat_id,
            text,
            int(upto_message_id),
            int(message_count),
            int(source_tokens),
            int(digest_tokens),
            model_key,
            1 if manual else 0,
            created,
            now,
        ),
    )
    row = conn.execute("SELECT * FROM chat_digests WHERE chat_id = ?", (chat_id,)).fetchone()
    return digest_json(row)


def delete_digest(conn, chat_id: str) -> bool:
    cur = conn.execute("DELETE FROM chat_digests WHERE chat_id = ?", (chat_id,))
    return cur.rowcount > 0


# ---------- 朋友圈 ----------
# 所有查询都按 character_id 过滤：每个角色的朋友圈是独立世界，
# 换角色就换一整个世界，NPC 也不共用。


def post_json(row, replies=None, likes=None) -> dict[str, Any]:
    try:
        images = jloads(row["images_json"] or "[]", [])
    except (KeyError, IndexError, TypeError):
        images = []
    out = {
        "id": row["id"],
        "characterId": row["character_id"],
        "bondId": row["bond_id"],
        "authorKind": row["author_kind"],
        "authorId": row["author_id"],
        "authorName": row["author_name"],
        "text": row["text"],
        "at": row["at"],
        "source": row["source"],
        "locked": bool(row["locked"]),
        "images": images if isinstance(images, list) else [],
        "createdAt": row["created_at"],
        "replies": replies or [],
        "likes": likes or [],
    }
    return out


def reply_json(row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "postId": row["post_id"],
        "authorKind": row["author_kind"],
        "authorId": row["author_id"],
        "authorName": row["author_name"],
        "text": row["text"],
        "at": row["at"],
        "createdAt": row["created_at"],
    }


def npc_json(row) -> dict[str, Any]:
    try:
        bond_id = row["bond_id"]
    except (KeyError, IndexError):
        bond_id = ""
    return {
        "id": row["id"],
        "bondId": bond_id,
        "characterId": row["character_id"],
        "name": row["name"],
        "relation": row["relation"],
        "note": row["note"],
        "lastSeenAt": row["last_seen_at"],
        "createdAt": row["created_at"],
    }


def like_json(row) -> dict[str, Any]:
    return {
        "authorKind": row["author_kind"],
        "authorId": row["author_id"],
        "authorName": row["author_name"],
        "createdAt": row["created_at"],
    }


def list_likes(conn, post_id: str) -> list[dict[str, Any]]:
    return [
        like_json(r)
        for r in conn.execute(
            "SELECT * FROM post_likes WHERE post_id = ? ORDER BY created_at ASC", (post_id,)
        ).fetchall()
    ]


def has_liked(conn, post_id: str, author_kind: str, author_id: str) -> bool:
    return bool(
        conn.execute(
            "SELECT 1 FROM post_likes "
            "WHERE post_id = ? AND author_kind = ? AND author_id = ?",
            (post_id, author_kind, author_id),
        ).fetchone()
    )


def add_like(
    conn, post_id: str, author_kind: str, author_id: str, author_name: str
) -> bool:
    """点个赞。已经点过就什么都不做（唯一索引兜底）。"""
    if has_liked(conn, post_id, author_kind, author_id):
        return False
    conn.execute(
        "INSERT OR IGNORE INTO post_likes "
        "(id, post_id, author_kind, author_id, author_name, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (new_id("like"), post_id, author_kind, author_id, author_name, now_iso()),
    )
    return True


def remove_like(conn, post_id: str, author_kind: str, author_id: str) -> bool:
    cur = conn.execute(
        "DELETE FROM post_likes "
        "WHERE post_id = ? AND author_kind = ? AND author_id = ?",
        (post_id, author_kind, author_id),
    )
    return cur.rowcount > 0


def set_post_images(conn, post_id: str, images: list[dict[str, Any]]) -> None:
    """整组替换某条动态的配图路径。文件本身的增删由调用方负责。"""
    conn.execute(
        "UPDATE posts SET images_json = ? WHERE id = ?",
        (json.dumps(images, ensure_ascii=False), post_id),
    )


def list_posts(conn, bond_id: str, limit: int = 50) -> list[dict[str, Any]]:
    """一段关系一个朋友圈。查的是 bond，不是角色——同一个人设换了，看到的就是另一份。"""
    if not bond_id:
        return []
    rows = conn.execute(
        "SELECT * FROM posts WHERE bond_id = ? ORDER BY at DESC, created_at DESC LIMIT ?",
        (bond_id, int(limit)),
    ).fetchall()
    if not rows:
        return []
    ids = [r["id"] for r in rows]
    marks = ",".join("?" * len(ids))
    replies: dict[str, list] = {}
    for rr in conn.execute(
        "SELECT * FROM post_replies WHERE post_id IN (" + marks + ") ORDER BY created_at ASC",
        ids,
    ).fetchall():
        replies.setdefault(rr["post_id"], []).append(reply_json(rr))
    likes: dict[str, list] = {}
    for lr in conn.execute(
        "SELECT * FROM post_likes WHERE post_id IN (" + marks + ") ORDER BY created_at ASC",
        ids,
    ).fetchall():
        likes.setdefault(lr["post_id"], []).append(like_json(lr))
    return [
        post_json(r, replies.get(r["id"], []), likes.get(r["id"], [])) for r in rows
    ]


def get_post_row(conn, post_id: str):
    return conn.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()


def create_post(
    conn,
    character_id: str,
    author_kind: str,
    author_id: str,
    author_name: str,
    text: str,
    at: str = "",
    source: str = "manual",
    bond_id: str = "",
    locked: bool = False,
) -> dict[str, Any]:
    pid = new_id("post")
    now = now_iso()
    conn.execute(
        "INSERT INTO posts (id, character_id, bond_id, author_kind, author_id, "
        "author_name, text, at, source, locked, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            pid,
            character_id,
            bond_id,
            author_kind,
            author_id,
            author_name,
            text,
            at or now,
            source,
            1 if locked else 0,
            now,
        ),
    )
    return post_json(get_post_row(conn, pid), [])


def delete_post(conn, post_id: str) -> bool:
    cur = conn.execute("DELETE FROM posts WHERE id = ?", (post_id,))
    conn.execute("DELETE FROM post_replies WHERE post_id = ?", (post_id,))
    conn.execute("DELETE FROM post_likes WHERE post_id = ?", (post_id,))
    return cur.rowcount > 0


def add_reply(
    conn,
    post_id: str,
    author_kind: str,
    author_id: str,
    author_name: str,
    text: str,
    at: str = "",
) -> dict[str, Any]:
    rid = new_id("rpl")
    now = now_iso()
    conn.execute(
        "INSERT INTO post_replies (id, post_id, author_kind, author_id, author_name, "
        "text, at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (rid, post_id, author_kind, author_id, author_name, text, at or now, now),
    )
    row = conn.execute("SELECT * FROM post_replies WHERE id = ?", (rid,)).fetchone()
    return reply_json(row)


def delete_reply(conn, reply_id: str) -> bool:
    cur = conn.execute("DELETE FROM post_replies WHERE id = ?", (reply_id,))
    return cur.rowcount > 0


def get_home_note(conn, chat_id: str, day: str) -> dict[str, Any] | None:
    """取某天已经写好的那张便条。没有就返回 None——不编。"""
    row = conn.execute(
        "SELECT chat_id, day, text, created_at FROM home_notes WHERE chat_id = ? AND day = ?",
        (chat_id, day),
    ).fetchone()
    if not row:
        return None
    return {
        "chatId": row["chat_id"],
        "day": row["day"],
        "text": row["text"],
        "createdAt": row["created_at"],
    }


def save_home_note(conn, chat_id: str, day: str, text: str) -> dict[str, Any]:
    """记住今天这句。同一天重复调用直接覆盖（手动的「再写一张」用得上）。"""
    conn.execute(
        "INSERT OR REPLACE INTO home_notes (chat_id, day, text, created_at) VALUES (?, ?, ?, ?)",
        (chat_id, day, text, now_iso()),
    )
    return {"chatId": chat_id, "day": day, "text": text}


def list_npcs(conn, bond_id: str) -> list[dict[str, Any]]:
    if not bond_id:
        return []
    rows = conn.execute(
        "SELECT * FROM circle_npcs WHERE bond_id = ? ORDER BY created_at ASC",
        (bond_id,),
    ).fetchall()
    return [npc_json(r) for r in rows]


def upsert_npc(
    conn,
    bond_id: str,
    character_id: str,
    name: str,
    relation: str = "",
    note: str = "",
    seen_at: str = "",
) -> dict[str, Any] | None:
    """按名字去重：同一段关系里，同名 NPC 只留一条。

    抽错的 NPC（把地点当成人）由用户手动删，不在这里猜。
    """
    name = (name or "").strip()
    if not name or not bond_id:
        return None
    row = conn.execute(
        "SELECT * FROM circle_npcs WHERE bond_id = ? AND name = ?",
        (bond_id, name),
    ).fetchone()
    now = now_iso()
    if row:
        conn.execute(
            "UPDATE circle_npcs SET relation = ?, note = ?, last_seen_at = ? WHERE id = ?",
            (relation or row["relation"], note or row["note"], seen_at or now, row["id"]),
        )
        row = conn.execute("SELECT * FROM circle_npcs WHERE id = ?", (row["id"],)).fetchone()
        return npc_json(row)
    nid = new_id("npc")
    conn.execute(
        "INSERT INTO circle_npcs "
        "(id, bond_id, character_id, name, relation, note, last_seen_at, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (nid, bond_id, character_id, name, relation, note, seen_at or now, now),
    )
    row = conn.execute("SELECT * FROM circle_npcs WHERE id = ?", (nid,)).fetchone()
    return npc_json(row)


def delete_npc(conn, npc_id: str) -> bool:
    cur = conn.execute("DELETE FROM circle_npcs WHERE id = ?", (npc_id,))
    return cur.rowcount > 0
