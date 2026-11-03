import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareBilibiliMedia, download } from '../src/media.js';
import { BilibiliClient } from '../src/client.js';

async function fixture(t, dash = false) {
  const directory = await mkdtemp(join(tmpdir(), 'bili-media-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  const requests = [], video = { bvid: 'BV1xx411c7mD', page: 1, cid: 1, duration: 7671 };
  const client = {
    resolveVideo: async () => video,
    subtitle: async () => ({ transcript: { source: 'original', language: 'zh', cues: [{ start: .3, end: 1.5, content: '字幕原句' }] } }),
    request: async () => dash ? { dash: { video: [{ baseUrl: 'https://cdn.bilivideo.com/v.m4s', codecs: 'avc', id: 32 }], audio: [{ baseUrl: 'https://cdn.bilivideo.com/a.m4s' }] } } : { durl: [{ url: 'https://cdn.bilivideo.com/v.mp4' }] },
    mediaResponse: async url => { requests.push(url); return new Response('media bytes'); },
  };
  return { directory, client, requests };
}

test('B站 media preparation downloads and imports original subtitles with no model or runtime', async t => {
  const f = await fixture(t);
  const result = await prepareBilibiliMedia(f.client, 'BV1xx411c7mD', f);
  assert.equal(result.path, result.audioPath); assert.equal(result.transcript.cues[0].content, '字幕原句');
  await prepareBilibiliMedia(f.client, 'BV1xx411c7mD', f); assert.equal(f.requests.length, 1);
  await assert.rejects(() => prepareBilibiliMedia(f.client, 'BV1xx411c7mD', { ...f, maxVideoMinutes: 60 }), { code: 'VIDEO_TOO_LONG' });
});

test('separate DASH audio and video remain usable without muxing or FFmpeg', async t => {
  const f = await fixture(t, true);
  const result = await prepareBilibiliMedia(f.client, 'BV1xx411c7mD', f);
  assert.notEqual(result.path, result.audioPath); assert.equal(f.requests.length, 2);
  assert.equal((await readFile(result.audioPath)).toString(), 'media bytes');
});

test('bounded CDN download removes failed partials and sends no login cookies', async t => {
  const f = await fixture(t); let headers;
  const client = new BilibiliClient({ fetcher: async (_url, init) => { headers = init.headers; return new Response('1234567890'); } });
  const target = join(f.directory, 'v.mp4');
  await assert.rejects(() => download(client, 'https://cdn.bilivideo.com/v.mp4', target, 5), { code: 'VIDEO_TOO_LARGE' });
  assert.equal(headers.Cookie, undefined); assert.deepEqual(await readdir(f.directory), []);
});
