# -*- coding: utf-8 -*-
"""
海角社区(haijiao.com) 主站 — 自研 API 客户端 (hj_api.py)
2026-11-13 全程实测逆向: Vue SPA + Cloudflare, 所有 API 响应三层 Base64。

协议地图:
  GET  /api/topic/{pid}          → 帖子详情(三层B64): attachments / sale / content / currentUserPurchased
  GET  /api/topic/att/{attId}    → 播放线路(三层B64): [{name,url,VipLimit}]
  POST /api/attachment           → 真实播放地址(需购买态 token): {id,resource_id,resource_type,line}
  播放: m3u8→.jpg 取AES key → WASM jquery_key 变换 → hls.js

唯一缺口: 能拿到完整 m3u8 的登录/购买态 (X-User-Token + X-User-Id)。
未购买时 /api/attachment 返回 errorCode:1, 前端拿不到地址。
"""
import base64
import json
import os
import re
import logging

import aiohttp

logger = logging.getLogger("hj.api")

BASE = os.getenv("HJ_SITE", "https://haijiao.com")
TOKEN = os.getenv("HJ_USER_TOKEN", "")     # X-User-Token (会员/已购买账号)
USER_ID = os.getenv("HJ_USER_ID", "")      # X-User-Id
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")


def _decrypt(data: str):
    """三层 Base64 解码 → 明文(str) 或 JSON。与 app.js 拦截器一致。"""
    raw = data
    for _ in range(3):
        try:
            raw = base64.b64decode(raw).decode("utf-8")
        except Exception:
            break
    s = raw.strip()
    if s.startswith("{") or s.startswith("["):
        try:
            return json.loads(s)
        except Exception:
            pass
    return s


def _headers(referer=None):
    h = {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "pcVer": "2",
    }
    if referer:
        h["Referer"] = referer
    if TOKEN:
        h["X-User-Token"] = TOKEN
    if USER_ID:
        h["X-User-Id"] = USER_ID
    return h


async def _http_get(url, referer):
    """本机实测 aiohttp 连 haijiao.com(Cloudflare) 超时, requests 正常 → 直接用 requests(线程池)。"""
    import asyncio as _aio
    def _sync():
        import requests
        rr = requests.get(url, headers=_headers(referer), timeout=12)
        return rr.json()
    return await _aio.to_thread(_sync)


async def _http_post(url, referer, body):
    import asyncio as _aio
    def _sync():
        import requests
        hh = dict(_headers(referer)); hh["Content-Type"] = "application/json"
        rr = requests.post(url, headers=hh, json=body, timeout=12)
        return rr.json()
    return await _aio.to_thread(_sync)


async def _get_json(session, url, referer):
    payload = await _http_get(url, referer)
    if payload.get("isEncrypted") and payload.get("data"):
        return _decrypt(payload["data"])
    return payload.get("data")


async def get_topic(session, pid: str, referer: str):
    """帖子详情 → 含 attachments / sale / currentUserPurchased。"""
    data = await _get_json(session, f"{BASE}/api/topic/{pid}", referer)
    return data


async def get_lines(session, att_id: int, referer: str):
    """播放线路列表 → [{name,url,VipLimit}]。未购买时 url 为空。"""
    data = await _get_json(session, f"{BASE}/api/topic/att/{att_id}", referer)
    return data if isinstance(data, list) else []


async def get_attachment(session, att_id: int, pid: str, line: str, referer: str):
    """POST /api/attachment → 真实 remoteUrl。未购买 = errorCode:1。"""
    body = {"id": int(att_id), "resource_id": int(pid),
            "resource_type": "topic", "line": line}
    payload = await _http_post(BASE + "/api/attachment", referer, body)
    if payload.get("errorCode") not in (0, None) or payload.get("success") is False:
        raise RuntimeError(f"未购买/无权限 (errorCode={payload.get('errorCode')})："
                           "服务端购买态校验，需会员/已购账号 token")
    d = payload.get("data")
    if payload.get("isEncrypted") and d:
        d = _decrypt(d)
    return d


def extract_pid(page_url: str) -> str:
    m = re.search(r"[?&]pid=(\d+)", page_url or "") or re.search(r"/post/details[/?]+(\d+)", page_url or "")
    return m.group(1) if m else ""


async def resolve(page_url: str) -> dict:
    """
    自研主流程: 从帖子页 URL 一路解到播放地址。
    返回 {pid, preview_url, purchased, lines, full_url, cover, key_transform}
    """
    pid = extract_pid(page_url)
    if not pid:
        raise RuntimeError("page_url 里找不到 pid")

    referer = f"{BASE}/post/details?pid={pid}"
    topic = await get_topic(None, pid, referer)
    if not isinstance(topic, dict):
        raise RuntimeError("帖子详情解密失败")

    vids = [a for a in (topic.get("attachments") or []) if a.get("category") == "video"]
    if not vids:
        raise RuntimeError("该帖无视频附件")
    vid = vids[0]
    att_id = vid.get("id")
    preview = vid.get("remoteUrl", "")
    cover = vid.get("coverUrl", "")

    purchased = bool(topic.get("currentUserPurchased")) or \
                bool((topic.get("sale") or {}).get("is_buy"))

    lines = await get_lines(None, att_id, referer)

    full_url = ""
    if purchased or TOKEN:
        # 有权限时向 /api/attachment 换完整地址
        for ln in lines or [{"line": ""}]:
            line_name = ln.get("line") or ln.get("url") or ""
            try:
                d = await get_attachment(None, att_id, pid, line_name, referer)
                if isinstance(d, dict):
                    full_url = d.get("remoteUrl") or d.get("url") or ""
                elif isinstance(d, str) and d.startswith("http"):
                    full_url = d
                if full_url:
                    break
            except Exception as e:
                logger.info("attachment_fail", extra={"extra": {"line": line_name, "err": str(e)}})

    # 从线路数组里捡现成 url（有些帖直接给）
    if not full_url:
        for ln in lines or []:
            if ln.get("url", "").startswith("http"):
                full_url = ln["url"]
                break

    return {
        "pid": pid,
        "att_id": att_id,
        "preview_url": preview,           # _i_preview.m3u8 试看(无需权限)
        "full_url": full_url,             # 完整版(需购买态)
        "purchased": purchased,
        "lines": lines,
        "cover": cover,
        "sale": topic.get("sale"),
        "key_transform": "hls-aes128 + WASM jquery_key + kversion(.key{v})",
        "note": "完整URL需会员/已购token；未购买时服务端不下发，前端无法绕过",
    }
