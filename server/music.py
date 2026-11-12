"""网易云音乐：本机 ncm-api 的薄封装。

ncm-api 跑在 Docker 里，只监听 127.0.0.1:3000，不对外。
登录 cookie 加密后存在 music_auth 表，只在服务端解密，不回传前端。

两个必须记住的点：
1. 播放直链带时效（约 20 分钟）。所以库里只存 song_id，播的时候才换地址，
   不能把 URL 缓存下来反复用。
2. ncm-api 用的是老的 request 库，容器必须带
   NODE_OPTIONS="--no-network-family-autoselection"，否则所有 interface 接口
   都会卡在 IPv6 上超时。
"""
from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from . import auth, db
from .errors import ApiError

LOG = logging.getLogger("msyq")

NCM_BASE = (os.environ.get("MSYQ_NCM_URL") or "http://127.0.0.1:3000").rstrip("/")
NCM_TIMEOUT = 25


def _call(path: str, params: dict[str, Any] | None = None, cookie: str = "", timeout: int = NCM_TIMEOUT) -> dict:
    """GET 一次 ncm-api。参数里的 None/空串会被丢掉。"""
    clean = {k: v for k, v in (params or {}).items() if v not in (None, "")}
    url = NCM_BASE + path
    if clean:
        url += "?" + urllib.parse.urlencode(clean, quote_via=urllib.parse.quote)
    req = urllib.request.Request(url, headers={"User-Agent": "msyq/1.0"})
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode() or "{}")
    except urllib.error.URLError as exc:
        LOG.warning("网易云接口不通（%s）：%s", path, exc)
        raise ApiError("badgateway", "音乐服务暂时连不上。", status=502) from exc
    except Exception as exc:  # noqa: BLE001
        LOG.warning("网易云接口出错（%s）：%s", path, exc)
        raise ApiError("badgateway", "音乐服务返回了看不懂的内容。", status=502) from exc


def _body(data: dict) -> dict:
    """ncm-api 有的接口把结果放在 body 里，有的直接就是结果。"""
    if isinstance(data.get("body"), dict):
        return data["body"]
    return data


# ---------------------------------------------------------------- 登录态
def cookie_of(conn) -> str:
    row = db.music_auth_row(conn)
    if not row or not row["cookie_enc"]:
        return ""
    try:
        return auth.decrypt_key(row["cookie_enc"])
    except Exception:  # noqa: BLE001
        LOG.warning("网易云 cookie 解不开，当作未登录")
        return ""


def state(conn) -> dict:
    row = db.music_auth_row(conn)
    if not row or not row["cookie_enc"]:
        return {"loggedIn": False, "nickname": "", "avatar": "", "userId": ""}
    return {
        "loggedIn": True,
        "nickname": row["nickname"] or "",
        "avatar": row["avatar"] or "",
        "userId": row["user_id"] or "",
    }


def send_captcha(phone: str) -> dict:
    phone = (phone or "").strip()
    if not (phone.isdigit() and len(phone) == 11):
        raise ApiError("badrequest", "手机号得是 11 位数字。")
    data = _body(_call("/captcha/sent", {"phone": phone}))
    if data.get("code") != 200:
        raise ApiError("badrequest", "验证码没发出去，等一会儿再试。")
    return {"ok": True}


def login(conn, phone: str, captcha: str) -> dict:
    phone = (phone or "").strip()
    captcha = (captcha or "").strip()
    if not phone or not captcha:
        raise ApiError("badrequest", "手机号和验证码都要填。")
    data = _call("/login/cellphone", {"phone": phone, "captcha": captcha})
    body = _body(data)
    code = body.get("code")
    if code != 200:
        msg = {502: "验证码不对，或者过期了。", 503: "请求太频繁，等一会儿。", 400: "网易云拒了这个请求。"}.get(
            code, "没登录上（%s）。" % code
        )
        raise ApiError("badrequest", msg)
    cookie = body.get("cookie") or ""
    if not cookie:
        raise ApiError("badgateway", "登录成功了，但没拿到凭证。")
    profile = body.get("profile") or {}
    db.save_music_auth(
        conn,
        auth.encrypt_key(cookie),
        str(profile.get("userId") or ""),
        str(profile.get("nickname") or ""),
        str(profile.get("avatarUrl") or ""),
    )
    LOG.info("网易云已登录：%s", profile.get("nickname"))
    return state(conn)


