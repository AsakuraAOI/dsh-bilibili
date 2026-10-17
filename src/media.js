import { mkdir, stat, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BilibiliClient, fail } from './client.js';

async function nonempty(file) { try { return (await stat(file)).size > 0; } catch { return false; } }

/** Bounded streamed CDN download: no cookies, no shell, no half-file cache hits. */
export async function download(client, url, destination, byteBudget) {
  const response = await client.mediaResponse(url);
  const declared = Number(response.headers.get('content-length'));
  if (declared > byteBudget) { await response.body?.cancel(); throw fail('VIDEO_TOO_LARGE', '视频超过下载大小限制。'); }
  if (!response.body) throw fail('BAD_RESPONSE', '媒体响应为空。');
  const temp = `${destination}.partial`, file = await open(temp, 'w'), reader = response.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > byteBudget) throw fail('VIDEO_TOO_LARGE', '视频超过下载大小限制。');
      await file.writeFile(value);
    }
    if (!size || (declared && size !== declared)) throw fail('INCOMPLETE_DOWNLOAD', '视频下载不完整。');
    await file.close(); await rename(temp, destination); return size;
  } catch (error) { await file.close().catch(() => {}); await rm(temp, { force: true }).catch(() => {}); throw error; }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Implements Seeit's BilibiliResolver boundary, reusing its original ASR/cache. */
export function createBilibiliResolver({ seeit, storage, commandRunner, asrProvider, accountFile, maxDownloadMb = 800, maxVideoMinutes = 60, fetcher, signal, getSignal }) {
  const pending = new Map();
  return {
    async ingestBilibili(source) {
      const client = new BilibiliClient({ accountFile, fetcher, signal: getSignal?.() || signal });
      const video = await client.resolveVideo(source.uri, source.metadata?.page);
      const videoId = source.videoId || video.videoId;
      const directory = storage.getCacheDir(videoId);
      const key = `${directory}:${video.bvid}:${video.page}`;
      if (pending.has(key)) return pending.get(key);
      const task = (async () => {
        if (video.duration > maxVideoMinutes * 60) throw fail('VIDEO_TOO_LONG', `视频分 P 超过 ${maxVideoMinutes} 分钟，请提高 bilibiliMaxVideoMinutes 或选择较短分 P。`);
        await mkdir(directory, { recursive: true });
        const mediaFile = join(directory, `${video.bvid}-p${video.page}.mp4`);
        const subtitleFile = join(directory, `${video.bvid}-p${video.page}.subtitle.json`);
        const warnings = [];
        let transcript;
        try { const result = await client.subtitle(video); transcript = result.transcript; if (result.note) warnings.push(result.note); }
        catch (error) { warnings.push(`原字幕未读取（${error.code || 'ERROR'}），尝试 Seeit ASR。`); }

        if (!await nonempty(mediaFile)) {
          const play = await client.request('/x/player/playurl', { params: { bvid: video.bvid, cid: video.cid, qn: 32, fnval: 1, fnver: 0, fourk: 0, platform: 'html5' } });
          const limit = maxDownloadMb * 1024 * 1024;
          if (play.durl?.length === 1 && play.durl[0].url && !/\.flv(?:\?|$)/i.test(play.durl[0].url)) {
            await download(client, play.durl[0].url, mediaFile, limit);
          } else {
            const dash = play.dash || (await client.request('/x/player/playurl', { params: { bvid: video.bvid, cid: video.cid, qn: 32, fnval: 16, fnver: 0, fourk: 0 } })).dash;
            const videos = (dash?.video || []).filter(v => !v.codecs || /^avc/.test(v.codecs)).sort((a, b) => Math.abs(a.id - 32) - Math.abs(b.id - 32));
            const visual = videos[0] || dash?.video?.[0], audio = dash?.audio?.[0];
            if (!visual || !audio) throw fail('PLAYURL_UNAVAILABLE', '没有可访问的音视频流；视频可能需要登录或不可用。');
            const videoPart = join(directory, 'source-video.m4s'), audioPart = join(directory, 'source-audio.m4s'), output = join(directory, 'merged.partial.mp4');
            try {
              const used = await download(client, visual.baseUrl || visual.base_url, videoPart, limit);
              await download(client, audio.baseUrl || audio.base_url, audioPart, limit - used);
              const result = await commandRunner.run('ffmpeg', ['-y', '-v', 'error', '-i', videoPart, '-i', audioPart, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', output], { timeoutMs: 300000 });
              if (result.exitCode !== 0 || !await nonempty(output)) throw fail('FFMPEG_FAILED', 'FFmpeg 合并 B站音视频失败，请检查 FFmpeg 安装。');
              await rename(output, mediaFile);
            } finally { for (const file of [videoPart, audioPart, output]) await rm(file, { force: true }).catch(() => {}); }
          }
        }
        // Keep subtitles out of discoverable stale sidecars: only pass today's accessible track explicitly.
        if (transcript) await writeFile(subtitleFile, JSON.stringify({ cues: transcript.cues }), 'utf8');
        const local = new seeit.LocalVideoSource(
          { kind: 'local', uri: mediaFile, videoId },
          { videoId, title: video.title, description: video.description, duration: video.duration, discoverSidecars: false, ...(transcript ? { subtitlePath: subtitleFile } : {}), ...(asrProvider ? { asrProvider } : {}), commandRunner, cacheDirForVideo: id => storage.getCacheDir(id) },
        );
        const ingested = await local.ingest();
        return { ...ingested, source: { kind: 'bilibili', uri: video.url, videoId }, ...(transcript ? { transcript } : {}), metadata: { ...ingested.metadata, bilibili: video, ingestWarnings: warnings, videoContentRead: Boolean(ingested.transcript?.cues.length || transcript?.cues.length), localPath: mediaFile } };
      })();
      pending.set(key, task);
      try { return await task; } finally { pending.delete(key); }
    },
  };
}
