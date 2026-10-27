#!/usr/bin/env node
// 一次性验证：AgentRunner 现在能不能真的走中转跑通一条最简消息
import { loadConfig } from '../src/config.mjs';
import { AgentRunner } from '../src/agent.mjs';
import { readMode } from '../src/model-mode.mjs';

const cfg = loadConfig();
console.log('当前路线状态：', JSON.stringify(readMode(cfg)));
const runner = new AgentRunner(cfg);
console.log('apiKey?', Boolean(runner.apiKey), 'relayKey?', Boolean(runner.relayKey));
const t0 = Date.now();
const r = await runner.run({ prompt: '只回两个字：收到', toolMode: 'none', persona: false });
console.log(`route=${r.route} ok=${r.ok} elapsed=${Date.now() - t0}ms failover=${Boolean(r.failover)}`);
console.log('text =', JSON.stringify(String(r.text || '').slice(0, 200)));
if (!r.ok) console.log('stderr tail =', String(r.stderr || '').slice(-600));
console.log('跑完后状态：', JSON.stringify(readMode(cfg)));
