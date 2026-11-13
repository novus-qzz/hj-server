# -*- coding: utf-8 -*-
"""
海角高阶版后端 — aiohttp 异步 API 网关
升级点: 异步并发 / HMAC 鉴权 / SQLite WAL / 令牌桶限流 / 结构化日志 / 代理池接口
"""
import asyncio
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
import uuid
from dataclasses import dataclass, field

import aiohttp
from aiohttp import web

# ═══════════════════════ 配置 ═══════════════════════
# PaaS (Cloady) 会注入 PORT；本机/VPS 用 HJ_PORT；默认 18787
LISTEN_PORT = int(os.getenv("PORT") or os.getenv("HJ_PORT") or "18787")
APP_TOKEN = os.getenv("HJ_APP_TOKEN", "EHqRzyUOH0p9R2kRvBrh9nmWurPOZn")
HMAC_KEY = os.getenv("HJ_HMAC_KEY", "please-change-me-to-32-bytes-key!!").encode()
TURNSTILE_SECRET = os.getenv("HJ_TURNSTILE_SECRET", "")  # 留空则跳过人机校验
DB_PATH = os.getenv("HJ_DB", "/tmp/hj.db")   # PaaS 文件系统易失，默认 /tmp
LOG_FILE = os.getenv("HJ_LOG", "/tmp/hj.log")

# 令牌桶参数：每设备每分钟 6 次，桶容量 3
RL_RATE = 6 / 60.0
RL_BURST = 3

# ═══════════════════════ 结构化日志 ═══════════════════════
logger = logging.getLogger("hj")
logger.setLevel(logging.INFO)


class JsonFormatter(logging.Formatter):
    def format(self, record):
        payload = {
            "ts": round(record.created, 3),
            "level": record.levelname,
            "msg": record.getMessage(),
            "module": record.module,
        }
        if hasattr(record, "extra"):
            payload.update(record.extra)
        return json.dumps(payload, ensure_ascii=False)


try:
    _h = logging.FileHandler(LOG_FILE, encoding="utf-8")
    _h.setFormatter(JsonFormatter())
    logger.addHandler(_h)
except (OSError, PermissionError):
    pass  # PaaS 只读 FS 时回退 stdout
_s = logging.StreamHandler()
_s.setFormatter(JsonFormatter())
logger.addHandler(_s)


def log(msg, **kw):
    logger.info(msg, extra={"extra": kw})


# ═══════════════════════ HMAC 鉴权 ═══════════════════════
def verify_auth(request) -> tuple[bool, str]:
    """
    双模式鉴权:
      1) 静态 Bearer token  (兼容原版油猴脚本)
      2) HMAC 签名: Authorization: HJ <serial>:<ts>:<hexsig>
         sig = HMAC-SHA256(HMAC_KEY, serial + ":" + ts)
         ts 距当前不得超过 300s (防重放)
    """
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return False, "缺少或错误的 APP_TOKEN"
    token = auth[7:].strip()
    if token == APP_TOKEN:
        return True, ""
    # HMAC 模式: token 形如 serial.ts.sig
    parts = token.split(".")
    if len(parts) == 3:
        serial, ts, sig = parts
        try:
            if abs(time.time() - int(ts)) > 300:
                return False, "签名已过期"
        except ValueError:
            return False, "签名格式错误"
        expect = hmac.new(HMAC_KEY, f"{serial}:{ts}".encode(), hashlib.sha256).hexdigest()
        if hmac.compare_digest(expect, sig.lower()):
            return True, ""
    return False, "缺少或错误的 APP_TOKEN"


# ═══════════════════════ 令牌桶限流 ═══════════════════════
@dataclass
class Bucket:
    tokens: float = RL_BURST
    last: float = field(default_factory=time.monotonic)


_buckets: dict[str, Bucket] = {}


def rate_limit(key: str) -> tuple[bool, float]:
    b = _buckets.get(key)
    now = time.monotonic()
    if b is None:
        if len(_buckets) > 100_000:
            _buckets.clear()
        b = _buckets[key] = Bucket()
    b.tokens = min(RL_BURST, b.tokens + (now - b.last) * RL_RATE)
    b.last = now
    if b.tokens >= 1.0:
        b.tokens -= 1.0
        return True, 0.0
    return False, (1.0 - b.tokens) / RL_RATE


# ═══════════════════════ 数据库 (SQLite WAL) ═══════════════════════
import sqlite3

_db_lock = asyncio.Lock()


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


