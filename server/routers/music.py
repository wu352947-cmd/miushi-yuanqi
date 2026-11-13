"""音乐路由。所有接口都只走本机 ncm-api，cookie 不出服务端。"""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends

from .. import db, music
from .deps import get_conn

router = APIRouter(prefix="/api/music", tags=["music"])


@router.get("/me")
def music_me(conn=Depends(get_conn)) -> dict:
    return music.state(conn)


@router.post("/captcha")
def music_captcha(payload: dict = Body(default={})) -> dict:
    return music.send_captcha(str(payload.get("phone") or ""))


@router.post("/login")
def music_login(payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    return music.login(conn, str(payload.get("phone") or ""), str(payload.get("captcha") or ""))


@router.post("/logout")
def music_logout(conn=Depends(get_conn)) -> dict:
    return music.logout(conn)


@router.get("/qr/new")
def music_qr_new() -> dict:
    return {"ok": True, **music.qr_new()}


@router.get("/qr/check")
def music_qr_check(key: str = "", conn=Depends(get_conn)) -> dict:
    return {"ok": True, **music.qr_check(conn, key)}


@router.get("/search")
def music_search(q: str = "", limit: int = 20) -> dict:
    return {"ok": True, "songs": music.search(q, max(1, min(50, limit)))}


@router.get("/url")
def music_url(id: str = "", level: str = "exhigh", conn=Depends(get_conn)) -> dict:
    out = music.song_url(conn, id, level)
    url = str(out.get("url") or "")
    if url and str(id).strip().isdigit():
        # 和 /audio 共用缓存：前端预取过之后，点播放就不用再问网易云
        _AUDIO_URL_CACHE[str(id).strip()] = (url, _time.time() + 600)
    return {"ok": True, **out}


@router.get("/playlists")
def music_playlists(conn=Depends(get_conn)) -> dict:
    return {"ok": True, "playlists": music.user_playlists(conn)}


@router.get("/playlist/{playlist_id}")
def music_playlist(playlist_id: str, conn=Depends(get_conn)) -> dict:
    return {"ok": True, "songs": music.playlist_tracks(conn, playlist_id)}


@router.get("/songs")
def music_songs(conn=Depends(get_conn)) -> dict:
    """我加进歌单的歌。"""
    return {"ok": True, "songs": db.music_song_list(conn)}


@router.post("/songs")
def music_song_add(payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    return {"ok": True, **db.music_song_add(conn, payload)}


@router.delete("/songs/{song_id}")
def music_song_remove(song_id: str, conn=Depends(get_conn)) -> dict:
    return {"ok": True, **db.music_song_remove(conn, song_id)}


@router.get("/picks")
def music_picks(chat_id: str = "", conn=Depends(get_conn)) -> dict:
    """她点的歌（恋缘之音）。"""
    return {"ok": True, "picks": db.music_pick_list(conn, chat_id)}


@router.post("/picks/generate")
async def music_picks_generate(payload: dict = Body(default={})) -> dict:
    """让她按当前剧情挑歌。会调模型 + 搜索，几秒到几十秒。"""
    from .. import music_she

    return await music_she.pick_songs(str(payload.get("chat_id") or ""))


@router.post("/picks/clear")
def music_picks_clear(payload: dict = Body(default={}), conn=Depends(get_conn)) -> dict:
    chat_id = str(payload.get("chat_id") or "")
    db.music_pick_clear(conn, chat_id)
    return {"ok": True, "picks": db.music_pick_list(conn, chat_id)}


# --------------------------------------------------------------------------- 封面代理
# 手机和 VPS 直连 p1~p4.music.126.net 都要 2~9 秒，200 首列表同时拉必然全裂。
# 这里由 VPS 拉一次落到 data/covers/，之后走本机磁盘，前端只连自己域名。
import hashlib  # noqa: E402
import threading  # noqa: E402
import urllib.parse  # noqa: E402
from pathlib import Path  # noqa: E402

from fastapi.responses import FileResponse, RedirectResponse  # noqa: E402

_COVER_DIR = db.data_dir() / "covers"
_COVER_LOCK = threading.BoundedSemaphore(6)
_COVER_HEADERS = {"Cache-Control": "public, max-age=2592000, immutable"}
_COVER_HOSTS = (".music.126.net",)


def _cover_file(url: str) -> Path:
    return _COVER_DIR / (hashlib.sha1(url.encode("utf-8")).hexdigest() + ".jpg")


def _cover_hit(url: str):
    path = _cover_file(url)
    if path.exists() and path.stat().st_size > 512:
        return FileResponse(path, media_type="image/jpeg", headers=_COVER_HEADERS)
    return None


@router.get("/cover")
def music_cover(u: str = ""):
    """网易云封面本地缓存。拿不到就 302 回原图，让浏览器自己试一次。"""
    raw = (u or "").strip()
    if not raw.startswith(("http://", "https://")):
        raise ApiError("badrequest", "封面地址不对。")
    host = (urllib.parse.urlsplit(raw).hostname or "").lower()
    if not any(host.endswith(h) for h in _COVER_HOSTS):
        raise ApiError("badrequest", "只能代理网易云图片。")
    _COVER_DIR.mkdir(parents=True, exist_ok=True)
    hit = _cover_hit(raw)
    if hit:
        return hit
    with _COVER_LOCK:
        hit = _cover_hit(raw)
        if hit:
            return hit
        blob = b""
        try:
            req = urllib.request.Request(
                raw,
                headers={"User-Agent": "Mozilla/5.0", "Referer": "https://music.163.com/"},
            )
            with urllib.request.urlopen(req, timeout=12) as resp:
                blob = resp.read(4 * 1024 * 1024)
        except Exception:  # noqa: BLE001
            blob = b""
        if len(blob) > 512:
            target = _cover_file(raw)
            part = target.with_suffix(".part")
            part.write_bytes(blob)
            part.replace(target)
            return FileResponse(target, media_type="image/jpeg", headers=_COVER_HEADERS)
    return RedirectResponse(raw, status_code=302)


# =========================================================================== 音频流代理
# 手机直连 m801 能下，但前端必须先 await 拿地址再 play()，那一步一过手势就失效了。
# 同源代理后：点击瞬间同步设 src + play()，并且透传 Range，进度条能拖。
import time as _time  # noqa: E402

import httpx as _httpx  # noqa: E402
from fastapi import Request  # noqa: E402
from fastapi.responses import StreamingResponse  # noqa: E402

_AUDIO_URL_CACHE = {}
_AUDIO_CLIENT = _httpx.Client(timeout=_httpx.Timeout(20.0, read=120.0), follow_redirects=True)


def _audio_url(conn, sid: str) -> str:
    now = _time.time()
    hit = _AUDIO_URL_CACHE.get(sid)
    if hit and hit[1] > now:
        return hit[0]
    data = music.song_url(conn, sid)
    url = str(data.get("url") or "")
    if not url:
        raise ApiError("badgateway", "这首暂时拿不到播放地址，可能是版权限制。", status=502)
    _AUDIO_URL_CACHE[sid] = (url, now + 600)
    return url


@router.get("/audio")
def music_audio(id: str = "", request: Request = None, conn=Depends(get_conn)):
    """把网易云音频边收边发地转给浏览器，支持 Range。"""
    sid = (id or "").strip()
    if not sid.isdigit():
        raise ApiError("badrequest", "歌曲 id 不对。")
    url = _audio_url(conn, sid)
    headers = {"User-Agent": "Mozilla/5.0", "Referer": "https://music.163.com/"}
    rng = request.headers.get("range") if request is not None else None
    if rng:
        headers["Range"] = rng
    upstream = _AUDIO_CLIENT.send(_AUDIO_CLIENT.build_request("GET", url, headers=headers), stream=True)
    if upstream.status_code >= 400:
        upstream.close()
        raise ApiError("badgateway", "音源没给数据，稍后再试。", status=502)
    out = {}
    for key in ("content-length", "content-range", "accept-ranges", "content-type"):
        value = upstream.headers.get(key)
        if value:
            out[key] = value

    def relay():
        try:
            for chunk in upstream.iter_raw():
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    return StreamingResponse(
        relay(),
        status_code=upstream.status_code,
        headers=out,
        media_type=upstream.headers.get("content-type") or "audio/mpeg",
    )
