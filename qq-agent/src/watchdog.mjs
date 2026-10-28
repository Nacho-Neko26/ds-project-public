#!/usr/bin/env node
/**
 * QQ 掉线自动恢复看守（watchdog）—— SnowLuma 版
 *
 * 为什么要有它：协议端或者桥挂了之后，两边都「活着」，但谁也连不上谁。以前只能人工上去
 * 抓二维码给人扫。这个脚本按分钟自检，能自己救的自己救，救不了才喊人。
 *
 * 2026-10-28 从 SnowLuma 换成 SnowLuma：容器名 snowluma、compose 在 /root/snowluma、
 * 判断「号还在不在」改成直接问 OneBot 的 get_login_info——比翻日志里的报错行准，
 * 因为 SnowLuma 掉线时容器本身是活的，只是 QQ 退回登录界面。
 *
 * 判定顺序（从便宜到贵）：
 *   1. 容器没了 / 退出了            → docker compose up -d
 *   2. 桥进程没在跑                  → systemctl restart qq-bridge
 *   3. get_login_info 拿不到号       → docker restart snowluma（每小时最多 2 次）
 *   4. 重启后还是拿不到              → 抓一张登录界面截图，私聊告诉号主
 *
 * 用 systemd timer 每 2 分钟跑一次：qq-watchdog.timer
 * 手动跑：node src/watchdog.mjs [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.env.QQ_AGENT_ROOT || '/root/qq-agent';
const STATE_FILE = path.join(ROOT, 'data', 'watchdog.json');
const LOG_FILE = path.join(ROOT, 'logs', 'watchdog.log');
const CTRL = process.env.QQ_CTRL || 'http://127.0.0.1:3899';
const COMPOSE = process.env.QQ_COMPOSE || '/root/snowluma/docker-compose.yml';
const CONTAINER = process.env.QQ_CONTAINER || 'snowluma';
const SL_CONFIG_DIR = process.env.QQ_SL_CONFIG || '/root/snowluma/data/config';
const API = process.env.QQ_ONEBOT_HTTP || 'http://127.0.0.1:3000';
const MAX_RESTARTS_PER_HOUR = Number(process.env.QQ_WD_MAX_RESTARTS || 2);
const SCREEN_PATH = '/root/qq-login-screen.png';
const DRY = process.argv.includes('--dry-run');

const HOUR = 3600_000;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, line);
  } catch { /* 日志写不了不影响主流程 */ }
  process.stdout.write(line);
}

function sh(cmd, { timeout = 120_000, allowFail = true } = {}) {
  try {
    return { ok: true, out: execFileSync('bash', ['-lc', cmd], { encoding: 'utf8', timeout }).trim() };
  } catch (e) {
    if (!allowFail) throw e;
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}`.trim(), code: e.status };
  }
}

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(s) {
  try {
    mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) { log(`写状态文件失败：${e.message}`); }
}

function ownerUid() {
  try {
    const cfg = JSON.parse(readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8'));
    return Number(cfg?.persona?.ownerUids?.[0] || 0);
  } catch { return 0; }
}

/** 容器状态：running / exited / '' (不存在) */
function containerStatus() {
  const r = sh(`docker inspect -f '{{.State.Status}}' ${CONTAINER}`);
  return r.ok ? r.out : '';
}

/** 从 SnowLuma 的账号配置里捞 HTTP 接口的 access_token（HTTP 与 WS 是两个不同的 token） */
function httpToken() {
  try {
    const files = readdirSync(SL_CONFIG_DIR).filter((f) => /^onebot_\d+\.json$/.test(f));
    if (!files.length) return '';
    const cfg = JSON.parse(readFileSync(path.join(SL_CONFIG_DIR, files[0]), 'utf8'));
    const servers = cfg?.networks?.httpServers || cfg?.httpServers || [];
    return servers?.[0]?.accessToken || '';
  } catch { return ''; }
}

/**
 * 号还在不在：直接问 OneBot 要登录信息。
 * 返回 { uin } 表示在线；{ uin: 0 } 表示接口通但没登录；null 表示接口都不通。
 */
function selfInfo() {
  const token = httpToken();
  if (!token) return null;
  const r = sh(`curl -s -m 10 -H 'Authorization: Bearer ${token}' ${API}/get_login_info`);
  if (!r.ok || !r.out.startsWith('{')) return null;
  try {
    const j = JSON.parse(r.out);
    if (j.retcode !== 0) return { uin: 0, raw: r.out.slice(0, 120) };
    return { uin: Number(j.data?.user_id || 0), nick: j.data?.nickname || '' };
  } catch { return null; }
}

function bridgeActive() {
  return sh('systemctl is-active qq-bridge').out === 'active';
}

function bridgeComplaining(minutes = 3) {
  const r = sh(`journalctl -u qq-bridge --since "-${minutes} min" --no-pager 2>/dev/null | grep -c 'non-101'`);
  return r.ok && Number(r.out) > 0;
}

/** 通过桥的控制台接口给号主发一句话（桥没起来时会失败，失败就当没发） */
async function notify(text) {
  const uid = ownerUid();
  if (!uid) { log('没有 ownerUids，跳过通知'); return false; }
  try {
    const res = await fetch(`${CTRL}/api/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'text', chat: `private:${uid}`, by: uid, text }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    log(`通知已发（${res.status}）：${body.slice(0, 120)}`);
    return res.ok;
  } catch (e) {
    log(`通知失败：${e.message}`);
    return false;
  }
}

