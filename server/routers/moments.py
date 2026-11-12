"""朋友圈：列表 / 发帖 / 评论 / NPC 管理。

路径顺序有讲究：/npcs、/generate 这些固定段要写在 /{post_id} 之前，
不然会被当成 id 吃掉。
"""

import asyncio
import os
import shutil

from fastapi import APIRouter, Depends, File, UploadFile

from .. import db, moments
from ..errors import ApiError
from ..schemas import PostIn, ReplyIn
from .deps import get_conn

router = APIRouter(prefix="/api/moments", tags=["moments"])


def _kick(coro) -> None:
    """丢到后台跑。生成要几秒到几十秒，不能让发表/评论干等。

    没有事件循环时（同步上下文里被调用）就把协程关掉，别留 warning。
    MSYQ_NO_AUTO_REACT=1 时整体跳过——测试里后台任务会和断言抢时序。
    """
    if (os.environ.get("MSYQ_NO_AUTO_REACT") or "").strip() in ("1", "true", "on"):
        try:
            coro.close()
        except Exception:  # noqa: BLE001
            pass
        return
    try:
        asyncio.create_task(coro)
    except RuntimeError:
        try:
            coro.close()
        except Exception:  # noqa: BLE001
            pass


def _persona_for(conn, character_id: str):
    """这场聊天绑定的那个人设。

    发帖和评论必须用同一套解析，否则会出现「我发的帖子叫杭杭、
    我发的评论却叫另一个名字」。
    """
    from .. import prompts as prompts_mod

    personas = [db.persona_json(r) for r in conn.execute("SELECT * FROM user_personas").fetchall()]
    chat_row = db.get_chat_row(conn, character_id) if character_id else None
    if chat_row:
        character = db.get_character(conn, character_id) or {}
        persona, _ = prompts_mod.resolve_persona(
            db.chat_json(conn, chat_row, include_messages=False), character, personas
        )
        if persona:
            return persona
    return personas[0] if personas else None


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
async def create_post(payload: PostIn, conn=Depends(get_conn)) -> dict:
    """我发一条。作者固定是人设（persona）。"""
    character_id = (payload.characterId or "").strip()
    text = (payload.text or "").strip()
    if not character_id:
        raise ApiError("badrequest", "先选一个角色。")
    if not text:
        raise ApiError("badrequest", "写点什么再发。")
    if len(text) > 1000:
        raise ApiError("badrequest", "太长了，朋友圈不是写作文的地方。")
    persona = _persona_for(conn, character_id)
    name = (persona or {}).get("name") or "我"
    pid_ = (persona or {}).get("id") or ""
    post = db.create_post(conn, character_id, "persona", pid_, name, text, source="manual")
    # 她看到你发了，后台接一句；发表本身不等她
    _kick(moments.character_react(post["id"]))
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
    """删动态。配图文件要一起清掉——只删数据库行的话，
    那些 jpg 会永远躺在磁盘上，谁也找不到。"""
    if db.get_post_row(conn, post_id):
        folder = db.data_dir() / "uploads" / "posts" / post_id
        if folder.is_dir():
            shutil.rmtree(folder, ignore_errors=True)
    return {"ok": db.delete_post(conn, post_id)}


@router.post("/{post_id}/replies")
async def add_reply(post_id: str, payload: ReplyIn, conn=Depends(get_conn)) -> dict:
    text = (payload.text or "").strip()
    if not text:
        raise ApiError("badrequest", "写点什么再发。")
    row = db.get_post_row(conn, post_id)
    if not row:
        raise ApiError("notfound", "这条动态已经不在了。", status=404)
    persona = _persona_for(conn, row["character_id"])
    name = (persona or {}).get("name") or "我"
    pid_ = (persona or {}).get("id") or ""
    reply = db.add_reply(conn, post_id, "persona", pid_, name, text[:500])
    # 你跟她说话了，她会回一句
    _kick(moments.character_react(post_id, my_text=text))
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


