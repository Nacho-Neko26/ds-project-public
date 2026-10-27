import { loadConfig } from '../src/config.mjs';
import { readFavorMap } from '../src/favor.mjs';

const cfg = loadConfig();
for (const [gid] of cfg.groupAllow) {
  const t0 = process.hrtime.bigint();
  const m = readFavorMap(cfg.agentCwd, `group:${gid}`);
  const t1 = process.hrtime.bigint();
  const high = Object.entries(m).filter(([, f]) => f > 70);
  console.log(`群 ${gid}: 读出 ${Object.keys(m).length} 人，好感>70 的 ${high.length} 人，耗时 ${Number(t1 - t0) / 1000}µs`);
  console.log('  ', high.map(([uid, f]) => `${uid}:${f}`).join(' '));
}
