import { stripCallBeforeHash } from './util.mjs';
/**
 * OneBot 消息段 → 模型能读的文本。
 *
 * 单独一个文件是为了能写单测：index.mjs 顶部就会连 NapCat 和起服务，
 * import 它等于启动整个机器人。
 */

/**
 * QQ 黄脸 id → 名字。放这里是因为 renderSegments 要把「收到的是哪个表情」告诉模型——
 * 原来一律渲染成「[表情]」，模型根本不知道对方发的是爱心还是赞，只能瞎猜或者
 * 回一句「就发个表情」，2026-10-29 用户点名要按表情含义来回话。
 * 注意：这张表只到 104，QQ 后来新增的那些（106/264/265/282…）靠 data.raw.faceText 兜住，
 * 所以 faceName() 先取 faceText 再查表，别反着来。
 */
export const FACE_NAMES = {
  '0': '惊讶', '1': '撇嘴', '2': '色', '3': '发呆', '4': '得意', '5': '流泪',
  '6': '害羞', '7': '闭嘴', '8': '睡', '9': '大哭', '10': '尴尬', '11': '发怒',
  '12': '调皮', '13': '呲牙', '14': '微笑', '15': '难过', '16': '酷', '17': '冷汗',
  '18': '抓狂', '19': '吐', '20': '偷笑', '21': '可爱', '22': '白眼', '23': '傲慢',
  '24': '饥饿', '25': '困', '26': '惊恐', '27': '流汗', '28': '憨笑', '29': '悠闲',
  '30': '奋斗', '31': '咒骂', '32': '疑问', '33': '嘘', '34': '晕', '35': '折磨',
  '36': '衰', '37': '骷髅', '38': '敲打', '39': '再见', '40': '擦汗', '41': '抠鼻',
  '42': '鼓掌', '43': '糗大了', '44': '坏笑', '45': '左哼哼', '46': '右哼哼',
  '47': '哈欠', '48': '鄙视', '49': '委屈', '50': '快哭了', '51': '阴险', '52': '亲亲',
  '53': '吓', '54': '可怜', '55': '菜刀', '56': '西瓜', '57': '啤酒', '58': '篮球',
  '59': '乒乓', '60': '咖啡', '61': '饭', '62': '猪头', '63': '玫瑰', '64': '凋谢',
  '65': '示爱', '66': '爱心', '67': '心碎', '68': '蛋糕', '69': '闪电', '70': '炸弹',
  '71': '刀', '72': '足球', '73': '瓢虫', '74': '便便', '75': '月亮', '76': '太阳',
  '77': '礼物', '78': '拥抱', '79': '强', '80': '弱', '81': '握手', '82': '胜利',
  '83': '抱拳', '84': '勾引', '85': '拳头', '86': '差劲', '87': '爱你', '88': 'NO',
  '89': 'OK', '90': '爱情', '91': '飞吻', '92': '跳跳', '93': '发抖', '94': '怄火',
  '95': '转圈', '96': '磕头', '97': '回头', '98': '跳绳', '99': '挥手', '100': '激动',
  '101': '街舞', '102': '献吻', '103': '左太极', '104': '右太极',
};

/** face 段 → 给模型看的中文名；查不到就空串，让调用方退回 id */
export function faceName(data) {
  const d = data ?? {};
  const raw = String(d.raw?.faceText ?? '').replace(/^[/／]/, '').replace(/^\[|\]$/g, '').trim();
  if (raw) return raw;
  return FACE_NAMES[String(d.id ?? '')] ?? '';
}

/** face 段 → 正文里的标签。有名字写名字，没名字写 id，都没有退回「[表情]」 */
export function faceLabel(data) {
  const name = faceName(data);
  if (name) return `[表情:${name}]`;
  const id = String(data?.id ?? '').trim();
  return id ? `[表情:#${id}]` : '[表情]';
}

/**
 * @ 段的人称标签。
 * 之前的坑：at 段只进 ats 数组、不进正文，模型看到的是「顾鹤 你今天吃饭没」，
 * 压根不知道有人在 @ 号主，群里又是默认接话，就当成在跟自己说了。
 */
export function atLabel(qq, selfId, ownerUids) {
  if (qq === 'all') return '@全体成员';
  if (selfId && String(selfId) === qq) return '@你';
  if (ownerUids.includes(Number(qq))) return '@号主';
  return '@群友';
}

/** 合并转发里的单条消息 → 一行「谁：说了什么」（纯文本，不递归） */
function forwardItemLine(item) {
  const who = item?.sender?.card || item?.sender?.nickname || String(item?.user_id || '某人');
  const inner = Array.isArray(item?.message)
    ? item.message
    : [{ type: 'text', data: { text: String(item?.raw_message ?? '') } }];
  let line = '';
  for (const s of inner) {
    const t = s?.type;
    const d = s?.data ?? {};
    if (t === 'text') line += d.text ?? '';
    else if (t === 'at') line += `@${d.qq} `;
    else if (t === 'image' || t === 'mface') line += '[图]';
    else if (t === 'face') line += faceLabel(d);
    else if (t === 'record') line += '[语音]';
    else if (t === 'file' || t === 'onlinefile') line += '[文件]';
    else if (t === 'video') line += '[视频]';
    else if (t === 'json' || t === 'xml') line += '[卡片]';
    else if (t === 'forward') line += '[又一段转发]';
  }
  line = line.replace(/\s+/g, ' ').trim();
  return `${who}：${line || '[非文字内容]'}`;
}

/**
 * 合并转发（聊天记录卡片）→ 模型能读的正文。
 * 2026-10-26 实测：NapCat 4.18.41 直接在段的 data.content 里塞了完整 messages 数组，
 * 不用再调 get_forward_msg（那个接口也在，data.content 为空时才需要兜底）。
 * 长度有上限：条数 40、总字 1500，超了就说「还有 N 条没展开」——
 * 一条转发几十条长文，不截断会把整轮 prompt 顶爆。
 */
