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
    return {"ok": True, **music.song_url(conn, id, level)}


@router.get("/playlists")
def music_playlists(conn=Depends(get_conn)) -> dict:
    return {"ok": True, "playlists": music.user_playlists(conn)}


@router.get("/playlist/{playlist_id}")
def music_playlist(playlist_id: str, conn=Depends(get_conn)) -> dict:
    return {"ok": True, "songs": music.playlist_tracks(conn, playlist_id)}