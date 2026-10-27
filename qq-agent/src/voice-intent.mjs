/**
 * 「对方明确要听语音」的识别。
 *
 * 背景：voiceHint 原来自带硬条件（心情必须是「高兴」、隔 3 分钟、非凌晨…），
 * 条件不满足就直接告诉模型「这轮不发语音」。结果主人说「发句语音听听」，
 * 模型也照这条推掉，还编理由（嗓子罢工）。所以主人点名的请求要单独放行。
 */

const ASK_VOICE = /(发|来|整|录|说)(一?[句条段个])?\s*语音|听听(你的?)?(声音|声儿)|语音(听听|来一句|发一句|说一句)/;

export function asksForVoice(text) {
  return ASK_VOICE.test(String(text ?? ''));
}

/**
 * 从回复里抽出语音指令行。
 * 语音内容不是正文：合成后单独发一条语音消息，行本身不显示。
 *
 * 支持的写法（都能混用，顺序无所谓）：
 *   __SEND_VOICE__ 诶……<emphasis>你咋才回</emphasis>啊<break time="0.4s"/>我都等半天了
 *   __VOICE_META__ {"emotion":"gentle","intensity":0.6,"scene":"凌晨一点，被窝里"}
 * 老写法 `__VOICE_SCENE__ 纯文本` 仍然认，转成 meta.scene。
 *
 * 桥的回复（index.mjs）和主动开口（selfwake.mjs）共用这一份。
 */
/** 一轮最多发几条语音（2026-10-25 用户要求「取消单位时间内发语音条数的限制」，允许一轮多条） */
export const MAX_VOICES_PER_REPLY = 5;

export function extractVoiceDirective(text) {
  const lines = String(text).split(/\r?\n/);
  const texts = [];
  let scene = '';
  let emotion = '';
  let intensity = null;
  const kept = [];
  for (const line of lines) {
    const t = line.trim();
    const m = t.match(/^__SEND_VOICE__\s+(.+)$/);
    if (m) {
      // 多行 = 多条语音，按顺序发；超过上限的丢掉，别把一轮拖成几十秒
      if (texts.length < MAX_VOICES_PER_REPLY) texts.push(m[1].trim());
      continue;
    }
    const meta = t.match(/^__VOICE_META__\s*(.*)$/);
    if (meta) {
      try {
        const j = JSON.parse(meta[1]);
        if (j && typeof j === 'object') {
          if (typeof j.scene === 'string') scene = j.scene.trim();
          if (typeof j.emotion === 'string') emotion = j.emotion.trim().toLowerCase();
          const n = Number(j.intensity);
          if (Number.isFinite(n)) intensity = Math.max(0, Math.min(1, n));
        }
      } catch { /* JSON 坏了就当没写，不阻塞发语音 */ }
      continue;
    }
    const s = t.match(/^__VOICE_SCENE__\s*(.*)$/);
    if (s) { scene = s[1].trim(); continue; }
    kept.push(line);
  }
  if (!texts.length) return null;
  return {
    text: texts[0],
    texts,
    scene,
    emotion,
    intensity,
    rest: kept.join('\n').trim(),
  };
}
