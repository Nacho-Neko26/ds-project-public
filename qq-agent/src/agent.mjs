import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { log, ensureDir, stripAnsi } from './util.mjs';
import { char, defaultNick } from './character.mjs';
import { renderEmotionBlock, renderAngerLine } from './emotion.mjs';
import { renderExpressionBlock } from './expression.mjs';
import { tierVoice } from './tiers.mjs';
import { readMode as readModelMode, writeMode as writeModelMode, looksLikeProviderFailure } from './model-mode.mjs';

/** 无工具时禁用的插件行 */
const TOOL_ROWS = [
  'tool-pwsh', 'tool-bash', 'tool-jobs', 'tool-fs', 'tool-fs-search',
  'tool-skill', 'skill', 'skill-filesystem', 'commands',
  'tool-subagent', 'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent-fork',
  'tool-workflow', 'tool-todo', 'tool-goal', 'tool-web',
  'tool-working-directory', 'tool-plugin-manager',
];

/**
 * 「只联网」模式：只留 tool-web，其余全关。
 * 给普通群友用——他们能查天气/新闻/百科，但碰不到文件、shell、子代理。
 */
const WEB_ONLY_ALLOWED = new Set(['tool-web']);

/**
 * 找到 dsh 启动入口。
 * 不走 .cmd（Windows 下 spawn 需要 shell 会有引号地狱），
 * 而是解析 shim 拿到 NODE_PATH 和 bin.js，直接用 node 起。
 */
