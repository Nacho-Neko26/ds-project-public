#!/usr/bin/env node
/**
 * QQ 掉线自动恢复看守（watchdog）
 *
 * 为什么要有它：登录态过期之后，NapCat 会每两分钟刷一次二维码，桥每 30 秒报
 * `Received network error or non-101`——两边都「活着」，但谁也连不上谁。以前只能人工
 * `docker cp` 抓二维码给人扫。这个脚本按分钟自检，能自己救的自己救，救不了才喊人。
 *
 * 判定顺序（从便宜到贵）：
 *   1. 容器没了 / 退出了        → docker compose up -d
 *   2. 桥进程没在跑              → systemctl restart qq-bridge
 *   3. 日志里出现登录错误        → docker restart napcat（每小时最多 2 次，防反复踢登录）
 *   4. 重启后仍然登录错误        → 抓最新二维码到 /root/qq-login-qr.png，私聊告诉号主
 *
 * 用 systemd timer 每 2 分钟跑一次：qq-watchdog.timer
 * 手动跑：node src/watchdog.mjs [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.env.QQ_AGENT_ROOT || '/root/qq-agent';
const STATE_FILE = path.join(ROOT, 'data', 'watchdog.json');
const LOG_FILE = path.join(ROOT, 'logs', 'watchdog.log');
const CTRL = process.env.QQ_CTRL || 'http://127.0.0.1:3899';
const COMPOSE = process.env.QQ_COMPOSE || '/root/napcat/docker-compose.yml';
const MAX_RESTARTS_PER_HOUR = Number(process.env.QQ_WD_MAX_RESTARTS || 2);
const QR_PATH = '/root/qq-login-qr.png';
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
function napcatStatus() {
  const r = sh("docker inspect -f '{{.State.Status}}' napcat");
  return r.ok ? r.out : '';
}

/** 最近 N 分钟的 NapCat 日志里有没有登录错误的痕迹 */
function loginBroken(minutes = 4) {
  const r = sh(`docker logs --since ${minutes}m napcat 2>&1 | sed 's/\\x1b\\[[0-9;]*m//g' | grep -E 'Login Error|登录失败|ErrType: *1' | tail -3`);
  return r.ok ? r.out : '';
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

/** 把容器里最新的二维码拷出来，放大成真 PNG，路径写到状态里 */
function grabQr() {
  const cp = sh('docker cp napcat:/app/napcat/cache/qrcode.png /root/napcat/data/qrcode.png');
  if (!cp.ok) { log(`取二维码失败：${cp.out.slice(0, 200)}`); return false; }
  const conv = sh(`ffmpeg -y -loglevel error -i /root/napcat/data/qrcode.png -vf "scale=640:640:flags=neighbor" -pix_fmt gray -frames:v 1 ${QR_PATH}`);
  if (!conv.ok) { log(`放大二维码失败：${conv.out.slice(0, 200)}`); return false; }
  log(`二维码已更新：${QR_PATH}`);
  return true;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const st = readState();
  const now = Date.now();
  st.restarts = (st.restarts || []).filter((t) => now - t < HOUR);

  const container = napcatStatus();
  if (container !== 'running') {
    if (DRY) { log(`[dry] 容器状态 ${container || '不存在'}，该起容器`); return; }
    log(`容器状态 ${container || '不存在'} → 起容器`);
    sh(`docker compose -f ${COMPOSE} up -d`);
    await sleep(20_000);
  }

  if (!bridgeActive()) {
    if (DRY) { log('[dry] 桥没在跑，该 restart qq-bridge'); return; }
    log('桥没在跑 → restart qq-bridge');
    sh('systemctl restart qq-bridge');
    await sleep(8000);
  }

  const broken = loginBroken();
  if (!broken) {
    if (bridgeComplaining()) log('提醒：桥最近有 non-101，但 NapCat 日志正常，先不动');
    else if (st.lastStatus !== 'ok') { log('一切正常'); }
    st.lastStatus = 'ok';
    writeState(st);
    return;
  }

  log(`检测到登录异常：${broken.split('\n').pop().slice(0, 120)}`);

  if (DRY) { log('[dry] 该重启 napcat'); return; }

  if (st.restarts.length >= MAX_RESTARTS_PER_HOUR) {
    log(`一小时内已重启 ${st.restarts.length} 次，不再自动踢登录；只更新二维码`);
    grabQr();
    // 同一个「需要扫码」状态半小时内只喊一次，别刷屏
    if (now - Number(st.lastNotifyAt || 0) > 30 * 60_000) {
      st.lastNotifyAt = now;
      writeState(st);
      await notify('QQ 掉线了，我自己救不回来，得扫一下码。二维码我放好了，喊我就是。');
    }
    return;
  }

  st.restarts.push(now);
  st.lastStatus = 'restarting';
  writeState(st);
  log('重启 napcat …');
  sh('docker restart napcat');
  await sleep(90_000);

  const still = loginBroken(2);
  if (!still) {
    log('重启后登录恢复正常');
    st.lastStatus = 'ok';
    writeState(st);
    await notify('刚才 QQ 掉了一下，我自己重连回来了，现在好的。');
    return;
  }

  log('重启后仍然登录异常 → 抓二维码');
  const gotQr = grabQr();
  if (now - Number(st.lastNotifyAt || 0) > 30 * 60_000) {
    st.lastNotifyAt = now;
    writeState(st);
    await notify(gotQr
      ? 'QQ 掉线了，自动重连没成功，得扫一下码（二维码已生成在服务器 /root/qq-login-qr.png）。'
      : 'QQ 掉线了，自动重连没成功，二维码也没取到，得上去看一眼。');
  }
}

main().catch((e) => { log(`看守自己出错了：${e?.stack || e}`); process.exitCode = 1; });
