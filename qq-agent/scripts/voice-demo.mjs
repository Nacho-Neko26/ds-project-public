/**
 * 生成语音对比样片。
 *
 *   node scripts/voice-demo.mjs [输出目录]
 *
 * 用同一批台词，把「现状」和几种人性化处理各渲染一遍，
 * 输出 mp3 + manifest.json，本机再拼成试听页。
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../src/util.mjs';
import { renderPlainVoice, renderVoice } from '../src/voice.mjs';

const OUT = process.argv[2] || '/tmp/voice-demo-v2';
ensureDir(OUT);

const BIN = process.env.EDGE_TTS_BIN || '/opt/tts/bin/edge-tts';

const SCRIPTS = [
  {
    id: 'jiao',
    label: '撒娇 · 等你好久',
    text: '来啦？我等你好久了。',
    oral: '诶——你终于来了，等得我都快睡着了。',
  },
  {
    id: 'tu',
    label: '吐槽 · 又加班',
    text: '又加班啊，真惨。',
    oral: '啊……又加班。你们老板是不是有点毛病啊。',
  },
  {
    id: 'wan',
    label: '晚安 · 别熬太晚',
    text: '早点睡吧，明天见。',
    oral: '那我先睡啦，你也别熬太晚，晚安。',
  },
  {
    id: 'qi',
    label: '闹脾气 · 不理你了',
    text: '哼，不理你了。',
    oral: '哼——你再说一遍试试？我今天可没心情陪你玩。',
  },
];

const VARIANTS = [
  {
    id: 'a', label: '现状', note: '现在线上的读法：把文字原样念出来，不做处理',
    mode: 'plain', voice: 'zh-CN-XiaoyiNeural',
  },
  {
    id: 'b', label: '只改韵律', note: '还是念文字稿，但分句、变速、变调、句间停顿',
    mode: 'natural', voice: 'zh-CN-XiaoyiNeural', breath: false, roomTone: false,
  },
  {
    id: 'c', label: '口语稿 + 韵律', note: '换成口语稿，再加韵律，不加任何音效',
    mode: 'natural', voice: 'zh-CN-XiaoyiNeural', breath: false, roomTone: false,
  },
  {
    id: 'd', label: '口语稿 + 韵律 + 气口/底噪', note: '在 c 的基础上加吸气声和一点房间底噪，更像手机录的',
    mode: 'natural', voice: 'zh-CN-XiaoyiNeural', breath: true, roomTone: true,
  },
  {
    id: 'e', label: '台湾腔晓臻', note: '同 d，换 zh-TW-HsiaoChenNeural（软、尾音上扬）',
    mode: 'natural', voice: 'zh-TW-HsiaoChenNeural', breath: true, roomTone: true,
  },
  {
    id: 'f', label: '晓晓提亮', note: '同 d，换 zh-CN-XiaoxiaoNeural，语速 +8%、音高 +25Hz',
    mode: 'natural', voice: 'zh-CN-XiaoxiaoNeural', rate: '+8%', pitch: '+25Hz', breath: true, roomTone: true,
  },
  {
    id: 'g', label: '活泼版晓伊', note: '同 d，但抖得更大、语速更快，适合开心的时候',
    mode: 'lively', voice: 'zh-CN-XiaoyiNeural', breath: true, roomTone: true,
  },
];

const base = {
  bin: BIN,
  ffmpeg: process.env.FFMPEG || 'ffmpeg',
  dir: OUT,
  voice: 'zh-CN-XiaoyiNeural',
  rate: '+0%',
  pitch: '+0Hz',
  maxChars: 80,
};

const manifest = [];

for (const s of SCRIPTS) {
  for (const v of VARIANTS) {
    const text = v.mode === 'plain' || v.id === 'b' ? s.text : s.oral;
    const vcfg = {
      ...base,
      voice: v.voice,
      rate: v.rate || '+0%',
      pitch: v.pitch || '+0Hz',
      breath: v.breath !== false,
      roomTone: v.roomTone !== false,
    };
    const started = Date.now();
    try {
      const out = v.mode === 'plain'
        ? await renderPlainVoice(vcfg, { text })
        : await renderVoice(vcfg, {
          text,
          style: v.mode,
          voice: v.voice,
          mood: s.id === 'qi' ? '生气' : '正常',
          rate: v.rate || '+0%',
          pitch: v.pitch || '+0Hz',
        });
      const name = `${s.id}-${v.id}.mp3`;
      fs.copyFileSync(out.file, path.join(OUT, name));
      manifest.push({
        script: s.id, scriptLabel: s.label, variant: v.id, label: v.label, note: v.note,
        mode: v.mode, voice: v.voice, rate: v.rate || '+0%', pitch: v.pitch || '+0Hz',
        text, file: name, durationMs: out.durationMs ?? null, chunks: out.chunks ?? 1,
        renderMs: Date.now() - started,
      });
      console.log(`ok  ${s.id}-${v.id}  ${Date.now() - started}ms  ${out.name}`);
    } catch (e) {
      console.error(`ERR ${s.id}-${v.id}  ${e.message}`);
      manifest.push({ script: s.id, variant: v.id, label: v.label, error: e.message });
    }
  }
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(`\n${manifest.filter((m) => !m.error).length}/${manifest.length} ok -> ${OUT}`);