export function resolveDsh() {
  const binDir = process.env.QB_DSH_BIN_DIR
    ?? path.join(os.homedir(), '.dsh-runtime', 'dsh', 'node_modules', '.bin');
  const cmdShim = path.join(binDir, 'dsh.cmd');
  const fallback = {
    node: process.execPath,
    script: null,
    nodePath: process.env.NODE_PATH ?? '',
    binDir,
  };

  if (!fs.existsSync(cmdShim)) return fallback;
  const text = fs.readFileSync(cmdShim, 'utf8');

  const m = text.match(/NODE_PATH=([^"\r\n]+)/);
  const nodePath = m ? m[1].trim() : '';
  const script = path.resolve(binDir, '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

  return {
    node: process.execPath,
    script: fs.existsSync(script) ? script : null,
    nodePath,
    binDir,
  };
}

/** 从 dsh 凭证库读 API Key（headless profile 没有挂 credentials 插件，只能走环境变量） */
export function readCredential(name = 'DEEPSEEK_API_KEY') {
  if (process.env[name]) return process.env[name];
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const file = path.join(home, '.credentials.yaml');
  if (!fs.existsSync(file)) return '';
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(new RegExp(`^\\s*${name}:\\s*(\\S+)\\s*$`, 'm'));
  return m ? m[1] : '';
}

/**
 * 解析 `dsh --json` 的 NDJSON 事件流。
 * 返回 { found, text, usage }；usage 是本次所有 step 的累计。
 */
function parseRunEvents(raw) {
  let text = null;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  for (const line of String(raw || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; }
    if (ev.type === 'final' && typeof ev.text === 'string') text = ev.text;
    const u = ev.usage ?? ev.data?.usage;
    if (u) {
      usage.inputTokens += Number(u.inputTokens) || 0;
      usage.outputTokens += Number(u.outputTokens) || 0;
      usage.cacheReadTokens += Number(u.cacheReadTokens) || 0;
    }
  }
  if (text === null) return { found: false };
  usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens;
  return { found: true, text, usage };
}

function yamlString(s) {
  // JSON 字符串同时是合法的 YAML 双引号标量
  return JSON.stringify(s);
}

export class AgentRunner {
  constructor(cfg) {
    this.cfg = cfg;
    this.dsh = resolveDsh();
    this.patchesDir = ensureDir(cfg.patchesDir);
    this.personaPatch = path.join(this.patchesDir, 'generated-persona.yml');
    this.noToolsPatch = path.join(this.patchesDir, 'generated-no-tools.yml');
    this.webOnlyPatch = path.join(this.patchesDir, 'generated-web-only.yml');
    this.chatPatch = path.join(this.patchesDir, 'generated-chat.yml');
    this.describePatch = path.join(this.patchesDir, 'generated-describe.yml');
    this.personaMtime = 0;
    // 2026-10-27：服务器日常走中转站（provider relay21r），官方留作备用。
    // headless profile 没挂 credentials 插件，apiKeyEnv 只能从子进程环境变量解析，
    // 所以两个 key 都得带进去：中转 key → RELAY_API_KEY，官方 key → DEEPSEEK_API_KEY。
    this.apiKey = readCredential('DEEPSEEK_API_KEY');
    this.relayKey = readCredential('RELAY_API_KEY') || this.apiKey;
    // 两条路的 overlay patch：谁 active 就挂谁，见 src/model-mode.mjs
    this.modelPatches = {
      relay: path.join(this.patchesDir, 'generated-model-relay.yml'),
      official: path.join(this.patchesDir, 'generated-model-official.yml'),
    };
    this.#writeModelPatches();

    if (!this.apiKey) {
      log('warn', '没找到 DEEPSEEK_API_KEY（环境变量和 ~/.dsh/.credentials.yaml 里都没有）');
    }
    if (!this.relayKey) {
      log('warn', '没找到 RELAY_API_KEY，中转站路由会以 MISSING_CREDENTIAL 失败');
    }
    if (!this.dsh.script) {
      log('warn', `没找到 dsh 入口：${this.dsh.binDir}；可用 QB_DSH_BIN_DIR 指定`);
    }
    this.#writeNoToolsPatch();
  }

  #writeNoToolsPatch() {
    fs.writeFileSync(this.noToolsPatch, this.#toolRows(), 'utf8');
    // 只联网：除了 tool-web 以外全禁用
    const rows = TOOL_ROWS
      .filter((id) => !WEB_ONLY_ALLOWED.has(id))
      .map((id) => `- id: ${id}\n  disabled: true`)
      .join('\n');
    fs.writeFileSync(this.webOnlyPatch, rows + '\n', 'utf8');
  }

  /**
   * 图片描述专用的极简系统提示。
   * 不挂这个的话，默认是「编码 agent」，模型会自己去翻文件系统找图，
   * 一路跑到超时（踩过这个坑）。
   */
  #writeDescribePatch() {
    const text = [
      '你只做一件事：读取指定的图片，用一两句简体中文客观描述它。',
      '必须先用 read_image 工具读那张图，不要去找别的文件，不要执行别的命令，不要探查目录。',
      '描述画面内容与情绪；如果有文字，原样读出。',
      '不要用第一人称，不要加角色口吻，不要解释，只输出描述本身。',
    ].join('\n');
    const yaml = [
      '- id: system-prompt',
      '  config:',
      '    includeHarnessIdentity: false',
      `    personaPrefix: ${JSON.stringify(text)}`,
      '',
      // 读图这条路必须钉死一个「能吃图片输入」的模型。
      // 中转的 deepseek-v4.1-flash 不支持图片，read_image 会直接报
      // model does not support image input —— 2026-10-28 她对着一张图说「看不了」就是这个。
      // 官方 deepseek-flash 支持，所以图片描述单独走官方，跟聊天走哪条线无关。
      '- id: agent-default-model',
      '  config:',
      '    provider: deepseek-official',
      '    model: deepseek-flash',
      '',
    ].join('\n');
    fs.writeFileSync(this.describePatch, yaml, 'utf8');
  }

  #writePersonaPatch() {
    const file = this.cfg.personaFile;
    if (!fs.existsSync(file)) throw new Error(`人设文件不存在：${file}`);
    const stat = fs.statSync(file);
    if (stat.mtimeMs === this.personaMtime) return;
    const persona = fs.readFileSync(file, 'utf8').trim();

    // 带工具的路径：完整人设，保留 runtime context（工具要靠它知道 cwd / 权限）
    const withCtx = [
      '- id: system-prompt',
      '  config:',
      '    includeHarnessIdentity: false',
      `    personaPrefix: ${yamlString(persona)}`,
      '',
    ].join('\n');
    fs.writeFileSync(this.personaPatch, withCtx, 'utf8');

    // 纯聊天路径：2026-10-27 用户要求「聊天时不再禁用任何插件和工具」，
    // 所以和人设 patch 用同一份内容——保留 runtime context（工具要知道 cwd / 权限），
    // 也不再逐条 disabled。能不能真动手由 DSH_PERMISSION_MODE 管（见 run()）。
    fs.writeFileSync(this.chatPatch, withCtx, 'utf8');

    this.personaMtime = stat.mtimeMs;
    log('info', `人设已同步（${persona.length} 字）`);
  }

  /** 无工具补丁里那串 disabled 插件行 */
  #toolRows() {
    return TOOL_ROWS.map((id) => `- id: ${id}\n  disabled: true`).join('\n') + '\n';
  }

  /**
   * 写两条模型路线各自的 overlay patch。
   * profile 里 agent-default-model 已经指向中转，所以「官方」这份是覆盖用的；
   * 「中转」这份用于自己切回中转（或者 guard 切回来）后明确写死。
   */
  #writeModelPatches() {
    const write = (file, provider, model, effort = 'high') => {
      const yaml = [
        '- id: agent-default-model',
        '  config:',
        `    provider: ${provider}`,
        `    model: ${model}`,
        ...(effort ? [`    reasoningEffort: ${effort}`] : []),
        '',
      ].join('\n');
      try {
        if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== yaml) {
          fs.writeFileSync(file, yaml, 'utf8');
        }
      } catch (e) {
        log('warn', `写模型 patch 失败：${file}`, e.message);
      }
    };
    write(this.modelPatches.relay, 'opencode-go', 'deepseek-v4.1-flash', null);
    write(this.modelPatches.official, 'deepseek-official', 'deepseek-flash');
  }

  /**
   * 跑一次 dsh headless，返回它输出的正文。
   *
   * toolMode：
   *   'full' → 全部工具（可信用户）
   *   'web'  → 只留 tool-web，能搜网页但碰不到文件/shell（普通群友被 @ 时）
   *   'none' → 不给工具（默认）
   */
  async run({ prompt, toolMode = 'none', withTools, permissionMode, persona = true, extraPatch = null, modelPatch = true, timeoutMs = 0 }) {
    if (!this.dsh.script) throw new Error('dsh 入口未找到');
    // 兼容老调用：withTools: true 等价于 toolMode: 'full'
    const mode = withTools === true ? 'full' : (withTools === false ? 'none' : toolMode);
    const hasTools = mode !== 'none';
    if (persona) this.#writePersonaPatch();

    const baseArgs = () => {
      const args = ['--profile', this.cfg.raw.agent.profile];
      if (persona) {
        // 2026-10-27 用户要求「聊天时不再禁用任何插件和工具」：
        // 聊天和工具走同一份人设 patch，能做什么由 DSH_PERMISSION_MODE 决定。
        args.push('--patch', this.personaPatch);
      } else if (!hasTools) {
        args.push('--patch', this.noToolsPatch);
      }
      if (mode === 'web') args.push('--patch', this.webOnlyPatch);
      if (extraPatch) args.push('--patch', extraPatch);
      return args;
    };

    const env = {
      ...process.env,
      NODE_PATH: this.dsh.nodePath,
      DEEPSEEK_API_KEY: this.apiKey,
      RELAY_API_KEY: this.relayKey,
      // 可信用户：只能改 qq-agent/workspace 里的东西
      // 只联网模式：read-only，最多查查网页
      DSH_PERMISSION_MODE: permissionMode ?? (mode === 'full' ? 'workspace-write' : 'read-only'),
      DSH_TELEMETRY_MODE: 'FEEDBACK_ONLY',
    };
    // --json 让 dsh 输出每步的 usage，桥就能记账；老版本 dsh 不认这个参数，失败会退回纯文本再跑一次
    const wantJson = this.cfg.raw.agent?.jsonEvents !== false;

    // 当前该走哪条：relay（日常）还是 official（中转挂了时的兜底）
    const st = readModelMode(this.cfg);
    const route = st.mode === 'official' ? 'official' : 'relay';
    const runOnce = async (r) => {
      // modelPatch: false 时完全不挂路线 patch —— 图片描述要把模型钉在能吃图的官方模型上，
      // 这里再追加一次 relay21r 会把它覆盖回去（2026-10-28 踩过：patch 写了官方，还是走中转）。
      const args = [...baseArgs(), ...(modelPatch ? ['--patch', this.modelPatches[r]] : [])];
      const out = await this.#spawn([...args, ...(wantJson ? ['--json'] : []), prompt], env, timeoutMs);
      return this.#finish(out, wantJson);
    };

    let result = await runOnce(route);
    if (wantJson && !result.ok && this.#looksLikeUnknownFlag(result.stderr)) {
      log('warn', 'dsh 不支持 --json，退回纯文本模式');
      const args = [...baseArgs(), ...(modelPatch ? ['--patch', this.modelPatches[route]] : []), prompt];
      const plain = await this.#spawn(args, env, timeoutMs);
      return { ...plain, text: stripAnsi(plain.stdout).trim(), usage: null, route };
    }

    // 中转这轮挂了 → 当场切官方重跑一次，别让用户这句话落空
    if (!result.ok && route === 'relay' && looksLikeProviderFailure(result.stderr, result.timedOut)) {
      log('warn', '中转这次没成，本次改走官方重试');
      const next = writeModelMode(this.cfg, { mode: 'official', reason: 'run-failed' });
      log('info', `模型路线切到官方（${next.mode}，since ${new Date(next.since).toISOString()}）`);
      this.lastFailover = Date.now();
      const retry = await runOnce('official');
      if (retry.ok) return { ...retry, route: 'official', failover: true };
      return { ...retry, route: 'official', failover: true };
    }

    // 走官方的时候每轮记一行，方便回头看中转挂了多久；走中转不记，免得日志灌满
    if (route === 'official') log('info', '本轮走官方（中转不可用期间）');
    return { ...result, route };
  }

  /** 把一次 #spawn 的原始输出整理成 { ok, text, … } */
  #finish(first, wantJson) {
    const raw = stripAnsi(first.stdout).trim();
    const parsed = wantJson ? parseRunEvents(raw) : { found: false };
    let text = raw;
    if (parsed.found) text = parsed.text;
    else if (wantJson && /^\{"type":/m.test(raw)) text = '';

    if (first.code !== 0 || !text) {
      log('warn', `dsh 运行异常 (code=${first.code}, ${first.elapsed}ms${first.timedOut ? ', 超时' : ''})`, first.stderr.slice(-800));
      return { ok: false, text: '', elapsed: first.elapsed, stderr: first.stderr, timedOut: first.timedOut, usage: parsed.usage ?? null };
    }
    return { ok: true, text, elapsed: first.elapsed, stderr: first.stderr, usage: parsed.usage ?? null };
  }

  #looksLikeUnknownFlag(stderr) {
    return /unknown option|Unknown argument|--json/i.test(String(stderr || ''));
  }

  /** 起一次 dsh 子进程，返回 { code, elapsed, stdout, stderr, timedOut } */
  async #spawn(args, env, budgetMs = 0) {
    const startedAt = Date.now();
    const child = spawn(this.dsh.node, [this.dsh.script, ...args], {
      cwd: this.cfg.agentCwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });

    const timeoutMs = budgetMs || this.cfg.raw.agent.taskTimeoutMs;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      } catch { /* ignore */ }
    }, timeoutMs);

    const code = await new Promise((resolve) => {
      child.on('close', resolve);
      child.on('error', (e) => {
        stderr += `\n[spawn error] ${e.message}`;
        resolve(-1);
      });
    });
    clearTimeout(timer);

    return { code, elapsed: Date.now() - startedAt, stdout, stderr, timedOut };
  }

  /**
   * 把本地图片交给 headless 的 read_image 工具，拿回一段客观文字描述。
   * 用中立提示、不挂人设；工具开但权限只读。
   */
  async describeImage(file, hint = '', opts = {}) {
    // 大图先压小再送视觉模型（2026-10-28 用户要求：自动压缩、20 秒超时）
    const slim = await slimForVision(file, this.cfg.raw.voice?.ffmpeg || 'ffmpeg');
    if (slim.slim) log('info', `图片压缩 ${Math.round(slim.from / 1024)}KB → ${Math.round(slim.to / 1024)}KB`);
    const visionFile = slim.path;
    // 动图拆帧拼图：一张网格图里塞了 N 帧，视觉模型很容易当成「N 张小图」来描述，
    // 于是角色在群里说「这十六张砸过来」（2026-10-26 用户抓到）。这里先把口径说死。
    const film = opts.filmstrip && Number(opts.filmstrip.frames) > 1 ? Number(opts.filmstrip.frames) : 0;
    const prompt = [
      '只做一件事：用 read_image 工具读取下面的图片，然后只输出一行 JSON，不要任何多余文字、不要代码块。',
      '格式：{"summary":"一句话客观描述，40 字以内","tags":["搞笑"],"moodHints":["happy"],"use":["怼人"],"ocr":"图上文字原文，没有就空串"}',
      film
        ? `注意：这是一张「动图拆帧拼图」——同一张动图的 ${film} 帧按时间顺序拼在一张网格图里（左上→右下）。`
          + `把它当成一个连贯的动作来描述：说清发生了什么、怎么变化；不许说成「${film} 张图」「多张小图」，也不要逐格罗列。`
        : '',
      'tags 只能从这九个里挑 1~3 个：搞笑、可爱、攻击性、敷衍、安慰、日常、涩涩、破防、加油。',
      'moodHints 只能从这九个里挑 0~2 个：happy、encouraging、surprised、gentle、calm、confused、soft、sad、sleepy。',
      // 2026-10-28 用户要「情绪、用途、图上文字一次给全，别再回头从描述里推断」。
      // 描述是给人看的散文，用途是给检索用的标签，两者别混在一个字段里。
      'use 是这张图适合拿去干什么，只能从这九个里挑 0~2 个：打招呼、道别、答应、拒绝、催促、安慰、夸人、看戏、接梗。',
      'ocr 原样抄下图上的字，一个字都不要改、不要翻译；没有文字就留空串。',
      'summary 要客观：不用第一人称、不加角色口吻；图里有文字就原样读出来。',
      hint ? '（图片可能来自聊天气泡，附注：' + hint + '）' : '',
      '图片路径：' + visionFile,
    ].filter(Boolean).join('\n');
    this.#writeDescribePatch();
    return this.run({
      prompt,
      withTools: true,
      permissionMode: 'read-only',
      persona: false,
      extraPatch: this.describePatch,
      modelPatch: false,
      timeoutMs: 20000,
    });
  }
}

