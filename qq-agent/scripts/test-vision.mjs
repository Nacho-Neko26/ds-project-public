/**
 * 看图直连 go 的自检脚本。
 * 用法：node scripts/test-vision.mjs [图片路径] [--model deepseek-v4.1-flash]
 * 不带路径时自己从 workspace 里捞一张最近收到的图。
 *
 * 验收标准（都要看到）：
 *   - ok=true，且 JSON 里有非空 summary；
 *   - 打印出 model / 耗时 / tokens / 单价字段，方便和官方 2 分/张 对比。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { readCredential } from '../src/agent.mjs';
import { resolveVisionConfig, describeImageWithGo } from '../src/vision.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const modelFlag = argv.indexOf('--model');
let model = null;
if (modelFlag >= 0) { model = argv[modelFlag + 1]; argv.splice(modelFlag, 2); }
let file = argv[0];

function findRecentImage(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 2) return;
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) { walk(p, depth + 1); continue; }
      if (!/\.(jpe?g|png|webp|gif)$/i.test(it.name)) continue;
      try { out.push({ p, m: fs.statSync(p).mtimeMs, s: fs.statSync(p).size }); } catch {}
    }
  };
  walk(dir, 0);
  out.sort((a, b) => b.m - a.m);
  const pick = out.find((x) => x.s > 8 * 1024 && x.s < 2 * 1024 * 1024);
  return pick ? pick.p : null;
}

const cfg = loadConfig();
const vcfg = resolveVisionConfig(cfg.raw);
if (model) vcfg.model = model;

if (!file) {
  file = findRecentImage(path.join(root, 'workspace'));
  if (!file) {
    console.error('✗ 没给图片路径，workspace 里也没找到能测的图');
    process.exit(1);
  }
  console.log(`（没指定图片，用最近的一张：${path.relative(root, file)}）`);
}

const key = readCredential('OPENCODE_GO_API_KEY');
if (!key) {
  console.error('✗ 没找到 OPENCODE_GO_API_KEY');
  process.exit(1);
}

const prompt = [
  '只做一件事：直接看下面这张图，然后只输出一行 JSON，不要任何多余文字、不要代码块、不要调用工具。',
  '格式：{"summary":"一句话客观描述，40 字以内","tags":["搞笑"],"moodHints":["happy"],"use":["怼人"],"ocr":"图上文字原文，没有就空串"}',
  'tags 只能从这九个里挑 1~3 个：搞笑、可爱、攻击性、敷衍、安慰、日常、涩涩、破防、加油。',
  'moodHints 只能从这九个里挑 0~2 个：happy、encouraging、surprised、gentle、calm、confused、soft、sad、sleepy。',
  'use 是这张图适合拿去干什么，只能从这九个里挑 0~2 个：打招呼、道别、答应、拒绝、催促、安慰、夸人、看戏、接梗。',
  'ocr 原样抄下图上的字，一个字都不要改、不要翻译；没有文字就留空串。',
  'summary 要客观：不用第一人称、不加角色口吻；图里有文字就原样读出来。',
].join('\n');

const size = (() => { try { return fs.statSync(file).size; } catch { return 0; } })();
console.log(`图片：${file}  ${Math.round(size / 1024)}KB`);
console.log(`模型：${vcfg.model}  端点：${vcfg.baseUrl}`);

const r = await describeImageWithGo({ file, prompt, key, ...vcfg });

if (!r.ok) {
  console.error(`✗ 失败：${r.error}  (${r.ms}ms)`);
  process.exit(1);
}

console.log(`✓ ok  ${r.ms}ms  ${r.usage?.total_tokens ?? '?'} tokens  list_cost=${r.cost?.listCost ?? '?'}  allowance=${r.cost?.allowance ?? '?'}`);
console.log('— 原文 —');
console.log(r.text);

const jsonText = (r.text.match(/\{[\s\S]*\}/) || [null])[0];
if (!jsonText) {
  console.error('✗ 没拿到 JSON，下游 parseDescPayload 会空手而归');
  process.exit(1);
}
let obj;
try { obj = JSON.parse(jsonText); } catch (e) {
  console.error(`✗ JSON 解析失败：${e.message}`);
  process.exit(1);
}
const bad = [];
if (!obj.summary || typeof obj.summary !== 'string') bad.push('summary 空');
if (!Array.isArray(obj.tags)) bad.push('tags 不是数组');
if (!Array.isArray(obj.moodHints)) bad.push('moodHints 不是数组');
if (!Array.isArray(obj.use)) bad.push('use 不是数组');
if (typeof obj.ocr !== 'string') bad.push('ocr 不是字符串');
if (bad.length) {
  console.error(`✗ 字段不对：${bad.join('、')}`);
  process.exit(1);
}
console.log(`✓ 字段齐：summary="${obj.summary}" tags=${JSON.stringify(obj.tags)} mood=${JSON.stringify(obj.moodHints)} use=${JSON.stringify(obj.use)} ocr="${obj.ocr}"`);
