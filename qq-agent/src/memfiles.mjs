/**
 * 记忆文件的读写（控制台「记忆」页用）。
 *
 * 对应的就是 dsh-memory-board 那套：能看、能搜、能改，改之前自动备份。
 * 这里没有设置页可挂，就挂到桥自己的控制台（127.0.0.1:3899）上。
 *
 * 规矩：
 *   - 只认白名单里的目录，路径必须落在里面（防目录穿越）
 *   - 写之前整份备份到 <文件>.bak-<时间戳>
 *   - 写临时文件再 rename，写完回读复核
 */
import fs from 'node:fs';
import path from 'node:path';

export function memoryRoots(cfg) {
  return [
    { id: 'diary', label: '日记', dir: path.join(cfg.agentCwd, 'diary') },
    { id: 'summary', label: '摘要', dir: path.join(cfg.agentCwd, 'summary') },
    { id: 'habits', label: '群习惯', dir: path.join(cfg.agentCwd, 'habits') },
    { id: 'memory', label: '记忆', dir: path.join(cfg.agentCwd, 'memory') },
    { id: 'persona', label: '人设', dir: path.join(cfg.agentCwd, '..', 'persona') },
  ];
}

/** 把相对路径解析成绝对路径，且必须落在某个白名单目录里 */
export function resolveMemoryPath(cfg, rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.includes('..')) throw new Error('非法路径');
  for (const root of memoryRoots(cfg)) {
    const base = path.resolve(root.dir);
    const abs = path.resolve(base, clean);
    if (abs === base) continue;
    if (!abs.startsWith(base + path.sep)) continue;
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue; // 这个目录里没有，换下一个
    return { abs, rel: clean, root };
  }
  throw new Error('文件不存在或不在记忆目录里');
}

export function listMemory(cfg) {
  const out = [];
  for (const root of memoryRoots(cfg)) {
    if (!fs.existsSync(root.dir)) continue;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(md|jsonl|json|txt)$/i.test(e.name)) continue;
        const st = fs.statSync(p);
        out.push({
          group: root.label,
          id: root.id,
          rel: path.relative(root.dir, p).replace(/\\/g, '/'),
          bytes: st.size,
          mtime: st.mtimeMs,
        });
      }
    };
    walk(root.dir);
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function readMemory(cfg, rel) {
  const { abs, rel: clean } = resolveMemoryPath(cfg, rel);
  return { rel: clean, text: fs.readFileSync(abs, 'utf8') };
}

/** 改之前备份，写临时文件再 rename，写完回读 */
export function writeMemory(cfg, rel, text) {
  const { abs, rel: clean } = resolveMemoryPath(cfg, rel);
  const backup = `${abs}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(abs, backup);
  const tmp = `${abs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, String(text ?? ''), 'utf8');
  fs.renameSync(tmp, abs);
  const check = fs.readFileSync(abs, 'utf8');
  if (check !== String(text ?? '')) {
    fs.copyFileSync(backup, abs);
    throw new Error('写入复核失败，已还原备份');
  }
  return { rel: clean, bytes: check.length, backup: path.basename(backup) };
}

export function searchMemory(cfg, q, limit = 60) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return [];
  const hits = [];
  for (const root of memoryRoots(cfg)) {
    if (!fs.existsSync(root.dir)) continue;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(md|jsonl|json|txt)$/i.test(e.name)) continue;
        let text = '';
        try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
        const rel = path.relative(root.dir, p).replace(/\\/g, '/');
        text.split(/\r?\n/).forEach((line, i) => {
          if (hits.length >= limit) return;
          if (line.toLowerCase().includes(needle)) {
            hits.push({ group: root.label, rel, line: i + 1, text: line.slice(0, 240) });
          }
        });
      }
    };
    walk(root.dir);
  }
  return hits;
}
