import http from 'node:http';
import { log } from './util.mjs';

const PAGE = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<title>QQ 桥 · 控制台</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{color-scheme:light dark}
  body{font:15px/1.6 system-ui,"Segoe UI",sans-serif;max-width:760px;margin:40px auto;padding:0 20px}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:#888;font-size:13px;margin-bottom:24px}
  .card{border:1px solid #8884;border-radius:10px;padding:16px;margin-bottom:14px}
  .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:6px 0}
  label{color:#888;min-width:76px;font-size:13px}
  code{background:#8882;padding:1px 6px;border-radius:4px}
  button{font:inherit;padding:7px 16px;border-radius:8px;border:1px solid #8886;background:#8881;cursor:pointer}
  button:hover{background:#8883}
  button.danger{color:#c22;border-color:#c228}
  #state{font-weight:600}
  .ok{color:#1a7f37}.bad{color:#c22}
  pre{background:#8881;padding:10px;border-radius:8px;overflow:auto;font-size:12px;max-height:260px}
</style>
<h1>QQ 桥 · 控制台</h1>
<div class="sub">本地桥接进程状态。这个页面只监听 127.0.0.1，别人碰不到。</div>

<div class="card">
  <div class="row"><label>NapCat</label><span id="link">—</span></div>
  <div class="row"><label>当前状态</label><span id="state">—</span></div>
  <div class="row"><label>账号</label><span id="self">—</span></div>
  <div class="row"><label>忙碌</label><span id="busy">—</span></div>
  <div class="row"><label>统计</label><span id="stats">—</span></div>
  <div class="row"><label>Token</label><span id="tokens">—</span></div>
  <div class="row" style="margin-top:14px">
    <button id="pause" class="danger">急停（停止回复）</button>
    <button id="resume">恢复</button>
    <button id="reload">重载配置</button>
  </div>
</div>

<div class="card">
  <div class="row"><label>会话</label><span id="chats" style="font-size:13px">—</span></div>
</div>

<div class="card">
  <div class="row"><label>记忆</label>
    <select id="memfile" style="max-width:320px"></select>
    <button id="memopen">打开</button>
    <input id="memq" placeholder="搜索记忆…" style="flex:1;min-width:120px">
    <button id="memsearch">搜</button>
  </div>
  <textarea id="memtext" spellcheck="false" style="width:100%;height:220px;font:12px/1.5 ui-monospace,Consolas,monospace;background:#8881;border:1px solid #8886;border-radius:8px;padding:8px"></textarea>
  <div class="row">
    <button id="memsave">保存</button>
    <span id="memmsg" style="font-size:12px;color:#888">改之前会自动备份</span>
  </div>
  <pre id="memhits" style="display:none"></pre>
</div>

<div class="card">
  <div class="row"><label>最近日志</label></div>
  <pre id="log">—</pre>
</div>

<script>
const $ = (id) => document.getElementById(id);
const post = (p) => fetch(p, { method: 'POST' }).then(r => r.json());
async function tick() {
  try {
    const s = await (await fetch('/api/status')).json();
    $('link').innerHTML = s.connected ? '<span class="ok">已连接</span>' : '<span class="bad">未连接</span>';
    $('state').innerHTML = s.paused ? '<span class="bad">已急停</span>' : '<span class="ok">正常回复</span>';
    $('self').textContent = s.self ? s.self.nickname + ' (' + s.self.user_id + ')' : '—';
    $('busy').textContent = s.busy + ' / ' + s.maxConcurrent;
    $('stats').textContent = '收到 ' + s.stats.received + ' · 回复 ' + s.stats.replied + ' · 跳过 ' + s.stats.skipped + ' · 失败 ' + s.stats.failed;
    const st = s.stats || {};
    $('tokens').textContent = st.turns
      ? ('新读 ' + st.tokensIn + ' · 缓存 ' + st.tokensCache + ' · 输出 ' + st.tokensOut + ' · ' + st.turns + ' 轮 · 每轮 ' + Math.round((st.tokensIn + st.tokensCache + st.tokensOut) / st.turns))
      : '—';
    $('chats').textContent = s.chats.map(c => c.key + ' (' + c.pending + '待处理)').join(' · ') || '—';
    $('log').textContent = s.logs.slice(-14).join('\\n');
  } catch (e) { $('state').textContent = '桥接进程未响应'; }
}
// ---- 记忆 ----
let memList = [];
async function memRefresh() {
  const r = await (await fetch('/api/memory/list')).json();
  memList = r.files || [];
  $('memfile').innerHTML = memList.map(f => '<option value="' + f.id + '|' + f.rel + '">' + f.group + ' / ' + f.rel + '</option>').join('') || '<option>（没有文件）</option>';
}
async function memOpen() {
  const v = $('memfile').value || '';
  const rel = v.split('|')[1];
  if (!rel) return;
  const r = await (await fetch('/api/memory/read?rel=' + encodeURIComponent(rel))).json();
  $('memtext').value = r.error ? ('读取失败：' + r.error) : r.text;
  $('memmsg').textContent = r.error ? r.error : ('已打开 ' + r.rel);
  $('memhits').style.display = 'none';
}
$('memopen').onclick = memOpen;
$('memfile').onchange = memOpen;
$('memsave').onclick = async () => {
  const rel = ($('memfile').value || '').split('|')[1];
  if (!rel) return;
  const r = await (await fetch('/api/memory/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rel, text: $('memtext').value }) })).json();
  $('memmsg').textContent = r.error ? ('保存失败：' + r.error) : ('已保存 ' + r.rel + '，备份 ' + r.backup);
  memRefresh();
};
$('memsearch').onclick = async () => {
  const q = $('memq').value.trim();
  if (!q) return;
  const r = await (await fetch('/api/memory/search?q=' + encodeURIComponent(q))).json();
  const hits = r.hits || [];
  $('memhits').style.display = 'block';
  $('memhits').textContent = hits.length
    ? hits.map(h => h.group + '/' + h.rel + ':' + h.line + '  ' + h.text).join('\n')
    : '（没搜到）';
};
memRefresh();

$('pause').onclick = () => post('/api/pause').then(tick);
$('resume').onclick = () => post('/api/resume').then(tick);
$('reload').onclick = () => post('/api/reload').then(tick);
tick(); setInterval(tick, 2000);
</script>
</html>`;

function readJsonBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
      if (raw.length > limit) { reject(new Error('内容太大')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(String(raw || '{}').replace(/^\uFEFF/, ''))); } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

export function startControl(cfg, hooks) {
  const { host, port } = cfg.raw.control;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const json = (obj, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };

    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        json(hooks.status());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/pause') {
        hooks.pause();
        json({ ok: true, paused: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/resume') {
        hooks.resume();
        json({ ok: true, paused: false });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/reload') {
        hooks.reload();
        json({ ok: true });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/memory/list') {
        json({ files: hooks.memory ? hooks.memory.list() : [] });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/memory/read') {
        try { json(hooks.memory.read(url.searchParams.get('rel') || '')); }
        catch (e) { json({ error: e.message }, 400); }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/memory/search') {
        try { json({ hits: hooks.memory.search(url.searchParams.get('q') || '') }); }
        catch (e) { json({ error: e.message }, 400); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/memory/write') {
        try {
          const body = await readJsonBody(req);
          json(hooks.memory.write(body.rel, body.text));
        } catch (e) { json({ error: e.message }, 400); }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/history') {
        const chat = url.searchParams.get('chat');
        json({ chat, rows: hooks.history(chat) });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/balance') {
        // 手动触发一次余额检查（默认绕过缓存）
        const force = url.searchParams.get('force') !== '0';
        const out = hooks.balance ? await hooks.balance(force) : { error: '没接余额模块' };
        json(out);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/reminders') {
        json({ items: hooks.reminders ? hooks.reminders.list() : [] });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/reminders/cancel') {
        try {
          const body = await readJsonBody(req);
          json(hooks.reminders.cancel(body.chat, body.id));
        } catch (e) { json({ error: e.message }, 400); }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/qzone') {
        json(hooks.qzone ? hooks.qzone.state() : { error: '没接说说模块' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/qzone/post') {
        // 手动发一条今天的说说（忽略时间窗，仍然一天一条）
        try {
          const body = await readJsonBody(req, 10_000);
          json(await hooks.qzone.post({ force: body.force !== false, dryRun: !!body.dryRun }));
        } catch (e) { json({ error: e.message }, 500); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/action') {
        // 桥内能力（发语音/发表情/发说说）的统一入口，给 DSH 的 # 命令用。
        try {
          const body = await readJsonBody(req, 10_000);
          if (!hooks.action) { json({ error: '没接 action' }, 501); return; }
          json(await hooks.action(body));
        } catch (e) { json({ error: e.message }, 400); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/simulate') {
        // 调试用：往某个会话里塞一条假消息，走完整的一轮（默认关，config.control.simulate 打开）
        if (!cfg.raw.control?.simulate) { json({ error: 'simulate 未开启' }, 403); return; }
        try {
          const body = await readJsonBody(req, 10_000);
          json(hooks.simulate(body));
        } catch (e) { json({ error: e.message }, 400); }
        return;
      }
      json({ error: 'not found' }, 404);
    } catch (e) {
      log('warn', `控制面板请求出错: ${e.message}`);
      json({ error: e.message }, 500);
    }
  });

  server.on('error', (e) => log('warn', `控制面板启动失败: ${e.message}`));
  server.listen(port, host, () => {
    log('info', `控制面板: http://${host}:${port}`);
  });

  return server;
}
