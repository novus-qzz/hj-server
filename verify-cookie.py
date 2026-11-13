# -*- coding: utf-8 -*-
"""
会员 Cookie 校验工具 — 在把 Cookie 写进 Cloady 之前，先本地验证它确实有效。

用法:
    set HJ_MEMBER_COOKIE=粘贴的整串Cookie
    python verify-cookie.py

判定:
    带 Cookie 请求 /play/{id}.html，若不再出现「会员专享,暂不支持试看」
    且页面里出现 m3u8 / <video> / 播放器，则会员态生效 → 自研解析可成。
"""
import asyncio
import os
import re
import sys

# Windows 控制台默认 GBK，统一成 UTF-8 避免中文/符号报错
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import aiohttp
import self_resolver as s

COOKIE = os.getenv("HJ_MEMBER_COOKIE", "").strip()
VID = os.getenv("HJ_TEST_VID", "291440846")


async def main():
    if not COOKIE:
        print("❌ 未设置 HJ_MEMBER_COOKIE")
        sys.exit(1)
    s.MEMBER_COOKIE = COOKIE

    async with aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True)) as sess:
        print("[1/3] 发现当日域名 ...")
        origin = await s.discover_origin(sess)
        print("      origin =", origin)

        print("[2/3] 过 18+ 门 ...")
        await s.pass_age_gate(sess, origin)

        print("[3/3] 带 Cookie 请求播放页 /play/%s.html ..." % VID)
        url = f"{origin}/play/{VID}.html?entered=1"
        async with sess.get(url, headers=s._headers(referer=origin + "/"),
                            timeout=aiohttp.ClientTimeout(total=20)) as r:
            html = await r.text()

    blocked = "会员专享" in html or "暂不支持试看" in html
    has_m3u8 = bool(re.search(r"\.m3u8", html))
    has_video = bool(re.search(r"<video|dplayer|DPlayer|player_aaaa|xgplayer|artplayer", html, re.I))
    play_urls = re.findall(r'https?://[^\s"\'<>\\]+\.m3u8[^\s"\'<>\\]*', html)[:3]

    print()
    print("      页面长度      :", len(html))
    print("      会员专享占位  :", "出现 ❌ (Cookie 无效/过期)" if blocked else "未出现 ✅")
    print("      含 m3u8       :", "是 ✅" if has_m3u8 else "否")
    print("      含播放器 DOM  :", "是 ✅" if has_video else "否")
    if play_urls:
        print("      播放地址样例  :")
        for u in play_urls:
            print("        ", u)

    print()
    if blocked:
        print("结论: ❌ Cookie 未被识别为会员。重新登录、确认是在【影院站】(非发布页)导出的 Cookie。")
        sys.exit(2)
    if has_m3u8 or has_video:
        print("结论: ✅ 会员态生效，服务端下发了播放地址/播放器。")
        print("     把 HJ_MEMBER_COOKIE 写进 Cloady，设 HJ_RESOLVE_MODE=self，Redeploy 即可纯自研播放。")
        if not play_urls:
            print("     (播放器为 JS 二次加载形态 —— 把上面 '页面长度' 对应的会员播放页源码发我，")
            print("      我补 _extract_m3u8 的适配就闭环)")
        sys.exit(0)
    print("结论: ⚠️ 会员占位没了但也没直接看到 m3u8 —— 播放器走二次 ajax。")
    print("     把会员播放页完整源码发我，我补接口适配(约 10 分钟)。")
    sys.exit(3)


if __name__ == "__main__":
    asyncio.run(main())
