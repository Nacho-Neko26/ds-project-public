/**
 * 群管理：撤回、禁言、改群名片。
 *
 * 由模型输出一行触发：
 *   __ADMIN__ {"op":"recall","id":123456}        撤回某条消息
 *   __ADMIN__ {"op":"recall_last"}               撤回自己刚发的那条
 *   __ADMIN__ {"op":"mute","uid":123,"minutes":10}
 *   __ADMIN__ {"op":"unmute","uid":123}
 *   __ADMIN__ {"op":"card","uid":123,"card":"新名字"}
 *
 * 四条铁律：
 *   1. 号主发的话全照办；号主没发话时它自己只能做「撤回」这一件（2026-10-27 用户要求），
 *      禁言、改名片、踢人一律要有号主点头；
 *   2. 「它自己撤」的边界必须比号主的紧：得是管理员身份、只撤最近十分钟、每群每天有上限、
 *      主人和高好感的人一个字都不碰；
 *   3. 机器人不是管理员就只能做「撤自己的消息」「改自己的名片」；
 *   4. 每一步都写日志，失败不抛给对话，只回一句为什么不行的原因。
 */

import { selfRef } from './character.mjs';

const DEFAULTS = {
  enabled: true,
  maxMuteMinutes: 720,   // 最多禁言 12 小时，别让它一怒之下把人禁一年
  roleCacheSeconds: 300,
  selfRecall: {
    enabled: true,
    maxPerGroupPerDay: 5,    // 每天每个群最多自己撤几条，撤多了管理员身份保不住
    maxAgeMinutes: 10,       // 只撤最近十分钟内的
    protectFavorAtLeast: 60, // 跟它熟到这份上的人，它不许自己动手
  },
};

export function adminConfig(cfg) {
  const raw = cfg.raw.admin || {};
  return {
    ...DEFAULTS,
    ...raw,
    selfRecall: { ...DEFAULTS.selfRecall, ...(raw.selfRecall || {}) },
  };
}

const roleCache = new Map(); // gid -> { role, at }

/** 北京时间当天日期，给「今天这个群撤了几条」计数用 */
function dayKeyNow() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

const selfRecallLog = new Map(); // `${gid}:${dayKey}` -> count

/** 机器人在这个群的身份：owner / admin / member；查不到当 member */
export async function getBotRole(ob, cfg, groupId, selfId, { force = false } = {}) {
  const key = String(groupId);
  const hit = roleCache.get(key);
  const ttl = adminConfig(cfg).roleCacheSeconds * 1000;
  if (!force && hit && Date.now() - hit.at < ttl) return hit.role;
  let role = 'member';
  try {
    const info = await ob.getGroupMemberInfo(groupId, selfId);
    role = String(info?.role || 'member');
  } catch { /* 查不到就按 member 算，宁可少做 */ }
  roleCache.set(key, { role, at: Date.now() });
  return role;
}

export function isAdminRole(role) {
  return role === 'admin' || role === 'owner';
}

/**
 * 执行一条群管理指令。
 * @param {object} p
 * @param {boolean} p.actorIsOwner  这条指令是不是号主要求的
 * @param {number}  [p.actorUid]    说话的人
 * @param {Array}   [p.recent]      最近几条消息 [{uid,name,text,time,messageId}]，它自己撤要核对
 * @param {function}[p.favorOfUid]  查某人好感，保护熟人用
 * @returns {Promise<{ok:boolean, message:string}>}
 */
