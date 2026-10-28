import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reviewOneBase, autoReviewKnowledge, AUTO_REVIEW_BASES } from '../src/kb-review.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass += 1; } else { fail += 1; console.log(`FAIL ${name}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-review-'));
const baseFile = path.join(dir, 'group.json');

function makeBase(nodes) {
  fs.writeFileSync(baseFile, JSON.stringify({ nodes, links: [] }, null, 2) + '\n', 'utf8');
}
function read() {
  return JSON.parse(fs.readFileSync(baseFile, 'utf8'));
}

// 1. added / modified / edited 都清掉，removed 保留
makeBase([
  { id: 'k1', parent: null, title: '群里的梗', body: '正文A', change: 'added', at: '2026-10-24 23:50' },
  { id: 'k2', parent: 'k1', title: '康神开播了', body: '正文B', change: 'modified', at: '2026-10-28 09:38' },
  { id: 'k3', parent: 'k1', title: '老节点', body: '正文C', change: 'edited', at: '2026-10-24 23:50' },
  { id: 'k4', parent: 'k1', title: '被删的', body: '正文D', change: 'removed', at: '2026-10-28 10:00' },
  { id: 'k5', parent: null, title: '本来就干净', body: '正文E', at: '2026-10-27 08:00' },
]);

const r1 = reviewOneBase(baseFile);
ok('清掉 3 条', r1.cleared === 3);
const after = read();
ok('added 被清', !('change' in after.nodes[0]));
ok('modified 被清', !('change' in after.nodes[1]));
ok('edited 被清', !('change' in after.nodes[2]));
ok('removed 保留', after.nodes[3].change === 'removed');
ok('本来就干净的没动', !('change' in after.nodes[4]));
ok('内容没丢-title', after.nodes[0].title === '群里的梗' && after.nodes[1].body === '正文B');
ok('at 没被改写', after.nodes[1].at === '2026-10-28 09:38');
ok('节点数不变', after.nodes.length === 5);

// 2. 第二次同一个文件：mtime 没变就跳过
const r2 = reviewOneBase(baseFile);
ok('二次跳过', r2.cleared === 0 && r2.skipped === 'unchanged');

// 3. 文件重写后（mtime 变）再来一次，已经没有可清的
fs.writeFileSync(baseFile, `${JSON.stringify(read())}\n`, 'utf8');
const r3 = reviewOneBase(baseFile);
ok('无标记时 cleared=0', r3.cleared === 0);

// 4. 文件不存在不炸
const r4 = reviewOneBase(path.join(dir, 'nope.json'));
ok('缺失文件跳过', r4.cleared === 0 && r4.skipped === 'missing');

// 5. 坏 JSON 不炸、也不覆盖
fs.writeFileSync(path.join(dir, 'bad.json'), '{oops', 'utf8');
const r5 = reviewOneBase(path.join(dir, 'bad.json'));
ok('坏文件跳过', r5.skipped === 'broken');
ok('坏文件没被覆盖', fs.readFileSync(path.join(dir, 'bad.json'), 'utf8') === '{oops');

// 6. autoReviewKnowledge 走 cfg.agentCwd/.dsh-knowledge，默认只碰 group
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cwd-'));
fs.mkdirSync(path.join(cwd, '.dsh-knowledge'), { recursive: true });
fs.writeFileSync(path.join(cwd, '.dsh-knowledge', 'group.json'),
  JSON.stringify({ nodes: [{ id: 'k1', title: 'a', change: 'added', at: '2026-10-28 18:00' }], links: [] }, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(cwd, '.dsh-knowledge', 'welcome.json'),
  JSON.stringify({ nodes: [{ id: 'n1', title: 'w', change: 'added', at: '2026-10-24 17:00' }], links: [] }, null, 2) + '\n', 'utf8');

const r6 = autoReviewKnowledge({ agentCwd: cwd });
ok('group 清 1 条', r6.cleared === 1 && r6.files[0].base === 'group');
ok('group 标记清干净', !('change' in JSON.parse(fs.readFileSync(path.join(cwd, '.dsh-knowledge', 'group.json'), 'utf8')).nodes[0]));
ok('welcome 没动', JSON.parse(fs.readFileSync(path.join(cwd, '.dsh-knowledge', 'welcome.json'), 'utf8')).nodes[0].change === 'added');
ok('默认只碰 group', AUTO_REVIEW_BASES.join(',') === 'group');

// 7. 目录都没有也不炸
const r7 = autoReviewKnowledge({ agentCwd: path.join(cwd, 'nowhere') });
ok('没有目录返回 0', r7.cleared === 0);

console.log(`pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