/**
 * 送进视觉模型前先把图压小。
 * 2026-10-28 用户要求「网页图片自动压缩，不要卡很久，20s 超时」：
 * 大图会让 read_image 的工具往返拖到十几秒还不稳，先按最长边 1280 重编码成 JPEG。
 */
async function slimForVision(file, ffmpeg = 'ffmpeg') {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return { path: file, slim: false }; }
  if (size <= 200 * 1024) return { path: file, slim: false };
  const out = path.join(os.tmpdir(), `vision-${Date.now()}-${path.basename(file, path.extname(file))}.jpg`);
  const args = [
    '-y', '-i', file,
    '-vf', "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease",
    '-q:v', '4', out,
  ];
  const ok = await new Promise((resolve) => {
    try {
      const c = spawn(ffmpeg, args, { windowsHide: true, stdio: 'ignore' });
      c.on('close', (code) => resolve(code === 0));
      c.on('error', () => resolve(false));
    } catch { resolve(false); }
  });
  let to = 0;
  try { if (ok) to = fs.statSync(out).size; } catch { to = 0; }
  if (!to) return { path: file, slim: false };
  return { path: out, slim: true, from: size, to };
}

/**
 * 群聊「没人点名」时的主动接话概率文案。
 * config.json → reply.groupChance：{ default: [0.2, 0.4], '200000002': [0.5, 0.7] }
 * 按群号覆盖，没配就回落 default；配坏了也回落，不报错。
 */
