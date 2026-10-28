#!/usr/bin/env node
// 一次性验证：go 坏掉的时候，run() 会不会自己切官方并且这一句话仍然答上来
// 手法：把 OPENCODE_GO_API_KEY 换成假的（readCredential 先看环境变量），provider 必然 401
import { loadConfig } from '../src/config.mjs';
import { AgentRunner } from '../src/agent.mjs';
import { readMode, writeMode } from '../src/model-mode.mjs';

process.env.OPENCODE_GO_API_KEY = 'sk-broken-on-purpose';
const cfg = loadConfig();

// 先把状态清回 go，保证这次测的是「中途发现坏了」
writeMode(cfg, { mode: 'go', reason: 'test-setup' });
console.log('起始状态：', JSON.stringify(readMode(cfg)));

const runner = new AgentRunner(cfg);
console.log('goKey 前 8 位 =', String(runner.goKey).slice(0, 8));

const t0 = Date.now();
const r = await runner.run({ prompt: '只回两个字：还在', toolMode: 'none', persona: false });
console.log(`route=${r.route} ok=${r.ok} elapsed=${Date.now() - t0}ms failover=${Boolean(r.failover)}`);
console.log('text =', JSON.stringify(String(r.text || '').slice(0, 200)));
if (!r.ok) console.log('stderr tail =', String(r.stderr || '').slice(-600));
const after = readMode(cfg);
console.log('跑完后状态：', JSON.stringify(after));
console.log(after.mode === 'official' ? '✓ 已经自己切到官方' : '✗ 没切');
