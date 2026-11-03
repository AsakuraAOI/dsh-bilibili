import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const TRANSIENT = new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT']);
const clean = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : undefined;
function causes(error) {
  const result = []; let current = error;
  for (let depth = 0; current && depth < 4; depth++, current = current.cause) {
    const entry = { ...(clean(current.name) ? { name: current.name } : {}), ...(clean(current.code) ? { code: current.code } : {}) };
    if (Object.keys(entry).length) result.push(entry);
  }
  return result;
}
async function diagnostic(target, attempts) {
  const path = target + '.download-diagnostics.json', temp = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(temp, JSON.stringify({ attempts }, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, path);
  } catch { /* Diagnostic persistence must not replace the original result. */ }
  finally { await rm(temp, { force: true }).catch(() => {}); }
}
function coded(code) { return Object.assign(new Error(code), { code }); }

/** Idempotent downloads only: bounded streamed bytes, atomic commit and two retries. */
export async function downloadWithRetry({ openResponse, target, maxBytes, signal, tooLargeCode = 'MEDIA_TOO_LARGE', timeoutMs = 300000 }) {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new Error('下载大小预算无效。');
  const attempts = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal?.throwIfAborted();
    const active = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    const temporary = `${target}.${randomUUID()}.partial`;
    let response, reader, file, received = 0, expected = null, stage = 'request', failed, retryable = false;
    try {
      response = await openResponse(active); active.throwIfAborted();
      stage = 'headers';
      if (!response.ok) throw coded('MEDIA_HTTP_ERROR');
      const length = Number(response.headers.get('content-length'));
      const encoded = response.headers.get('content-encoding');
      if (Number.isSafeInteger(length) && length > 0 && (!encoded || encoded === 'identity')) expected = length;
      if (expected !== null && expected > maxBytes) throw coded(tooLargeCode);
      if (!response.body) throw coded('EMPTY_MEDIA');
      stage = 'file-open'; await mkdir(dirname(target), { recursive: true }); file = await open(temporary, 'wx');
      reader = response.body.getReader(); stage = 'body';
      for (;;) {
        active.throwIfAborted(); const { value, done } = await reader.read(); if (done) break;
        received += value.length;
        if (received > maxBytes) throw coded(tooLargeCode);
        stage = 'file-write'; await file.writeFile(value); stage = 'body';
      }
      if (!received || (expected !== null && expected !== received)) throw coded('INCOMPLETE_DOWNLOAD');
      active.throwIfAborted(); stage = 'commit'; await file.close(); file = undefined; await rename(temporary, target);
      attempts.push({ attempt, at: new Date().toISOString(), status: 'complete', stage, receivedBytes: received, expectedBytes: expected, httpStatus: response.status });
      await diagnostic(target, attempts); return received;
    } catch (error) {
      signal?.throwIfAborted();
      const chain = causes(error), codes = chain.map(c => c.code).filter(Boolean);
      const transport = stage === 'request' || stage === 'headers' || stage === 'body';
      const httpStatus = response?.status ?? (Number.isInteger(error.status) ? error.status : undefined);
      retryable = transport && (active.aborted || codes.some(code => TRANSIENT.has(code)) || (error.message === 'terminated' && !codes.length) || (error.code === 'INCOMPLETE_DOWNLOAD' && received > 0) || [500,502,503,504].includes(httpStatus));
      const detail = { attempt, at: new Date().toISOString(), status: 'failed', stage, receivedBytes: received, expectedBytes: expected, ...(httpStatus !== undefined ? { httpStatus } : {}), causes: chain, reason: active.aborted ? 'deadline' : error.message === 'terminated' ? 'response-body-terminated' : clean(error.code) || 'download-failed', retryable };
      attempts.push(detail);
      const code = [tooLargeCode,'EMPTY_MEDIA'].includes(error.code) ? error.code : 'MEDIA_DOWNLOAD_FAILED';
      failed = Object.assign(new Error(`媒体下载失败：${JSON.stringify(detail)}`), { code, details: detail });
      await diagnostic(target, attempts);
    } finally {
      await file?.close().catch(() => {});
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      else await response?.body?.cancel().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
    if (!retryable || attempt === 3) throw failed;
    await delay(attempt * 500, undefined, { ...(signal ? { signal } : {}) });
  }
}
