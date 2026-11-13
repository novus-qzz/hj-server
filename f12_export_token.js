/**
 * 海角社区 haijiao.com — 自研播放器密钥链（F12 一键脚本）
 * =========================================================
 * 用法：登录 haijiao.com 后，打开任意视频页，按 F12 → Console，粘贴此脚本回车。
 * 输出：X-User-Token / X-User-Id（用于填进 Cloady 环境变量 HJ_USER_TOKEN / HJ_USER_ID）。
 * 
 * 原理：app.js 登录成功后把 token 写进 localStorage（s.a.TOKEN / s.a.ID 或 store userInfo）。
 * 本脚本遍历 localStorage / sessionStorage 把可能的 token/uid 键值全部导出。
 */
(async () => {
  console.log("%c=== 海角自研 Token 导出 (F12) ===", "color:#2ecc71;font-weight:bold");

  const candidates = [
    "TOKEN", "token", "access_token", "jwt", "Authorization",
    "X-User-Token", "x-user-token",
    "USER_ID", "user_id", "uid", "X-User-Id", "x-user-id",
    "userInfo", "user", "hj_user", "hj_token",
  ];

  const dump = (store, name) => {
    const out = {};
    try {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        const v = store.getItem(k);
        const kl = k.toLowerCase();
        const hit = candidates.some(c => kl === c.toLowerCase() || kl.includes(c.toLowerCase()));
        if (hit || /token|uid|user|id|jwt|auth/.test(kl)) {
          out[k] = v;
        }
      }
    } catch (e) { out["_ERR_" + name] = String(e); }
    return out;
  };

  const ls = dump(localStorage, "localStorage");
  const ss = dump(sessionStorage, "sessionStorage");

  console.log("localStorage:", ls);
  console.log("sessionStorage:", ss);

  const merged = { ...ls, ...ss };
  const token = merged["X-User-Token"] || merged["TOKEN"] || merged["token"] || merged["access_token"] || "";
  const uid   = merged["X-User-Id"]   || merged["USER_ID"] || merged["user_id"] || merged["uid"] || "";

  console.log("%c==== 可直接填入 Cloady 环境变量 ====", "color:#e74c3c;font-weight:bold");
  console.log("HJ_USER_TOKEN=" + token);
  console.log("HJ_USER_ID=" + uid);
  console.log("HJ_RESOLVE_MODE=self");
  console.log("HJ_APP_TOKEN=EHqRzyUOH0p9R2kRvBrh9nmWurPOZn");
  console.log("%c================================", "color:#e74c3c;font-weight:bold");

  if (!token || !uid) {
    console.warn("未自动抓到 token/uid。请先登录 haijiao.com，刷新页面后重试；"
                 "或在 Network 面板里找 /api/topic/xxx 请求的 X-User-Token / X-User-Id 响应头/请求头。");
  }
})();