import { renderVoice, renderPlainVoice } from '../src/voice.mjs';

const vcfg = {
  bin: '/opt/tts/bin/edge-tts',
  ffmpeg: 'ffmpeg',
  dir: '/tmp/voice-test',
  voice: 'zh-CN-XiaoyiNeural',
  rate: '+0%',
  pitch: '+0Hz',
  maxChars: 80,
  breath: true,
  roomTone: true,
};

const line = '诶——你终于来了，等得我都快睡着了。';
console.log('render natural ...');
const a = await renderVoice(vcfg, { text: line, style: 'natural', mood: '正常' });
console.log(JSON.stringify(a));
console.log('render plain ...');
const b = await renderPlainVoice(vcfg, { text: '来啦？我等你好久了。' });
console.log(JSON.stringify(b));