def logout(conn) -> dict:
    try:
        _call("/logout", {})
    except Exception:  # noqa: BLE001
        pass
    db.clear_music_auth(conn)
    return {"ok": True}


# ---------------------------------------------------------------- 歌曲
def _song_json(s: dict) -> dict:
    artists = s.get("artists") or s.get("ar") or []
    album = s.get("album") or s.get("al") or {}
    dur = s.get("duration") or s.get("dt") or 0
    fee = s.get("fee")
    return {
        "id": str(s.get("id") or ""),
        "name": s.get("name") or "",
        "artist": "、".join(str(a.get("name") or "") for a in artists if a.get("name")),
        "album": album.get("name") or "",
        "cover": album.get("picUrl") or s.get("picUrl") or "",
        "dur": round(float(dur) / 1000.0, 1) if dur else 0,
        "vip": fee in (1, 4),
    }


def search(q: str, limit: int = 20) -> list[dict]:
    q = (q or "").strip()
    if not q:
        return []
    data = _body(_call("/search", {"keywords": q, "limit": limit, "type": 1}))
    songs = ((data.get("result") or {}).get("songs")) or []
    return [_song_json(s) for s in songs]


def song_url(conn, song_id: str, level: str = "exhigh") -> dict:
    """现取直链。URL 带时效，调用方不要缓存。"""
    sid = str(song_id or "").strip()
    if not sid.isdigit():
        raise ApiError("badrequest", "歌曲 id 不对。")
    data = _body(_call("/song/url/v1", {"id": sid, "level": level}, cookie=cookie_of(conn)))
    item = (data.get("data") or [{}])[0] if isinstance(data.get("data"), list) else (data.get("data") or {})
    url = item.get("url")
    if not url:
        # 高音质没版权时退回标准音质再试一次
        data = _body(_call("/song/url/v1", {"id": sid, "level": "standard"}, cookie=cookie_of(conn)))
        item = (data.get("data") or [{}])[0] if isinstance(data.get("data"), list) else (data.get("data") or {})
        url = item.get("url")
    if not url:
        raise ApiError("badrequest", "这首歌放不了（可能是没版权的付费歌）。")
    # 网易云返回的是 http，页面也是 http，能直接播
    return {"url": url, "br": item.get("br") or 0, "type": item.get("type") or ""}


# ---------------------------------------------------------------- 歌单
def user_playlists(conn) -> list[dict]:
    st = state(conn)
    if not st.get("loggedIn") or not st.get("userId"):
        return []
    data = _body(
        _call("/user/playlist", {"uid": st["userId"], "limit": 60}, cookie=cookie_of(conn))
    )
    out = []
    for p in data.get("playlist") or []:
        out.append(
            {
                "id": str(p.get("id") or ""),
                "name": p.get("name") or "",
                "count": p.get("trackCount") or 0,
                "cover": p.get("coverImgUrl") or "",
                "mine": bool(p.get("subscribed") is False),
            }
        )
    return out


def playlist_tracks(conn, playlist_id: str, limit: int = 200) -> list[dict]:
    pid = str(playlist_id or "").strip()
    if not pid.isdigit():
        raise ApiError("badrequest", "歌单 id 不对。")
    data = _body(
        _call("/playlist/track/all", {"id": pid, "limit": limit}, cookie=cookie_of(conn))
    )
    return [_song_json(s) for s in data.get("songs") or []]