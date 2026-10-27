// 手动触发一次知识整理（排查/验收用）
// 用法：node scripts/digest-now.mjs group:200000001
import { loadConfig } from '../src/config.mjs';
import { AgentRunner } from '../src/agent.mjs';
import { HistoryStore } from '../src/context.mjs';
import { maybeDigestKnowledge } from '../src/knowledge-digest.mjs';

const cfg = loadConfig();
const key = process.argv[2] || 'group:200000001';

// 测试不受「攒够 30 条 / 30 分钟」限制
const patched = {
  ...cfg,
  raw: { ...cfg.raw, digest: { ...(cfg.raw.digest || {}), everyMessages: 1, minGapMs: 0, maxPerDay: 99 } },
};

const runner = new AgentRunner(cfg);
const history = new HistoryStore(cfg.dataDir, cfg.raw.context);

const verdict = await maybeDigestKnowledge({
  cfg: patched,
  runner,
  history,
  chatKey: key,
  note: (level, msg) => console.log(`[${level}] ${msg}`),
});
console.log('VERDICT:', verdict);