# ---------------- 配图 ----------------
# 图片放 data/uploads/posts/<post_id>/<n>.<ext>，库里只存路径。
# 不往 SQLite 里塞 base64：一张手机照片转 base64 就是几 MB，库会迅速膨胀，
# 而库每 5 分钟就被整份复制一次（同步），塞进去等于自己给自己加负担。
MAX_IMAGE_BYTES = 6 * 1024 * 1024
MAX_IMAGES = 9


def _sniff_ext(raw: bytes) -> str:
    """只认文件头，不信客户端给的扩展名。"""
    if raw[:3] == b"\xff\xd8\xff":
        return "jpg"
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp"
    return ""


@router.post("/{post_id}/images")
async def upload_post_images(
    post_id: str,
    files: list[UploadFile] = File(...),
    conn=Depends(get_conn),
) -> dict:
    """给一条已存在的动态追加图片。多张一次传，最多凑满 9 张。"""
    row = db.get_post_row(conn, post_id)
    if not row:
        raise ApiError("notfound", "这条动态已经不在了。", status=404)
    existing = list(db.post_json(row).get("images") or [])
    room = MAX_IMAGES - len(existing)
    if room <= 0:
        raise ApiError("badrequest", "最多 %d 张。" % MAX_IMAGES)

    folder = db.data_dir() / "uploads" / "posts" / post_id
    folder.mkdir(parents=True, exist_ok=True)

    added: list[dict] = []
    for upload in files[:room]:
        raw = await upload.read()
        if not raw or len(raw) > MAX_IMAGE_BYTES:
            continue
        ext = _sniff_ext(raw)
        if not ext:
            continue
        name = "%02d.%s" % (len(existing) + len(added) + 1, ext)
        (folder / name).write_bytes(raw)
        added.append({"path": "/uploads/posts/" + post_id + "/" + name, "size": len(raw)})

    if not added:
        raise ApiError("badrequest", "这几张不是图片，或者太大了。")

    merged = (existing + added)[:MAX_IMAGES]
    db.set_post_images(conn, post_id, merged)
    fresh = db.get_post_row(conn, post_id)
    return {"ok": True, "images": merged, "post": db.post_json(fresh)}


@router.delete("/{post_id}/images/{index}")
def drop_post_image(post_id: str, index: int, conn=Depends(get_conn)) -> dict:
    row = db.get_post_row(conn, post_id)
    if not row:
        raise ApiError("notfound", "这条动态已经不在了。", status=404)
    images = list(db.post_json(row).get("images") or [])
    if index < 0 or index >= len(images):
        raise ApiError("badrequest", "这张图不在列表里。")
    gone = images.pop(index)
    path = str(gone.get("path") or "")
    if path.startswith("/uploads/"):
        target = db.data_dir() / path[len("/uploads/"):]
        try:
            target.unlink()
        except OSError:
            pass
    db.set_post_images(conn, post_id, images)
    return {"ok": True, "images": images}


@router.post("/{post_id}/like")
def like_post(post_id: str, conn=Depends(get_conn)) -> dict:
    """我点个赞。重复点不会多出一个（唯一索引兜底）。"""
    row = db.get_post_row(conn, post_id)
    if not row:
        raise ApiError("notfound", "这条动态已经不在了。", status=404)
    persona = _persona_for(conn, row["character_id"])
    name = (persona or {}).get("name") or "我"
    pid_ = (persona or {}).get("id") or ""
    db.add_like(conn, post_id, "persona", pid_, name)
    return {"ok": True, "likes": db.list_likes(conn, post_id)}


@router.delete("/{post_id}/like")
def unlike_post(post_id: str, conn=Depends(get_conn)) -> dict:
    row = db.get_post_row(conn, post_id)
    if not row:
        raise ApiError("notfound", "这条动态已经不在了。", status=404)
    persona = _persona_for(conn, row["character_id"])
    pid_ = (persona or {}).get("id") or ""
    db.remove_like(conn, post_id, "persona", pid_)
    return {"ok": True, "likes": db.list_likes(conn, post_id)}
