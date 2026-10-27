/**
 * 开机自启看门狗（新增文件，不改动原有代码）
 * 只管两件事：napcat 挂了重拉，桥挂了重拉。
 * 由 Windows 计划任务 "qq-agent" 在登录时调用。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:\\Users\\14381\\Documents\\deepseek-harness\\default-workspace\\qq-agent';
const NODE = 'C:\\Users\\14381\\.dsh-runtime\\node\\node.exe';
const QQ = '100000002';
const LOG = path.join(ROOT, 'logs', 'supervisor.log');

function log(...a) {
  const line = `${new Date().toISOString()}  ${a.join(' ')}`;
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
}

const kids = new Map();

function start(name, cmd, args, cwd, delayMs) {
  log(`[${name}] 启动`);
  const p = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  kids.set(name, p);

  const pipe = (stream, tag) => stream.on('data', (d) => {
    for (const line of d.toString().split(/\r?\n/)) if (line.trim()) log(`[${name}${tag}] ${line}`);
  });
  pipe(p.stdout, '');
  pipe(p.stderr, '!');

  p.on('exit', (code, sig) => {
    log(`[${name}] 退出 code=${code} sig=${sig}，${delayMs / 1000}s 后重启`);
    kids.delete(name);
    setTimeout(() => {
      if (kids.has(name)) return;
      if (name === 'napcat') start('napcat', 'cmd.exe', ['/c', 'launcher-user.bat', '-q', QQ], path.join(ROOT, 'napcat', 'app'), 15000);
      else start('bridge', NODE, [path.join(ROOT, 'src', 'index.mjs')], ROOT, 5000);
    }, delayMs);
  });
}

log('===== supervisor 启动 =====');
start('napcat', 'cmd.exe', ['/c', 'launcher-user.bat', '-q', QQ], path.join(ROOT, 'napcat', 'app'), 15000);
setTimeout(() => start('bridge', NODE, [path.join(ROOT, 'src', 'index.mjs')], ROOT, 5000), 12000);

process.on('SIGTERM', () => process.exit(0));
