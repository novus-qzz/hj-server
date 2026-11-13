// ==UserScript==
// @name         海角社区视频解析助手（自研免验证版 v3）
// @namespace    hj.auto.panel
// @version      3.0
// @description  解析注入原版播放器：拦截 /api/attachment 用自研后端结果替换，站点原生 WASM 播放器直接播放；另附现代化解析面板（密钥替换已修复 fragParsingError）
// @author       Little Code Sauce
// @match        *://haijiao.com/*
// @match        *://*.haijiao.com/*
// @require      https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      haijiao.com
// @connect      hj-server-rs34mttf-novus-qzz.cloady.io
// @connect      *
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // ═══════════════ 配置 ═══════════════
    const API_BASE = "https://hj-server-rs34mttf-novus-qzz.cloady.io";
    const APP_TOKEN = "EHqRzyUOH0p9R2kRvBrh9nmWurPOZn";

    const state = {
        pid: null, parsedPid: null,
        playUrl: null, keyinfo: null, hls: null,
        collapsed: false,
        native: localStorage.getItem('hj_native_takeover') !== '0', // 原版播放器接管开关
    };

    // ═══════════════ 工具 ═══════════════
    const $ = (id) => document.getElementById(id);
    const hexToBytes = (hex) => {
        const b = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) b[i / 2] = parseInt(hex.substr(i, 2), 16);
        return b;
    };
    const gmRequest = (opts) => new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            timeout: 45000, ...opts,
            onload: (r) => resolve(r),
            onerror: (e) => reject(new Error("网络错误(" + (e.error || "connection") + ")")),
            ontimeout: () => reject(new Error("请求超时(45s)")),
        });
    });
    const detectPid = () => {
        const m = location.href.match(/[?&]pid=(\d+)/);
        return m ? m[1] : null;
    };

    // 调自研后端 /api/play
    async function resolveFromBackend(pid) {
        const res = await gmRequest({
            method: "POST",
            url: API_BASE + "/api/play",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + APP_TOKEN, "pcVer": "2" },
            data: JSON.stringify({ page_url: "https://haijiao.com/post/details?pid=" + pid, device_key: "tm-" + pid }),
        });
        if (res.status !== 200) throw new Error("后端 HTTP " + res.status);
        const data = JSON.parse(res.responseText);
        if (!data.ok) throw new Error(data.error || "后端返回失败");
        return data.data || {};
    }

    // ═══════════════ 原版播放器接管（XHR 应答注入）════════════════
    // 站点原生 JS 点播放 → POST /api/attachment → 被本脚本拦下，
    // 用自研后端解析结果伪装成成功响应，站点自己的 WASM jquery_key 链路原样播放。
    (function nativeHook() {
        const OPEN = XMLHttpRequest.prototype.open;
        const SEND = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function (method, url) {
            try { this.__hj = { method: String(method || ''), url: String(url || '') }; } catch (e) {}
            return OPEN.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function (body) {
            const x = this;
            const meta = x.__hj;
            const isAttachment = meta && /\/api\/attachment/.test(meta.url) && /POST/i.test(meta.method);
            const pid = detectPid();
            if (isAttachment && pid && state.native) {
                // 吞掉原请求，改由自研后端应答
                resolveFromBackend(pid).then((d) => {
                    const url = d.play_url || "";
                    shadow(x, url
                        ? { isEncrypted: false, errorCode: 0, message: "", success: true, data: { remoteUrl: url, url: url } }
                        : { isEncrypted: false, errorCode: 1, message: "解析失败：无可用播放地址", success: false, data: null });
                }).catch((err) => {
                    shadow(x, { isEncrypted: false, errorCode: 1, message: "自研解析失败: " + (err && err.message || err), success: false, data: null });
                });
                return; // 不放行原 send
            }
            return SEND.apply(this, arguments);
        };

        function shadow(x, envelope) {
            const txt = JSON.stringify(envelope);
            const define = (k, v) => { try { Object.defineProperty(x, k, { value: v, configurable: true, writable: true }); } catch (e) {} };
            define('readyState', 4);
            define('status', 200);
            define('statusText', 'OK');
            define('responseText', txt);
            define('response', txt);
            define('responseURL', (x.__hj && x.__hj.url) || '');
            try {
                Object.defineProperty(x, 'getAllResponseHeaders', { value: () => 'content-type: application/json\r\n', configurable: true });
                Object.defineProperty(x, 'getResponseHeader', { value: (n) => (/^content-type$/i.test(n) ? 'application/json' : null), configurable: true });
            } catch (e) {}
            setTimeout(() => {
                try { x.dispatchEvent(new Event('readystatechange')); } catch (e) {}
                try { x.dispatchEvent(new ProgressEvent('load')); } catch (e) {}
                try { x.dispatchEvent(new ProgressEvent('loadend')); } catch (e) {}
            }, 0);
        }
    })();

    // ═══════════════ 现代化面板 ═══════════════
    const CSS = `
    @keyframes hjSlideUp{from{transform:translateY(24px);opacity:0}to{transform:translateY(0);opacity:1}}
    @keyframes hjBreath{0%,100%{box-shadow:0 0 0 0 rgba(168,85,247,.55)}50%{box-shadow:0 0 0 7px rgba(168,85,247,0)}}
    @keyframes hjSpin{to{transform:rotate(360deg)}}
    #hj-panel{position:fixed;right:18px;bottom:18px;width:430px;max-width:calc(100vw - 36px);
      background:rgba(17,17,28,.88);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
      border:1px solid rgba(255,255,255,.09);border-radius:18px;color:#e8e8f0;
      font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;font-size:13px;
      box-shadow:0 24px 70px rgba(0,0,0,.55);z-index:2147483000;overflow:hidden;
      animation:hjSlideUp .35s cubic-bezier(.2,.9,.3,1.2)}
    #hj-panel *{box-sizing:border-box;margin:0;padding:0}
    .hj-head{display:flex;align-items:center;gap:10px;padding:13px 15px;
      background:linear-gradient(90deg,rgba(124,58,237,.25),rgba(236,72,153,.15));
      border-bottom:1px solid rgba(255,255,255,.07)}
    .hj-logo{width:26px;height:26px;border-radius:8px;flex:none;display:grid;place-items:center;
      background:linear-gradient(135deg,#7c3aed,#ec4899);font-size:14px}
    .hj-title{font-weight:700;font-size:14px;background:linear-gradient(90deg,#c4b5fd,#f9a8d4);
      -webkit-background-clip:text;background-clip:text;color:transparent;flex:1;white-space:nowrap}
    .hj-pill{flex:none;font-size:11px;font-weight:600;padding:4px 10px;border-radius:99px;transition:all .3s}
    .hj-pill.idle{background:rgba(148,163,184,.18);color:#94a3b8}
    .hj-pill.work{background:rgba(168,85,247,.22);color:#d8b4fe;animation:hjBreath 1.6s infinite}
    .hj-pill.ok{background:rgba(34,197,94,.18);color:#86efac}
    .hj-pill.err{background:rgba(239,68,68,.2);color:#fca5a5}
    .hj-iconbtn{flex:none;width:28px;height:28px;border:none;border-radius:8px;cursor:pointer;
      background:rgba(255,255,255,.06);color:#aab;font-size:14px;line-height:1;transition:.2s}
    .hj-iconbtn:hover{background:rgba(255,255,255,.14);color:#fff}
    .hj-body{padding:13px 15px 15px;display:flex;flex-direction:column;gap:11px;max-height:66vh;overflow:auto}
    .hj-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .hj-lbl{color:#8b8ba3;font-size:12px;flex:none}
    .hj-mono{font-family:Consolas,Menlo,monospace;font-size:11px;color:#7dd3fc;
      background:rgba(0,0,0,.35);padding:3px 8px;border-radius:6px;word-break:break-all;flex:1;min-width:0}
    .hj-btn{border:none;border-radius:10px;padding:9px 16px;font-size:13px;font-weight:600;
      cursor:pointer;transition:.2s;color:#fff;white-space:nowrap}
    .hj-btn:active{transform:scale(.97)}
    .hj-btn-main{background:linear-gradient(135deg,#7c3aed,#db2777);box-shadow:0 6px 22px rgba(219,39,119,.35)}
    .hj-btn-main:hover{filter:brightness(1.12)}
    .hj-btn-ghost{background:rgba(255,255,255,.07);color:#cbb}
    .hj-btn-ghost:hover{background:rgba(255,255,255,.13);color:#fff}
    .hj-btn[disabled]{opacity:.45;cursor:not-allowed;filter:none}
    .hj-video{width:100%;aspect-ratio:16/9;border-radius:12px;background:#000;display:block;
      border:1px solid rgba(255,255,255,.08)}
    .hj-msg{font-size:12px;color:#9a9ab0;line-height:1.6;word-break:break-all}
    .hj-msg.err{color:#fca5a5}
    .hj-msg .link{color:#7dd3fc;cursor:pointer;text-decoration:underline}
    .hj-spin{display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.25);
      border-top-color:#d8b4fe;border-radius:50%;animation:hjSpin .7s linear infinite;vertical-align:-2px;margin-right:6px}
    .hj-hint{font-size:11px;color:#6b6b80}
    .hj-hide{display:none!important}
    .hj-switch{display:inline-flex;align-items:center;gap:7px;cursor:pointer;user-select:none;font-size:12px;color:#9a9ab0}
    .hj-track{width:36px;height:20px;border-radius:99px;background:rgba(255,255,255,.12);position:relative;transition:.25s;flex:none}
    .hj-track::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
      background:#9a9ab0;transition:.25s}
    .hj-track.on{background:linear-gradient(90deg,#7c3aed,#db2777)}
    .hj-track.on::after{left:18px;background:#fff}
    `;

    const HTML = `
    <div id="hj-panel">
      <div class="hj-head">
        <div class="hj-logo">🎬</div>
        <div class="hj-title">海角视频解析 · 自研免验证</div>
        <span id="hj-pill" class="hj-pill idle">待机</span>
        <button id="hj-min" class="hj-iconbtn" title="折叠">—</button>
        <button id="hj-close" class="hj-iconbtn" title="关闭">×</button>
      </div>
      <div id="hj-body" class="hj-body">
        <div class="hj-row">
          <span class="hj-lbl">帖子 PID</span>
          <span id="hj-pid" class="hj-mono">—</span>
          <button id="hj-parse" class="hj-btn hj-btn-main" style="margin-left:auto">⚡ 立即解析</button>
        </div>
        <div id="hj-msg" class="hj-msg">正在检测页面…</div>
        <video id="hj-video" class="hj-video hj-hide" controls playsinline preload="metadata"></video>
        <div id="hj-kv" class="hj-hide">
          <div class="hj-row" style="margin-bottom:5px">
            <span class="hj-lbl">AES Key</span><span id="hj-key" class="hj-mono"></span>
          </div>
          <div class="hj-row">
            <span class="hj-lbl">IV</span><span id="hj-iv" class="hj-mono" style="margin-left:29px"></span>
          </div>
        </div>
        <div id="hj-actions" class="hj-row hj-hide">
          <button id="hj-play" class="hj-btn hj-btn-main">▶ 面板播放</button>
          <button id="hj-copy" class="hj-btn hj-btn-ghost">📋 m3u8</button>
          <button id="hj-copykey" class="hj-btn hj-btn-ghost">📋 Key+IV</button>
          <span id="hj-timing" class="hj-hint"></span>
        </div>
        <div class="hj-row" style="justify-content:space-between">
          <span id="hj-native-sw" class="hj-switch"><span id="hj-native-track" class="hj-track"></span>接管原版播放器（点站内播放按钮即用自研解析）</span>
        </div>
        <div class="hj-hint">v3：解析结果直接注入站内原生播放器（WASM 解密链原样生效）；面板内播放为备用。</div>
      </div>
    </div>`;

    function setPill(cls, text) { const p = $("hj-pill"); p.className = "hj-pill " + cls; p.textContent = text; }
    function setMsg(html, isErr) { const m = $("hj-msg"); m.className = "hj-msg" + (isErr ? " err" : ""); m.innerHTML = html; }

    async function parse() {
        const pid = state.pid;
        if (!pid) { setPill("err", "无PID"); setMsg("当前页面不是帖子详情页。打开 <span class='link'>/post/details?pid=…</span> 页面后再解析。", true); return; }
        const btn = $("hj-parse");
        btn.disabled = true;
        setPill("work", "解析中");
        setMsg('<span class="hj-spin"></span>正在调用自研后端解析帖子 ' + pid + ' …');
        $("hj-video").classList.add("hj-hide");
        const t0 = performance.now();
        try {
            const d = await resolveFromBackend(pid);
            state.playUrl = d.play_url || "";
            state.keyinfo = d.keyinfo || null;
            state.parsedPid = pid;
            const ms = Math.round(performance.now() - t0);
            setPill("ok", "解析成功");
            setMsg("解析成功（" + ms + " ms）。<b>站内原播放按钮已被接管</b>——直接点帖子里的播放按钮即可原生播放；也可用下方「面板播放」。" + (d.keyinfo ? "" : "（该流无密钥信息）"));
            $("hj-key").textContent = state.keyinfo ? state.keyinfo.aes_key : "（明文流）";
            $("hj-iv").textContent = state.keyinfo ? state.keyinfo.iv : "-";
            $("hj-kv").classList.toggle("hj-hide", !state.keyinfo);
            $("hj-actions").classList.remove("hj-hide");
            $("hj-timing").textContent = ms + " ms";
        } catch (e) {
            setPill("err", "失败");
            setMsg("解析失败：" + (e && e.message ? e.message : e) + "<br>排查：① 后端 <span class='link' id='hj-hz'>健康检查</span> ② Cloady 环境变量 ③ 本地网络/代理", true);
            const hz = $("hj-hz");
            if (hz) hz.onclick = () => gmRequest({ method: "GET", url: API_BASE + "/healthz" })
                .then(r => setMsg("healthz：" + r.status + " " + r.responseText, false)).catch(err => setMsg("healthz 失败：" + err.message, true));
        } finally { btn.disabled = false; }
    }

    // 面板播放：密钥用 blob URL 直接替换 hls.js 的 .key 请求（版本无关、每个分片都正确）
    function play() {
        const video = $("hj-video");
        if (!state.playUrl) return;
        video.classList.remove("hj-hide");
        if (state.hls) { try { state.hls.destroy(); } catch (e) {} state.hls = null; }

        const kver = (state.keyinfo && state.keyinfo.kversion) || "";
        const aesKeyHex = state.keyinfo && state.keyinfo.aes_key;
        let keyBlobUrl = null;
        if (aesKeyHex) {
            keyBlobUrl = URL.createObjectURL(new Blob([hexToBytes(aesKeyHex)], { type: "application/octet-stream" }));
        }

        if (window.Hls && Hls.isSupported()) {
            const hls = new Hls({
                autoStartLoad: true, maxBufferLength: 15, maxMaxBufferLength: 30, maxBufferSize: 3e7, startLevel: -1,
                xhrSetup(xhr, url) {
                    if (keyBlobUrl && /\.key(\?|$)/.test(url)) {
                        xhr.open("GET", keyBlobUrl, true);          // 直接喂已变换的密钥
                    } else if (kver && url.includes(".key")) {
                        xhr.open("GET", url.replace(".key", ".key" + kver), true);
                    }
                },
            });
            state.hls = hls;
            if (aesKeyHex) {
                // 双保险：每次 KEY_LOADED 都覆盖（修复旧版只换一次导致 fragParsingError 的问题）
                hls.on(Hls.Events.KEY_LOADED, (ev, d) => {
                    try { if (d && d.frag && d.frag.decryptdata) d.frag.decryptdata.key = hexToBytes(aesKeyHex); } catch (e) {}
                });
            }
            hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
            hls.on(Hls.Events.ERROR, (ev, d) => {
                if (d && d.fatal) {
                    setPill("err", "播放错误");
                    setMsg("面板播放出错：" + (d.details || d.type) + "。建议改用<b>站内原生播放按钮</b>（已被接管）。", true);
                    try { hls.destroy(); } catch (e) {}
                }
            });
            hls.loadSource(state.playUrl);
            hls.attachMedia(video);
            setMsg("▶ 面板播放中（密钥经 blob 注入，已修复 fragParsingError）。");
            setPill("ok", "播放中");
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
            video.src = state.playUrl;
            video.play().catch(() => {});
        } else {
            setMsg("当前浏览器不支持 HLS 播放，请用站内原生播放按钮（已被接管）。", true);
        }
    }

    function copy(text, tip) {
        navigator.clipboard.writeText(text).then(
            () => setMsg("已复制" + (tip || "") + "到剪贴板。"),
            () => setMsg("复制失败，请手动选择文本复制。", true)
        );
    }

    function boot() {
        if (document.getElementById("hj-panel")) return;
        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);
        const wrap = document.createElement("div");
        wrap.innerHTML = HTML;
        document.body.appendChild(wrap.firstElementChild);

        $("hj-close").onclick = () => { if (state.hls) try { state.hls.destroy(); } catch (e) {} $("hj-panel").remove(); };
        $("hj-min").onclick = () => {
            state.collapsed = !state.collapsed;
            $("hj-body").classList.toggle("hj-hide", state.collapsed);
            $("hj-min").textContent = state.collapsed ? "▢" : "—";
        };
        $("hj-parse").onclick = () => parse();
        $("hj-play").onclick = () => play();
        $("hj-copy").onclick = () => state.playUrl && copy(state.playUrl, " m3u8 地址 ");
        $("hj-copykey").onclick = () => state.keyinfo && copy("key=" + state.keyinfo.aes_key + "\niv=" + state.keyinfo.iv, " Key/IV ");
        const sw = $("hj-native-sw");
        const syncSw = () => $("hj-native-track").className = "hj-track" + (state.native ? " on" : "");
        syncSw();
        sw.onclick = () => { state.native = !state.native; localStorage.setItem('hj_native_takeover', state.native ? '1' : '0'); syncSw(); setMsg(state.native ? "已开启：站内播放按钮将使用自研解析结果。" : "已关闭：站内播放按钮恢复原站行为。"); };

        let lastPid = null;
        setInterval(() => {
            const pid = detectPid();
            state.pid = pid;
            $("hj-pid").textContent = pid || "—";
            if (pid && pid !== lastPid) { lastPid = pid; if (state.parsedPid !== pid) parse(); }
            if (!pid) { setPill("idle", "待机"); setMsg("当前不是帖子页。打开帖子详情页自动解析。"); }
        }, 900);
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
})();
