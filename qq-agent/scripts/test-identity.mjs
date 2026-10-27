/**
 * 认人系统回归测试：node scripts/test-identity.mjs
 *
 * 验的四件事（用户 2026-10-25 的要求）：
 *   1. 同一个 QQ 号在不同群用不同名片 → 两个名字都记在同一个 uid 下
 *   2. 认人表里两个名字挂在同一个 QQ 号后面（模型据此说「是同一个人」）
 *   3. 文本里提到任一别名 → 能对回那个 QQ 号
 *   4. 「关于他」跨群共用一份（同 QQ 号在哪个群都是同一个印象）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  recordIdentity, aliasesOf, renderIdentityBlock, resolveMentions,
  writeSharedAbout, readSharedAbout, cleanAlias, identitiesFile,
} from '../src/identity.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-test-'));
const agentCwd = root;
fs.mkdirSync(path.join(agentCwd, 'profiles'), { recursive: true });

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
}

// 1) 同一个 QQ 号，两个群两个名片
recordIdentity(agentCwd, <MEMBER_QQ_1>, '沐·枫逸萧', { chat: 'group:<GROUP_ID_1>' });
recordIdentity(agentCwd, <MEMBER_QQ_1>, '史莱姆', { chat: 'group:<GROUP_ID_2>' });
const al = aliasesOf(agentCwd, <MEMBER_QQ_1>);
ok('两个群两个名片都记在同一个 QQ 号下', al.length === 2 && al.includes('沐·枫逸萧') && al.includes('史莱姆'), JSON.stringify(al));
ok('身份表落盘位置正确', fs.existsSync(identitiesFile(agentCwd)));
ok('重复记同一个名字不涨长度', (() => {
  recordIdentity(agentCwd, <MEMBER_QQ_1>, '史莱姆', { chat: 'group:<GROUP_ID_2>' });
  return aliasesOf(agentCwd, <MEMBER_QQ_1>).length === 2;
})());

// 2) 认人表：两个名字挂同一个 QQ 号
const block = renderIdentityBlock(agentCwd, [<MEMBER_QQ_1>], new Map());
ok('认人表带 QQ 号和两个别名', block.includes('<MEMBER_QQ_1>') && block.includes('沐·枫逸萧') && block.includes('史莱姆'));
ok('认人表说明「都是同一个人」', block.includes('同一个人'), block.slice(0, 120));

// 别的 QQ 号同名也不算同一人
recordIdentity(agentCwd, 999999, '史莱姆', { chat: 'group:<GROUP_ID_2>' });
const block2 = renderIdentityBlock(agentCwd, [999999], new Map());
ok('不同 QQ 号各自一条', block2.includes('999999') && !block2.includes('<MEMBER_QQ_1>'), block2);

// 3) 从文本认出别名 → QQ 号
const hits = resolveMentions(agentCwd, '史莱姆呢，今天怎么没说话');
ok('文本里的别名能对回 QQ 号', hits.some((h) => h.uid === <MEMBER_QQ_1>), JSON.stringify(hits));
ok('没提到的别名不会乱认', resolveMentions(agentCwd, '今天吃什么').length === 0);

// 4) 关于他跨群共用
writeSharedAbout(agentCwd, <MEMBER_QQ_1>, '很话多的一个人，爱发沙雕图。');
writeSharedAbout(agentCwd, <MEMBER_QQ_1>, '很话多的一个人，爱发沙雕图。最近在考研。');
ok('共享描述能读回最新一份', readSharedAbout(agentCwd)[<MEMBER_QQ_1>]?.about.includes('考研'));

// 5) 名片清洗
ok('纯 QQ 号不当别名', cleanAlias('<MEMBER_QQ_1>', <MEMBER_QQ_1>) === '');
ok('空名片不收', recordIdentity(agentCwd, 888888, '   ', { chat: 'group:1' })?.aliases?.length === 0
  || aliasesOf(agentCwd, 888888).length === 0);

// 6) 长名片要能拆出群里真正会喊的短叫法
recordIdentity(agentCwd, 555555, '阮沐の史莱姆', { chat: 'group:<GROUP_ID_2>' });
const al6 = aliasesOf(agentCwd, 555555);
ok('「阮沐の史莱姆」拆出「史莱姆」', al6.includes('史莱姆'), JSON.stringify(al6));
ok('短叫法能认回 QQ 号', resolveMentions(agentCwd, '史莱姆你怎么不说话').some((h) => h.uid === 555555));
recordIdentity(agentCwd, 777777, '麻辣小土豆(づ ●─● )づ', { chat: 'group:1' });
const al7 = aliasesOf(agentCwd, 777777);
ok('「麻辣小土豆(…)」拆出「小土豆」', al7.includes('小土豆'), JSON.stringify(al7));
ok('带符号的名字保留原形', (() => {
  recordIdentity(agentCwd, 424242, '沐·枫逸萧', { chat: 'group:1' });
  return aliasesOf(agentCwd, 424242).includes('沐·枫逸萧');
})());

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