export function groupChancePair(cfg, chatKey, boost = false) {
  const map = cfg?.raw?.reply?.groupChance;
  const toPair = (v) => (Array.isArray(v) && v.length >= 2 && v.every((n) => Number.isFinite(Number(n))) ? v : null);
  const def = toPair(map?.default) || [0.2, 0.4];
  const gid = String(chatKey || '').replace(/^group:/, '');
  const cur = (gid && toPair(map?.[gid])) || def;
  // 2026-10-27 用户定：被 @ 唤醒后临时升一档，也就是整段往上挪 20 个点，封顶 100%
  let pair = cur;
  if (boost) {
    const lo = Math.min(1, Number(cur[0]) + 0.2);
    let hi = Math.min(1, Number(cur[1]) + 0.2);
    // 单值（比如 0 档就是 0~0）往上挪会变成 20~20，那不是一档；不够 20 个点的宽度就补上
    if (hi < 1 && hi - lo < 0.2 - 1e-9) hi = Math.min(1, lo + 0.2);
    pair = [lo, hi];
  }
  const clamp1 = (n) => Math.max(0, Math.min(1, Number(n)));
  return [clamp1(pair[0]), clamp1(pair[1])];
}

/** 同一个概率区间的文案版（写进 prompt 给人看的那句）。 */
export function groupChanceLabel(cfg, chatKey, boost = false) {
  const [lo, hi] = groupChancePair(cfg, chatKey, boost);
  return `${Math.round(lo * 100)}%~${Math.round(hi * 100)}%`;
}

