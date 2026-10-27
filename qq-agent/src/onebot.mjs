import { EventEmitter } from 'node:events';
import { log } from './util.mjs';

/**
 * OneBot 11 正向 WebSocket 客户端。
 * NapCat 作为 WS 服务器，本进程连上去；事件与 API 响应走同一条连接，
 * 用 echo 字段区分（事件有 post_type，响应有 echo）。
 */
export class OneBot extends EventEmitter {
  #ws = null;
  #pending = new Map();
  #seq = 0;
  #retry = 0;
  #stopped = false;
  #reconnectTimer = null;

  constructor({ wsUrl, token = '' }) {
    super();
    this.wsUrl = wsUrl;
    this.token = token;
    this.connected = false;
  }

  start() {
    this.#stopped = false;
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#reconnectTimer);
    try { this.#ws?.close(); } catch { /* ignore */ }
  }

  #connect() {
    if (this.#stopped) return;
    let url;
    try {
      url = new URL(this.wsUrl);
    } catch {
      log('error', `napcat.wsUrl 不是合法 URL: ${this.wsUrl}`);
      return;
    }
    if (this.token) url.searchParams.set('access_token', this.token);

    log('info', `正在连接 NapCat: ${url.origin}${url.pathname}`);
    const ws = new WebSocket(url);
    this.#ws = ws;

    ws.addEventListener('open', () => {
      this.connected = true;
      this.#retry = 0;
      log('info', 'NapCat 已连接');
      this.emit('ready');
    });

    ws.addEventListener('message', (ev) => this.#onMessage(ev.data));

    ws.addEventListener('error', (ev) => {
      log('warn', `NapCat 连接错误: ${ev?.message ?? 'unknown'}`);
      // 有些失败只报 error、不发 close（NapCat 重启时踩过），连接会永久卡死 → 这里补一次重连
      if (!this.connected) this.#scheduleReconnect();
    });

    ws.addEventListener('close', () => {
      this.connected = false;
      this.#failAllPending(new Error('连接已断开'));
      this.#scheduleReconnect();
    });
  }

  /** 退避重连；重复触发只留一个定时器 */
  #scheduleReconnect() {
    if (this.#stopped) return;
    clearTimeout(this.#reconnectTimer);
    const delay = Math.min(30000, 1000 * 2 ** this.#retry++);
    log('warn', `NapCat 连接断开，${Math.round(delay / 1000)}s 后重连`);
    this.#reconnectTimer = setTimeout(() => this.#connect(), delay);
  }

  #onMessage(raw) {
    let data;
    try { data = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch { return; }

    if (data.post_type) {
      this.emit('event', data);
      return;
    }
    if (data.echo !== undefined) {
      const p = this.#pending.get(String(data.echo));
      if (!p) return;
      this.#pending.delete(String(data.echo));
      if (data.retcode === 0 || data.status === 'ok') p.resolve(data.data ?? {});
      else p.reject(new Error(`OneBot ${data.status}/${data.retcode}: ${data.message ?? data.wording ?? ''}`));
    }
  }

  #failAllPending(err) {
    for (const [, p] of this.#pending) p.reject(err);
    this.#pending.clear();
  }

  call(action, params = {}, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      if (!this.#ws || this.#ws.readyState !== 1) {
        reject(new Error('NapCat 未连接'));
        return;
      }
      const echo = String(++this.#seq);
      const timer = setTimeout(() => {
        this.#pending.delete(echo);
        reject(new Error(`OneBot 调用超时: ${action}`));
      }, timeoutMs);
      this.#pending.set(echo, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.#ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  sendPrivate(userId, message) {
    return this.call('send_private_msg', { user_id: Number(userId), message });
  }

  sendGroup(groupId, message) {
    return this.call('send_group_msg', { group_id: Number(groupId), message });
  }

  getLoginInfo() {
    return this.call('get_login_info', {});
  }

  /* ---- 群管理 ---- */

  /** 撤回一条消息（自己的随时能撤；别人的要管理员） */
  deleteMsg(messageId) {
    return this.call('delete_msg', { message_id: Number(messageId) });
  }

  /** 禁言；duration 秒，0 = 解除 */
  setGroupBan(groupId, userId, duration) {
    return this.call('set_group_ban', {
      group_id: Number(groupId), user_id: Number(userId), duration: Math.max(0, Number(duration) || 0),
    });
  }

  setGroupCard(groupId, userId, card) {
    return this.call('set_group_card', {
      group_id: Number(groupId), user_id: Number(userId), card: String(card ?? ''),
    });
  }

  getGroupMemberInfo(groupId, userId) {
    return this.call('get_group_member_info', {
      group_id: Number(groupId), user_id: Number(userId), no_cache: false,
    });
  }

  /* ---- 戳一戳（2026-10-28） ---- */

  /** 私聊戳：user_id = 被戳的人 */
  sendPokePrivate(userId) {
    return this.call('send_poke', { user_id: Number(userId) });
  }

  /** 群聊戳：group_id + user_id（被戳的人在哪个群） */
  sendPokeGroup(groupId, userId) {
    return this.call('send_poke', { group_id: Number(groupId), user_id: Number(userId) });
  }

  /* ---- 点歌 / QQ 空间 ---- */

  /** QQ 空间说说：返回 { tid } */
  sendQzoneMsg({ content, images = [], ugcRight = 1 }) {
    const params = { content: String(content), ugc_right: Number(ugcRight) || 1 };
    if (images.length) params.images = images;
    return this.call('send_qzone_msg', params, 40000);
  }

  deleteQzoneMsg(tid) {
    return this.call('delete_qzone_msg', { tid: String(tid) });
  }
}
