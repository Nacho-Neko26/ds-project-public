import { loadConfig } from '../src/config.mjs';
import { computeSpend } from '../src/balance.mjs';

const cfg = loadConfig();
const s = computeSpend(cfg.dataDir);
console.log('今天消耗:', s.today.toFixed(2), '元');
console.log('近七天消耗:', s.week.toFixed(2), '元');
console.log('累计消耗:', s.total.toFixed(2), '元');
console.log('记账起点:', s.since ? new Date(s.since).toLocaleString('zh-CN') : '还没有记录');
