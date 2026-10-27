#!/usr/bin/env node
/**
 * 好感度 v2 双轴自检：不碰真实数据，纯内存验证规则。
 * 跑法：node scripts/favor-selftest.mjs
 */
import * as F from '../src/favor.mjs';

let pass = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; return; }
  fails.push(`${name}${extra ? ' —— ' + extra : ''}`);
}
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

const DAY = '2026-10-27';
const WEEK = '2026-W44';

function person(favor = 0, trust = 50, extra = {}) {
  return { favor, trust, _schema: 2, dayKey: DAY, weekKey: WEEK, dayGain: 0, weekGain: 0, dayTrust: 0, weekTrust: 0, ...extra };
}

/* 1. 旧的百分值换算：90 分必须落在第五档 660 */
ok('旧90 → 660', F.upgradeLegacy(90).favor === 660, String(F.upgradeLegacy(90).favor));
ok('旧80 → 360', F.upgradeLegacy(80).favor === 360, String(F.upgradeLegacy(80).favor));
ok('旧70 → 180', F.upgradeLegacy(70).favor === 180);
ok('旧50 → 60', F.upgradeLegacy(50).favor === 60);
ok('旧100 → 1080', F.upgradeLegacy(100).favor === 1080);
ok('旧35 → 25 信任', near(F.upgradeLegacy(35).trust, 25), String(F.upgradeLegacy(35).trust));
ok('旧90 → 82 信任', near(F.upgradeLegacy(90).trust, 82));

/* 2. 老档案就地升级（迁移脚本没跑也不会崩） */
{
  const p = { favor: 78, tempPenalty: 20 };
  F.ensureFavor(p);
  ok('老档案 78+20 惩罚 → 996', p.favor === 996, String(p.favor));
  ok('老档案升级后 _schema=2', p._schema === 2);
  ok('老档案升级后 tempPenalty 清零', p.tempPenalty === 0, String(p.tempPenalty));
  ok('老档案升级后信任 90', near(p.trust, 90), String(p.trust));
}

/* 3. 档位 */
ok('660 = 普通朋友第5档', F.stageByFavor(660).name === '普通朋友' && F.stageByFavor(660).idx === 5);
ok('59 = 看见就不爽', F.stageByFavor(59).name === '看见就不爽');
ok('1080 = 关系很好的朋友', F.stageByFavor(1080).name === '关系很好的朋友');
ok('2400 = 恋人爱人', F.stageByFavor(2400).name === '恋人爱人');
ok('超上限也停在恋人爱人', F.stageByFavor(9999).name === '恋人爱人');

/* 4. 升档要双轴都够 */
{
  const p = person(700, 10);
  ok('分数够信任不够 → 不升档', F.stageIndex(p) === 1, 'idx=' + F.stageIndex(p));
  p.trust = 55;
  ok('信任补齐 → 升到第5档', F.stageIndex(p) === 5, 'idx=' + F.stageIndex(p));
}

/* 5. 好感只增：负数只扣信任 */
{
  const p = person(500, 60);
  const r = F.applyFavor(p, -50, { dayKey: DAY });
  ok('扣分不动好感', p.favor === 500, String(p.favor));
  ok('扣分落到信任', p.trust === 10, String(p.trust));
  ok('返回值 applied 是负的信任变化', r.applied === -50, String(r.applied));
}

/* 6. 信任不越界 */
{
  const p = person(500, 10);
  F.applyFavor(p, -50, { dayKey: DAY });
  ok('信任最低 0', p.trust === 0, String(p.trust));
}

/* 7. 软区：日额度 120 内全额，超出按 25%，硬顶 150 */
{
  const p = person(0, 100);
  F.applyAffection(p, 200, { dayKey: DAY });
  ok('软区折算后 ≈127', near(p.favor, 127, 2), String(p.favor));
  const p2 = person(0, 100, { dayGain: 145 });
  F.applyAffection(p2, 100, { dayKey: DAY });
  ok('软区剩 5 点只给 1', p2.favor === 1, String(p2.favor));
  const p3 = person(0, 100, { dayGain: 150 });
  F.applyAffection(p3, 100, { dayKey: DAY });
  ok('日硬顶 150 后一点不给', p3.favor === 0, String(p3.favor));
}

/* 8. 周上限 500 */
{
  const p = person(0, 100, { weekGain: 480 });
  F.applyAffection(p, 100, { dayKey: DAY });
  ok('周上限只给剩的 20', p.favor === 20, String(p.favor));
}

/* 9. 加好感不会超过 2400 */
{
  const p = person(2380, 100);
  F.applyAffection(p, 500, { dayKey: DAY, ignoreCap: true });
  ok('好感封顶 2400', p.favor === 2400, String(p.favor));
}

/* 10. 半速：信任不到门槛一半 */
{
  const p = person(700, 20);   // 第五档要 55 信任，一半是 27.5
  ok('低信任算半速', F.slowGrowth(p) === true);
  const p2 = person(700, 60);
  ok('信任够了全速', F.slowGrowth(p2) === false);
}

/* 11. 生气扣信任、消气回一部分 */
{
  const p = person(900, 60);
  const r1 = F.applyAngerPenalty(p, { isPrivate: false });
  ok('生气扣 10 信任', p.trust === 50, String(p.trust));
  ok('生气不动好感', p.favor === 900);
  const r2 = F.restoreAngerPenalty(p);
  ok('消气回 6 信任', p.trust === 56, String(p.trust));
  ok('消气后归还标记清零', p.angerTrustHeld === 0);
}

/* 12. 卡片文案 */
{
  const card = F.renderFavorCard(996, 996);
  ok('卡片显示普通朋友', card.includes('普通朋友'), card.split('\n')[0]);
  ok('卡片不报分数', !/\d{3,}/.test(card), card);
  const ownerCard = F.renderFavorCard(0, 0, 30, { isOwner: true });
  ok('主人保底第六档', ownerCard.includes('关系很好的朋友'), ownerCard.split('\n')[0]);
}

/* 13. 信任日上限 / 周上限 */
{
  const p = person(500, 50, { dayTrust: 10 });
  F.applyTrust(p, 5, { dayKey: DAY });
  ok('信任日上限 10', p.trust === 50, String(p.trust));
}

/* 14. 第五档以上：获取难度低增（每上一档 ×0.9） */
{
  const p5 = person(700, 80);
  F.applyAffection(p5, 100, { dayKey: DAY });
  ok('第五档 100 全拿', p5.favor === 800, String(p5.favor));
  const p6 = person(1100, 80);
  F.applyAffection(p6, 100, { dayKey: DAY });
  ok('第六档 100 只拿 90', p6.favor === 1190, String(p6.favor));
  const p7 = person(1700, 90);
  F.applyAffection(p7, 100, { dayKey: DAY });
  ok('第七档 100 只拿 80', p7.favor === 1780, String(p7.favor));
}

console.log(`\n通过 ${pass} 项${fails.length ? `，失败 ${fails.length} 项` : '，全过'}`);
for (const f of fails) console.log('  ✗ ' + f);
process.exit(fails.length ? 1 : 0);
