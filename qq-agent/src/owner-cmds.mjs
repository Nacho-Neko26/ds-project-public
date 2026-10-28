/**
 * 主人专属指令（2026-10-27 用户给的指令权限体系，m02704）。
 *
 * 全部带 #，只有主人（号主 / trusted）能用；别人说同样的话一律拒绝。
 * 状态存在 data/owner-state.json，桥每轮读一次：
 *   paused       #关机   休眠，不回任何消息
 *   takeover     #接管   她在后台，只听不回
 *   relationLocked #锁定关系  好感/信任冻结
 *   limitOffUntil  #解除限制  放宽说话边界（仍不碰露骨色情/违法）
 *   powerUntil   #最高权限  别人的指令权限临时提到 level_4
 *   pendingFormatAt #格式化  第一次只要求确认，第二次才真清
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { loadTable } from './commands-table.mjs';
import { readMode, writeMode, describeMode } from './model-mode.mjs';

const HOUR = 3600_000;

function statePath(cfg) {
  return path.join(cfg.dataDir, 'owner-state.json');
}

export function readOwnerState(cfg) {
  try {
    return JSON.parse(fs.readFileSync(statePath(cfg), 'utf8'));
  } catch {
    return {};
  }
}

export function writeOwnerState(cfg, patch) {
  const s = { ...readOwnerState(cfg), ...patch };
  fs.mkdirSync(path.dirname(statePath(cfg)), { recursive: true });
  fs.writeFileSync(statePath(cfg), JSON.stringify(s, null, 2), 'utf8');
  return s;
}

/** 现在是不是在休眠 / 接管状态（active=false 时桥不吭声） */
export function bridgeMuted(cfg) {
  const s = readOwnerState(cfg);
  return { paused: !!s.paused, takeover: !!s.takeover };
}

/** 现在放宽边界了吗（过期自动失效） */
export function limitOffActive(cfg) {
  const s = readOwnerState(cfg);
  return Number(s.limitOffUntil || 0) > Date.now();
}

/** 有没有人临时拿到 level_4（返回那个 uid 或 0） */
export function powerBoost(cfg) {
  const s = readOwnerState(cfg);
  if (Number(s.powerUntil || 0) <= Date.now()) return 0;
  return Number(s.powerUid || 0);
}

/** 关系被锁住了吗——锁住时好感/信任不增不减 */
export function relationLocked(cfg) {
  return !!readOwnerState(cfg).relationLocked;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

/** 把时长写成 +30m 之类；认 30m / 2h / 1d，没写就默认 */
function parseDuration(s, defMin = 60) {
  const m = /(\d+)\s*(m|min|分钟|h|小时|d|天)?/i.exec(String(s || ''));
  if (!m) return defMin * 60_000;
  const n = Number(m[1]);
  const unit = (m[2] || 'm').toLowerCase();
  if (unit === 'h' || unit === '小时') return n * HOUR;
  if (unit === 'd' || unit === '天') return n * 24 * HOUR;
  return n * 60_000;
}

function configPath(cfg) {
  return path.join(cfg.root, 'config', 'config.json');
}

/**
 * 改 reply 段的设置（2026-10-27 #群聊）：写文件 + 同时热更新内存里的 cfg.raw.reply。
 * 两者都做，改完立刻生效，不用 restart。
 */
function applyReplyPatch(cfg, patch) {
  const file = configPath(cfg);
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  obj.reply = { ...obj.reply, ...patch };
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  cfg.raw.reply = { ...cfg.raw.reply, ...patch };
}

/** 「30」「20-50」「30%」→ [0.3,0.3] / [0.2,0.5]；认不出来给 null */
function parseChance(s) {
  const t = String(s || '').trim().replace(/%/g, '');
  const m = /^(\d{1,3})(?:\s*[-~到]\s*(\d{1,3}))?$/.exec(t);
  if (!m) return null;
  const lo = Math.max(0, Math.min(100, Number(m[1]))) / 100;
  const hi = Math.max(0, Math.min(100, Number(m[2] ?? m[1]))) / 100;
  return [Math.min(lo, hi), Math.max(lo, hi)];
}

// 接话档位（2026-10-27 用户定）：0 = 只回被@和喊名字，1~4 每档往上 20 个点
const TIERS = [
  [0, 0], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1],
];

