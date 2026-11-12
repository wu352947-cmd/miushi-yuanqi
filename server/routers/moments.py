"""朋友圈：列表 / 发帖 / 评论 / NPC 管理。

路径顺序有讲究：/npcs、/generate 这些固定段要写在 /{post_id} 之前，
不然会被当成 id 吃掉。
"""

from fastapi import APIRouter, Depends

from .. import db, moments
from ..errors import ApiError
from ..schemas import PostIn, ReplyIn
from .deps import get_conn

router = APIRouter(prefix="/api/moments", tags=["moments"])


@router.get("")
def list_feed(character_id: str = "", limit: int = 50, conn=Depends(get_conn)) -> dict:
    """一整个朋友圈：动态 + 这个世界里的 NPC。"""
    if not character_id:
        return {"ok": True, "posts": [], "npcs": []}
    return {
        "ok": True,
        "posts": db.list_posts(conn, character_id, limit=max(1, min(200, limit))),
        "npcs": db.list_npcs(conn, character_id),
    }


@router.post("")
def create_post(payload: PostIn, conn=Depends(get_conn)) -> dict:
    """我发一条。作者固定是人设（persona）。"""
    character_id = (payload.characterId or "").strip()
    text = (payload.text or "").strip()
    if not character_id:
        raise ApiError("badrequest", "先选一个角色。")
    if not text:
        raise ApiError("badrequest", "写点什么再发。")
    if len(text) > 1000:
        raise ApiError("badrequest", "太长了，朋友圈不是写作文的地方。")
    personas = [db.persona_json(r) for r in conn.execute("SELECT * FROM user_personas").fetchall()]
    chat_row = db.get_chat_row(conn, character_id)
    persona = None
    if chat_row:
        character = db.get_character(conn, character_id) or {}
        from .. import prompts as prompts_mod

        persona, _ = prompts_mod.resolve_persona(
            db.chat_json(conn, chat_row, include_messages=False), character, personas
        )
    if not persona and personas:
        persona = personas[0]
    name = (persona or {}).get("name") or "我"
    pid_ = (persona or {}).get("id") or ""
    post = db.create_post(conn, character_id, "persona", pid_, name, text, source="manual")
    return {"ok": True, "post": post}


@router.get("/npcs")
def list_npcs(character_id: str = "", conn=Depends(get_conn)) -> dict:
    if not character_id:
        return {"ok": True, "npcs": []}
    return {"ok": True, "npcs": db.list_npcs(conn, character_id)}


@router.delete("/npcs/{npc_id}")
def drop_npc(npc_id: str, conn=Depends(get_conn)) -> dict:
    """抽错的 NPC 手动删掉。"""
    return {"ok": db.delete_npc(conn, npc_id)}


@router.post("/generate")
async def generate(character_id: str = "", conn=Depends(get_conn)) -> dict:
    """手动让她发一条（绕过「今天已经发过」的限制由用户自己决定）。"""
    cid = (character_id or "").strip()
    if not cid:
        raise ApiError("badrequest", "先选一个角色。")
    chat_row = db.get_chat_row(conn, cid)
    if not chat_row:
        raise ApiError("badrequest", "这个角色还没有聊天记录，没有素材可写。")
    result = await moments.compose_character_post(chat_row["id"])
    if not result.get("ok"):
        raise ApiError("badrequest", str(result.get("message") or "没写出来。"))
    return result


@router.delete("/{post_id}")
def drop_post(post_id: str, conn=Depends(get_conn)) -> dict:
    return {"ok": db.delete_post(conn, post_id)}


@router.post("/{post_id}/replies")
def add_reply(post_id: str, payload: ReplyIn, conn=Depends(get_conn)) -> dict:
    text = (payload.text or "").strip()
    if not text:
        raise ApiError("badrequest", "写点什么再发。")
    row = db.get_post_row(conn, post_id)
    if not row:
        raise ApiError("notfound", "这条动态已经不在了。", status=404)
    personas = [db.persona_json(r) for r in conn.execute("SELECT * FROM user_personas").fetchall()]
    persona = personas[0] if personas else None
    name = (persona or {}).get("name") or "我"
    pid_ = (persona or {}).get("id") or ""
    reply = db.add_reply(conn, post_id, "persona", pid_, name, text[:500])
    return {"ok": True, "reply": reply}


@router.delete("/replies/{reply_id}")
def drop_reply(reply_id: str, conn=Depends(get_conn)) -> dict:
    return {"ok": db.delete_reply(conn, reply_id)}


@router.post("/{post_id}/comment")
async def npc_comment(post_id: str, conn=Depends(get_conn)) -> dict:
    """手动叫个人来评论（测试/补氛围用）。"""
    if not db.get_post_row(conn, post_id):
        raise ApiError("notfound", "这条动态已经不在了。", status=404)
    result = await moments.maybe_comment(post_id)
    if not result.get("ok"):
        raise ApiError("badrequest", str(result.get("message") or "这次没人评论。"))
    return result