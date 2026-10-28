/**
 * 直连 opencode-go 的看图描述。
 *
 * 为什么不再走 headless dsh 的 read_image：
 *  - dsh 每次描述都要 spawn 一个 420~450MB 的进程，群里甩图时机器吃不消；
 *  - 走 dsh 只能钉官方 deepseek-flash，官方余额就这么被一张两分钱地啃（2026-10-28 查清）；
 *  - go 的 deepseek-v4.1-flash 实测认图、认字都行（3/3 命中，3 秒左右），单价还低两个数量级。
 *
 * 2026-10-28 用户拍板：「默认用 flash」。kimi-k3 也能看图但一次贵 20~100 倍，
 * 要做成 config 里可切的备选（images.visionModel）。
 *
 * 两个坑记在这里，别再踩：
 *  1. go 端点必须带 x-opencode-session，否则 400 MissingSessionID；
 *  2. 这类模型会先推理再答，max_tokens 给 400 会被 reasoning 吃光、content 为空，要留 1000 以上。
 */
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

export const DEFAULT_VISION = {
  provider: 'go',
  model: 'deepseek-v4.1-flash',
  baseUrl: 'https://opencode.ai/inference/go/openai/v1',
  timeoutMs: 30000,
  maxTokens: 1200,
  session: 'qq-bridge-vision',
};

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

/** 合并 config.json 的 images 节，缺的走默认值 */
export function resolveVisionConfig(raw) {
  const s = raw?.images ?? {};
  const pick = (v, d) => (v === undefined || v === null || v === '' ? d : v);
  return {
    provider: String(pick(s.visionProvider, DEFAULT_VISION.provider)),
    model: String(pick(s.visionModel, DEFAULT_VISION.model)),
    baseUrl: String(pick(s.visionBaseUrl, DEFAULT_VISION.baseUrl)).replace(/\/+$/, ''),
    timeoutMs: Number(pick(s.visionTimeoutMs, DEFAULT_VISION.timeoutMs)) || DEFAULT_VISION.timeoutMs,
    maxTokens: Number(pick(s.visionMaxTokens, DEFAULT_VISION.maxTokens)) || DEFAULT_VISION.maxTokens,
    session: String(pick(s.visionSession, DEFAULT_VISION.session)),
  };
}

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'image/jpeg';
}

/**
 * POST 一个 JSON 并拿回文本响应体。
 *
 * 为什么不用全局 fetch（2026-10-28 踩）：这台机器 opencode.ai 只解析出 IPv6（AAAA），
 * 而 ECS 没有全局 IPv6 路由。Node 22 的 fetch/undici 会先试 IPv6，连不上就整条请求
 * 报 `fetch failed`（cause ETIMEDOUT，1 秒左右）——实测 8 次里 4 次这样，
 * 表现就是读图时灵时不灵。https.request 显式 `family: 4` 后 8/8 成功。
 */
export function httpsJsonPost({ url, headers, body, timeoutMs, family = 4 }) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error(`只支持 https：${url}`);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const req = https.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      family,
      headers: { ...headers, 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => done({ error: String(e?.message || e) }));
    });
    req.on('error', (e) => done({ error: String(e?.message || e), code: e?.code }));
    const timer = setTimeout(() => {
      req.destroy();
      done({ error: `超时（${timeoutMs}ms）`, timedOut: true });
    }, timeoutMs);
    req.end(body);
  });
}

/**
 * 直接把图发给 go 的视觉模型，拿回一段文字。
 * 返回 { ok, text, ms, model, usage, error }
 */
export async function describeImageWithGo({ file, prompt, key, model, baseUrl, timeoutMs, maxTokens, session }) {
  const started = Date.now();
  if (!key) return { ok: false, error: '缺 OPENCODE_GO_API_KEY', ms: 0 };
  let b64;
  try {
    b64 = fs.readFileSync(file).toString('base64');
  } catch (e) {
    return { ok: false, error: `读不到图片文件：${e.message}`, ms: Date.now() - started };
  }

  const body = {
    model,
    max_tokens: maxTokens,
    temperature: 0.2,
    stream: false,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mimeOf(file)};base64,${b64}` } },
      ],
    }],
  };

  try {
    const res = await httpsJsonPost({
      url: `${baseUrl}/chat/completions`,
      timeoutMs,
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        'x-opencode-session': session,
        // Cloudflare 前面挡着，默认 UA 会被 1010 掉
        'user-agent': 'curl/8.5.0',
      },
    });
    if (res.error) {
      return {
        ok: false,
        ms: Date.now() - started,
        timedOut: !!res.timedOut,
        error: res.timedOut ? `超时（${timeoutMs}ms）` : `${res.error}${res.code ? ` (${res.code})` : ''}`,
      };
    }
    const text = res.text;
    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        ms: Date.now() - started,
        status: res.status,
        error: `HTTP ${res.status} ${String(text).slice(0, 200)}`,
      };
    }
    let data;
    try { data = JSON.parse(text); } catch {
      return { ok: false, ms: Date.now() - started, error: `返回不是 JSON：${String(text).slice(0, 120)}` };
    }
    const msg = data.choices?.[0]?.message ?? {};
    const content = typeof msg.content === 'string' ? msg.content.trim() : '';
    const usage = data.usage ?? null;
    const cost = {
      listCost: data.list_cost ?? usage?.list_cost ?? null,
      allowance: data.allowance ?? usage?.allowance ?? null,
    };
    if (!content) {
      const rt = usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens ?? null;
      return {
        ok: false,
        ms: Date.now() - started,
        usage,
        error: `content 为空${rt ? `（reasoning 吃掉 ${rt} tokens，max_tokens 给太小）` : ''}`,
      };
    }
    return { ok: true, text: content, ms: Date.now() - started, model, usage, cost };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - started,
      timedOut: false,
      error: String(e?.message || e),
    };
  }
}