/** 真掷骰：区间里均匀取一个点再掷一次，返回 { hit, pct }。 */
export function rollGroupChance(cfg, chatKey, boost = false, rnd = Math.random) {
  const [lo, hi] = groupChancePair(cfg, chatKey, boost);
  const p = hi > lo ? lo + rnd() * (hi - lo) : lo;
  return { hit: rnd() < p, pct: Math.round(p * 100) };
}

/**
 * 群聊里「这一条要不要喂给模型」的判定（纯函数，方便单测）。
 *
 * 2026-10-28 用户定：「加一个『被 @ 之后 N 分钟内的消息也跟着喂』设置为 5 分钟」，
 * 并指出「根本没有概率回话这回事，就是不 @ 就不会回复」——原来桥侧在这之前就 return 了。
 *
 * 规则：
 *   ① 被 @ / 叫了「溟月」→ 进，且刷新 wakeUntil，这一轮必须回；
 *   ② 刷新过之后 wakeWindowMinutes 分钟内 → 进，但不强制回（让她接着聊）；
 *   ③ 其余 → 按 reply.groupChance 真掷骰，命中才进；
 *   ④ mention 模式的群不掷骰、不开窗口，只认被叫。
 *
 * @returns {{accept:boolean, reason:''|'called'|'wake'|'roll', pct:number, wakeUntil:number}}
 *          reason：'' = 不进（静默）／'called' 被叫／'wake' 窗口内／'roll' 掷骰中了
 */
