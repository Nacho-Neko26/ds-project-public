/**
 * 控制台前端（单文件 HTML，无构建、无外部依赖、无 CDN、无 import）
 * 只导出 PAGE 一个字符串，服务端直接吐给浏览器。
 *
 * 面板：概览 / 会话 / Token / 目的 / 记忆 / 表情 / 日志
 * 用到的后端接口：
 *   GET  /api/status                         概览、日志、会话待处理
 *   POST /api/pause /api/resume /api/reload  概览三个按钮
 *   GET  /api/chat/list                      会话列表
 *   GET  /api/chat/messages?key=&limit=      消息流
 *   GET  /api/usage/summary?days=7           Token 面板 + 概览今日小结
 *   GET  /api/balance                        概览余额
 *   GET  /api/purpose/state                  目的面板
 *   GET  /api/memory/struct?grep=            记忆结构
 *   GET  /api/memory/list|read|search        记忆文件编辑
 *   POST /api/memory/write                   记忆文件保存
 *   GET  /api/stickers?limit=&grep=          表情网格
 *   GET  /api/stickers/img?i=                表情图片
 *   POST /api/stickers/update|del            表情编辑 / 删除
 *
 * 改完先 node --check src/control-page.mjs，再上传重启才生效。
 * 注意：模板里不能出现裸反引号，反斜杠要写成 \\。
 */