async def init_db():
    async with _db_lock:
        conn = _db()
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS devices (
                device_key TEXT PRIMARY KEY,
                serial     TEXT UNIQUE NOT NULL,
                created_at REAL NOT NULL,
                last_seen  REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS verify_codes (
                code       TEXT PRIMARY KEY,
                device_key TEXT NOT NULL,
                created_at REAL NOT NULL,
                verified   INTEGER NOT NULL DEFAULT 0,
                play_token TEXT
            );
            CREATE TABLE IF NOT EXISTS play_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_key TEXT, page_url TEXT,
                play_url TEXT, created_at REAL
            );
            CREATE INDEX IF NOT EXISTS idx_verify_dev ON verify_codes(device_key);
            """
        )
        conn.commit()
        conn.close()


async def db_upsert_device(device_key: str) -> str:
    async with _db_lock:
        conn = _db()
        row = conn.execute(
            "SELECT serial FROM devices WHERE device_key=?", (device_key,)
        ).fetchone()
        now = time.time()
        if row:
            conn.execute(
                "UPDATE devices SET last_seen=? WHERE device_key=?", (now, device_key)
            )
            serial = row[0]
        else:
            serial = secrets.token_hex(4).upper()
            for _ in range(10):
                try:
                    conn.execute(
                        "INSERT INTO devices(device_key,serial,created_at,last_seen) VALUES(?,?,?,?)",
                        (device_key, serial, now, now),
                    )
                    break
                except sqlite3.IntegrityError:
                    serial = secrets.token_hex(4).upper()
            conn.commit()
        conn.close()
        return serial


async def db_new_code(device_key: str) -> str:
    code = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(6))
    async with _db_lock:
        conn = _db()
        conn.execute(
            "INSERT INTO verify_codes(code,device_key,created_at) VALUES(?,?,?)",
            (code, device_key, time.time()),
        )
        conn.commit()
        conn.close()
    return code


async def db_check_code(code: str):
    async with _db_lock:
        conn = _db()
        row = conn.execute(
            "SELECT verified FROM verify_codes WHERE code=? AND created_at>?",
            (code, time.time() - 600),
        ).fetchone()
        conn.close()
    return row


async def db_confirm_code(code: str) -> str:
    token = secrets.token_urlsafe(24)
    async with _db_lock:
        conn = _db()
        conn.execute(
            "UPDATE verify_codes SET verified=1, play_token=? WHERE code=?", (token, code)
        )
        conn.commit()
        conn.close()
    return token


async def db_play_token_ok(device_key: str, token: str) -> bool:
    if not token:
        return False
    async with _db_lock:
        conn = _db()
        row = conn.execute(
            "SELECT 1 FROM verify_codes WHERE play_token=? AND device_key=? AND verified=1",
            (token, device_key),
        ).fetchone()
        conn.close()
    return bool(row)


async def db_log_play(device_key: str, page_url: str, play_url: str):
    async with _db_lock:
        conn = _db()
        conn.execute(
            "INSERT INTO play_log(device_key,page_url,play_url,created_at) VALUES(?,?,?,?)",
            (device_key, page_url, play_url, time.time()),
        )
        conn.commit()
        conn.close()


# ═══════════════════════ Telegram Bot (验证) ═══════════════════════
TG_BOT_TOKEN = os.getenv("HJ_TG_BOT_TOKEN", "")
TG_BOT_USERNAME = os.getenv("HJ_TG_BOT_USERNAME", "haijiao_helper_bot")


async def send_tg_code(code: str):
    """真实部署时把 code 推给管理员 TG，人工加群后由 bot 确认。"""
    if not TG_BOT_TOKEN:
        return
    url = f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage"
    try:
        async with aiohttp.ClientSession() as s:
            await s.post(url, json={"chat_id": os.getenv("HJ_TG_ADMIN_ID", ""), "text": f"验证码 {code}"}, timeout=8)
    except Exception as e:
        log("tg_send_fail", err=str(e))


# ═══════════════════════ 解析 worker (占位，可接代理池/播放源) ═══════════════════════
# 真实逻辑: 收到 page_url → 代理池抓页面 → 提取 m3u8 → 返回
# 这里给出结构，函数体接你自己的解析源
async def resolve_play_url(page_url: str, device_key: str) -> str:
    # TODO: 接入解析源，如 需要代理: 见 proxy_pool.py
    # demo: 直接返回一个测试流
    log("resolve", device_key=device_key, page_url=page_url)
    return "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"


# ═══════════════════════ HTTP Handlers ═══════════════════════
def ok(data=None):
    return web.json_response({"ok": True, "data": data or {}})


def err(msg: str, status: int = 400):
    return web.json_response({"ok": False, "error": msg}, status=status)


def client_ip(request) -> str:
    fwd = request.headers.get("X-Forwarded-For", "")
    return fwd.split(",")[0].strip() if fwd else request.remote


async def handle_device(request: web.Request):
    okk, msg = verify_auth(request)
    if not okk:
        return err(msg, 401)
    try:
        body = await request.json()
    except Exception:
        return err("请求体必须是合法 JSON")
    device_key = str(body.get("device_key", "")).strip()
    if not device_key:
        return err("device_key 缺失")
    allowed, wait = rate_limit(device_key)
    if not allowed:
        return web.json_response(
            {"ok": False, "error": f"请求过于频繁，请 {wait:.0f} 秒后重试"}, status=429
        )
    serial = await db_upsert_device(device_key)
    log("device_register", device_key=device_key, serial=serial, ip=client_ip(request))
    return ok({"serial": serial})


async def handle_verify_start(request: web.Request):
    okk, msg = verify_auth(request)
    if not okk:
        return err(msg, 401)
    try:
        body = await request.json()
    except Exception:
        return err("请求体必须是合法 JSON")
    device_key = str(body.get("device_key", "")).strip()
    if not device_key:
        return err("device_key 缺失")

    # Turnstile (可选)
    if TURNSTILE_SECRET:
        cf = str(body.get("cf_token", "")).strip()
        if not cf:
            return err("请先完成人机验证")
        async with aiohttp.ClientSession() as s:
            r = await s.post(
                "https://challenges.cloudflare.com/turnstile/v0/siteverify",
                data={"secret": TURNSTILE_SECRET, "response": cf},
                timeout=10,
            )
            if not (await r.json()).get("success"):
                return err("人机验证失败")

    code = await db_new_code(device_key)
    await send_tg_code(code)
    log("verify_start", device_key=device_key, code=code, ip=client_ip(request))
    return ok({
        "code": code,
        "bot_url": f"https://t.me/{TG_BOT_USERNAME}",
    })


async def handle_verify_status(request: web.Request):
    okk, msg = verify_auth(request)
    if not okk:
        return err(msg, 401)
    code = request.query.get("code", "").strip()
    if not code:
        return err("code 缺失")
    row = await db_check_code(code)
    if not row:
        return err("验证码不存在或已过期", 404)
    verified, = row
    if not verified:
        return ok({"verified": False})
    # 拿 token
    async with _db_lock:
        conn = _db()
        r = conn.execute("SELECT play_token FROM verify_codes WHERE code=?", (code,)).fetchone()
        conn.close()
    return ok({"verified": True, "play_token": r[0]})


async def handle_play(request: web.Request):
    okk, msg = verify_auth(request)
    if not okk:
        return err(msg, 401)
    try:
        body = await request.json()
    except Exception:
        return err("请求体必须是合法 JSON")
    device_key = str(body.get("device_key", "")).strip()
    page_url = str(body.get("page_url", "")).strip()
    play_token = str(body.get("play_token", "")).strip()
    if not device_key or not page_url:
        return err("参数缺失")
    if not page_url.startswith("http"):
        return err("page_url 非法")
    allowed, wait = rate_limit(device_key)
    if not allowed:
        return web.json_response(
            {"ok": False, "error": f"请求过于频繁，请 {wait:.0f} 秒后重试"}, status=429
        )
    if not await db_play_token_ok(device_key, play_token):
        return err("需要群验证，请先加群", 403)

    play_url = await resolve_play_url(page_url, device_key)
    await db_log_play(device_key, page_url, play_url)
    log("play", device_key=device_key, page_url=page_url, ip=client_ip(request))
    return ok({"play_url": play_url})


# ═══════════════════════ App 装配 ═══════════════════════
async def on_start(app):
    await init_db()


def build_app() -> web.Application:
    app = web.Application(client_max_size=64 * 1024)
    app.on_startup.append(on_start)
    app.router.add_post("/api/device", handle_device)
    app.router.add_post("/api/verify/start", handle_verify_start)
    app.router.add_get("/api/verify/status", handle_verify_status)
    app.router.add_post("/api/play", handle_play)
    app.router.add_get("/healthz", lambda r: web.json_response({"ok": True, "service": "haijiao"}))
    return app


if __name__ == "__main__":
    log("server_start", port=LISTEN_PORT)
    web.run_app(build_app(), host="0.0.0.0", port=LISTEN_PORT, print=None)
