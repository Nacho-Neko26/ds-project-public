// 黄脸渲染回归测试：收到的是哪个表情必须告诉模型
// node scripts/test-render-face.mjs
//
// 背景（2026-10-29 用户要求）：「收到用户单个表情要根据表情含义来回话」。
// 原来 renderSegments 把 face 段一律渲染成「[表情]」，模型根本不知道对方发的是爱心
// 还是赞，只能回一句「就发个表情」。现在带名字：`[表情:爱心]`；认不出来带 id：`[表情:#498]`。
import assert from 'node:assert';
import { renderSegments, renderForwardMessages, faceName, faceLabel } from '../src/render.mjs';

let pass = 0;
const t = (name, fn) => { fn(); pass += 1; console.log(`  ✓ ${name}`); };
const seg = (type, data) => ({ type, data });

console.log('render-face');

t('表内 id：13 → 呲牙', () => {
  const { text } = renderSegments([seg('face', { id: '13' })]);
  assert.strictEqual(text, '[表情:呲牙]');
});

t('66 → 爱心（用户举的例子）', () => {
  const { text } = renderSegments([seg('face', { id: 66 })]);
  assert.strictEqual(text, '[表情:爱心]');
});

t('表外 id 靠 raw.faceText：264 → 斜眼笑', () => {
  const { text } = renderSegments([seg('face', { id: '264', raw: { faceText: '/斜眼笑' } })]);
  assert.strictEqual(text, '[表情:斜眼笑]');
});

t('faceText 带方括号时去掉：344 → 怨念', () => {
  const { text } = renderSegments([seg('face', { id: '344', raw: { faceText: '[怨念]' } })]);
  assert.strictEqual(text, '[表情:怨念]');
});

t('faceText 优先于表：13 但 faceText=/偷笑', () => {
  const { text } = renderSegments([seg('face', { id: '13', raw: { faceText: '/偷笑' } })]);
  assert.strictEqual(text, '[表情:偷笑]');
});

t('认不出来留 id：498 → [表情:#498]', () => {
  const { text } = renderSegments([seg('face', { id: '498' })]);
  assert.strictEqual(text, '[表情:#498]');
});

t('连 id 都没有 → [表情]', () => {
  const { text } = renderSegments([seg('face', {})]);
  assert.strictEqual(text, '[表情]');
});

t('和文字混排：只替换表情那一段', () => {
  const { text } = renderSegments([
    seg('text', { text: '你好' }),
    seg('face', { id: '66' }),
    seg('text', { text: '再见' }),
  ]);
  assert.strictEqual(text, '你好[表情:爱心]再见');
});

t('mface 不受影响（还是占位符进 images）', () => {
  const r = renderSegments([seg('mface', { url: 'http://x/1.gif' })]);
  assert.strictEqual(r.text, '[[MFACE:0]]');
  assert.strictEqual(r.images.length, 1);
});

t('合并转发里的脸也带名字', () => {
  const out = renderForwardMessages([
    { sender: { card: '顾鹤' }, message: [seg('text', { text: '干得好' }), seg('face', { id: '42' })] },
  ]);
  assert.ok(out.includes('顾鹤：干得好[表情:鼓掌]'), out);
});

t('faceName / faceLabel 直接调用', () => {
  assert.strictEqual(faceName({ id: '66' }), '爱心');
  assert.strictEqual(faceName({ id: '264', raw: { faceText: '/斜眼笑' } }), '斜眼笑');
  assert.strictEqual(faceName({ id: '498' }), '');
  assert.strictEqual(faceLabel({ id: '498' }), '[表情:#498]');
});

console.log(`\npass=${pass}`);
