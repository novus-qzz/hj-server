// ============================================================
// 会员 Cookie 一键导出 — 在【已登录会员】的影院页面按 F12 → Console 粘贴运行
// 运行后自动把整串 Cookie 复制到剪贴板，直接粘到 Cloady 的
// HJ_MEMBER_COOKIE 环境变量即可。
// ============================================================
(function () {
  'use strict';
  var c = document.cookie || '';
  if (!c) {
    alert('当前页没有 Cookie —— 确认已登录会员、且是在影院站(不是发布页)上运行');
    return;
  }
  // 顺带把 localStorage / sessionStorage 里的 token 也带出来（有些站把登录态放这里）
  var extra = [];
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      var v = localStorage.getItem(k) || '';
      if (/token|sess|auth|user|uid|login|member|vip/i.test(k) && v.length < 500) {
        extra.push(k + '=' + v);
      }
    }
  } catch (_) {}

  var out = c.trim().replace(/;\s*/g, '; ');
  console.log('===== 复制下面这行到 HJ_MEMBER_COOKIE =====');
  console.log(out);
  console.log('===== localStorage 疑似登录态(备用) =====');
  console.log(extra.join('\n') || '(无)');
  console.log('长度: ' + out.length + ' 字符');

  try {
    navigator.clipboard.writeText(out).then(function () {
      console.log('✅ 已复制到剪贴板');
    });
  } catch (_) {
    // 降级：手动选中
    var ta = document.createElement('textarea');
    ta.value = out; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
    console.log('✅ 已复制(降级方式)');
  }
})();
