import { loadConfig } from '../src/config.mjs';
import { getAmbient, renderAmbient } from '../src/ambient.mjs';

const cfg = loadConfig();
const a = await getAmbient(cfg.agentCwd, { force: true });
console.log('--- 原始数据 ---');
console.log(JSON.stringify(a));
console.log('\n--- 注入 prompt 的那段 ---');
console.log(renderAmbient(a));
