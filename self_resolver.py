# -*- coding: utf-8 -*-
"""
海角/我为人人影院 — 自研解析器 (self_resolver.py)
把实测确认的整条链路固化成代码，不依赖原作者后端。

实测链路 (2026-11-13, REA Chromium 157 全程验证):
  1. 域名发现: hjd2048.com/yy.php --303--> 当日随机 .shop 站
  2. 18+ 门:   GET /home/enter.html?to=%2F  --302--> 设 cookie --> /?entered=1
  3. 首页:     GET /?entered=1  卡片 <a href="/play/{id}.html">  封面 p5.yyjpg2026b.com/{date}/{hash}/vod.jpg
  4. 播放页:   GET /play/{id}.html  (Next.js SSR)
               - 未登录: 服务端渲染 "会员专享,暂不支持试看" 占位, 无播放器/无 m3u8
               - 带会员 Cookie: 服务端下发播放器 + m3u8 播放地址

唯一必需输入: HJ_MEMBER_COOKIE (会员登录态)。
这是服务端鉴权, 不是能绕过的前端墙 —— 无 Cookie 时服务端根本不下发播放地址。
"""
import os
import re
import logging

import aiohttp

logger = logging.getLogger("hj.resolver")

# 入口/分发域（长期稳定）—— 从这里每日发现当前 .shop 站
PORTAL_YY = os.getenv("HJ_PORTAL_YY", "https://hjd2048.com/yy.php")
PORTAL_IP_YY = os.getenv("HJ_PORTAL_IP_YY", "http://172.247.194.203:2048/yy.php")

# 会员登录态 Cookie（唯一缺口）：从浏览器登录会员后复制整串 Cookie
MEMBER_COOKIE = os.getenv("HJ_MEMBER_COOKIE", "")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")


def _headers(referer=None, cookie=None):
    h = {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    if referer:
        h["Referer"] = referer
    c = cookie if cookie is not None else MEMBER_COOKIE
    if c:
        h["Cookie"] = c
    return h


async def discover_origin(session: aiohttp.ClientSession) -> str:
    """从发布页 303 跳转拿到当日活跃 .shop 域名。"""
    for portal in (PORTAL_YY, PORTAL_IP_YY):
        try:
            async with session.get(portal, headers=_headers(),
                                  allow_redirects=False,
                                  timeout=aiohttp.ClientTimeout(total=12)) as r:
                loc = r.headers.get("Location", "")
                if loc.startswith("http"):
                    from urllib.parse import urlparse
                    u = urlparse(loc)
                    origin = f"{u.scheme}://{u.netloc}"
                    logger.info("discover_origin", extra={"extra": {"origin": origin}})
                    return origin
        except Exception as e:
            logger.warning("discover_origin_fail", extra={"extra": {"portal": portal, "err": str(e)}})
    raise RuntimeError("域名发现失败：发布页不可达")


async def pass_age_gate(session: aiohttp.ClientSession, origin: str):
    """过 18+ 确认门: /home/enter.html 会 set-cookie, 之后带 cookie 访问即放行。"""
    try:
        async with session.get(
            origin + "/home/enter.html?to=%2F",
            headers=_headers(referer=origin + "/"),
            allow_redirects=True,
            timeout=aiohttp.ClientTimeout(total=12),
        ) as r:
            await r.text()
    except Exception:
        pass  # 门页本身只是设 cookie, 失败也继续尝试


async def fetch_play_ids(session: aiohttp.ClientSession, origin: str):
    """抓首页, 提取 /play/{id}.html 视频列表。"""
    html = ""
    for path in ("/?entered=1", "/"):
        try:
            async with session.get(origin + path, headers=_headers(referer=origin + "/"),
                                  timeout=aiohttp.ClientTimeout(total=15)) as r:
                html = await r.text()
            if "/play/" in html:
                break
        except Exception:
            continue
    ids = re.findall(r'href="(/play/(\d+)\.html)"', html)
    seen, out = set(), []
    for href, vid in ids:
        if vid not in seen:
            seen.add(vid)
            out.append((href, vid))
    return out


def _extract_m3u8(html: str):
    """从会员播放页提取播放地址。命中多种可能的下发形态。"""
    patterns = [
        r'https?://[^\s"\'<>\\]+\.m3u8[^\s"\'<>\\]*',
        r'player_aaaa\s*=\s*(\{.{0,4000}?\})',
        r'"(?:play_?url|url|video_?url|source|playurl)"\s*:\s*"(https?://[^"]+)"',
        r'(?:let|var|const)\s+(?:play_?url|url|vurl)\s*=\s*["\'](https?://[^"\']+)',
    ]
    for p in patterns:
        m = re.search(p, html, re.I | re.S)
        if m:
            val = m.group(0) if p.startswith("http") else (m.group(1) if m.lastindex else m.group(0))
            val = val.strip().replace("\\/", "/")
            if val.startswith("http") and (".m3u8" in val or ".mp4" in val):
                return val
            # player_aaaa / JSON 形态: 再从里面抠 url
            inner = re.search(r'"url"\s*:\s*"(https?://[^"]+)"', val)
            if inner:
                return inner.group(1).replace("\\/", "/")
    # 兜底: 页面里任意 m3u8 字符串
    m = re.search(r'["\']([^"\']*\.m3u8[^"\']*)["\']', html)
    if m:
        u = m.group(1).replace("\\/", "/")
        return u if u.startswith("http") else None
    return None


async def resolve(video_id: str = "", page_url: str = "", device_key: str = "") -> str:
    """
    自研解析主流程。返回可播放 m3u8 地址。

    video_id:  /play/{id}.html 里的数字 id
    page_url:  用户当前页面 (可能是旧域名), 从中抽 id
    """
    if not MEMBER_COOKIE:
        raise RuntimeError(
            "未配置会员登录态 (HJ_MEMBER_COOKIE)。"
            "实测确认: 播放页是服务端 SSR, 未登录时不下发任何 m3u8/播放器, "
            "只有会员 Cookie 才能换取播放地址。这是账号鉴权, 前端无法绕过。"
        )

    # 从 page_url 抽 id
    if not video_id and page_url:
        m = re.search(r"/play/(\d+)\.html", page_url) or re.search(r"[?&]id=(\d+)", page_url)
        if m:
            video_id = m.group(1)

    jar = aiohttp.CookieJar(unsafe=True)
    async with aiohttp.ClientSession(cookie_jar=jar) as session:
        origin = await discover_origin(session)
        await pass_age_gate(session, origin)

        if not video_id:
            ids = await fetch_play_ids(session, origin)
            if not ids:
                raise RuntimeError("首页没抓到视频列表")
            video_id = ids[0][1]

        play_url = f"{origin}/play/{video_id}.html?entered=1"
        async with session.get(play_url, headers=_headers(referer=origin + "/"),
                               timeout=aiohttp.ClientTimeout(total=20)) as r:
            html = await r.text()

        if "会员专享" in html or "暂不支持试看" in html:
            raise RuntimeError("会员 Cookie 无效或已过期，服务端仍判定为未登录")

        url = _extract_m3u8(html)
        if not url:
            # 会员态下播放器可能走二次 ajax 接口 —— 留钩子，按实际返回补
            raise RuntimeError("会员态页面里未定位到 m3u8（播放器形态需按会员返回二次适配）")
        logger.info("resolve_ok", extra={"extra": {"vid": video_id, "url": url[:120]}})
        return url