export async function runAdminOp({
  ob, cfg, groupId, selfId, op, lastBotMsgId, actorIsOwner,
  actorUid = 0, actorLevel = 1, recent = [], favorOfUid = null,
}) {
  const conf = adminConfig(cfg);
  if (!conf.enabled) return { ok: false, message: '群管理功能已关闭' };
  if (!groupId) return { ok: false, message: '私聊里没法做群管理' };

  const role = await getBotRole(ob, cfg, groupId, selfId);
  const admin = isAdminRole(role);
  const kind = String(op?.op || '').toLowerCase();

  // 2026-10-28 用户定档位：号主没发话时，撤回/点赞她自己来，头衔和公告要第六档，
  // 禁言和设管理要第七档，踢人永远只有主人能下（这一层是硬闸门，不听提示词的）。
  const MIN_LEVEL = { title: 6, notice: 6, mute: 7, unmute: 7, set_admin: 7 };
  if (!actorIsOwner) {
    if (kind === 'kick') return { ok: false, message: '踢人只有主人能下' };
    if (kind !== 'recall' && kind !== 'recall_last' && kind !== 'like') {
      const need = MIN_LEVEL[kind];
      if (!need) return { ok: false, message: '这个得号主点头才能做' };
      if (Number(actorLevel || 0) < need) return { ok: false, message: '这个得等关系再近一些' };
    }
  }

  try {
    if (kind === 'recall' || kind === 'recall_last') {
      const id = kind === 'recall_last' ? lastBotMsgId : Number(op.id || op.message_id || 0);
      if (!id) return { ok: false, message: kind === 'recall_last' ? '没找到刚发的那条' : '要撤哪条？没给消息 id' };

      // ---- 它自己判的那条路（号主没发话）----
      if (!actorIsOwner) {
        const sc = conf.selfRecall;
        if (!sc.enabled) return { ok: false, message: '自己撤回的功能没开' };
        if (!admin) return { ok: false, message: `${selfRef()}还不是管理员，撤不了别人的消息` };

        if (kind === 'recall') {
          const target = (recent || []).find((m) => String(m.messageId) === String(id));
          if (!target) return { ok: false, message: '那条不在这几轮消息里，撤不了' };
          const tUid = Number(target.uid) || 0;
          const mine = tUid === Number(selfId) || tUid === Number(actorUid);
          if (!mine) {
            const owners = (cfg.raw.persona?.ownerUids || []).map(Number);
            if (owners.includes(tUid)) return { ok: false, message: '主人说的话不能撤' };
            if (Date.now() - Number(target.time || 0) > sc.maxAgeMinutes * 60000) {
              return { ok: false, message: '那句太久了，撤不动' };
            }
            let fav = 0;
            try { fav = Number(favorOfUid?.(tUid) ?? 0) || 0; } catch { fav = 0; }
            if (fav >= sc.protectFavorAtLeast) return { ok: false, message: '这个跟它够熟，不撤' };
          }
        }

        const dk = `${groupId}:${dayKeyNow()}`;
        for (const k of selfRecallLog.keys()) if (k !== dk) selfRecallLog.delete(k);
        const used = selfRecallLog.get(dk) || 0;
        // 2026-10-27 用户原话「骂她的随便撤」：挨骂这类不占每天五条的名额，但主人和熟人照样不碰
        const abuse = String(op.reason || '').toLowerCase() === 'abuse';
        if (!abuse && used >= sc.maxPerGroupPerDay) return { ok: false, message: '今天这个群撤够了，剩的不动' };
        await ob.deleteMsg(id);
        if (!abuse) selfRecallLog.set(dk, used + 1);
        return { ok: true, message: abuse ? `已撤回骂人那条 ${id}` : `已撤回消息 ${id}（今天第 ${used + 1} 条）` };
      }

      // ---- 号主发话：原样执行 ----
      await ob.deleteMsg(id);
      return { ok: true, message: `已撤回消息 ${id}` };
    }

    if (kind === 'mute' || kind === 'unmute') {
      const uid = Number(op.uid || op.user_id || 0);
      if (!uid) return { ok: false, message: '要禁言谁？没给 QQ 号' };
      if (uid === Number(selfId)) return { ok: false, message: '不能禁言自己' };
      if (!admin) return { ok: false, message: `${selfRef()}还不是管理员，禁言不了` };
      const minutes = kind === 'unmute' ? 0 : Math.min(conf.maxMuteMinutes, Math.max(1, Number(op.minutes) || 10));
      await ob.setGroupBan(groupId, uid, minutes * 60);
      return { ok: true, message: minutes ? `已禁言 ${uid} ${minutes} 分钟` : `已解除 ${uid} 的禁言` };
    }

    if (kind === 'card') {
      const uid = Number(op.uid || op.user_id || 0);
      const card = String(op.card ?? '').slice(0, 30);
      if (!uid) return { ok: false, message: '要给谁改名片？没给 QQ 号' };
      if (uid !== Number(selfId) && !admin) return { ok: false, message: `${selfRef()}还不是管理员，改不了别人的名片` };
      await ob.setGroupCard(groupId, uid, card);
      return { ok: true, message: `已把 ${uid} 的群名片改成「${card}」` };
    }

    // ---- 以下都是 2026-10-28 接 SnowLuma 时补的，全部要号主点头（上面第 93 行已拦） ----

    if (kind === 'kick') {
      const uid = Number(op.uid || op.user_id || 0);
      if (!uid) return { ok: false, message: '要踢谁？没给 QQ 号' };
      if (uid === Number(selfId)) return { ok: false, message: '不能踢自己' };
      if (!admin) return { ok: false, message: `${selfRef()}还不是管理员，踢不了人` };
      const owners = (cfg.raw.persona?.ownerUids || []).map(Number);
      if (owners.includes(uid)) return { ok: false, message: '主人不能踢' };
      await ob.setGroupKick(groupId, uid, !!op.reject);
      return { ok: true, message: `已把 ${uid} 请出本群${op.reject ? '（并拒绝再加）' : ''}` };
    }

    if (kind === 'whole_ban') {
      if (!admin) return { ok: false, message: `${selfRef()}还不是管理员，开不了全员禁言` };
      const enable = op.enable === undefined ? true : !!op.enable;
      await ob.setGroupWholeBan(groupId, enable);
      return { ok: true, message: enable ? '已开启全员禁言' : '已解除全员禁言' };
    }

    if (kind === 'set_admin') {
      const uid = Number(op.uid || op.user_id || 0);
      if (!uid) return { ok: false, message: '要设谁当管理？没给 QQ 号' };
      if (!admin) return { ok: false, message: `${selfRef()}还不是管理员，设不了管理` };
      const enable = op.enable === undefined ? true : !!op.enable;
      await ob.setGroupAdmin(groupId, uid, enable);
      return { ok: true, message: enable ? `已把 ${uid} 设成管理员` : `已取消 ${uid} 的管理员` };
    }

    if (kind === 'title') {
      const uid = Number(op.uid || op.user_id || 0);
      const title = String(op.title ?? '').slice(0, 20);
      if (!uid) return { ok: false, message: '要给谁挂头衔？没给 QQ 号' };
      if (!admin) return { ok: false, message: `${selfRef()}还不是管理员，挂不了头衔` };
      await ob.setGroupSpecialTitle(groupId, uid, title, -1);
      return { ok: true, message: title ? `已给 ${uid} 挂上「${title}」` : `已取消 ${uid} 的头衔` };
    }

    if (kind === 'notice') {
      const content = String(op.content ?? op.text ?? '').trim();
      if (!content) return { ok: false, message: '公告要写什么？内容是空的' };
      if (!admin) return { ok: false, message: `${selfRef()}还不是管理员，发不了公告` };
      await ob.sendGroupNotice(groupId, content.slice(0, 500));
      return { ok: true, message: '公告发出去了' };
    }

    if (kind === 'group_name') {
      const name = String(op.name ?? '').trim().slice(0, 30);
      if (!name) return { ok: false, message: '群名改成什么？没给内容' };
      if (!admin) return { ok: false, message: `${selfRef()}还不是管理员，改不了群名` };
      await ob.setGroupName(groupId, name);
      return { ok: true, message: `群名改成「${name}」了` };
    }

    if (kind === 'like') {
      const id = Number(op.id || op.message_id || 0);
      if (!id) return { ok: false, message: '给哪条点赞？没给消息 id' };
      await ob.setMsgEmojiLike(id, String(op.emoji || '128077'));
      return { ok: true, message: '点了' };
    }

    return { ok: false, message: `不认识的群管理操作：${kind}` };
  } catch (e) {
    return { ok: false, message: `操作失败：${e.message}` };
  }
}

