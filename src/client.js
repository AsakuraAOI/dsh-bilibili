import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_ACCOUNT_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'bilibili', 'account.json');
const API = 'https://api.bilibili.com';
const PASSPORT = 'https://passport.bilibili.com';
const VC = 'https://api.vc.bilibili.com';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', Referer: 'https://www.bilibili.com/', Origin: 'https://www.bilibili.com' };
const COOKIE_NAMES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid', 'buvid3', 'buvid4'];
const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

export function fail(code, message) { return Object.assign(new Error(message), { code }); }
export function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw fail('INVALID_ARGUMENT', `${name} 必须是非空字符串。`);
  return value.trim();
}
export function idString(value, name = 'id') {
  const str = String(value ?? '');
  if (!/^[1-9]\d*$/.test(str) || (typeof value === 'number' && !Number.isSafeInteger(value))) throw fail('INVALID_ARGUMENT', `${name} 必须是正整数字符串。`);
  return str;
}
export function parseJson(raw) {
  // Node 22+ exposes the original numeric token, preserving B站 64-bit message IDs.
  return JSON.parse(raw, (_key, value, context) => typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) ? context.source : value);
}
export async function readJson(file, fallback) {
  try { return parseJson(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw fail('STORAGE_ERROR', 'B站本地状态无法读取，请检查文件权限或 JSON 格式。'); }
}
export async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}
export function extractCookies(urlText, setCookies = []) {
  const jar = {};
  const queue = [String(urlText || '')], visited = new Set();
  while (queue.length && visited.size < 12) {
    const text = queue.shift();
    if (visited.has(text)) continue;
    visited.add(text);
    let url; try { url = new URL(text); } catch { continue; }
    for (const name of COOKIE_NAMES) {
      const value = url.searchParams.get(name);
      if (value) jar[name] = name === 'SESSDATA' ? encodeURIComponent(value) : value;
    }
    for (const value of url.searchParams.values()) {
      if (/^https?:\/\//.test(value)) queue.push(value);
    }
  }
  for (const line of setCookies) {
    const pair = line.split(';')[0], eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    if (eq > 0 && COOKIE_NAMES.includes(name)) jar[name] = pair.slice(eq + 1).trim();
  }
  for (const [name, value] of Object.entries(jar)) {
    if (/[;\r\n]/.test(value)) throw fail('INVALID_COOKIE', `登录响应的 ${name} 无效。`);
  }
  return jar;
}
export function isBilibiliInput(value) {
  const str = String(value || '').trim();
  if (/^(?:BV[\da-zA-Z]{10}|av\d+)(?:\?p=\d+)?$/.test(str)) return true;
  const match = str.match(/https?:\/\/[^\s<>"）)]+/);
  if (!match) return false;
  try { const host = new URL(match[0]).hostname; return host === 'b23.tv' || host === 'bilibili.com' || host.endsWith('.bilibili.com'); } catch { return false; }
}
export function signWbi(params, imageKey, subKey, now = Date.now()) {
  const key = MIXIN.map(index => (imageKey + subKey)[index]).join('').slice(0, 32);
  const values = { ...params, wts: Math.floor(now / 1000) };
  for (const name of Object.keys(values)) values[name] = String(values[name]).replace(/[!'()*]/g, '');
  const query = Object.keys(values).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(values[k])}`).join('&');
  return { ...values, w_rid: createHash('md5').update(query + key).digest('hex') };
}
export function isMediaHost(host) {
  return ['bilivideo.com', 'bilivideo.cn', 'hdslb.com', 'bilibili.com'].some(domain => host === domain || host.endsWith(`.${domain}`));
}
export async function boundedBody(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) throw fail('RESPONSE_TOO_LARGE', 'B站响应超过大小限制。');
  if (!response.body) throw fail('BAD_RESPONSE', 'B站响应为空。');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > limit) throw fail('RESPONSE_TOO_LARGE', 'B站响应超过大小限制。');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export class BilibiliClient {
  constructor({ accountFile = DEFAULT_ACCOUNT_FILE, fetcher = fetch, signal, timeoutMs = 30000 } = {}) {
    this.accountFile = accountFile; this.fetcher = fetcher; this.signal = signal; this.timeoutMs = timeoutMs;
  }
  async account(requiredLogin = false) {
    const record = await readJson(this.accountFile, {});
    if (requiredLogin && !record.cookies?.SESSDATA) throw fail('LOGIN_REQUIRED', '尚未登录 B站独立账号。请调用 bilibili_login(action="start") 扫码。');
    return record;
  }
  async request(path, { host = API, params = {}, form, authenticated = true, envelope = true } = {}) {
    if (![API, VC, PASSPORT].includes(host) || !path.startsWith('/')) throw fail('INVALID_HOST', '拒绝非 B站 API 地址。');
    this.signal?.throwIfAborted();
    const url = new URL(path, host); for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
    const headers = { ...HEADERS };
    if (authenticated) {
      const account = await this.account(Boolean(form));
      headers.Cookie = Object.entries(account.cookies || {}).filter(([key, value]) => COOKIE_NAMES.includes(key) && typeof value === 'string' && !/[;\r\n]/.test(value)).map(([key, value]) => `${key}=${value}`).join('; ');
      if (!headers.Cookie) delete headers.Cookie;
      if (form) {
        if (!account.cookies.bili_jct) throw fail('CSRF_MISSING', '账号缺少 bili_jct，请重新扫码登录。');
        form = { ...form, csrf: account.cookies.bili_jct, csrf_token: account.cookies.bili_jct };
      }
    }
    if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    let response;
    try {
      response = await this.fetcher(url.href, { method: form ? 'POST' : 'GET', headers, ...(form ? { body: new URLSearchParams(form) } : {}), redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(this.signal ? [this.signal] : [])]) });
    } catch (error) { this.signal?.throwIfAborted(); throw fail(form ? 'WRITE_RESULT_UNKNOWN' : 'NETWORK_ERROR', form ? '发送请求中断，结果未知；请到 B站核对，勿直接重试以免重复发送。' : 'B站请求失败或超时。'); }
    if (!response.ok) {
      if (form && response.status >= 500) throw fail('WRITE_RESULT_UNKNOWN', `B站 HTTP ${response.status}，发送结果未知；请在 B站核对后再操作。`);
      throw fail([412,429].includes(response.status) ? 'RISK_CONTROL' : 'HTTP_ERROR', `B站 HTTP ${response.status}；请稍后重试。`);
    }
    let json; try { json = parseJson((await boundedBody(response, 8 * 1024 * 1024)).toString('utf8')); }
    catch (error) {
      if (form) throw fail('WRITE_RESULT_UNKNOWN', '发送响应无法读取，结果未知；请在 B站核对，勿直接重试。');
      if (error.code) throw error; throw fail('BAD_RESPONSE', 'B站返回非 JSON 响应。');
    }
    if (json.code !== 0) {
      const code = json.code === -101 ? 'LOGIN_REQUIRED' : [-412,-352,-509,21020,21046].includes(json.code) ? 'RISK_CONTROL' : 'API_ERROR';
      throw fail(code, `B站返回 ${json.code}：${String(json.message || json.msg || '请求失败').slice(0, 240)}`);
    }
    return envelope ? json.data : { data: json.data, response };
  }
  async signed(params) {
    const nav = await this.request('/x/web-interface/nav');
    const key = name => new URL(nav.wbi_img?.[name] || '').pathname.split('/').pop().split('.')[0];
    try { return signWbi(params, key('img_url'), key('sub_url')); }
    catch { throw fail('WBI_UNAVAILABLE', '无法取得 B站签名参数。'); }
  }
  async status() {
    const record = await this.account();
    if (!record.cookies?.SESSDATA) return { loggedIn: false };
    const nav = await this.request('/x/web-interface/nav');
    return { loggedIn: nav.isLogin === true, uid: String(nav.mid || ''), name: nav.uname || '', savedAt: record.savedAt };
  }
  async startLogin() {
    const data = await this.request('/x/passport-login/web/qrcode/generate', { host: PASSPORT, authenticated: false });
    if (!data?.qrcode_key || !data.url) throw fail('BAD_RESPONSE', '二维码生成失败。');
    return { key: data.qrcode_key, url: data.url };
  }
  async pollLogin(key) {
    const { data, response } = await this.request('/x/passport-login/web/qrcode/poll', { host: PASSPORT, params: { qrcode_key: required(key, 'qrcodeKey') }, authenticated: false, envelope: false });
    if (data.code !== 0) return { status: ({86101:'waiting',86090:'scanned',86038:'expired'})[data.code] || 'failed' };
    const cookies = extractCookies(data.url, response.headers.getSetCookie?.() || []);
    if (!cookies.SESSDATA || !cookies.bili_jct || !cookies.DedeUserID) throw fail('LOGIN_INCOMPLETE', '登录响应缺少账号凭据，请重新扫码。');
    await writeJson(this.accountFile, { cookies, deviceId: randomUUID().toUpperCase(), savedAt: new Date().toISOString() });
    return { status: 'success', ...await this.status() };
  }
  async logout() { await rm(this.accountFile, { force: true }); return { loggedIn: false }; }
  async resolveVideo(input, pageOverride) {
    let text = required(input, '视频链接/BV号'), page = pageOverride;
    const link = text.match(/https?:\/\/[^\s<>"）)]+/);
    if (link) {
      let url = new URL(link[0]);
      for (let hops = 0; url.hostname === 'b23.tv'; hops++) {
        if (hops >= 4 || url.protocol !== 'https:' || url.username || url.password) throw fail('INVALID_VIDEO_URL', 'B站短链接无效。');
        const res = await this.fetcher(url.href, { headers: HEADERS, redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(this.signal ? [this.signal] : [])]) });
        await res.body?.cancel();
        if (![301,302,303,307,308].includes(res.status) || !res.headers.get('location')) throw fail('INVALID_VIDEO_URL', '短链接没有指向视频。');
        url = new URL(res.headers.get('location'), url);
      }
      if (url.protocol !== 'https:' || url.username || url.password || !['bilibili.com','www.bilibili.com','m.bilibili.com'].includes(url.hostname) || !/^\/video\//.test(url.pathname)) throw fail('INVALID_VIDEO_URL', '只接受 B站视频链接、b23.tv 短链或 BV/av 号。');
      text = url.pathname; page ??= Number(url.searchParams.get('p') || 1);
    } else if (!/^(?:BV[\da-zA-Z]{10}|av\d+)(?:\?p=\d+)?$/.test(text)) {
      throw fail('INVALID_VIDEO_URL', '无法解析 B站视频。');
    } else { page ??= Number(text.match(/\?p=(\d+)/)?.[1] || 1); }
    if (!Number.isSafeInteger(page) || page < 1) throw fail('INVALID_ARGUMENT', 'page 必须是正整数。');
    const bvid = text.match(/BV[\da-zA-Z]{10}/)?.[0], aid = text.match(/av(\d+)/)?.[1];
    const info = await this.request('/x/web-interface/view', { params: bvid ? { bvid } : { aid } });
    const part = info.pages?.find(p => p.page === page) || (page === 1 && !info.pages?.length ? { cid: info.cid, duration: info.duration, page: 1 } : undefined);
    if (!part?.cid) throw fail('VIDEO_PART_MISSING', `视频没有第 ${page} 分 P。`);
    return { bvid: info.bvid, aid: String(info.aid), cid: String(part.cid), page, title: info.title, part: part.part, description: info.desc || '', duration: part.duration || info.duration, uploader: info.owner?.name, url: `https://www.bilibili.com/video/${info.bvid}/?p=${page}`, videoId: `bilibili-${info.bvid}-p${page}`, pages: info.pages?.map(p => ({ page: p.page, title: p.part, duration: p.duration })) || [] };
  }
  async subtitle(video) {
    const params = { bvid: video.bvid, cid: video.cid };
    let data;
    try { data = await this.request('/x/player/wbi/v2', { params: await this.signed(params) }); }
    catch (error) { if (error.code === 'RISK_CONTROL') throw error; data = await this.request('/x/player/v2', { params }); }
    const tracks = data.subtitle?.subtitles || [];
    const track = tracks.find(s => /zh/.test(s.lan) && s.subtitle_url) || tracks.find(s => s.subtitle_url);
    if (!track) return { transcript: undefined, note: data.need_login_subtitle ? '字幕需要登录；当前未读取字幕。' : '没有可用原字幕，尝试 Seeit ASR。' };
    const response = await this.mediaResponse(track.subtitle_url);
    const body = parseJson((await boundedBody(response, 8 * 1024 * 1024)).toString('utf8'));
    const cues = (body.body || []).map((c, i) => ({ id: `subtitle-${i}`, start: Number(c.from), end: Number(c.to), content: String(c.content || '') })).filter(c => c.content && Number.isFinite(c.start) && Number.isFinite(c.end) && c.start >= 0 && c.end >= c.start);
    return { transcript: cues.length ? { source: 'original', language: track.lan, cues } : undefined, note: cues.length ? '' : '字幕轨为空。' };
  }
  async mediaResponse(address) {
    let url = new URL(address.startsWith('//') ? `https:${address}` : address);
    for (let hops = 0; hops < 5; hops++) {
      if (url.protocol !== 'https:' || url.username || url.password || !isMediaHost(url.hostname)) throw fail('INVALID_MEDIA_HOST', '拒绝非 B站媒体域名。');
      // Login cookies must never accompany CDN or redirect requests.
      const response = await this.fetcher(url.href, { headers: HEADERS, redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(300000), ...(this.signal ? [this.signal] : [])]) });
      if ([301,302,303,307,308].includes(response.status)) { await response.body?.cancel(); url = new URL(response.headers.get('location'), url); continue; }
      if (!response.ok) { await response.body?.cancel(); throw fail('MEDIA_HTTP_ERROR', `媒体下载 HTTP ${response.status}。`); }
      return response;
    }
    throw fail('TOO_MANY_REDIRECTS', '媒体重定向次数过多。');
  }
  async comments(input, page = 1) {
    const video = await this.resolveVideo(input);
    if (!Number.isSafeInteger(page) || page < 1) throw fail('INVALID_ARGUMENT', 'page 必须是正整数。');
    const data = await this.request('/x/v2/reply', { params: { type: 1, oid: video.aid, pn: page, ps: 20, sort: 2 } });
    const project = c => ({ id: String(c.rpid_str || c.rpid), root: String(c.root_str || c.root || 0), parent: String(c.parent_str || c.parent || 0), uid: String(c.member?.mid || ''), name: c.member?.uname, text: c.content?.message || '', time: c.ctime });
    return { video, page, total: data.page?.count, comments: (data.replies || []).map(c => ({ ...project(c), replies: (c.replies || []).map(project) })) };
  }
  async mentions(cursor = {}) {
    await this.account(true);
    const data = await this.request('/x/msgfeed/at', { params: { platform: 'web', build: 0, mobi_app: 'web', ...(cursor.id ? { id: cursor.id, at_time: cursor.time } : {}) } });
    return { cursor: data.cursor, items: (data.items || []).map(m => {
      const item = m.item || {}, uri = item.uri || '', bv = uri.match(/BV[\da-zA-Z]{10}/)?.[0];
      const isVideo = Boolean(bv) || (Number(item.business_id) === 1 && item.subject_id);
      return { id: String(m.id), time: m.at_time || m.reply_time || 0, user: m.user?.nickname || '', uid: String(m.user?.mid || ''), text: item.source_content || item.title || '', root: String(item.root_id || item.source_id || 0), parent: String(item.source_id || 0), video: isVideo ? (bv ? uri : `av${item.subject_id}`) : null, uri, businessId: item.business_id };
    }) };
  }
  async messages(uid, before) {
    await this.account(true);
    const data = await this.request('/svr_sync/v1/svr_sync/fetch_session_msgs', { host: VC, params: { talker_id: idString(uid, 'uid'), session_type: 1, size: 20, ...(before ? { begin_seqno: idString(before, 'before') } : {}) } });
    return { hasMore: data.has_more, messages: (data.messages || []).map(m => ({ key: String(m.msg_key), sequence: String(m.msg_seqno), sender: String(m.sender_uid), type: m.msg_type, content: m.content, time: m.timestamp })) };
  }
  async privateSessions(before) {
    await this.account(true);
    const data = await this.request('/session_svr/v1/session_svr/get_sessions', { host: VC, params: { session_type: 1, group_fold: 0, unfollow_fold: 0, sort_rule: 2, size: 20, build: 0, mobi_app: 'web', ...(before ? { end_ts: idString(before, 'before') } : {}) } });
    return { hasMore: Boolean(data.has_more), sessions: (data.session_list || []).map(s => ({
      uid: String(s.talker_id), type: s.session_type, system: Number(s.system_msg_type || 0) !== 0,
      name: s.account_info?.name || '', timestamp: String(s.session_ts || ''),
      lastTime: Number(s.last_msg?.timestamp || 0), lastKey: String(s.last_msg?.msg_key || ''),
    })) };
  }
  async comment(input, content, root, parent) {
    const text = required(content, 'content');
    if ([...text].length > 1000) throw fail('MESSAGE_TOO_LONG', '评论最多 1000 字符。');
    if (parent && !root) throw fail('INVALID_ARGUMENT', '回复评论必须同时指定 root 和 parent。');
    const video = await this.resolveVideo(input);
    const data = await this.request('/x/v2/reply/add', { form: { type: '1', oid: video.aid, plat: '1', message: text, ...(root ? { root: idString(root, 'root'), parent: idString(parent || root, 'parent') } : {}) } });
    if (data.need_captcha) throw fail('CAPTCHA_REQUIRED', 'B站要求验证，请在 B站客户端完成。');
    if (!data.rpid_str && !data.rpid) throw fail('WRITE_RESULT_UNKNOWN', '评论响应没有评论 ID，请在 B站核对结果后再操作。');
    return { sent: true, video: video.url, commentId: String(data.rpid_str || data.rpid), content: text };
  }
  async sendMessage(uid, content) {
    const receiver = idString(uid, 'uid'), account = await this.account(true), text = required(content, 'content');
    const body = JSON.stringify({ content: text });
    if (Buffer.byteLength(body) > 2000) throw fail('MESSAGE_TOO_LONG', '私信 JSON 内容最多 2000 字节。');
    const sender = idString(account.cookies.DedeUserID, '账号 UID');
    const params = await this.signed({ w_sender_uid: sender, w_receiver_id: receiver, w_dev_id: account.deviceId });
    const data = await this.request('/web_im/v1/web_im/send_msg', { host: VC, params, form: { 'msg[sender_uid]': sender, 'msg[receiver_id]': receiver, 'msg[receiver_type]': '1', 'msg[msg_type]': '1', 'msg[msg_status]': '0', 'msg[dev_id]': account.deviceId, 'msg[timestamp]': String(Math.floor(Date.now() / 1000)), 'msg[new_face_version]': '1', 'msg[content]': body } });
    if (!data.msg_key) throw fail('WRITE_RESULT_UNKNOWN', '私信响应没有消息 ID，请在 B站核对结果后再操作。');
    return { sent: true, receiver, messageKey: String(data.msg_key), content: text };
  }
}
