import { loadConfig } from '../src/config.mjs';
import { loadProfiles } from '../src/anger.mjs';
import { ensureFavor, tierOf, tierText } from '../src/favor.mjs';
import fs from 'node:fs';
import path from 'node:path';

const cfg = loadConfig();
const dir = path.join(cfg.agentCwd, 'profiles');
if (!fs.existsSync(dir)) { console.log('没有档案'); process.exit(0); }

for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.json')) continue;
  const chatKey = f.replace(/\.json$/, '');
  const pr = loadProfiles(cfg.agentCwd, chatKey);
  console.log(`\n=== ${chatKey} ===`);
  for (const p of Object.values(pr.people)) {
    const fav = ensureFavor(p);
    console.log(`  ${(p.displayName || '?').padEnd(14)} 好感 ${String(fav).padStart(3)}/100  ${tierOf(fav).padEnd(7)}  ${tierText(fav)}`);
  }
}
