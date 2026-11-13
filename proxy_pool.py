# -*- coding: utf-8 -*-
"""
SOCKS5 代理池 — 轮换 / 健康检查 / 失败摘除
用法:
    pool = ProxyPool(["socks5://user:pass@1.2.3.4:1080", ...])
    proxy = await pool.get()      # 拿一个可用代理
    await pool.report(False)      # 报告失败(摘除)
    await pool.report(True)       # 报告成功
"""
import asyncio
import time
import random

import aiohttp
from aiohttp_socks import ProxyConnector, ProxyType


class ProxyPool:
    def __resolve(self, p: str):
        # 支持 socks5://host:port 或 socks5://user:pass@host:port
        from urllib.parse import urlparse
        u = urlparse(p)
        return ProxyConnector(
            proxy_type=ProxyType.SOCKS5,
            host=u.hostname,
            port=u.port or 1080,
            rdns=True,
            username=u.username,
            password=u.password,
        )

    def __init__(self, proxies: list[str]):
        self._raw = proxies
        self._pool: dict[str, dict] = {}
        for p in proxies:
            self._pool[p] = {"conn": self.__resolve(p), "fails": 0, "last_ok": 0.0}

    async def get(self) -> str:
        """返回一个可用代理字符串(用于 aiohttp session.connector)，失败返回空串"""
        alive = [p for p, v in self._pool.items() if v["fails"] < 3]
        if not alive:
            # 全挂了，重置失败计数再试一轮
            for v in self._pool.values():
                v["fails"] = 0
            alive = list(self._pool)
            if not alive:
                return ""
        # 随机挑一个失败次数最少的
        alive.sort(key=lambda p: (self._pool[p]["fails"], self._pool[p]["last_ok"]))
        best = alive[0]
        return best

    async def report(self, proxy: str, success: bool):
        v = self._pool.get(proxy)
        if not v:
            return
        if success:
            v["fails"] = 0
            v["last_ok"] = time.time()
        else:
            v["fails"] += 1

    async def health_check(self):
        """并发探活所有代理(示例: google generate_204)"""
        async def check(p):
            try:
                async with aiohttp.ClientSession(connector=self._pool[p]["conn"]) as s:
                    async with s.get("http://www.google.com/generate_204", timeout=aiohttp.ClientTimeout(total=8)) as r:
                        await self.report(p, r.status == 204)
            except Exception:
                await self.report(p, False)

        await asyncio.gather(*[check(p) for p in self._pool], return_exceptions=True)
