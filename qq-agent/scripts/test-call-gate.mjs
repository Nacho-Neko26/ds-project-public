// 群聊「# 指令和一般指令都要先叫她」的门禁单测：node scripts/test-call-gate.mjs
// 2026-10-28 用户定（m00122）：群里没叫到她的 # 指令一律当没看见。
import { calledByUser, isHashLine, gateHashLines, nameHit } from '../src/util.mjs';
import { detectSingRequest, detectSingAsk } from '../src/sing-intent.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ' -> ' + e.message); }
};
const eq = (a, b, msg = '') => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
};

const NAMES = ['溟月'];
const msg = (text, extra = {}) => ({ uid: 1, name: '某人', text, ...extra });
const called = (m) => calledByUser(NAMES, m);

console.log('叫她判定 calledByUser');

t('真 @ 算叫她（atMe）', () => {
  eq(called(msg('#好感度', { atMe: true })), true);
});

t('mentioned 字段也算叫她', () => {
  eq(called(msg('#好感度', { mentioned: true })), true);
});

t('正文出现「溟月」不算没叫', () => {
  eq(called(msg('溟月 #好感度')), true);
});

t('@ 了但正文没名字，也算（真 @ 优先）', () => {
  eq(called(msg('#好感度', { atMe: true, text: '#好感度' })), true);
});

t('没叫到 → false', () => {
  eq(called(msg('#好感度')), false);
});

t('通用外号不算叫她（群里有别的鲸鱼娘）', () => {
  eq(called(msg('鲸鱼娘 #好感度')), false);
  eq(called(msg('小鲸鱼 唱首歌')), false);
  eq(called(msg('DeepSeek酱 #心情')), false);
});

t('名字只是长得像也不认（不含子串）', () => {
  eq(called(msg('溟月月你好')), true); // nameHit 是子串，含「溟月」就算
  eq(called(msg('溟 月 #好感度')), false); // 中间有空格就不算
});

t('空消息不炸', () => {
  eq(called(null), false);
  eq(called(undefined), false);
  eq(called({}), false);
  eq(called(msg('')), false);
});

t('名字表为空就不认外号', () => {
  eq(calledByUser([], msg('溟月 #好感度')), false);
  eq(nameHit([], '溟月'), false);
});

console.log('isHashLine');

t('半角/全角 # 都认', () => {
  eq(isHashLine(msg('#好感度')), true);
  eq(isHashLine(msg('＃好感度')), true);
});

t('前面有空格也认', () => {
  eq(isHashLine(msg('   #好感度')), true);
});

t('# 不在开头就不算', () => {
  eq(isHashLine(msg('溟月 #好感度')), false);
  eq(isHashLine(msg('什么#东西')), false);
});

t('普通聊天不算 # 指令', () => {
  eq(isHashLine(msg('溟月你好')), false);
  eq(isHashLine(msg('')), false);
  eq(isHashLine(null), false);
});

console.log('gateHashLines');

t('私聊一条不少', () => {
  const batch = [msg('#好感度'), msg('溟月 #心情'), msg('随便聊聊')];
  eq(gateHashLines(batch, { kind: 'private', isCalled: called }).length, 3);
});

t('kind 没传当私聊处理（不拦）', () => {
  const batch = [msg('#好感度')];
  eq(gateHashLines(batch, {}).length, 1);
});

t('群里：没叫她的 # 剔掉，普通聊天留下', () => {
  const batch = [msg('#好感度'), msg('溟月 #心情'), msg('刚才那个梗好好笑')];
  const kept = gateHashLines(batch, { kind: 'group', isCalled: called });
  eq(kept.map((m) => m.text), ['溟月 #心情', '刚才那个梗好好笑']);
});

t('群里：一条都没叫到 → 空的（这一批整个不办）', () => {
  const batch = [msg('#好感度'), msg('#关机')];
  eq(gateHashLines(batch, { kind: 'group', isCalled: called }).length, 0);
});

t('群里：@ 了就算，留着', () => {
  const batch = [msg('#好感度', { atMe: true })];
  eq(gateHashLines(batch, { kind: 'group', isCalled: called }).length, 1);
});

t('群里：非 # 的指令不受这道门约束（交给后面的批次判定）', () => {
  const batch = [msg('唱首歌'), msg('点一首起风了')];
  eq(gateHashLines(batch, { kind: 'group', isCalled: called }).length, 2);
});

t('群里：# 夹在中间也算，只看单条', () => {
  const batch = [msg('溟月在吗'), msg('#好感度'), msg('溟月 #心情')];
  const kept = gateHashLines(batch, { kind: 'group', isCalled: called });
  eq(kept.map((m) => m.text), ['溟月在吗', '溟月 #心情']);
});

t('批次里别人叫了她，不能替另一条 # 开绿灯', () => {
  const batch = [msg('溟月你看'), msg('#好感度')];
  const kept = gateHashLines(batch, { kind: 'group', isCalled: called });
  eq(kept.map((m) => m.text), ['溟月你看']);
});

t('非数组/空批次不炸', () => {
  eq(gateHashLines(null, { kind: 'group', isCalled: called }), []);
  eq(gateHashLines([], { kind: 'group', isCalled: called }), []);
});

t('桥自己的开关交给调用方放行（这里只看 isCalled）', () => {
  const bridgeSwitch = /^\s*[#＃]\s*(关机|接管|回来|群聊)/;
  const isCalled = (m) => bridgeSwitch.test(String(m.text || '')) || called(m);
  const batch = [msg('#关机'), msg('#好感度')];
  const kept = gateHashLines(batch, { kind: 'group', isCalled });
  eq(kept.map((m) => m.text), ['#关机']);
});

console.log('点唱识别也要认同一套「叫她」口径');

t('群里没叫她 → 不认点唱', () => {
  eq(detectSingRequest('翻唱起风了', { isGroup: true }), null);
});

t('群里叫「溟月」→ 认', () => {
  eq(detectSingRequest('溟月 翻唱起风了', { isGroup: true })?.body, '起风了');
});

t('群里真 @ 她 → 认', () => {
  eq(detectSingRequest('翻唱起风了', { isGroup: true, atMe: true })?.body, '起风了');
});

t('群里通用外号不算叫她（鲸鱼娘/小鲸鱼/大肥鱼 都不认）', () => {
  eq(detectSingRequest('鲸鱼娘 翻唱起风了', { isGroup: true }), null);
  eq(detectSingRequest('小鲸鱼 翻唱起风了', { isGroup: true }), null);
  eq(detectSingRequest('大肥鱼 翻唱起风了', { isGroup: true }), null);
});

t('私聊不用叫她', () => {
  eq(detectSingRequest('翻唱起风了')?.body, '起风了');
});

t('征求许可（能不能点一首）同一套口径', () => {
  eq(detectSingAsk('可以点一首吗', { isGroup: true }), null);
  eq(detectSingAsk('溟月 可以点一首吗', { isGroup: true })?.word, '翻唱');
  eq(detectSingAsk('可以点一首吗', { isGroup: true, atMe: true })?.word, '翻唱');
  eq(detectSingAsk('可以点一首吗')?.word, '翻唱');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