/** 抓一张容器里 Xvfb 的画面（掉线时上面就是登录二维码），存到宿主机 */
function captureScreen() {
  const r = sh(`docker exec ${CONTAINER} sh -c 'DISPLAY=:1 ffmpeg -y -loglevel error -f x11grab -video_size 1920x1080 -i :1 -frames:v 1 /app/data/screen.png'`);
  if (!r.ok) { log(`抓屏失败：${r.out.slice(0, 160)}`); return false; }
  const cp = sh(`cp /root/snowluma/data/screen.png ${SCREEN_PATH}`);
  if (!cp.ok) { log(`拷贝截图失败：${cp.out.slice(0, 160)}`); return false; }
  log(`截图已更新：${SCREEN_PATH}`);
  return true;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const st = readState();
  const now = Date.now();
  st.restarts = (st.restarts || []).filter((t) => now - t < HOUR);

  // 1. 容器
  const container = containerStatus();
  if (container !== 'running') {
    if (DRY) { log(`[dry] 容器状态 ${container || '不存在'}，该起容器`); return; }
    log(`容器状态 ${container || '不存在'} → 起容器`);
    sh(`docker compose -f ${COMPOSE} up -d`);
    await sleep(30_000);
  }

  // 2. 桥
  if (!bridgeActive()) {
    if (DRY) { log('[dry] 桥没在跑，该 restart qq-bridge'); return; }
    log('桥没在跑 → restart qq-bridge');
    sh('systemctl restart qq-bridge');
    await sleep(8000);
  }

  // 3. 号在不在
  const info = selfInfo();
  if (info === null) {
    log('问不到 OneBot 接口（token 读不到或端口不通），这轮只报不改');
    st.lastStatus = 'unknown';
    writeState(st);
    return;
  }
  if (info.uin > 0) {
    if (bridgeComplaining()) log(`在线（${info.uin}），但桥最近有 non-101，先不动`);
    else if (st.lastStatus !== 'ok') log(`一切正常，在线账号 ${info.uin}`);
    st.lastStatus = 'ok';
    writeState(st);
    return;
  }

  // 4. 接口通但没登录 = 掉线
  log(`检测到掉线（接口返回 ${info.raw || '无 user_id'}）`);
  if (DRY) { log('[dry] 该重启容器'); return; }

  if (st.restarts.length >= MAX_RESTARTS_PER_HOUR) {
    log(`一小时内已重启 ${st.restarts.length} 次，不再自动重启；只更新截图`);
    captureScreen();
    if (now - Number(st.lastNotifyAt || 0) > 30 * 60_000) {
      st.lastNotifyAt = now;
      writeState(st);
      await notify('QQ 掉了，我自己救不回来，得扫一下码。登录界面我截图放好了，喊我就是。');
    }
    return;
  }

  st.restarts.push(now);
  st.lastStatus = 'restarting';
  writeState(st);
  log(`重启 ${CONTAINER} …`);
  sh(`docker restart ${CONTAINER}`);
  await sleep(90_000);

  const after = selfInfo();
  if (after && after.uin > 0) {
    log('重启后恢复了');
    st.lastStatus = 'ok';
    writeState(st);
    await notify('刚才 QQ 掉了一下，我自己重连回来了，现在好的。');
    return;
  }

  log('重启后仍然没登录 → 抓登录界面');
  const shot = captureScreen();
  if (now - Number(st.lastNotifyAt || 0) > 30 * 60_000) {
    st.lastNotifyAt = now;
    writeState(st);
    await notify(shot
      ? 'QQ 掉线了，自动重连没成功，得扫一下码（登录界面截图我放在服务器上了）。'
      : 'QQ 掉线了，自动重连没成功，截图也没抓到，得上去看一眼。');
  }
}

main().catch((e) => { log(`看守自己出错了：${e?.stack || e}`); process.exitCode = 1; });