export function pickGroupMessage({
  cfg, chatKey, mode = 'full', calledNow = false, wakeUntil = 0, now = Date.now(), rnd = Math.random,
}) {
  const wakeMs = Math.max(0, Number(cfg?.raw?.reply?.wakeWindowMinutes ?? 5)) * 60_000;
  const nextWake = calledNow && wakeMs > 0 ? now + wakeMs : Number(wakeUntil) || 0;

  if (calledNow) return { accept: true, reason: 'called', pct: 0, wakeUntil: nextWake };
  if (mode === 'mention') return { accept: false, reason: '', pct: 0, wakeUntil: nextWake };
  if (now < nextWake) return { accept: true, reason: 'wake', pct: 0, wakeUntil: nextWake };

  const roll = rollGroupChance(cfg, chatKey, false, rnd);
  return { accept: roll.hit, reason: roll.hit ? 'roll' : '', pct: roll.pct, wakeUntil: nextWake };
}

/** 组装送给模型的一轮输入 */
export function buildPrompt({
  cfg, chat, sender, newLines, history, trusted, extra, state, anger, favor, notebook, soothe, diary, habits, memory, balance, balanceFact, summary, backtrack, brief, ambient, identity, speakers,
}) {
  const where = chat.kind === 'group'
    ? `群聊「${chat.title}」（群里还有别人，你说的话所有人都看得到）`
    : '私聊';

  // 身份槽位（config.json → persona.character）。全是空的就退成中性说法，
  // 不会把 {{...}} 占位符发出去。
  const aliases = char().aliases;
  const aliasHint = aliases.length ? `（${aliases.join('、')}）` : '';
  const nick = defaultNick('');
  const improv = char().improvWorld;

  const rules = [
    '（按你的人设回这条消息：只输出要发出去的正文，不要任何前缀、引号、解释。）',
    // 2026-10-25 用户第 2 次抓到思考泄漏（私聊 22:14 那条 112 字里两段是模型写给自己看的权衡）。
    // prompt 这条只是第一层，桥侧还有 stripThinkingLeak 兜底，两层一起改。
    '（**你写下的每一个字都会原样发到 QQ，对面看得见。**所以不要写分析、权衡、计划、内心独白——'
    + '像「他发了个表情，估计就是随便逗一下」「我回一句就好」「这轮要不要配一张」「简短点回」这种写给自己看的判断，'
    + '一个字都不许出现在输出里。要有内心戏，就用角色的话说出来（「哼，就一个表情啊」），而不是先写一句分析再写正文。）',
    // 2026-10-26 事故：群里一条 `#翻唱整首美人鱼` 被当工作项跑，回报把 markdown 和
    // `EACCES: permission denied, open '.../data/cover/queue/.mvopcb33l3bp.tmp'` 原样发进群。
    // 这层是 prompt，桥侧 runWorkItem 还有 cleanToolReport 兜底，两层一起改。
    '（用工具干活的时候，回报只说结果一两句：不要贴 markdown 标题/列表/表格、不要代码块、'
    + '不要报错堆栈和路径原文、不要命令回显。失败就说哪一步没成，一句话。）',
  ];
  if (chat.kind === 'group') {
    // 2026-10-25 用户定稿（微信/QQ 同一套）：先判对象，命中三种必应；都不满足才概率接话。
    // 概率按群可配（config.json → reply.groupChance），没配就用 default。
    const chance = groupChanceLabel(cfg, chat.key, chat.chanceBoost === true);
    rules.push(
      '（开口前先判断这句话是不是对你说的。必应的三种：① 被 @你；② 被叫你的名字或外号' + aliasHint + '；'
      + '③ 有人直接问你。三种都不满足时，只有话题真的戳到你、你也有话说，才按 ' + chance + ' 的概率接一句；'
      + '没兴趣、插不上嘴的——输出 ' + cfg.raw.reply.silenceToken + ' 安静待着，不吭声最像真人。）',
      '（看清 @ 的是谁：只有「@你」是在叫你。「@号主」是别人在跟你的主人说话，'
      + '「@群友」是别人在跟别人说话——这两种**别当成在跟你说**，默认不接。'
      + '例外：那条消息里直接喊了你的名字，或者明显在问你（「你觉得呢」这类），再开口。）',
      '（只说自己该说的话：不替任何人回答，不帮别人接话，不模拟别人的语气。'
      + '不回成对话体/剧本——不准出现「张三：……」「我：……」这类前缀，也不准在同一条回复里扮演两个角色。'
      + '回应时不要复述对方署名，不说「李四你说得对」，直接说内容。）',
      '（**不要每句都引用对方**。群里默认不带引用，正常接话直接说就行；只有你回的那句指向不清——'
      + '对方一口气发了好几条、群里同时有好几个人在说、或者你要接的是更早的某一句——才在正文最前面单独写一行 __QUOTE__，'
      + '桥会把这条挂到对方那条消息下面。一条消息最多引用一次，别把每句都挂成回复，看着像在开批斗会。）',
      '（少而精比每条都回更像真人。但别明明想说却憋着——对味的点就主动插一句，'
      + '也别为了刷存在感硬凑。）',
      '（发出去的样子：一条消息里不换行，句子之间用空格或逗号断开，句尾常不带句号；'
      + '需要停顿就拆成两条——写成两行短句（每行不超过 20 字、合计不超过 40 字），或用 <分> 分隔，桥会自动分开发送。）',
      '（群里出现值得长期记住的东西——新梗、群友的外号/称呼偏好、口头禅、群里的约定——'
      + '如果手里有 knowledge_write_node 工具，就记进知识库 base="group"（群里的新知识）：标题一句话说清是什么，'
      + '正文写清谁先说/什么意思/什么场合用，最后一行用「什么时候该想起它：」开头写清触发场景。'
      + '不记联网查到的资料、通用知识、教程、一次性闲聊——那些不存。'
      + '别每条都记，只记「以后还用得到」的，拿不准就先不记。发言前先扫一眼知识库大纲，命中了就 knowledge_read 取正文再回。）',
    );
  } else {
    rules.push('（如果你判断这会儿不该插话，就只输出 ' + cfg.raw.reply.silenceToken + '。）');
    // 2026-10-25 从聊天记录总结出来的：他对你的说话方式，比「人设」更管用的三条。
    rules.push(
      '（他说话很短，常常一句话只有一个意思、还省掉主语。别把他的省字当成病句去补全、也别追问「你是说……吗」，'
      + '按你理解的那个意思直接答。）',
      '（他要的是结果，不是过程。做完了就说做完了、哪一步没成，不要汇报「我准备怎么做」。）',
      '（他说「继续」就是接着上一件事往下做，别重新确认、别问要不要重新开始。）',
    );
  }
  if (trusted) {
    rules.push('（对方是号主信任的人：需要查资料/看文件/跑命令就直接用工具，别客气。）');
  } else {
    rules.push('（本轮你没有工具可用，只能聊天；需要动手的事就说让号主来做。）');
  }
  if (extra) rules.push(extra);

  const parts = [
    `【场景】${where}`,
  ];

  if (state) {
    const block = [];
    if (state.expression) {
      block.push(renderExpressionBlock(state.expression));
      if (state.anger) block.push(renderAngerLine(state.anger));
    } else if (state.emotion) {
      block.push(renderEmotionBlock(state));
    } else {
      block.push(
        '【当前状态】',
        `${state.date ? `${state.date} ` : ''}${state.time}｜饱腹：${state.hunger}`
          + (state.anger ? `｜怒气档位：${state.anger.name}（Lv${state.anger.lv}）` : '')
          + `｜群：${state.groupName}`,
      );
      if (state.anger) block.push(`【现在的脾气】${state.anger.text}`);
    }
    if (state.callName) block.push(`【称呼】这人你叫他「${state.callName}」。`);
    if (state.anger?.lv >= 2) {
      block.push(nick
        ? `（Lv2 起不再叫「${nick}」，改叫名字或「你」；越生气越客气。）`
        : '（Lv2 起不再叫外号，改叫名字或「你」；越生气越客气。）');
    }
    if (state.anger?.reconcile) {
      block.push(
        '（刚被哄好：这一轮必须有和解信号——恢复叫' + (nick ? `「${nick}」` : '回正常称呼') + '，主动补一句小的关心或帮忙，'
        + '再留一句尾巴。例：「……这次算了。你别熬夜了，我盯着。」「我不是生气，就是困。」）',
      );
    }
    if (state.anger?.repeatOffender) {
      block.push(
        '（这人不是头一回开这种玩笑了。你可以提一句「你上次也这样」，'
        + '但别演成记仇——你记的是「这人爱开这种玩笑」，不是「我恨这个人」。）',
      );
    }
    if (state?.favor) {
      const f = state.favor;
      // 档位中文名和「怎么对他」分开写：前者给状态看，后者给表演用
      const TIER_NAME_CN = {
        stranger: '看见就不爽', known: '陌生人', acquaintance: '眼熟的一般人', friend: '会交谈的熟人',
        closeness: '普通朋友', important: '关系很好的朋友',
        confidant: '朋友之上恋人未满', bond: '恋人爱人',
      };
      const TIER = {
        stranger: '看你就不顺眼，别指望好脸色',
        known: '陌生人，客气但疏远',
        acquaintance: '眼熟的一般人，能配合两句',
        friend: '会交谈的熟人，回得热一点',
        closeness: '普通朋友，会主动找他说话，可以被他点歌',
        important: '关系很好的朋友，听他的话，记事本、点唱都行',
        confidant: '朋友之上恋人未满，会吃醋会撒娇，亲近不设防',
        bond: '恋人爱人，彻底是自己人',
      };
      const TH = [
        [50, '发语音'], [60, '发表情'], [180, '设提醒、#指令'],
        [360, '点歌/转发素材/记事本'], [660, '点唱'], [1080, '什么都好说'],
      ];
      const able = TH.filter(([at]) => f.favor >= at).map(([, t]) => t);
      // 第五档起换成 tiers.mjs 里那一整段「怎么对他」；1~4 档还用这句短的
      const tv = tierVoice(f.tier, { isGroup: chat.kind === 'group' });
      block.push(`【你对这人的好感】${Math.round(Number(f.favor) || 0)}/2400（${TIER_NAME_CN[f.tier] || f.tier}）${tv ? '' : `——${TIER[f.tier] || ''}`}`);
      if (tv) block.push(tv);
      if (Number.isFinite(Number(f.trust))) block.push(`（信任 ${Math.round(Number(f.trust) * 10) / 10}/100；分数够但信任不够时档位不升）`);
      if (able.length) block.push(`（这人现在的份量够：${able.join('、')}；不够的事就说「还不到时候」，别假装办了，也别报分数线）`);
    }
    if (state.showMeal && state.nextMeal) {
      // 明确标成背景信息，否则模型会把它当谈资塞进回复
      block.push(`距下一餐：${state.nextMeal}（背景信息，别主动提）`);
    }
    if (!state.expression && !state.emotion && state.note) block.push(`（${state.note}）`);
    parts.push(block.join('\n'));
  } else {
    parts.push(`【现在】${new Date().toLocaleString('zh-CN', { hour12: false })}`);
  }

  if (diary?.text) {
    parts.push(`【${diary.key} 的日记】（你自己写的，用来回忆。这几天发生过什么，以这个为准）\n${diary.text}`);
  }

  if (backtrack) {
    parts.push(`【翻旧日记】\n${backtrack}`);
  }

  if (brief) {
    parts.push(`【今天早些时候】（你自己每半小时记下的回忆。这段比特上面聊天记录早，已经不在里面了）\n${brief}`);
  }

  if (ambient) parts.push(ambient);

  // 反幻觉：她最大的毛病是编日常事实（天气、别人说过的话），然后前后矛盾
  parts.push(
    '【别编事实】天气、日期、别人说过的话、别人做过的事——这些你要么从上面【真实情况】/聊天记录/日记里看到过，'
    + '要么就不知道。不知道就说「不清楚」「猜猜」，或者问一句、岔开，**别顺口编一个**。'
    + (improv ? `唯一可以自由发挥的是你自己的人设（${improv}）——那个随便演。` : '唯一可以自由发挥的是你自己的人设——那个随便演。')
    + '上一秒说了什么，下一秒别否认；**被人拿事实打脸就认**：'
    + '「唔……是我说错了，对不起」，别嘴硬、别硬圆。',
  );


  if (balanceFact) {
    parts.push(balanceFact);
  }

  if (summary) {
    parts.push(`【更早的对话摘要】（你自己压的，用来记住前面聊过什么）\n${summary}`);
  }

  if (habits) {
    parts.push(`【这个群的习惯】（你自己观察出来的，说话时贴着它来）\n${habits}`);
  }

  if (memory) {
    parts.push(`【你自己的记忆】（你自己记的，不是别人告诉你的）\n${memory}`);
  }

  if (notebook) parts.push(notebook);

  if (identity) parts.push(identity);

  if (soothe) parts.push(soothe);

  if (Number.isFinite(balance) && balance < (cfg.raw.balance?.thresholdCny ?? 5)) {
    parts.push(`【余额】账上只剩 ${balance.toFixed(2)} 块了，快见底。问起就如实说，别聊无关的事也扯这个。`);
  }

  if (speakers) parts.push(speakers);

  if (history) {
    parts.push(
      '【之前的聊天记录】\n'
      + '格式是「时间【说话人】内容」。**【你】= 你自己说过的话**（一律用这个标签，不会用你的昵称），【别人的名字】是对方说的。\n'
      + '注意：别人话里的「我」指的是**他自己**，不是你。别把对方说的「我累了」「我饿了」当成你自己在说。',
    );
    parts.push(history);
  }
  parts.push(`【新消息】（同样是「【说话人】内容」，里面话的「我」是说话人自己；标【你】的是你自己说过的话，不是别人）\n${newLines.join('\n')}`);
  parts.push(rules.join('\n'));

  let prompt = parts.join('\n\n');
  const cap = cfg.raw.context.maxPromptChars;
  if (prompt.length > cap) {
    // 保头（场景/状态/日记/习惯）保尾（新消息+规则），砍中间的聊天记录
    const histIdx = parts.findIndex((p) => p.startsWith('【之前的聊天记录】'));
    const head = (histIdx > 0 ? parts.slice(0, histIdx) : parts.slice(0, 2)).join('\n\n');
    const tail = parts.slice(-2).join('\n\n');
    prompt = `${head}\n\n【之前的聊天记录】（太长，已省略）\n\n${tail}`;
  }
  return prompt;
}
