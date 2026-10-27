import http from 'node:http';
import fs from 'node:fs';
import { log } from './util.mjs';
import { listStickers, stickerImage, updateSticker, deleteSticker, restoreSticker } from './sticker-api.mjs';
import { PAGE } from './control-page.mjs';
import { chatList, chatMessages, usageSummary, purposeState, memoryStruct } from './control-data.mjs';


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
      // ── 会话 / token / 目的 / 结构化记忆（2026-10-28）──────────────
      if (req.method === 'GET' && url.pathname === '/api/chat/list') {
        json(chatList(cfg));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/chat/messages') {
        try { json(chatMessages(cfg, url.searchParams.get('key'), url.searchParams.get('limit'))); }
        catch (e) { json({ error: e.message }, 400); }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/usage/summary') {
        json(usageSummary(cfg, url.searchParams.get('days')));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/purpose/state') {
        json(purposeState(cfg));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/memory/struct') {
        json(memoryStruct(cfg, url.searchParams.get('grep') || ''));
        return;
      }
      // ── 表情库（2026-10-28 从 tools/sticker-admin.mjs 搬进来）─────────
      if (req.method === 'GET' && url.pathname === '/api/stickers') {
        json(listStickers({
          grep: url.searchParams.get('grep') || '',
          offset: url.searchParams.get('offset') || 0,
          limit: url.searchParams.get('limit') || 60,
        }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/stickers/img') {
        const hit = stickerImage(url.searchParams.get('i') || 0);
        if (!hit) { res.writeHead(404); res.end('no image'); return; }
        try {
          const buf = fs.readFileSync(hit.file);
          res.writeHead(200, { 'content-type': hit.mime, 'cache-control': 'max-age=3600' });
          res.end(buf);
        } catch { res.writeHead(404); res.end('read fail'); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/stickers/update') {
        try { json({ ok: true, row: updateSticker(await readJsonBody(req, 20000)) }); }
        catch (e) { json({ error: e.message }, 400); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/stickers/del') {
        try { json({ ok: true, ...deleteSticker(await readJsonBody(req, 20000)) }); }
        catch (e) { json({ error: e.message }, 400); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/stickers/restore') {
        try { json({ ok: true, row: restoreSticker(await readJsonBody(req, 20000)) }); }
        catch (e) { json({ error: e.message }, 400); }
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
