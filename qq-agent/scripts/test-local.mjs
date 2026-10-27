#!/usr/bin/env node
/**
 * 本机处理单测：node scripts/test-local.mjs
 *
 * 覆盖能纯函数验证的部分：路径白名单（extractFileDirective）、排队与回执、
 * 心跳判断、「最近收到的文件」记忆。真正调用 NapCat 发文件那一步（sendFileToChat）
 * 和本机 python 的执行要靠云端 + 本机实测（见 docs/qq-commands.md）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureLocalDirs, enqueueLocal, localExecutorOnline, localQueueDepth,
  rememberLocalInput, lastLocalInput, extractFileDirective, EXECUTOR_TIMEOUT_MS,
} from '../src/localfile.mjs';

let pass = 0; let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ← ' + extra : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localtest-'));
const work = path.join(root, 'workspace');
const data = path.join(root, 'data');
const voice = path.join(root, 'voice');
fs.mkdirSync(path.join(work, 'incoming', 'files'), { recursive: true });
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(voice, { recursive: true });
const cfg = {
  root, agentCwd: work, dataDir: data,
  raw: { local: { voiceDir: voice, pollMs: 1000 } },
};
const write = (p, s = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); return p; };

console.log('\n[1] extractFileDirective 只放行白名单目录');
const inWork = write(path.join(work, 'incoming', 'files', 'a.txt'));
const inData = write(path.join(data, 'local', 'b.txt'));
const inVoice = write(path.join(voice, 'local-c.mp3'));
const outside = write(path.join(root, 'secret.txt'));
const roots = [work, data, voice];
eq('工作区里的文件放行', extractFileDirective(`__SEND_FILE__ ${inWork}`, { roots }).paths, [inWork]);
eq('数据目录放行', extractFileDirective(`__SEND_FILE__ ${inData}`, { roots }).paths, [inData]);
eq('语音目录放行', extractFileDirective(`__SEND_FILE__ ${inVoice}`, { roots }).paths, [inVoice]);
eq('白名单外一律丢掉', extractFileDirective(`__SEND_FILE__ ${outside}`, { roots }).paths, []);
eq('穿越写法也按最终路径判', extractFileDirective('__SEND_FILE__ ../../etc/passwd', { roots }).paths, []);

console.log('\n[2] 指令行本身不进正文');
const both = extractFileDirective(`弄好了\n__SEND_FILE__ ${inWork}\n你看看`, { roots });
eq('正文留下', both.rest, '弄好了\n你看看');
eq('路径摘出来', both.paths.length, 1);

console.log('\n[3] 多种写法都认');
for (const line of [
  `__SEND_FILE__ ${inWork}`,
  `SEND_FILE: ${inWork}`,
  `__send_file__ ${inWork}`,
  `__SEND FILE__ ${inWork}`,
  `__SEND_FILE__ \`${inWork}\``,
  `__SEND_FILE__ file://${inWork}`,
]) {
  ok(`认得：${line.slice(0, 18)}…`, extractFileDirective(line, { roots }).paths.length === 1);
}
eq('普通文字里出现 SEND_FILE 但不独占一行也不算', extractFileDirective('我说 SEND_FILE 这个词', { roots }).paths, []);

console.log('\n[4] 排队与回执');
const p = ensureLocalDirs(cfg);
ok('目录都建好了', ['queue', 'done', 'files', 'sent'].every((d) => fs.existsSync(path.join(p.dir, d))));
const input = write(path.join(work, 'incoming', 'files', '报告.md'), '内容');
const job = enqueueLocal(cfg, { task: '把它转成 pdf', chat: 'private:<OWNER_QQ>', by: <OWNER_QQ>, file: { path: input, name: '报告.md' } });
ok('任务有 id', !!job.id);
eq('会话记下了', job.chat, 'private:<OWNER_QQ>');
ok('输入文件复制进 files/', !!job.file && fs.existsSync(job.file.path));
eq('复制件保留中文名', job.file.name, '报告.md');
ok('输出目录给了绝对路径', /local-/.test(job.out) && job.out.includes('local-' + job.id));
ok('queue 里有这个任务', fs.existsSync(path.join(p.queue, `${job.id}.json`)));
ok('sent 里留了回执', fs.existsSync(path.join(p.sent, `${job.id}.json`)));
eq('队列深度 1', localQueueDepth(cfg), 1);

console.log('\n[5] 没有输入文件也能排');
const job2 = enqueueLocal(cfg, { task: '算一下 1+1', chat: 'group:<GROUP_ID_1>' });
eq('file 为 null', job2.file, null);
eq('队列深度 2', localQueueDepth(cfg), 2);

console.log('\n[6] 心跳判断');
eq('没有心跳 = 离线', localExecutorOnline(cfg).online, false);
fs.writeFileSync(p.heartbeat, JSON.stringify({ ts: Date.now() }));
eq('刚心跳 = 在线', localExecutorOnline(cfg).online, true);
fs.writeFileSync(p.heartbeat, JSON.stringify({ ts: Date.now() - EXECUTOR_TIMEOUT_MS - 1000 }));
eq('心跳过期 = 离线', localExecutorOnline(cfg).online, false);
fs.writeFileSync(p.heartbeat, 'not json');
eq('心跳文件坏了 = 离线（不抛）', localExecutorOnline(cfg).online, false);

console.log('\n[7] 最近收到的文件');
eq('没记过就是 null', lastLocalInput(cfg, 'private:1'), null);
rememberLocalInput(cfg, 'private:1', { path: input, name: '报告.md' });
const got = lastLocalInput(cfg, 'private:1');
ok('记得住', !!got && got.name === '报告.md');
eq('别的会话看不到', lastLocalInput(cfg, 'private:2'), null);
ok('超过 30 分钟算过期', lastLocalInput(cfg, 'private:1', -1) === null);
try { fs.unlinkSync(input); } catch { /* ignore */ }
eq('文件没了就算没有', lastLocalInput(cfg, 'private:1'), null);

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