/**
 * 给 prompt 的一行能力说明；不给管理员时也如实说，免得它答应了做不到。
 * @param {string} role
 * @param {boolean} isGroup
 * @param {{selfRecall?:boolean}} [opt] selfRecall=true 时给「自己也能撤」的说明和边界
 */
export function adminHint(role, isGroup, opt = {}) {
  if (!isGroup) return '';
  // 2026-10-28 用户定档位：这几件的门槛要在提示里写清，不然她会一口答应下来又办不成。
  const gate = '\n【档位门槛】挂头衔、发群公告要第六档；禁言、设管理要第七档；踢人永远只有号主能下。'
    + '档位不够就直接说还不够熟，别答应下来。';
  if (!isAdminRole(role)) {
    return '[群管理] 你在本群只是普通成员：能撤回自己刚发的消息（__ADMIN__ {"op":"recall_last"}），'
      + '改不了别人的名片，也禁言不了任何人。有人让你禁言/踢人，就说你又不是管理，让管理来。';
  }
  if (opt.selfRecall) {
    return '[群管理] 你是这个群的管理员。除了号主交代的，你自己也撤得掉看不下去的消息。'
      + '要动手就单独输出一行（不要写成文字）：\n'
      + '__ADMIN__ {"op":"recall","id":消息id}\n'
      + '__ADMIN__ {"op":"recall_last"}\n'
      + '（禁言、改名片这两种只有号主让你做才行，别人让你干你就说做不了主。）\n'
      + '【你自己撤的规矩】只对广告、刷屏、辱骂、色情这类明显不该出现的东西动手；'
      + '有人骂你、冲你来的难听话，这种不用犹豫直接撤，一行写成\n'
      + '__ADMIN__ {"op":"recall","id":消息id,"reason":"abuse"}\n'
      + '带 reason 的这种不占每天那五条的名额。'
      + '别人只是说话难听、跟你抬杠、你看不顺眼，一律不许撤，那是人家说话的地方。'
      + '主人说的话一条都不许碰，跟它熟的人也不碰。拿不准就别动，顶一句比撤一条强。'
      + '最近消息 id 见下面那节，没在那节里的撤不了。' + gate;
  }
  return '[群管理] 你是这个群的管理员，能禁言/解禁、撤回消息、改群名片、踢人、全员禁言、设管理员、挂头衔、发公告、改群名。'
    + '要动手就单独输出一行（不要写成文字）：\n'
    + '__ADMIN__ {"op":"mute","uid":123456,"minutes":10}\n'
    + '__ADMIN__ {"op":"unmute","uid":123456}\n'
    + '__ADMIN__ {"op":"recall","id":消息id}\n'
    + '__ADMIN__ {"op":"recall_last"}\n'
    + '__ADMIN__ {"op":"card","uid":123456,"card":"新名片"}\n'
    + '__ADMIN__ {"op":"kick","uid":123456,"reject":true}\n'
    + '__ADMIN__ {"op":"whole_ban","enable":true}\n'
    + '__ADMIN__ {"op":"set_admin","uid":123456,"enable":true}\n'
    + '__ADMIN__ {"op":"title","uid":123456,"title":"头衔"}\n'
    + '__ADMIN__ {"op":"notice","content":"公告正文"}\n'
    + '__ADMIN__ {"op":"group_name","name":"新群名"}\n'
    + '__ADMIN__ {"op":"like","id":消息id}\n'
    + '踢人、全员禁言、改群名这三件只有号主能下；头衔和群公告第六档就办，禁言和设管理要第七档，够档就直接办。'
    + '点名式的表情回应用 like 就够了，别为了点个赞写一整句。' + gate;
}
