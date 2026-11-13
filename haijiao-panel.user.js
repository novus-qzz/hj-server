// ==UserScript==
// @name         海角社区视频解析助手（自研免验证版）
// @namespace    hj.auto.panel
// @version      2.0
// @description  一键解析 haijiao.com 视频播放地址与AES密钥，现代化面板内直接播放，无需TG群验证，不依赖原作者后端
// @author       Little Code Sauce
// @match        *://haijiao.com/*
// @match        *://*.haijiao.com/*
// @require      https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      haijiao.com
// @connect      hj-server-rs34mttf-novus-qzz.cloady.io
// @connect      *
// @run-at       document-end
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // ═══════════════ 配置 ═══════════════
    const API_BASE = "https://hj-server-rs34mttf-novus-qzz.cloady.io";
    const APP_TOKEN = "EHqRzyUOH0p9R2kRvBrh9nmWurPOZn";

    // ═══════════════ 状态 ═══════════════
    const state = {
        pid: null,          // 当前帖子 pid
        parsedPid: null,    // 已解析的 pid
        playUrl: null,
        keyinfo: null,
        hls: null,          // hls.js 实例
        collapsed: false,
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
            timeout: 45000,
            ...opts,
            onload: (r) => resolve(r),
            onerror: (e) => reject(new Error("网络错误(" + (e.error || "connection") + ")，请检查代理/网络")),
            ontimeout: () => reject(new Error("请求超时(45s)")),
        });
    });

    // ═══════════════ 样式 ═══════════════
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
    `;

    // ═══════════════ 面板 HTML ═══════════════
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
          <button id="hj-play" class="hj-btn hj-btn-main">▶ 播放</button>
          <button id="hj-copy" class="hj-btn hj-btn-ghost">📋 m3u8</button>
          <button id="hj-copykey" class="hj-btn hj-btn-ghost">📋 Key+IV</button>
          <span id="hj-timing" class="hj-hint"></span>
        </div>
        <div class="hj-hint">视频在帖子弹窗里也可用：本面板解析成功后，站内原生播放按钮同样生效。</div>
      </div>
    </div>`;

    // ═══════════════ 面板逻辑 ═══════════════
    function setPill(cls, text) {
        const p = $("hj-pill");
        p.className = "hj-pill " + cls;
        p.textContent = text;
    }
    function setMsg(html, isErr) {
        const m = $("hj-msg");
        m.className = "hj-msg" + (isErr ? " err" : "");
        m.innerHTML = html;
    }

    function detectPid() {
        const m = location.href.match(/[?&]pid=(\d+)/) || location.pathname.match(/\/post\/details\/?(\d+)?/);
        return m ? (m[1] || null) : null;
    }

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
            const res = await gmRequest({
                method: "POST",
                url: API_BASE + "/api/play",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + APP_TOKEN,
                    "pcVer": "2",
                },
                data: JSON.stringify({ page_url: "https://haijiao.com/post/details?pid=" + pid, device_key: "tm-" + pid }),
            });
            if (res.status !== 200) throw new Error("后端 HTTP " + res.status + "：" + (res.responseText || "").slice(0, 160));
            let data;
            try { data = JSON.parse(res.responseText); } catch { throw new Error("后端返回非 JSON：" + String(res.responseText).slice(0, 160)); }
            if (!data.ok) throw new Error(data.error || "后端返回失败");

            const d = data.data || {};
            state.playUrl = d.play_url || "";
            state.keyinfo = d.keyinfo || null;
            state.parsedPid = pid;

            const ms = Math.round(performance.now() - t0);
            setPill("ok", "解析成功");
            setMsg("解析成功（" + ms + " ms）。播放地址与密钥已就绪，点下方「▶ 播放」开始。");
            $("hj-key").textContent = state.keyinfo ? state.keyinfo.aes_key : "（明文流，无密钥）";
            $("hj-iv").textContent = state.keyinfo ? state.keyinfo.iv : "-";
            $("hj-kv").classList.toggle("hj-hide", !state.keyinfo);
            $("hj-actions").classList.remove("hj-hide");
            $("hj-timing").textContent = ms + " ms";
        } catch (e) {
            setPill("err", "失败");
            setMsg("解析失败：" + (e && e.message ? e.message : e) +
                "<br>排查：① 后端 <span class='link' id='hj-hz'>健康检查</span> ② Cloady 环境变量是否还在 ③ 本地网络/代理", true);
            const hz = $("hj-hz");
            if (hz) hz.onclick = () => gmRequest({ method: "GET", url: API_BASE + "/healthz" })
                .then(r => setMsg("healthz：" + r.status + " " + r.responseText, false)).catch(err => setMsg("healthz 失败：" + err.message, true));
        } finally {
            btn.disabled = false;
        }
    }

    function play() {
        const video = $("hj-video");
        if (!state.playUrl) return;
        video.classList.remove("hj-hide");
        if (state.hls) { try { state.hls.destroy(); } catch (e) {} state.hls = null; }

        const kver = (state.keyinfo && state.keyinfo.kversion) || "";
        const aesKeyHex = state.keyinfo && state.keyinfo.aes_key;

        // 与原站一致的链路：hls.js + KEY_LOADED 密钥替换（WASM XOR 已由服务端完成）
        if (window.Hls && Hls.isSupported()) {
            const hls = new Hls({
                autoStartLoad: true, maxBufferLength: 15, maxMaxBufferLength: 30, maxBufferSize: 3e7, startLevel: -1,
                xhrSetup(xhr, url) {
                    if (kver && url.includes(".key")) {
                        url = url.replace(".key", ".key" + kver);
                        xhr.open("GET", url, true);
                    }
                },
            });
            state.hls = hls;
            if (aesKeyHex) {
                let swapped = false;
                hls.on(Hls.Events.KEY_LOADED, (ev, data) => {
                    if (swapped) return;
                    swapped = true;
                    try { data.frag.decryptdata.key = hexToBytes(aesKeyHex); } catch (e) {}
                });
            }
            hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
            hls.on(Hls.Events.ERROR, (ev, data) => {
                if (data && data.fatal) {
                    setPill("err", "播放错误");
                    setMsg("播放出错：" + (data.details || data.type) + "，可尝试重新解析或换线路。", true);
                    try { hls.destroy(); } catch (e) {}
                }
            });
            hls.loadSource(state.playUrl);
            hls.attachMedia(video);
            setMsg("▶ 正在加载流并解密分片…（密钥替换模式，与原站链路一致）");
            setPill("ok", "播放中");
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
            video.src = state.playUrl;
            video.play().catch(() => {});
        } else {
            setMsg("当前浏览器不支持 HLS 播放。", true);
        }
    }

    function copy(text, tip) {
        navigator.clipboard.writeText(text).then(
            () => setMsg("已复制" + (tip || "") + "到剪贴板。"),
            () => setMsg("复制失败，请手动选择文本复制。", true)
        );
    }

    // ═══════════════ 启动 ═══════════════
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

        // 轮询检测 SPA 路由（Vue 无刷新跳转）
        let lastPid = null;
        setInterval(() => {
            const pid = detectPid();
            state.pid = pid;
            $("hj-pid").textContent = pid || "—";
            if (pid && pid !== lastPid) {
                lastPid = pid;
                if (state.parsedPid !== pid) parse();   // 新帖自动解析
            }
            if (!pid) { setPill("idle", "待机"); setMsg("当前不是帖子页。打开帖子详情页自动解析。"); }
        }, 900);
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
})();