export const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>QQ 桥 · 控制台</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box}
body{margin:0;background:#0f1115;color:#e6e9ef;font:14px/1.55 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
/* ---- 侧边栏 ---- */
#nav{position:fixed;top:0;left:0;bottom:0;width:200px;background:#12151b;border-right:1px solid #2a2f3a;padding:14px 10px;overflow-y:auto}
.brand{padding:6px 10px 14px;font-size:14px;font-weight:600;letter-spacing:.3px}
.brand span{display:block;margin-top:2px;color:#8b93a3;font-size:11px;font-weight:400;letter-spacing:0}
.nav-item{margin-bottom:2px;padding:8px 11px;border-radius:8px;font-size:13.5px;color:#8b93a3;cursor:pointer;user-select:none}
.nav-item:hover{background:#1a1e26;color:#e6e9ef}
.nav-item.on{background:#1c2534;color:#fff;box-shadow:inset 2px 0 0 #4f8cff}
.navfoot{margin-top:16px;padding:10px 10px 0;border-top:1px solid #2a2f3a;color:#5c6474;font-size:11px;line-height:1.7}
/* ---- 主区 ---- */
main{margin-left:200px;padding:20px 24px 80px;max-width:1240px}
#err{display:none;position:sticky;top:0;z-index:9;margin-bottom:12px;padding:8px 12px;border:1px solid #6b2626;border-radius:8px;background:#2a1518;color:#ff9c95;font-size:12.5px}
.panel{display:none}
.panel.on{display:block}
.card{margin-bottom:14px;padding:16px 18px;border:1px solid #2a2f3a;border-radius:12px;background:#171a20}
.card h2{margin:0 0 2px;font-size:14px;letter-spacing:.2px}
.desc{margin:0 0 14px;color:#8b93a3;font-size:12.5px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}
.acts{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:14px}
/* ---- 通用件 ---- */
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.stat{padding:9px 12px;border:1px solid #2a2f3a;border-radius:9px;background:#12151b;min-width:0}
.stat .k{color:#8b93a3;font-size:11.5px}
.stat .v{margin-top:2px;font-size:16px;font-weight:600;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ok{color:#3fb950}.bad{color:#f85149}.acc{color:#4f8cff}.mut{color:#8b93a3}
button{font:inherit}
.btn{padding:7px 14px;border:1px solid #2f3542;border-radius:8px;background:#1d222b;color:#e6e9ef;font-size:13px;cursor:pointer}
.btn:hover{background:#252b36}
.btn.acc{background:#1b3a6b;border-color:#2b5a9e;color:#d6e4ff}
.btn.acc:hover{background:#21457c}
.btn.danger{background:#3a1a1a;border-color:#6b2626;color:#ffb4b0}
.btn.danger:hover{background:#481f1f}
input,select,textarea{font:inherit;font-size:13px;color:#e6e9ef;background:#12151b;border:1px solid #2a2f3a;border-radius:8px;padding:7px 10px;outline:none;min-width:0}
input:focus,select:focus,textarea:focus{border-color:#4f8cff}
input[type=checkbox]{padding:0;margin:0;accent-color:#4f8cff}
textarea{width:100%;font:12px/1.5 ui-monospace,Consolas,"Courier New",monospace;padding:10px;resize:vertical}
label.sw{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:#8b93a3;cursor:pointer;user-select:none}
.msg{font-size:12px;color:#8b93a3}
.msg.bad{color:#f85149}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;color:#8b93a3;margin-left:6px}
.empty{padding:14px 4px;color:#8b93a3;font-size:12.5px}
pre{margin:0;padding:10px 12px;border:1px solid #2a2f3a;border-radius:9px;background:#0c0e12;font:12px/1.6 ui-monospace,Consolas,monospace;overflow:auto;white-space:pre-wrap;word-break:break-word}
#log{max-height:660px;min-height:220px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
.chip{padding:4px 10px;border:1px solid #2a2f3a;border-radius:999px;background:#12151b;font-size:12px;color:#c9cfdb}
.chip b{color:#fff}
.tag{display:inline-block;padding:1px 7px;border-radius:999px;background:#1d2634;color:#9fc0ff;font-size:11px;border:1px solid #2b5a9e}
.imp{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;border:1px solid #2a2f3a;color:#8b93a3}
.imp2{color:#9fc0ff;border-color:#2b5a9e;background:#131d2c}
.imp3{color:#f0b64a;border-color:#6b4c14;background:#2a2110}
.imp4{color:#ff8a80;border-color:#6b2626;background:#2a1518}
/* ---- 表格 ---- */
.tw{overflow-x:auto}
.tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.tbl th,.tbl td{padding:7px 8px;border-bottom:1px solid #232833;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.tbl th:first-child,.tbl td:first-child{text-align:left;color:#8b93a3}
.tbl thead th{color:#8b93a3;font-weight:500;font-size:11.5px;border-bottom:1px solid #2a2f3a}
.tbl td.strong{color:#fff;font-weight:600}
/* ---- 条形图 ---- */
.bar-row{display:flex;align-items:center;gap:10px;margin:6px 0}
.bar-row .bl{flex:0 0 150px;font-size:12.5px;color:#c9cfdb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-row .bl i{margin-left:6px}
.bar-row .bt{flex:1;height:10px;border-radius:999px;background:#12151b;border:1px solid #2a2f3a;overflow:hidden;min-width:60px}
.bar-row .bf{display:block;height:100%;background:linear-gradient(90deg,#2b5a9e,#4f8cff)}
.bar-row .bv{flex:0 0 96px;text-align:right;font-size:12px;color:#9aa3b2;font-variant-numeric:tabular-nums}
/* ---- 会话 ---- */
.split{display:grid;grid-template-columns:290px 1fr;gap:12px;align-items:start}
.list{max-height:620px;overflow:auto;border:1px solid #2a2f3a;border-radius:10px;background:#12151b;padding:6px}
.ci{padding:8px 9px;border:1px solid transparent;border-radius:8px;cursor:pointer;margin-bottom:4px}
.ci:hover{background:#1a1f28}
.ci.on{background:#1c2534;border-color:#2b5a9e}
.ci-t{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ci-k{font:11px/1.4 ui-monospace,Consolas,monospace;color:#6f7787;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ci-l{margin:3px 0;font-size:12px;color:#8b93a3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ci-b{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:#6f7787}
.pend{color:#6f7787}
.pend.has{color:#ff9c95}
.stream{border:1px solid #2a2f3a;border-radius:10px;background:#12151b;padding:10px 12px;min-height:220px}
.st-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-bottom:8px;margin-bottom:6px;border-bottom:1px solid #232833;font-size:13px}
.st-head .mono{margin-left:0}
.st-head .mut{font-size:11.5px}
.st-body{max-height:540px;overflow:auto;padding:2px 2px 0}
.msg2{margin:8px 0;max-width:82%}
.msg2 .meta{font-size:11px;color:#6f7787;margin-bottom:2px}
.msg2 .bubble{padding:7px 11px;border-radius:11px;font-size:13px;white-space:pre-wrap;word-break:break-word;line-height:1.5;border:1px solid #2a2f3a;background:#1d222b}
.msg2.mine{margin-left:auto}
.msg2.mine .meta{text-align:right}
.msg2.mine .bubble{background:#1b3a6b;border-color:#2b5a9e;color:#eaf2ff}
/* ---- 记忆 ---- */
.items{max-height:520px;overflow:auto;margin-top:10px}
.mi{padding:9px 0;border-bottom:1px solid #232833}
.mi:last-child{border-bottom:0}
.mi-h{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:11.5px;margin-bottom:3px}
.mi-t{font-size:13px;color:#dbe0e8;white-space:pre-wrap;word-break:break-word}
/* ---- 目的 ---- */
.goal{padding:10px 0;border-bottom:1px solid #232833}
.goal:last-child{border-bottom:0}
.g1{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.gtext{font-size:13px;color:#e6e9ef;white-space:pre-wrap;word-break:break-word}
.g2{display:flex;gap:14px;flex-wrap:wrap;margin-top:4px;font-size:11.5px;color:#8b93a3}
.g2 b{color:#dbe0e8;font-weight:600}
/* ---- 表情 ---- */
#stgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;max-height:470px;overflow:auto;margin-top:6px}
.st{position:relative;padding:4px;border:1px solid #2a2f3a;border-radius:9px;background:#12151b;cursor:pointer}
.st:hover{border-color:#2b5a9e}
.st img{display:block;width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px;background:#1c2028}
.st .st-s{padding:3px 2px 1px;font-size:10.5px;color:#8b93a3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.st .anim{position:absolute;top:7px;left:7px;padding:0 5px;border-radius:5px;background:#2b5a9e;color:#fff;font-size:10px}
#stedit{margin-top:12px;border-top:1px solid #232833;padding-top:10px}
/* ---- 窄屏：侧边栏变顶部横条 ---- */
@media (max-width:760px){
  #nav{position:static;width:auto;height:auto;display:flex;align-items:center;gap:6px;overflow-x:auto;border-right:0;border-bottom:1px solid #2a2f3a;padding:8px;white-space:nowrap}
  .brand{display:none}
  .navfoot{display:none}
  .nav-item{margin:0;flex:0 0 auto}
  main{margin-left:0;padding:14px 14px 60px}
  .split{grid-template-columns:1fr}
  .bar-row .bl{flex:0 0 110px}
  .bar-row .bv{flex:0 0 72px}
}
</style>
</head>
<body>
<div id="nav">
  <div class="brand">QQ 桥 · 控制台<span>127.0.0.1 · 仅本机可访问</span></div>
  <div class="nav-item on" data-tab="overview">概览</div>
  <div class="nav-item" data-tab="chat">会话</div>
  <div class="nav-item" data-tab="token">Token</div>
  <div class="nav-item" data-tab="purpose">目的</div>
  <div class="nav-item" data-tab="memory">记忆</div>
  <div class="nav-item" data-tab="sticker">表情</div>
  <div class="nav-item" data-tab="log">日志</div>
  <div class="navfoot">急停立刻停止回复；重载只重读配置，不动进程。</div>
</div>

<main>
<div id="err"></div>

<!-- ================= 概览 ================= -->
<section class="panel on" id="p-overview">
  <div class="card">
    <h2>连接与状态</h2>
    <div class="desc">每 2 秒拉一次 /api/status，这里显示桥自己报告的实时值。</div>
    <div class="stats" id="ov-stats"></div>
    <div class="acts">
      <button class="btn danger" id="btn-pause">急停（停止回复）</button>
      <button class="btn acc" id="btn-resume">恢复</button>
      <button class="btn" id="btn-reload">重载配置</button>
      <span class="msg" id="ov-msg"></span>
    </div>
  </div>
  <div class="card">
    <h2>今日 Token</h2>
    <div class="desc">/api/usage/summary?days=7 的 today 段；合计 = 新读 + 缓存 + 输出。</div>
    <div class="stats" id="ov-token"></div>
    <div class="row"><span class="msg" id="ov-balance"><span class="mut">账户余额读取中…</span></span></div>
  </div>
  <div class="card">
    <h2>会话待处理</h2>
    <div class="desc">status.chats 里 pending 大于 0 的会话。</div>
    <div class="chips" id="ov-chats"></div>
  </div>
</section>

<!-- ================= 会话 ================= -->
<section class="panel" id="p-chat">
  <div class="card">
    <h2>会话消息流</h2>
    <div class="desc">左边按会话列表点一条，右边看最近 100 条；列表和消息每 5 秒自动刷新。</div>
    <div class="row">
      <input id="chat-q" placeholder="过滤会话：标题 / key" style="flex:1;min-width:160px">
      <label class="sw"><input type="checkbox" id="chat-pause"> 暂停刷新</label>
      <button class="btn" id="chat-reload">立即刷新</button>
      <span class="msg" id="chat-msg"></span>
    </div>
    <div class="split">
      <div class="list" id="chat-list"><div class="empty">加载中…</div></div>
      <div class="stream" id="chat-stream"><div class="empty">左边选一个会话</div></div>
    </div>
  </div>
</section>

<!-- ================= Token ================= -->
<section class="panel" id="p-token">
  <div class="card">
    <h2>用量</h2>
    <div class="desc">/api/usage/summary?days=7。单位 token，今日与近 7 天两行。</div>
    <div id="tk-nums"><div class="empty">加载中…</div></div>
  </div>
  <div class="card">
    <h2>按天分布</h2>
    <div class="desc">横向条长度 = 当天合计 / 区间最大值。</div>
    <div id="tk-bars"><div class="empty">加载中…</div></div>
  </div>
  <div class="card">
    <h2>按会话排行</h2>
    <div class="desc">按合计 token 从高到低。</div>
    <div id="tk-chats"><div class="empty">加载中…</div></div>
  </div>
</section>

<!-- ================= 目的 ================= -->
<section class="panel" id="p-purpose">
  <div class="card">
    <h2>九维驱动</h2>
    <div class="desc">每根条 0–1，来自 /api/purpose/state 的 drives。</div>
    <div id="pu-drives"><div class="empty">加载中…</div></div>
  </div>
  <div class="card">
    <h2>目标</h2>
    <div class="desc">按 value × 0.6 + urgency × 0.4 从高到低排。</div>
    <div id="pu-goals"><div class="empty">加载中…</div></div>
  </div>
  <div class="card">
    <h2>开口节奏</h2>
    <div class="desc">下次开口时间、今日已开口次数、静音状态。</div>
    <div class="stats" id="pu-meta"></div>
  </div>
</section>

<!-- ================= 记忆 ================= -->
<section class="panel" id="p-memory">
  <div class="card">
    <h2>记忆结构</h2>
    <div class="desc">/api/memory/struct?grep=：先给每个 scope 的条数与字符数，再列条目。</div>
    <div class="row">
      <input id="ms-q" placeholder="过滤记忆条目…" style="flex:1;min-width:180px">
      <button class="btn" id="ms-go">搜索</button>
      <span class="msg" id="ms-total"></span>
    </div>
    <div class="chips" id="ms-scopes"></div>
    <div class="items" id="ms-items"><div class="empty">加载中…</div></div>
  </div>
  <div class="card">
    <h2>文件编辑</h2>
    <div class="desc">直接改硬盘上的记忆文件；保存前自动备份，下一轮注入生效。</div>
    <div class="row">
      <select id="memfile" style="flex:1;min-width:200px;max-width:420px"></select>
      <button class="btn" id="memopen">打开</button>
      <input id="memq" placeholder="全文搜索…" style="flex:1;min-width:120px">
      <button class="btn" id="memsearch">搜</button>
    </div>
    <textarea id="memtext" spellcheck="false" style="height:240px"></textarea>
    <div class="row">
      <button class="btn acc" id="memsave">保存</button>
      <span class="msg" id="memmsg">改之前会自动备份</span>
    </div>
    <pre id="memhits" style="display:none"></pre>
  </div>
</section>

<!-- ================= 表情 ================= -->
<section class="panel" id="p-sticker">
  <div class="card">
    <h2>表情库</h2>
    <div class="desc">点一张编辑摘要 / 分类 / 用途；保存与删除都直接落到库里。</div>
    <div class="row">
      <input id="stq" placeholder="搜摘要 / 分类 / 用途…" style="flex:1;min-width:150px">
      <button class="btn" id="stgo">搜索</button>
      <label class="sw"><input type="checkbox" id="st-anim"> 只看动图</label>
      <span class="msg" id="stcount">—</span>
    </div>
    <div id="stgrid"></div>
    <div id="stedit" style="display:none">
      <div class="row"><label class="sw" style="flex:0 0 60px">摘要</label><input id="stsum" style="flex:1;min-width:200px"></div>
      <div class="row">
        <label class="sw" style="flex:0 0 60px">分类</label><input id="sttag" style="width:140px">
        <label class="sw" style="flex:0 0 60px">用途</label><input id="stuse" placeholder="逗号分隔，如 看戏,接梗" style="flex:1;min-width:160px">
      </div>
      <div class="row">
        <button class="btn acc" id="stsave">保存</button>
        <button class="btn danger" id="stdel">删除</button>
        <span class="msg" id="stmsg"></span>
      </div>
    </div>
  </div>
</section>

<!-- ================= 日志 ================= -->
<section class="panel" id="p-log">
  <div class="card">
    <h2>运行日志</h2>
    <div class="desc">status.logs 的末尾，只读，新内容自动滚到底。</div>
    <pre id="log">加载中…</pre>
  </div>
</section>
</main>

<script>
'use strict';
/* ================= 基础工具 ================= */
function $(id){ return document.getElementById(id); }

function esc(v){
  if (v === null || v === undefined) return '';
  return String(v).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;')
    .split('"').join('&quot;').split("'").join('&#39;');
}
function fmt(n){
  let v = Math.round(Number(n));
  if (!isFinite(v)) v = 0;
  const neg = v < 0;
  if (neg) v = -v;
  const s = String(v);
  let out = '';
  for (let i = s.length - 1, c = 0; i >= 0; i--, c++){
    if (c > 0 && c % 3 === 0) out = ',' + out;
    out = s.charAt(i) + out;
  }
  return (neg ? '-' : '') + out;
}
function p2(n){ return (n < 10 ? '0' : '') + n; }
function ts(t){
  if (t === null || t === undefined || t === '') return '—';
  const d = (t instanceof Date) ? t : new Date(t);
  if (!d || isNaN(d.getTime())) return String(t);
  const now = new Date();
  const hm = p2(d.getHours()) + ':' + p2(d.getMinutes());
  if (d.toDateString() === now.toDateString()) return hm;
  const md = p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  if (d.getFullYear() === now.getFullYear()) return md + ' ' + hm;
  return d.getFullYear() + '-' + md + ' ' + hm;
}
function num2(v){ const n = Number(v); return isFinite(n) ? n.toFixed(2) : '—'; }
function short(s, n){
  const x = (s === null || s === undefined) ? '' : String(s);
  return x.length > n ? x.slice(0, n) + '…' : x;
}
function stat(k, v, cls){
  return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v ' + (cls || '') + '">' + esc(v) + '</div></div>';
}
function setMsg(id, text, bad){
  const el = $(id);
  if (!el) return;
  el.textContent = text || '';
  el.className = 'msg' + (bad ? ' bad' : '');
}

/* ---- 错误条：任何 fetch 失败都往这里写一行红字，不静默吞 ---- */
let errTimer = 0;
function showErr(msg){
  const el = $('err');
  if (!el) return;
  el.textContent = '⚠ ' + msg;
  el.style.display = 'block';
  if (errTimer) clearTimeout(errTimer);
  errTimer = setTimeout(function(){ el.style.display = 'none'; }, 15000);
}
async function req(url, opts, quiet){
  let r;
  try { r = await fetch(url, opts); }
  catch (e) {
    showErr('请求失败 ' + String(url).split('?')[0] + ' — ' + (e && e.message ? e.message : '网络错误'));
    return null;
  }
  let txt = '';
  try { txt = await r.text(); } catch (e) { txt = ''; }
  let j = null;
  if (txt) { try { j = JSON.parse(txt); } catch (e) { j = null; } }
  if (!r.ok){
    showErr(String(url).split('?')[0] + ' → HTTP ' + r.status +
      (j && j.error ? ' · ' + j.error : (txt ? ' · ' + short(txt, 120) : '')));
    return j;
  }
  if (j && j.error && !quiet) showErr(String(url).split('?')[0] + ' → ' + j.error);
  return j;
}
function jget(url, quiet){ return req(url, undefined, quiet); }
function jpost(url, body, quiet){
  const opts = { method: 'POST' };
  if (body !== undefined && body !== null){
    opts.headers = { 'content-type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  return req(url, opts, quiet);
}

/* ================= 标签页 ================= */
const TABS = ['overview', 'chat', 'token', 'purpose', 'memory', 'sticker', 'log'];
let tab = 'overview';
function switchTab(name){
  tab = name;
  if (location.hash.slice(1) !== name) location.hash = name;
  TABS.forEach(function(k){
    const p = $('p-' + k);
    if (p) p.className = 'panel' + (k === name ? ' on' : '');
  });
  document.querySelectorAll('.nav-item').forEach(function(el){
    el.className = 'nav-item' + (el.getAttribute('data-tab') === name ? ' on' : '');
  });
  if (name === 'overview'){ refreshStatus(); refreshUsage(); refreshBalance(); }
  else if (name === 'chat') chatListLoad();
  else if (name === 'token') refreshUsage();
  else if (name === 'purpose') purposeLoad();
  else if (name === 'memory'){ structLoad(); if (!memList.length) memRefresh(); }
  else if (name === 'sticker') stLoad();
  else if (name === 'log') refreshStatus();
}
document.querySelectorAll('.nav-item').forEach(function(el){
  el.onclick = function(){ switchTab(el.getAttribute('data-tab')); };
});

/* ================= 状态 / 概览 / 日志 ================= */
let lastStatus = null;
let lastLog = '';

function renderOverview(s){
  const st = s.stats || {};
  $('ov-stats').innerHTML =
    stat('SnowLuma 连接', s.connected ? '已连接' : '未连接', s.connected ? 'ok' : 'bad') +
    stat('账号', s.self ? ((s.self.nickname || '—') + ' (' + (s.self.user_id || '') + ')') : '—') +
    stat('回复状态', s.paused ? '已急停' : '正常', s.paused ? 'bad' : 'ok') +
    stat('忙碌', fmt(s.busy) + ' / ' + fmt(s.maxConcurrent)) +
    stat('收到', fmt(st.received)) +
    stat('回复', fmt(st.replied)) +
    stat('跳过', fmt(st.skipped)) +
    stat('失败', fmt(st.failed), Number(st.failed) > 0 ? 'bad' : '');
  renderOverviewChats(s);
  syncPending(s);
}

function renderOverviewChats(s){
  const rows = (s.chats || []).filter(function(c){ return Number(c.pending || 0) > 0; });
  $('ov-chats').innerHTML = rows.length ? rows.map(function(c){
    return '<span class="chip">' + esc(c.key) + ' · <b>' + fmt(c.pending) + '</b> 待处理</span>';
  }).join('') : '<span class="mut">没有积压</span>';
}

function renderLogs(logs){
  const el = $('log');
  if (!el) return;
  const txt = (logs || []).join('\\n');
  if (txt === lastLog) return;
  lastLog = txt;
  el.textContent = txt || '（暂无日志）';
  el.scrollTop = el.scrollHeight;
}

async function refreshStatus(){
  const s = await jget('/api/status');
  if (!s) return;
  lastStatus = s;
  renderOverview(s);
  renderLogs(s.logs || []);
}

async function refreshBalance(){
  const b = await jget('/api/balance', true);
  const el = $('ov-balance');
  if (!el) return;
  if (!b || b.error || b.balance === undefined || b.balance === null){
    el.innerHTML = '<span class="mut">余额：' + esc(b && b.error ? b.error : '不可用') + '</span>';
    return;
  }
  el.innerHTML = '<span class="mut">账户余额</span> <b>' + esc(String(b.balance)) + ' ' + esc(b.currency || '') + '</b>';
}

/* ================= 会话 ================= */
let chatCache = [];
let chatKey = null;
let streamSig = '';

async function chatListLoad(){
  const r = await jget('/api/chat/list');
  if (r && r.chats){
    chatCache = r.chats;
    chatListRender();
    setMsg('chat-msg', '共 ' + fmt(chatCache.length) + ' 个会话 · 更新于 ' + ts(Date.now()), false);
  }
  if (chatKey) await chatMsgsLoad(chatKey);
}

function syncPending(s){
  const map = {};
  (s.chats || []).forEach(function(c){ map[c.key] = Number(c.pending || 0); });
  document.querySelectorAll('#chat-list [data-pend]').forEach(function(el){
    const n = map[el.getAttribute('data-pend')] || 0;
    el.textContent = n ? ('· ' + n + ' 待处理') : '';
    el.className = 'pend' + (n ? ' has' : '');
  });
}

function chatListRender(){
  const q = String($('chat-q').value || '').trim().toLowerCase();
  const pend = {};
  if (lastStatus) (lastStatus.chats || []).forEach(function(c){ pend[c.key] = Number(c.pending || 0); });
  const rows = chatCache.filter(function(c){
    if (!q) return true;
    const t = String(c.title || '').toLowerCase();
    const k = String(c.key || '').toLowerCase();
    return t.indexOf(q) >= 0 || k.indexOf(q) >= 0;
  });
  $('chat-list').innerHTML = rows.map(function(c){
    const n = pend[c.key] || 0;
    return '<div class="ci' + (c.key === chatKey ? ' on' : '') + '" data-key="' + esc(c.key) + '">' +
      '<div class="ci-t">' + esc(c.title || c.key) + '</div>' +
      '<div class="ci-k">' + esc(c.key) + '</div>' +
      '<div class="ci-l">' + esc(short(c.lastText || '', 36)) + '</div>' +
      '<div class="ci-b"><span>' + esc(ts(c.lastAt || c.mtime)) + '</span>' +
      '<span class="pend' + (n ? ' has' : '') + '" data-pend="' + esc(c.key) + '">' + (n ? ('· ' + n + ' 待处理') : '') + '</span></div>' +
      '</div>';
  }).join('') || '<div class="empty">' + (q ? '没有匹配的会话' : '没有会话') + '</div>';
  document.querySelectorAll('#chat-list .ci').forEach(function(el){
    el.onclick = function(){ chatOpen(el.getAttribute('data-key')); };
  });
}

async function chatOpen(key){
  chatKey = key;
  streamSig = '';
  chatListRender();
  await chatMsgsLoad(key);
}

async function chatMsgsLoad(key){
  if (!key) return;
  const r = await jget('/api/chat/messages?key=' + encodeURIComponent(key) + '&limit=100');
  if (!r) return;
  if (r.key && r.key !== chatKey) return;
  renderStream(r);
}

function renderStream(r){
  const rows = r.rows || [];
  const last = rows.length ? rows[rows.length - 1] : null;
  const sig = String(r.key || '') + '|' + rows.length + '|' + (last ? String(last.t) + String(last.text) : '');
  if (sig === streamSig) return;
  streamSig = sig;
  const head = '<div class="st-head"><b>' + esc(r.title || r.key || '') + '</b>' +
    '<span class="mono">' + esc(r.key || '') + '</span>' +
    '<span class="mut">' + fmt(rows.length) + ' 条</span></div>';
  const body = rows.map(function(m){
    const mine = !!m.mine;
    return '<div class="msg2 ' + (mine ? 'mine' : 'them') + '">' +
      '<div class="meta">' + esc(m.name || (mine ? '我' : String(m.uid || ''))) + ' · ' + esc(ts(m.t)) + '</div>' +
      '<div class="bubble">' + esc(m.text || '') + '</div></div>';
  }).join('');
  $('chat-stream').innerHTML = head + '<div class="st-body">' + (body || '<div class="empty">没有消息</div>') + '</div>';
  const b = $('chat-stream').querySelector('.st-body');
  if (b) b.scrollTop = b.scrollHeight;
}

/* ================= Token / 用量 ================= */
let usage = null;

function sumDays(days){
  const o = { turns: 0, tin: 0, tcache: 0, tout: 0, total: 0, ms: 0 };
  (days || []).forEach(function(d){
    o.turns += Number(d.turns || 0);
    o.tin += Number(d.in || 0);
    o.tcache += Number(d.cache || 0);
    o.tout += Number(d.out || 0);
    o.total += Number(d.total || 0);
    o.ms += Number(d.elapsedMs || 0);
  });
  return o;
}

function usageRow(label, t){
  return '<tr><th>' + esc(label) + '</th><td>' + fmt(t.tin) + '</td><td>' + fmt(t.tcache) +
    '</td><td>' + fmt(t.tout) + '</td><td class="strong">' + fmt(t.total) + '</td><td>' + fmt(t.turns) + '</td></tr>';
}

function renderUsage(){
  if (!usage) return;
  const days = (usage.days || []).slice().sort(function(a, b){
    return String(a.date || '').localeCompare(String(b.date || ''));
  });
  const today = usage.today || {};
  const week = sumDays(days.length ? days : [today]);
  const tObj = {
    tin: Number(today.in || 0), tcache: Number(today.cache || 0), tout: Number(today.out || 0),
    total: Number(today.total || 0), turns: Number(today.turns || 0)
  };
  $('tk-nums').innerHTML = '<div class="tw"><table class="tbl"><thead><tr><th>区间</th><th>新读</th><th>缓存</th><th>输出</th><th>合计</th><th>轮次</th></tr></thead><tbody>' +
    usageRow('今日 ' + (today.date || ''), tObj) +
    usageRow('近 7 天', week) +
    '</tbody></table></div>';

  const max = Math.max.apply(null, days.map(function(d){ return Number(d.total || 0); }).concat([1]));
  $('tk-bars').innerHTML = days.map(function(d){
    const v = Number(d.total || 0);
    const w = Math.max(v > 0 ? 3 : 0, Math.round(v / max * 100));
    return '<div class="bar-row"><span class="bl">' + esc(d.date || '') + '</span>' +
      '<span class="bt"><span class="bf" style="width:' + w + '%"></span></span>' +
      '<span class="bv">' + fmt(v) + '</span></div>';
  }).join('') || '<div class="empty">没有按天的数据</div>';

  const bc = (usage.byChat || []).slice().sort(function(a, b){
    return Number(b.total || 0) - Number(a.total || 0);
  });
  $('tk-chats').innerHTML = bc.length
    ? '<div class="tw"><table class="tbl"><thead><tr><th>会话</th><th>轮次</th><th>合计</th></tr></thead><tbody>' +
      bc.map(function(c){
        return '<tr><td>' + esc(c.title || c.chat || '') + '<span class="mono">' + esc(c.chat || '') + '</span></td>' +
          '<td>' + fmt(c.turns) + '</td><td class="strong">' + fmt(c.total) + '</td></tr>';
      }).join('') + '</tbody></table></div>'
    : '<div class="empty">没有按会话的数据</div>';
}

function renderOverviewTokens(){
  if (!usage) return;
  const t = usage.today || {};
  $('ov-token').innerHTML =
    stat('今日新读', fmt(t.in)) +
    stat('今日缓存', fmt(t.cache)) +
    stat('今日输出', fmt(t.out)) +
    stat('今日合计', fmt(t.total), 'acc') +
    stat('今日轮次', fmt(t.turns));
}

async function refreshUsage(){
  const u = await jget('/api/usage/summary?days=7');
  if (!u) return;
  usage = u;
  renderUsage();
  renderOverviewTokens();
}

/* ================= 目的 ================= */
const DRIVES = [
  ['play', '玩 / 摸鱼'],
  ['install', '装东西'],
  ['learn', '学习'],
  ['connect', '连接'],
  ['care', '照顾'],
  ['share', '分享'],
  ['identity', '自我'],
  ['create', '创作'],
  ['consume', '消费']
];
let purpose = null;

function renderPurpose(){
  const p = purpose;
  if (!p) return;
  const d = p.drives || {};
  $('pu-drives').innerHTML = DRIVES.map(function(it){
    const raw = Number(d[it[0]] || 0);
    const v = Math.max(0, Math.min(1, isFinite(raw) ? raw : 0));
    return '<div class="bar-row"><span class="bl">' + esc(it[1]) + '<i class="mono">' + esc(it[0]) + '</i></span>' +
      '<span class="bt"><span class="bf" style="width:' + Math.round(v * 100) + '%"></span></span>' +
      '<span class="bv">' + v.toFixed(2) + '</span></div>';
  }).join('');

  const goals = (p.goals || []).slice().sort(function(a, b){
    const sa = Number(a.value || 0) * 0.6 + Number(a.urgency || 0) * 0.4;
    const sb = Number(b.value || 0) * 0.6 + Number(b.urgency || 0) * 0.4;
    return sb - sa;
  });
  $('pu-goals').innerHTML = goals.length ? goals.map(function(g){
    return '<div class="goal">' +
      '<div class="g1"><span class="tag">' + esc(g.kind || '?') + '</span>' +
      '<span class="gtext">' + esc(g.text || '') + '</span></div>' +
      '<div class="g2">' +
      '<span>置信 <b>' + num2(g.confidence) + '</b></span>' +
      '<span>紧迫 <b>' + num2(g.urgency) + '</b></span>' +
      '<span>价值 <b>' + num2(g.value) + '</b></span>' +
      '<span>风险 <b>' + num2(g.risk) + '</b></span>' +
      '<span>尝试 <b>' + fmt(g.attempts) + '</b></span>' +
      '<span class="mut">' + esc(ts(g.updatedAt)) + '</span>' +
      '</div></div>';
  }).join('') : '<div class="empty">没有目标</div>';

  const muted = Number(p.mutedUntil || 0) > Date.now();
  $('pu-meta').innerHTML =
    stat('下次开口', p.nextFireAt ? ts(p.nextFireAt) : '—') +
    stat('今日已开口', fmt(p.todayCount)) +
    stat('静音', muted ? ('至 ' + ts(p.mutedUntil)) : '未静音', muted ? 'bad' : 'ok') +
    stat('模式', p.mode || '—') +
    stat('状态更新', ts(p.updatedAt));
}

async function purposeLoad(){
  const p = await jget('/api/purpose/state');
  if (!p) return;
  purpose = p;
  renderPurpose();
}

/* ================= 记忆结构 ================= */
async function structLoad(){
  const q = encodeURIComponent(String($('ms-q').value || '').trim());
  const r = await jget('/api/memory/struct?grep=' + q);
  if (!r) return;
  renderStruct(r);
}

function renderStruct(r){
  const scopes = r.scopes || [];
  const items = r.items || [];
  $('ms-total').textContent = '共 ' + fmt(r.total) + ' 条 / ' + fmt(r.chars) + ' 字符';
  $('ms-scopes').innerHTML = scopes.map(function(s){
    return '<span class="chip">' + esc(s.scope || '?') + ' <b>' + fmt(s.count) + '</b> 条 · ' +
      fmt(s.chars) + ' 字</span>';
  }).join('') || '<span class="mut">没有 scope 统计</span>';
  $('ms-items').innerHTML = items.map(function(it){
    const imp = Math.max(0, Math.min(9, Number(it.importance || 0)));
    const cls = imp >= 4 ? 'imp4' : (imp === 3 ? 'imp3' : (imp === 2 ? 'imp2' : 'imp'));
    return '<div class="mi"><div class="mi-h"><span class="tag">' + esc(it.scope || '?') + '</span>' +
      '<span class="imp ' + cls + '">重要度 ' + esc(imp) + '</span>' +
      '<span class="mut">' + esc(ts(it.t)) + '</span></div>' +
      '<div class="mi-t">' + esc(it.text || '') + '</div></div>';
  }).join('') || '<div class="empty">没有条目</div>';
}

/* ================= 记忆文件编辑 ================= */
let memList = [];
let memOpenRel = null;

async function memRefresh(){
  const r = await jget('/api/memory/list');
  if (!r) return;
  memList = r.files || [];
  $('memfile').innerHTML = memList.map(function(f, i){
    return '<option value="' + i + '">' + esc(f.group) + ' / ' + esc(f.rel) + '</option>';
  }).join('') || '<option value="">（没有文件）</option>';
}

async function memOpen(){
  const f = memList[Number($('memfile').value || 0)];
  if (!f) return;
  const r = await jget('/api/memory/read?rel=' + encodeURIComponent(f.rel));
  if (!r) return;
  if (r.error){
    setMsg('memmsg', '读取失败：' + r.error, true);
    $('memtext').value = '';
    memOpenRel = null;
    return;
  }
  $('memtext').value = r.text || '';
  memOpenRel = f.rel;
  setMsg('memmsg', '已打开 ' + (r.rel || f.rel) + '（' + fmt((r.text || '').length) + ' 字符）', false);
  $('memhits').style.display = 'none';
}

async function memSave(){
  const f = memList[Number($('memfile').value || 0)];
  if (!f) return;
  if (memOpenRel !== f.rel){ setMsg('memmsg', '先点「打开」再保存', true); return; }
  setMsg('memmsg', '保存中…', false);
  const r = await jpost('/api/memory/write', { rel: f.rel, text: $('memtext').value });
  if (!r) return;
  if (r.error){ setMsg('memmsg', '保存失败：' + r.error, true); return; }
  setMsg('memmsg', '已保存 ' + (r.rel || f.rel) + '，备份 ' + (r.backup || '已生成'), false);
  memRefresh();
}

async function memSearch(){
  const q = String($('memq').value || '').trim();
  if (!q) return;
  const r = await jget('/api/memory/search?q=' + encodeURIComponent(q));
  if (!r) return;
  const hits = r.hits || [];
  const el = $('memhits');
  el.style.display = 'block';
  el.textContent = hits.length ? hits.map(function(h){
    return (h.group || '') + '/' + (h.rel || '') + ':' + (h.line || '') + '  ' + (h.text || '');
  }).join('\\n') : '（没搜到）';
}

/* ================= 表情库 ================= */
let stRows = [];
let stCur = null;
let stTotal = 0;
let stAll = 0;

async function stLoad(){
  const q = encodeURIComponent(String($('stq').value || '').trim());
  const r = await jget('/api/stickers?limit=200&offset=0&grep=' + q);
  if (!r) return;
  stRows = r.rows || [];
  stTotal = Number(r.total || 0);
  stAll = Number(r.totalAll || 0);
  stRender();
}

function stRender(){
  const onlyAnim = $('st-anim').checked;
  const rows = onlyAnim ? stRows.filter(function(x){ return !!x.animated; }) : stRows;
  $('stcount').textContent = rows.length + ' 张显示 / 匹配 ' + fmt(stTotal) + ' / 共 ' + fmt(stAll);
  $('stgrid').innerHTML = rows.map(function(x){
    return '<div class="st" data-i="' + esc(x.i) + '" title="' + esc(x.summary || '') + '">' +
      '<img src="/api/stickers/img?i=' + encodeURIComponent(String(x.i)) + '" loading="lazy" alt="">' +
      (x.animated ? '<span class="anim">动</span>' : '') +
      '<div class="st-s">' + esc(x.summary || x.tag || ('#' + x.i)) + '</div></div>';
  }).join('') || '<div class="empty">没有匹配的表情' + (onlyAnim ? '（只看动图）' : '') + '</div>';
  document.querySelectorAll('#stgrid .st').forEach(function(el){
    el.onclick = function(){ stPick(Number(el.getAttribute('data-i'))); };
  });
}

function stPick(i){
  const hit = stRows.filter(function(r){ return Number(r.i) === i; });
  if (!hit.length) return;
  const x = hit[0];
  stCur = x;
  $('stedit').style.display = 'block';
  $('stsum').value = x.summary || '';
  $('sttag').value = x.tag || '';
  $('stuse').value = (x.use || []).join(',');
  setMsg('stmsg', '#' + x.i + ' · ' + (x.digest || '') + (x.animated ? ' · 动图' : ''), false);
}

async function stSave(){
  if (!stCur) return;
  setMsg('stmsg', '保存中…', false);
  const r = await jpost('/api/stickers/update', {
    i: stCur.i, summary: $('stsum').value, tag: $('sttag').value, use: $('stuse').value
  });
  if (!r) return;
  if (r.error){ setMsg('stmsg', '出错：' + r.error, true); return; }
  setMsg('stmsg', '已保存', false);
  stLoad();
}

async function stDel(){
  if (!stCur) return;
  if (!confirm('删掉这张？会进回收站，能拉回来。')) return;
  const r = await jpost('/api/stickers/del', { i: stCur.i });
  if (!r) return;
  if (r.error){ setMsg('stmsg', '出错：' + r.error, true); return; }
  setMsg('stmsg', '已移入回收站', false);
  $('stedit').style.display = 'none';
  stCur = null;
  stLoad();
}

/* ================= 事件绑定 ================= */
async function act(path, okText, msgId){
  setMsg(msgId, '执行中…', false);
  const r = await jpost(path);
  if (r && r.ok) setMsg(msgId, okText, false);
  else if (r && r.error) setMsg(msgId, '失败：' + r.error, true);
  refreshStatus();
}

$('btn-pause').onclick = function(){ act('/api/pause', '已急停，桥不再回复', 'ov-msg'); };
$('btn-resume').onclick = function(){ act('/api/resume', '已恢复回复', 'ov-msg'); };
$('btn-reload').onclick = function(){ act('/api/reload', '配置已重载', 'ov-msg'); };

$('chat-q').oninput = chatListRender;
$('chat-reload').onclick = chatListLoad;

$('ms-go').onclick = structLoad;
$('ms-q').onkeydown = function(e){ if (e.key === 'Enter') structLoad(); };

$('memfile').onchange = memOpen;
$('memopen').onclick = memOpen;
$('memsave').onclick = memSave;
$('memsearch').onclick = memSearch;
$('memq').onkeydown = function(e){ if (e.key === 'Enter') memSearch(); };

$('stgo').onclick = stLoad;
$('stq').onkeydown = function(e){ if (e.key === 'Enter') stLoad(); };
$('st-anim').onchange = stRender;
$('stsave').onclick = stSave;
$('stdel').onclick = stDel;

/* ================= 启动与轮询 ================= */
switchTab(location.hash.slice(1) || 'overview');
window.addEventListener('hashchange', function(){ switchTab(location.hash.slice(1) || 'overview'); });
setInterval(refreshStatus, 2000);
setInterval(function(){
  if (tab === 'chat' && !$('chat-pause').checked) chatListLoad();
}, 5000);
setInterval(refreshUsage, 30000);
setInterval(refreshBalance, 60000);
setInterval(function(){ if (tab === 'purpose') purposeLoad(); }, 15000);
setInterval(function(){
  if (tab === 'memory' && document.activeElement !== $('ms-q')) structLoad();
}, 30000);
</script>
</body>
</html>`;
