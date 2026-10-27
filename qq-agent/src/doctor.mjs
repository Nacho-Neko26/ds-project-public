import fs from 'node:fs';
import { loadConfig } from './config.mjs';
import { resolveDsh, readCredential, AgentRunner } from './agent.mjs';

const ok = (m) => console.log(`  \u2713 ${m}`);
const bad = (m) => console.log(`  \u2717 ${m}`);
const warn = (m) => console.log(`  ! ${m}`);

async function tryWs(url, token, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const u = new URL(url);
      if (token) u.searchParams.set('access_token', token);
      const ws = new WebSocket(u);
      const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } done({ ok: false, reason: '连接超时' }); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); try { ws.close(); } catch { /* ignore */ } done({ ok: true }); });
      ws.addEventListener('error', (e) => { clearTimeout(timer); done({ ok: false, reason: e?.message ?? 'error' }); });
    } catch (e) {
      done({ ok: false, reason: e.message });
    }
  });
}

const cfg = loadConfig();
console.log('\n运行环境');
ok(`Node ${process.version}`);

const dsh = resolveDsh();
if (dsh.script) ok(`dsh 入口 ${dsh.script}`);
else bad(`找不到 dsh 入口（bin: ${dsh.binDir}），可用 QB_DSH_BIN_DIR 指定`);

const key = readCredential('DEEPSEEK_API_KEY');
if (key) ok(`DEEPSEEK_API_KEY 已就绪（${key.slice(0, 5)}…，${key.length} 字符）`);
else bad('DEEPSEEK_API_KEY 缺失：环境变量和 ~/.dsh/.credentials.yaml 里都没有');

console.log('\n人设与配置');
if (fs.existsSync(cfg.personaFile)) {
  ok(`人设文件 ${cfg.personaFile}（${fs.statSync(cfg.personaFile).size} 字节）`);
} else bad(`人设文件不存在: ${cfg.personaFile}`);

if (cfg.privateAllow.size) ok(`私聊白名单 ${[...cfg.privateAllow].join(', ')}`);
else warn('私聊白名单为空');
if (cfg.groupAllow.size) {
  ok(`群白名单 ${[...cfg.groupAllow.entries()].map(([i, m]) => `${i}(${m})`).join(', ')}`);
} else warn('群白名单为空');
if (cfg.trusted.size) ok(`可用工具的人 ${[...cfg.trusted].join(', ')}`);
else warn('没有可信用户：谁都不能让它动工具');

console.log('\nNapCat');
const ws = await tryWs(cfg.raw.napcat.wsUrl, cfg.raw.napcat.token);
if (ws.ok) ok(`OneBot WebSocket 可用 (${cfg.raw.napcat.wsUrl})`);
else bad(`连不上 ${cfg.raw.napcat.wsUrl}：${ws.reason}（NapCat 没启动或没开 WS 服务器）`);

if (process.argv.includes('--agent')) {
  console.log('\n模型连通性（会真的烧一次调用）');
  const runner = new AgentRunner(cfg);
  const t0 = Date.now();
  const r = await runner.run({ prompt: '只回复两个字：收到', withTools: false });
  if (r.ok) ok(`${Date.now() - t0}ms：${r.text.slice(0, 40)}`);
  else bad(`失败：${r.stderr.slice(-300)}`);
}

console.log('');