export function renderForward(data, opts = {}) {
  const items = Array.isArray(data?.content) ? data.content : [];
  if (items.length) return renderForwardMessages(items, opts);
  // 2026-10-26 实测：私聊那条 data.content 里带了全部内容，**群里那条是空的**，
  // 内容得另外调 get_forward_msg 按 id 捞（见 index.mjs 的 resolveForwards）。
  // 这里只留占位符，异步补齐由桥负责，别在同步渲染里编内容。
  const id = String(data?.id ?? '');
  if (id) return `[[FWD:${id}]]`;
  return '[对方转发了一段聊天记录，我这边读不到里面的内容]';
}

/** 把 get_forward_msg 拿回来的 messages 数组渲染成文本（也可以直接喂 data.content） */
export function renderForwardMessages(items, { maxItems = 40, maxChars = 1500 } = {}) {
  if (!Array.isArray(items) || !items.length) {
    return '[对方转发了一段聊天记录，我这边读不到里面的内容]';
  }
  const lines = [];
  let used = 0;
  let shown = 0;
  for (const it of items) {
    if (shown >= maxItems) break;
    const line = forwardItemLine(it);
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  const rest = items.length - shown;
  const head = `[对方转发了一段聊天记录，共 ${items.length} 条${rest > 0 ? `，只展开前 ${shown} 条` : ''}]\n`;
  return head + lines.join('\n');
}

export function renderSegments(message, { selfId = 0, ownerUids = [] } = {}) {
  const segs = Array.isArray(message)
    ? message
    : [{ type: 'text', data: { text: String(message ?? '') } }];
  let text = '';
  const ats = [];
  const images = [];
  const records = [];
  const files = [];
  // 引用回复：QQ 只在段里给一个被引用消息的 id，正文得另外捞（见 index.mjs 的 resolveQuote）
  let replyId = 0;
  for (const s of segs) {
    const d = s?.data ?? {};
    switch (s?.type) {
      case 'text': text += d.text ?? ''; break;
      case 'at': {
        const qq = String(d.qq);
        ats.push(qq);
        text += `${atLabel(qq, selfId, ownerUids)} `;
        break;
      }
      case 'image':
        text += `[[IMG:${images.length}]]`;
        images.push({ url: d.url || '', kind: 'image', summary: d.summary || '' });
        break;
      case 'mface':
        text += `[[MFACE:${images.length}]]`;
        images.push({ url: d.url || '', kind: 'mface', summary: d.summary || '' });
        break;
      case 'face': text += faceLabel(d); break;
      // 注意措辞：不能给模型「你看不到」这种直接可复述的提示，
      // 否则它会开口就说「我看不到」。改成中性的「没法细看」，配合人设里
      // 「不许说自己看不见，打个哈哈岔开」这条。
      case 'record':
        text += `[[REC:${records.length}]]`;
        records.push({ file: d.file || '', url: d.url || '', duration: d.duration || 0 });
        break;
      case 'video': text += '[对方发了段视频，你没细看]'; break;
      // 文件：NapCat 的 file 段给 `file`（文件名）/`file_id`/`file_size`/`url`，
      // 早期写法读的是 `d.name`，字段名对不上，群里收到的文件一律显示成「[文件:]」。
      // 这里只留占位符，真正的下载和落盘交给 index.mjs 的 resolveFiles（异步）。
      case 'file':
        text += `[[FILE:${files.length}]]`;
        files.push({
          name: d.file || d.name || '',
          url: d.url || '',
          fileId: d.file_id || '',
          size: Number(d.file_size ?? d.size ?? 0) || 0,
          // SnowLuma 取私聊文件直链要 file_hash，NapCat 不给（空串，走不到那条路也无所谓）
          fileHash: d.file_hash || d.fileHash || '',
        });
        break;
      // 在线文件（QQ 的「发送文件」走内核 onlinefile 段，NapCat 单独给了 type）
      case 'onlinefile':
        text += `[[FILE:${files.length}]]`;
        files.push({
          name: d.fileName || d.name || '',
          url: d.url || '',
          fileId: d.file_id || '',
          size: Number(d.fileSize ?? d.file_size ?? 0) || 0,
          msgId: d.msgId || '',
          elementId: d.elementId || '',
          isDir: !!d.isDir,
        });
        break;
      case 'json':
      case 'xml': text += '[卡片消息]'; break;
      case 'forward': text += renderForward(d); break;
      case 'reply': replyId = Number(d.id) || 0; break;
      default: break;
    }
  }
  return { text: text.replace(/[ \t]+$/g, '').trim(), ats, images, records, files, replyId };
}

/** 去掉 @ 标签后的纯正文：判断「空的 @」和「只 @ 了别人」用 */
export function stripAtLabels(text) {
  return String(text)
    .replace(/\[\[(?:IMG|MFACE|REC|FILE):\d+\]\]/g, '')
    .replace(/@(?:你|号主|群友|全体成员)\s*/g, '')
    .trim();
}

/**
 * 「#好感度」命令。
 * 只认「@了你」或者「谁都没 @」的消息——别人 @号主、@群友 时发的 #好感度 不算叫它。
 */
export function isFavorCommand(text) {
  //群里「溟月 #好感度」这种，先把行首那声称呼剥掉再认指令（2026-10-28）
 const t = stripCallBeforeHash(String(text ?? ''), ['溟月']);
  if (!t.includes('@你') && /@(?:号主|群友|全体成员)/.test(t)) return false;
  return /^[#＃]\s*好感度$/.test(stripAtLabels(t));
}
