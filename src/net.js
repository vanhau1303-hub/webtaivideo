// HTTP phía server: gửi kèm Referer/Origin/Cookie/User-Agent giống trình duyệt, có retry và Range.

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status}`);
    this.status = status;
    this.url = url;
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    });
  });

/** Chọn cookie hợp lệ cho host (giống quy tắc domain của trình duyệt) */
export function cookieHeader(jar, url) {
  if (!jar || !jar.length) return '';
  const host = new URL(url).hostname;
  return jar
    .filter((c) => {
      const d = (c.domain || '').replace(/^\./, '');
      return host === d || host.endsWith('.' + d);
    })
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * headers: { referer, origin, userAgent, cookies } — lấy từ request thật mà trình duyệt ẩn đã gửi.
 * cookies là danh sách cookie của phiên duyệt; chỉ cookie đúng domain mới được gửi đi.
 */
export function buildHeaders(h = {}, url, range) {
  const out = { 'user-agent': h.userAgent || DEFAULT_UA, accept: '*/*', 'accept-language': 'vi-VN,vi;q=0.9,en;q=0.8' };
  if (h.referer) out.referer = h.referer;
  if (h.origin) out.origin = h.origin;
  const cookie = url ? cookieHeader(h.cookies, url) : '';
  if (cookie) out.cookie = cookie;
  if (range) out.range = `bytes=${range.start}-${range.end != null ? range.end : ''}`;
  return out;
}

async function request(url, { headers, range, signal } = {}) {
  const res = await fetch(url, { headers: buildHeaders(headers, url, range), signal, redirect: 'follow' });
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    throw new HttpError(res.status, url);
  }
  return res;
}

async function withRetry(fn, { retries = 4, signal } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (signal?.aborted || e.name === 'AbortError') throw e;
      lastErr = e;
      if (e instanceof HttpError && e.status >= 400 && e.status < 500 && ![408, 429].includes(e.status) && attempt >= 1) break;
      if (attempt < retries) await sleep(500 * 2 ** attempt, signal);
    }
  }
  throw lastErr;
}

export function fetchText(url, { headers, signal, retries = 2 } = {}) {
  return withRetry(async () => (await request(url, { headers, signal })).text(), { retries, signal });
}

export function fetchBytes(url, { headers, range, signal, retries = 4, onBytes } = {}) {
  return withRetry(
    async () => {
      const res = await request(url, { headers, range, signal });
      let received = 0;
      const chunks = [];
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          onBytes?.(value.length);
        }
      } catch (e) {
        onBytes?.(-received);
        throw e;
      }
      let out = concat(chunks, received);
      if (range && res.status === 200) out = out.subarray(range.start, range.end != null ? range.end + 1 : undefined);
      return out;
    },
    { retries, signal }
  );
}

/** Tải file lớn dạng stream, tự tải tiếp bằng Range khi đứt kết nối */
export async function streamFile(url, { headers, signal, onChunk, onTotal } = {}) {
  let offset = 0;
  let total = 0;
  let failures = 0;
  for (;;) {
    try {
      const res = await request(url, { headers, range: offset ? { start: offset } : null, signal });
      if (offset && res.status !== 206) throw new Error('Server không hỗ trợ tải tiếp (Range)');
      if (!total) {
        const cr = res.headers.get('content-range');
        const m = cr && /\/(\d+)$/.exec(cr);
        total = m ? Number(m[1]) : Number(res.headers.get('content-length')) || 0;
        onTotal?.(total, res.headers.get('content-type') || '');
      }
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        offset += value.length;
        failures = 0;
        await onChunk(value);
      }
      if (!total || offset >= total) return { total: offset };
      throw new Error('Kết nối bị đóng sớm');
    } catch (e) {
      if (signal?.aborted || e.name === 'AbortError') throw e;
      if (++failures > 5) throw e;
      await sleep(1000 * failures, signal);
    }
  }
}

export function concat(chunks, total) {
  if (chunks.length === 1) return chunks[0];
  if (total == null) total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
