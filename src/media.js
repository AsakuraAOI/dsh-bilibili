import { mkdir, stat, rename, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from './client.js';
import { downloadWithRetry } from './download.js';

async function size(file) { try { return (await stat(file)).size; } catch { return 0; } }

/** Cookies stay in the API client; CDN requests never receive them. */
export async function download(client, url, destination, byteBudget) {
  return downloadWithRetry({ openResponse: signal => client.mediaResponse(url, signal), target: destination, maxBytes: byteBudget, signal: client.signal, tooLargeCode: 'VIDEO_TOO_LARGE' });
}

const pending = new Map();
/** Resolve/download only. Agent chooses ASR and visual reads; no Seeit runtime or mux needed. */
export async function prepareBilibiliMedia(client, input, { directory, maxDownloadMb = 800, maxVideoMinutes = 0 } = {}) {
  if (!Number.isFinite(maxVideoMinutes) || maxVideoMinutes < 0) throw fail('INVALID_ARGUMENT', 'maxVideoMinutes 必须为非负数。');
  const video = await client.resolveVideo(input);
  if (!/^BV[a-zA-Z0-9]+$/.test(video.bvid) || !Number.isInteger(video.page) || video.page < 1) throw fail('INVALID_VIDEO', '视频标识无效。');
  if (maxVideoMinutes && video.duration > maxVideoMinutes * 60) throw fail('VIDEO_TOO_LONG', '视频超过配置的时长限制。');
  const root = join(directory, `${video.bvid}-p${video.page}`), previous = pending.get(root) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    client.signal?.throwIfAborted();
    await mkdir(root, { recursive: true });
    const warnings = []; let transcript;
    try { const result = await client.subtitle(video); transcript = result.transcript; if (result.note) warnings.push(result.note); }
    catch (error) { client.signal?.throwIfAborted(); warnings.push(`原字幕未读取（${error.code || 'ERROR'}）；由主 Agent 决定是否调用 ASR。`); }
    const manifestFile = join(root, 'download.json'), limit = maxDownloadMb * 1024 * 1024;
    let manifest;
    try { manifest = JSON.parse(await readFile(manifestFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (manifest && ['muxed', 'dash'].includes(manifest.kind)) {
      const path = join(root, manifest.kind === 'muxed' ? 'media.mp4' : 'video.m4s');
      const audioPath = manifest.kind === 'muxed' ? path : join(root, 'audio.m4s');
      const actual = await size(path) + (path === audioPath ? 0 : await size(audioPath));
      if (actual > limit) throw fail('VIDEO_TOO_LARGE', '已缓存视频超过当前下载大小限制。');
      if (await size(path) && await size(audioPath)) return { video, path, audioPath, transcript, warnings };
    }
    const play = await client.request('/x/player/playurl', { params: { bvid: video.bvid, cid: video.cid, qn: 32, fnval: 1, fnver: 0, fourk: 0, platform: 'html5' } });
    let path, audioPath, kind;
    if (play.durl?.length === 1 && play.durl[0].url && !/\.flv(?:\?|$)/i.test(play.durl[0].url)) {
      kind = 'muxed'; path = join(root, 'media.mp4'); audioPath = path;
      await download(client, play.durl[0].url, path, limit);
    } else {
      const dash = play.dash || (await client.request('/x/player/playurl', { params: { bvid: video.bvid, cid: video.cid, qn: 32, fnval: 16, fnver: 0, fourk: 0 } })).dash;
      const videos = (dash?.video || []).filter(v => !v.codecs || /^avc/.test(v.codecs)).sort((a, b) => Math.abs(a.id - 32) - Math.abs(b.id - 32));
      const visual = videos[0] || dash?.video?.[0], audio = dash?.audio?.[0];
      if (!visual || !audio) throw fail('PLAYURL_UNAVAILABLE', '没有可访问的音视频流；视频可能需要登录或不可用。');
      kind = 'dash'; path = join(root, 'video.m4s'); audioPath = join(root, 'audio.m4s');
      const used = await download(client, visual.baseUrl || visual.base_url, path, limit);
      await download(client, audio.baseUrl || audio.base_url, audioPath, limit - used);
    }
    const temp = manifestFile + '.' + randomUUID() + '.tmp';
    try { await writeFile(temp, JSON.stringify({ kind }), { mode: 0o600 }); await rename(temp, manifestFile); }
    finally { await rm(temp, { force: true }); }
    return { video, path, audioPath, transcript, warnings };
  });
  pending.set(root, task);
  try { return await task; } finally { if (pending.get(root) === task) pending.delete(root); }
}