function tierIndex(pair) {
  const lo = Number(pair?.[0]);
  const hi = Number(pair?.[1]);
  return TIERS.findIndex(([a, b]) => a === lo && b === hi);
}

function chanceText(pair) {
  const lo = Math.round(Number(pair[0]) * 100);
  const hi = Math.round(Number(pair[1]) * 100);
  const body = lo === 0 && hi === 0 ? '只回被@和被叫' : (lo === hi ? `${lo}%` : `${lo}%~${hi}%`);
  const ti = tierIndex(pair);
  return ti >= 0 ? `${ti} 档 · ${body}` : body;
}

/** 「3」或「3档」→ 档位区间副本；不是 0~4 的纯数字就给 null */
function parseTierArg(s) {
  const m = /^\s*([0-4])\s*档?\s*$/.exec(String(s || ''));
  return m ? [...TIERS[Number(m[1])]] : null;
}

function listHashCommands(cfg) {
  const t = loadTable(path.join(cfg.root, 'config', 'commands.json'));
  return t.hash
    .filter((e) => e.enabled !== false)
    .map((e) => {
      // 有的条目 match 写的是宽正则（/^[#＃].../），直接取 match[0] 会得到孤零零一个「#」，
      // 所以优先用 name，没有 name 才退回第一个字面 pattern。
      const raw = e.name || (Array.isArray(e.match) ? e.match[0] : e.match) || '';
      const word = String(raw).replace(/^[#＃]\s*/, '');
      return `#${word} —— ${e.do || e.name || ''}`;
    });
}

/**
 * 执行一条主人专属指令。
 * @returns {Promise<boolean>} true = 已经处理掉了（调用方不要再往下走）
 */
export async function runOwnerCommand({
  name, extra, cfg, session, sendText, history, note,
}) {
  const say = (t) => sendText(session, t, null);

  switch (name) {
    case '关机': {
      writeOwnerState(cfg, { paused: true, pausedAt: Date.now() });
      await say('好，我眯一会儿去');
      note('info', `[${session.key}] #关机：桥进入休眠`);
      return true;
    }

    case '重启': {
      await say('等我几秒');
      setTimeout(() => {
        try {
          const p = spawn('systemctl', ['restart', 'qq-bridge'], { detached: true, stdio: 'ignore' });
          p.unref();
        } catch (e) {
          note('error', `#重启失败：${e.message}`);
        }
      }, 1500);
      note('info', `[${session.key}] #重启`);
      return true;
    }

    case '清屏': {
      try {
        if (history) {
          history.cache?.delete?.(session.key);
          const f = history.file?.(session.key);
          if (f && fs.existsSync(f)) fs.rmSync(f);
        }
        await say('这边清干净了');
      } catch (e) {
        await say(`清屏没成：${e.message}`);
      }
      return true;
    }

    case '导出全部数据':
    case '导出数据': {
      try {
        const dir = path.join(cfg.dataDir, 'export');
        fs.mkdirSync(dir, { recursive: true });
        const out = path.join(dir, `export-${Date.now()}.tar.gz`);
        const items = ['profiles', 'diary', 'history', 'stickers', '.dsh-meow', 'impressions.md', 'owner-state.json']
          .map((x) => path.join(cfg.agentCwd, x));
        const exist = items.filter((p) => fs.existsSync(p));
        execSync(`tar czf "${out}" -C "${cfg.agentCwd}" ${exist.map((p) => path.basename(p)).join(' ')}`, { stdio: 'ignore' });
        const mb = (fs.statSync(out).size / 1048576).toFixed(1);
        await say(`打包好了：${out}（${mb} MB，${exist.length} 项）`);
      } catch (e) {
        await say(`导出没成：${e.message}`);
      }
      return true;
    }

    case '修改核心设定': {
      const kv = /^([\w.]+)\s*[=＝]\s*(.+)$/.exec(String(extra || '').trim());
      const file = path.join(cfg.dataDir, 'core-override.json');
      if (!kv) {
        let now = {};
        try { now = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 还没有 */ }
        const lines = Object.entries(now).map(([k, v]) => `${k} = ${v}`);
        await say(lines.length
          ? `现在改过的：${lines.join('；')}。要改就说 #修改核心设定 键=值`
          : '能改：名字、自称、称呼、口头禅、雷区。要改就说 #修改核心设定 键=值，比如 自称=人家');
        return true;
      }
      let now = {};
      try { now = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 还没有 */ }
      now[kv[1]] = kv[2];
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(now, null, 2), 'utf8');
      await say(`改好了：${kv[1]} = ${kv[2]}`);
      return true;
    }

    case '查看完整日志':
    case '看日志': {
      try {
        const raw = execSync('journalctl -u qq-bridge -n 60 --no-pager', { encoding: 'utf8', timeout: 8000 });
        const text = raw.split('\n').slice(-40).join('\n').slice(-2200);
        await say(`最近的日志：\n${text}`);
      } catch (e) {
        await say(`日志没取到：${e.message}`);
      }
      return true;
    }

    case '解除限制': {
      const ms = parseDuration(extra, 24 * 60);
      const until = Date.now() + ms;
      writeOwnerState(cfg, { limitOffUntil: until });
      await say(`放开到 ${fmtTime(until)}。骂人不忌口、亲近的尺度也放大，但露骨色情和违法的事还是不碰`);
      return true;
    }

    case '最高权限': {
      const ms = parseDuration(extra, 60);
      const until = Date.now() + ms;
      writeOwnerState(cfg, { powerUntil: until, powerUid: 0 });
      await say(`接下来 ${Math.round(ms / 60000)} 分钟，别人的指令按最高层级对待，到 ${fmtTime(until)} 自动失效`);
      return true;
    }

    case '锁定关系': {
      const s = readOwnerState(cfg);
      const next = !s.relationLocked;
      writeOwnerState(cfg, { relationLocked: next });
      await say(next ? '关系锁上了，谁说什么都不动分' : '解锁了，分照常走动');
      return true;
    }

    case '格式化': {
      const s = readOwnerState(cfg);
      const fresh = Date.now() - Number(s.pendingFormatAt || 0) < 120_000;
      if (!fresh) {
        writeOwnerState(cfg, { pendingFormatAt: Date.now() });
        await say('这会清掉所有记忆和好感度，收不回来。真要清就再说一次 #格式化');
        return true;
      }
      try {
        const stamp = Date.now();
        const bak = path.join(cfg.dataDir, 'format-backup');
        fs.mkdirSync(bak, { recursive: true });
        const targets = [
          path.join(cfg.agentCwd, '.dsh-meow', 'memory.db'),
          path.join(cfg.agentCwd, 'impressions.md'),
        ];
        const profDir = path.join(cfg.agentCwd, 'profiles');
        if (fs.existsSync(profDir)) {
          for (const f of fs.readdirSync(profDir)) {
            if (f.endsWith('.json')) targets.push(path.join(profDir, f));
          }
        }
        let n = 0;
        for (const t of targets) {
          if (!fs.existsSync(t)) continue;
          fs.copyFileSync(t, path.join(bak, `${stamp}-${path.basename(t)}`));
          fs.rmSync(t);
          n += 1;
        }
        writeOwnerState(cfg, { pendingFormatAt: 0 });
        await say(`清掉了 ${n} 个文件，旧的在 data/format-backup 里`);
      } catch (e) {
        await say(`格式化没成：${e.message}`);
      }
      return true;
    }

    case '接管': {
      writeOwnerState(cfg, { takeover: true });
      await say('好，我退到后头去');
      return true;
    }

    case '回来': {
      writeOwnerState(cfg, { takeover: false, paused: false });
      await say('在的');
      return true;
    }

    case '群聊': {
      const map = cfg.raw.reply.groupChance || {};
      const mutes = (cfg.raw.reply.muteGroups || []).map(String);
      const isGroup = String(session.key).startsWith('group:');
      const gid = isGroup ? String(session.key).replace(/^group:/, '') : '';
      const arg = String(extra || '').trim();

      if (!arg) {
        const rows = Object.entries(map)
          .filter(([k]) => k !== 'default')
          .map(([k, v]) => `群 ${k}：${chanceText(v)}`);
        const lines = [`默认：${chanceText(map.default || [0.2, 0.4])}`, ...rows];
        if (mutes.length) lines.push(`静音的群：${mutes.join('、')}`);
        if (isGroup) {
          lines.push(`当前群 ${gid}：${chanceText(map[gid] || map.default || [0.2, 0.4])}${mutes.includes(gid) ? '（已静音）' : ''}`);
        }
        lines.push('改法：#群聊 0 / 1 / 2 / 3 / 4 选档位（0 只回被@和被叫，1 是 20%~40%，往后每档加 20 个点）；也可 #群聊 20-50 自定义；#群聊 静音 / #群聊 解除；改默认用 #群聊 全部 2');
        lines.push('（被 @ 唤醒会临时上一档，撑 10 分钟自己掉回来，5 分钟内不重复触发）');
        await say(lines.join('\n'));
        return true;
      }

      if (/^(全部|默认|default)/i.test(arg)) {
        const rest = arg.replace(/^(全部|默认|default)\s*/i, '');
        const p = parseTierArg(rest) || parseChance(rest);
        if (!p) { await say('要写成 #群聊 全部 2（档位）或 #群聊 全部 20-40'); return true; }
        applyReplyPatch(cfg, { groupChance: { ...map, default: p } });
        await say(`默认接话改成 ${chanceText(p)}`);
        return true;
      }

      if (!isGroup) { await say('这条要在群里发，我改的是那个群'); return true; }

      if (/^只听/.test(arg)) {
        applyReplyPatch(cfg, { groupChance: { ...map, [gid]: [0, 0] } });
        await say('这个群我只回被@和被叫，别的不插嘴');
        return true;
      }

      if (/^静音/.test(arg)) {
        applyReplyPatch(cfg, { muteGroups: Array.from(new Set([...mutes, gid])) });
        await say('这个群我不说话了，要恢复就发 #群聊 解除');
        return true;
      }

      if (/^(解除|恢复)/.test(arg)) {
        const patch = { muteGroups: mutes.filter((x) => x !== gid) };
        if (map[gid]) {
          const rest = { ...map };
          delete rest[gid];
          patch.groupChance = rest;
        }
        applyReplyPatch(cfg, patch);
        await say('恢复了，按默认的节奏来');
        return true;
      }

      const p = parseTierArg(arg) || parseChance(arg);
      if (!p) { await say('没看懂。档位是 0~4：0 只回被@和被叫，1 是 20%~40%，2 是 40%~60%，3 是 60%~80%，4 是 80%~100%；也能直接给区间，比如 #群聊 20-50'); return true; }
      applyReplyPatch(cfg, { groupChance: { ...map, [gid]: p } });
      await say(`这个群改成 ${chanceText(p)}`);
      return true;
    }

    case '指令清单':
    case '指令': {
      const list = listHashCommands(cfg);
      await say(list.length ? list.join('\n') : '表是空的');
      return true;
    }

    // #模型 —— 2026-10-28 用户要求「中转要指令才切换」：
    // 不说参数就是报现在走哪条；#模型 go / #模型 中转 / #模型 官方 才真的切。
    case '模型':
    case '模型路线': {
      let want = String(extra || '').trim().toLowerCase();
      // #模型路线 / #模型咋样 这类只问不切
      if (/^(路线|路|$|\?|？|啥|什么)$/.test(want)) want = '';
      const cur = readMode(cfg);
      if (!want) {
        await say(`现在走 ${describeMode(cur.mode)}`);
        return true;
      }
      let target = '';
      if (/^(go|opencode|opencode-go|open-code)$/.test(want)) target = 'go';
      else if (/^(中转|relay|21r|relay21r)$/.test(want)) target = 'relay';
      else if (/^(官方|official|deepseek|deepseek-official)$/.test(want)) target = 'official';
      if (!target) {
        await say('只认得 go / 中转 / 官方，别的我不切');
        return true;
      }
      if (target === cur.mode) {
        await say(`本来就走的 ${describeMode(cur.mode)}`);
        return true;
      }
      const next = writeMode(cfg, { mode: target, reason: 'manual' });
      note('info', `[${session.key}] #模型 ${target}：手动切路线 ${cur.mode} → ${target}`);
      await say(`切到 ${describeMode(next.mode)} 了，下一轮生效`);
      return true;
    }

    default:
      return false;
  }
}

/** 主人专属命令名集合（给 index.mjs 快速判断） */
export function isOwnerCommandName(name) {
  return [
    '关机', '重启', '清屏', '导出全部数据', '导出数据', '修改核心设定', '查看完整日志', '看日志',
    '解除限制', '最高权限', '锁定关系', '格式化', '接管', '回来', '指令清单', '指令', '群聊',
    '模型', '模型路线',
  ].includes(String(name || ''));
}
