// 工具执行报告不许原样进聊天 —— 回归测试
// 事故来源：2026-10-26 11:33:38 群 <GROUP_ID_2>，`#翻唱整首美人鱼` 被当工作项跑，
// runWorkItem 把 r.text 原样 say() 发进群（markdown + EACCES + 沙箱路径）。
// 跑：node scripts/test-tool-report.mjs
import { cleanToolReport } from '../src/thinking-guard.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok  ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${extra}`); }
};

const LEAK = [
  '两次尝试都在同一处失败：沙箱不允许写入 `/root/qq-agent/data/cover/queue/`。',
  '',
  '- 我先确认了执行器在线（心跳正常），然后按对应流程走 `enqueueCover` 把整首《美人鱼》排进队列；',
  "  它却报错 `EACCES: permission denied, open '.../data/cover/queue/.mvopcb33l3bp.tmp'`。这条路径在 workspace 外面。",
].join('\n');

console.log('cleanToolReport:');
const r1 = cleanToolReport(LEAK);
ok(!r1.includes('`'), '事故原文：反引号被去掉', r1);
ok(!r1.includes('EACCES'), '事故原文：报错代号被剔掉', r1);
ok(!/^[-*]\s/m.test(r1), '事故原文：列表符号被去掉', r1);
ok(!r1.includes('\n'), '事故原文：收成一行', r1);
ok(r1.length <= 160, '事故原文：长度受控', `${r1.length}`);
ok(/沙箱|失败/.test(r1), '事故原文：还留着失败结论', r1);

const r2 = cleanToolReport('改完了。\n```bash\nsystemctl restart qq-bridge\n```\n现在桥是 active，日志里没有再报错。');
ok(!r2.includes('systemctl'), '代码块整块删掉', r2);
ok(r2.includes('改完了'), '代码块外的正文保留', r2);

const r3 = cleanToolReport('| 项目 | 值 |\n|---|---|\n| 磁盘 | 27G |\n### 结论\n磁盘还剩 27G，够用。');
ok(!r3.includes('|'), '表格删掉', r3);
ok(!r3.includes('###'), 'markdown 标题删掉', r3);
ok(r3.includes('27G'), '结论句保留', r3);

const r4 = cleanToolReport("Error: EACCES: permission denied, open '/root/x.tmp'");
ok(r4.length > 0, '整段只有报错时留一句，不空', r4);

const r5 = cleanToolReport('');
ok(r5 === '', '空输入返回空串');

const r6 = cleanToolReport('第一句结论。第二句补充。第三句是废话不该出现。');
ok(!r6.includes('第三句'), '最多留两句', r6);

const r7 = cleanToolReport('A'.repeat(400));
ok(r7.length <= 161, '超长截断并加省略号', `${r7.length}`);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
