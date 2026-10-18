import { fail, idString, COMMENT_MAX_CHARACTERS, PRIVATE_MAX_CHARACTERS, PRIVATE_MAX_JSON_BYTES, PRIVATE_SEND_INTERVAL_MS } from './client.js';

/** Include numbering in both limits and retain every original code point. */
export function splitReply(content, channel) {
  const limit = channel === 'private' ? PRIVATE_MAX_CHARACTERS : COMMENT_MAX_CHARACTERS;
  const fits = value => [...value].length <= limit && (channel !== 'private' || Buffer.byteLength(JSON.stringify({ content: value })) <= PRIVATE_MAX_JSON_BYTES);
  if (fits(content)) return [content];
  const chars = [...content];
  let total = 2;
  for (;;) {
    const chunks = [];
    let offset = 0;
    while (offset < chars.length) {
      const prefix = `【${chunks.length + 1}/${total}】\n`;
      let low = 0, high = Math.min(limit, chars.length - offset);
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits(prefix + chars.slice(offset, offset + middle).join(''))) low = middle;
        else high = middle - 1;
      }
      if (!low) throw fail('MESSAGE_TOO_LONG', '分段编号已超过单条消息限制。');
      // Prefer paragraph/word boundaries without dropping whitespace.
      if (offset + low < chars.length) {
        for (let size = low; size > low / 2; size--) {
          if (/\s/u.test(chars[offset + size - 1])) { low = size; break; }
        }
      }
      chunks.push(prefix + chars.slice(offset, offset + low).join(''));
      offset += low;
    }
    if (chunks.length === total) return chunks;
    total = chunks.length;
  }
}

/** A mention may select its own reply channel, never another recipient or action. */
export function wantsPrivateReply(text = '') {
  return String(text).split(/[，。；！？,;.!?\n]/).some(clause => {
    if (/(?:不要|不用|无需|别|禁止|不必|不需要|不想|不接受|勿).{0,6}(?:私信|私聊|DM)|(?:私信|私聊).{0,4}(?:不要|不用|不必|别发)/i.test(clause)) return false;
    return /(?:请|麻烦|希望|可以|用|通过|走|发|给我|回复|结果|总结|内容|直接|记得).{0,10}(?:私信|私聊)|(?:私信|私聊).{0,10}(?:我|发|回复|发送|告诉|给|结果|总结|内容)|\bdm\s+me\b|(?:send|reply).{0,20}(?:private message|\bdm\b)/i.test(clause.trim()) || /^(?:请)?(?:私信|私聊)$/i.test(clause.trim());
  });
}

export function prepareDelivery(item, reading) {
  const channel = wantsPrivateReply(item.text) ? 'private' : 'comment';
  const target = channel === 'private'
    ? { uid: idString(item.uid, '提及者 UID') }
    : { video: item.video, parent: idString(item.parent, '原 @评论 ID'), root: idString(item.root && item.root !== '0' ? item.root : item.parent, '根评论 ID') };
  const raw = String(reading || '').trim();
  const overview = raw.match(/^overview:\s*\r?\n([\s\S]*)/m)?.[1]?.trim();
  if (!overview && /^(?:videoId|videoContentRead|status):/m.test(raw)) throw fail('REPLY_CONTENT_MISSING', '视频阅读缺少内容摘要，未发送。');
  const summary = (overview || raw).replace(/^sections \(\d+\):/gm, '关键时间点：').trim();
  if (!summary) throw fail('REPLY_CONTENT_MISSING', '视频阅读摘要为空，未发送。');
  const content = `视频阅读结果：\n${summary}`;
  const parts = splitReply(content, channel).map(content => ({ content, status: 'pending' }));
  return { channel, target, content, parts };
}

export async function sendDelivery(client, delivery, persist) {
  let previousReceipt;
  for (const part of delivery.parts) {
    if (part.status === 'sent') { previousReceipt = part.receipt; continue; }
    if (part.status !== 'pending') throw fail('DELIVERY_BLOCKED', '分段发送状态不确定，需核对后再操作。');
    part.status = 'sending'; delivery.status = 'sending';
    await persist();
    try {
      part.receipt = delivery.channel === 'private'
        ? await client.sendMessage(delivery.target.uid, part.content, ...(Number.isFinite(previousReceipt?.acknowledgedAt) ? [{ notBefore: previousReceipt.acknowledgedAt + PRIVATE_SEND_INTERVAL_MS }] : []))
        : await client.comment(delivery.target.video, part.content, delivery.target.root, delivery.target.parent);
    } catch (error) {
      part.status = error.code === 'WRITE_RESULT_UNKNOWN' ? 'unknown' : 'failed';
      part.error = `${error.code || 'ERROR'}:${error.message}`;
      delivery.status = part.status; delivery.error = part.error;
      await persist(); return;
    }
    part.status = 'sent';
    previousReceipt = part.receipt;
    delivery.receipt = part.receipt;
    delivery.status = delivery.parts.every(part => part.status === 'sent') ? 'sent' : 'pending';
    // Record this receipt before even starting the following segment.
    await persist();
  }
}
