// Web app: dán link -> phân tích -> tải video chất lượng cao nhất.
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from 'linkedom';
import { resolveLink } from './src/resolve.js';
import { runDownload, transcodeH264 } from './src/downloader.js';
import { detectYtdlp, ytdlpDownload, ytdlpVersion } from './src/ytdlp.js';
import { hasFfmpeg } from './src/ffmpeg.js';
import { getBrowser, browserName, closeBrowser } from './src/sniffer.js';
import { sanitizeFilename } from './src/util.js';
import { loadEnv } from './src/env.js';
import { authEnabled, isAuthed, tryLogin, logoutCookie, isPrivateHost } from './src/auth.js';

globalThis.DOMParser = DOMParser; // cho parser DASH

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(ROOT, '.env'), { override: true });
const PUBLIC = path.join(ROOT, 'public');
const WORK = path.join(ROOT, 'downloads');
const PORT = Number(process.env.PORT) || 8686;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_PARALLEL_JOBS = 2;
const KEEP_MS = 3 * 60 * 60 * 1000; // giữ file đã tải 3 giờ

const status = { ytdlp: false, ytdlpVersion: '', ffmpeg: false, browser: '' };
const analyses = new Map(); // id -> { status, statusText, result, error, created, ctrl }
const jobs = new Map(); // id -> job

let seq = 0;
const newId = (p) => p + Date.now().toString(36) + (++seq).toString(36);

// ---------------- Phân tích ----------------
function startAnalysis(url, mode) {
  const id = newId('a');
  const a = { id, status: 'running', statusText: 'Đang bắt đầu…', created: Date.now(), ctrl: new AbortController(), url };
  analyses.set(id, a);
  resolveLink(url, {
    mode,
    ytdlpReady: status.ytdlp,
    signal: a.ctrl.signal,
    onStatus: (t) => (a.statusText = t),
  })
    .then((result) => {
      a.result = result;
      a.status = 'done';
    })
    .catch((e) => {
      a.status = 'error';
      a.error = e.message || String(e);
    });
  return a;
}

function publicAnalysis(a) {
  const out = { id: a.id, status: a.status, statusText: a.statusText, error: a.error };
  if (a.result) {
    const r = a.result;
    out.result = {
      title: r.title,
      thumbnail: r.thumbnail,
      pageUrl: r.pageUrl,
      via: r.via,
      browser: r.browser,
      duration: r.duration,
      best: r.best,
      bestCompat: r.bestCompat,
      errors: r.errors,
      sources: r.sources.map((s) => ({
        id: s.id,
        kind: s.kind,
        name: s.name || sourceName(s.url),
        url: s.url,
        size: s.size || 0,
        playing: !!s.playing,
        duration: s.info.duration || s.duration || 0,
        error: s.info.error,
        drm: !!s.info.drm,
        live: !!s.info.live,
        options: s.info.options.map(({ sel, ...o }) => o),
      })),
    };
  }
  return out;
}

function sourceName(url) {
  try {
    const u = new URL(url);
    const file = decodeURIComponent(u.pathname.split('/').pop() || '');
    return u.hostname + (file ? ' / ' + file : '');
  } catch {
    return url;
  }
}

// ---------------- Hàng đợi tải ----------------
function createJob(analysis, sourceId, optionId, transcode = false) {
  const r = analysis.result;
  const source = r.sources.find((s) => s.id === sourceId);
  if (!source) throw new Error('Không tìm thấy nguồn');
  const option = source.info.options.find((o) => o.id === optionId);
  if (!option) throw new Error('Không tìm thấy chất lượng');
  if (option.disabled) throw new Error(option.reason || 'Chất lượng này không tải được');
  const title = (r.title || 'video').trim();
  // Bản tương thích: đã là H.264 sẵn, hoặc sẽ chuyển mã sau khi tải
  const compat = transcode || (option.codec === 'H.264' && r.bestCompat?.optionId === option.id);
  const quality = option.label + (compat ? ' H.264' : '');
  const job = {
    id: newId('j'),
    title,
    quality,
    transcode: !!transcode && option.codec !== 'H.264',
    duration: source.info.duration || source.duration || r.duration || 0,
    filename: sanitizeFilename(`${title} [${quality}]`, 150),
    thumbnail: r.thumbnail,
    pageUrl: r.pageUrl,
    via: r.via,
    source,
    sel: option.sel,
    status: 'queued',
    statusText: 'Đang chờ…',
    created: Date.now(),
    stats: { bytes: 0, totalBytes: 0, doneUnits: 0, totalUnits: 0 },
    speed: 0,
  };
  jobs.set(job.id, job);
  pump();
  return job;
}

function publicJob(j) {
  const s = j.stats;
  let progress = 0;
  if (j.status === 'done') progress = 1;
  else if (j.encoding) progress = s.encodeProgress || 0;
  else if (s.totalUnits) progress = s.doneUnits / s.totalUnits;
  else if (s.totalBytes) progress = s.bytes / s.totalBytes;
  return {
    id: j.id,
    title: j.title,
    quality: j.quality,
    thumbnail: j.thumbnail,
    pageUrl: j.pageUrl,
    status: j.status,
    statusText: j.statusText,
    error: j.error,
    warning: j.warning,
    progress: Math.min(1, progress),
    bytes: s.bytes,
    totalBytes: s.totalBytes,
    doneUnits: s.doneUnits,
    totalUnits: s.totalUnits,
    speed: j.encoding ? 0 : j.speed,
    encoding: !!j.encoding,
    encodeSpeed: s.encodeSpeed || 0,
    transcode: !!j.transcode,
    size: j.size || 0,
    ext: j.ext,
    created: j.created,
  };
}

function pump() {
  const running = [...jobs.values()].filter((j) => j.status === 'running').length;
  const next = [...jobs.values()].filter((j) => j.status === 'queued').sort((a, b) => a.created - b.created);
  for (const j of next.slice(0, Math.max(0, MAX_PARALLEL_JOBS - running))) runJob(j);
}

async function runJob(job) {
  job.status = 'running';
  job.ctrl = new AbortController();
  job.dir = path.join(WORK, job.id);
  await mkdir(job.dir, { recursive: true });

  let lastBytes = 0;
  let lastTime = Date.now();
  const onProgress = (stats) => {
    job.stats = { ...job.stats, ...stats };
    if (stats.speed != null && job.via === 'ytdlp') job.speed = stats.speed;
    const now = Date.now();
    if (job.via !== 'ytdlp' && now - lastTime >= 1000) {
      const inst = ((job.stats.bytes - lastBytes) * 1000) / (now - lastTime);
      job.speed = job.speed ? job.speed * 0.6 + inst * 0.4 : inst;
      lastBytes = job.stats.bytes;
      lastTime = now;
    }
  };
  const onStatus = (t) => (job.statusText = t);

  try {
    const opts = { signal: job.ctrl.signal, onProgress, onStatus };
    const out =
      job.source.kind === 'ytdlp'
        ? await ytdlpDownload(job.source.url, job.sel.format, job.dir, opts)
        : await runDownload(job, job.dir, opts);
    if (job.transcode) {
      job.encoding = true;
      Object.assign(out, await transcodeH264(out.file, job.dir, { ...opts, duration: job.duration }));
      job.encoding = false;
    }
    job.file = out.file;
    job.ext = out.ext;
    job.warning = out.warning;
    job.size = (await stat(out.file)).size;
    job.status = 'done';
    job.statusText = 'Hoàn tất';
    job.finished = Date.now();
  } catch (e) {
    if (job.ctrl.signal.aborted) {
      job.status = 'canceled';
      job.statusText = 'Đã hủy';
    } else {
      job.status = 'error';
      job.error = e.message || String(e);
      job.statusText = 'Lỗi';
    }
    job.finished = Date.now();
    rm(job.dir, { recursive: true, force: true }).catch(() => {});
  } finally {
    pump();
  }
}

// Dọn dẹp định kỳ
setInterval(() => {
  const now = Date.now();
  for (const [id, a] of analyses) if (now - a.created > 60 * 60 * 1000) analyses.delete(id);
  for (const [id, j] of jobs) {
    if (j.finished && now - j.finished > KEEP_MS) {
      rm(j.dir, { recursive: true, force: true }).catch(() => {});
      jobs.delete(id);
    }
  }
}, 10 * 60 * 1000).unref();

// ---------------- HTTP ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function send(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e5) throw new Error('Body quá lớn');
  }
  return raw ? JSON.parse(raw) : {};
}

function contentDisposition(name) {
  const ascii = name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'Không tìm thấy' });
  }
}

async function serveFile(req, res, job) {
  const name = `${job.filename}.${job.ext}`;
  const size = job.size;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  const headers = {
    'content-type': job.ext === 'webm' ? 'video/webm' : job.ext === 'ts' ? 'video/mp2t' : job.ext === 'mkv' ? 'video/x-matroska' : 'video/mp4',
    'content-disposition': contentDisposition(name),
    'accept-ranges': 'bytes',
  };
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    return createReadStream(job.file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': size });
  createReadStream(job.file).pipe(res);
}

// Trang/tài nguyên xem được khi chưa đăng nhập
const PUBLIC_PATHS = new Set(['/login.html', '/style.css', '/icon.svg', '/favicon.ico', '/api/login']);

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/api/login' && req.method === 'POST') {
      const { password } = await readJson(req);
      const r = tryLogin(req, password);
      if (!r.ok) return send(res, 401, { error: r.error });
      res.setHeader('set-cookie', r.cookie);
      return send(res, 200, { ok: true });
    }
    if (pathname === '/api/logout') {
      res.setHeader('set-cookie', logoutCookie());
      res.writeHead(302, { location: '/login.html' });
      return res.end();
    }
    if (!PUBLIC_PATHS.has(pathname) && !isAuthed(req)) {
      if (pathname.startsWith('/api/')) return send(res, 401, { error: 'Cần đăng nhập', login: true });
      res.writeHead(302, { location: '/login.html' });
      return res.end();
    }

    if (!pathname.startsWith('/api/')) return await serveStatic(req, res, pathname);

    if (pathname === '/api/status' && req.method === 'GET') return send(res, 200, { ...status, auth: authEnabled() });

    if (pathname === '/api/health' && req.method === 'GET') {
      const active = [...jobs.values()].filter((j) => j.status === 'running' || j.status === 'queued').length;
      const analyzing = [...analyses.values()].filter((a) => a.status === 'running').length;
      return send(res, 200, { ok: true, active, analyzing });
    }

    if (pathname === '/api/analyze' && req.method === 'POST') {
      const { url, mode } = await readJson(req);
      let u;
      try {
        u = new URL(String(url || '').trim());
        if (!/^https?:$/.test(u.protocol)) throw 0;
      } catch {
        return send(res, 400, { error: 'Link không hợp lệ. Hãy dán link bắt đầu bằng http:// hoặc https://' });
      }
      if (authEnabled() && isPrivateHost(u.hostname)) {
        return send(res, 400, { error: 'Không hỗ trợ địa chỉ mạng nội bộ' });
      }
      const a = startAnalysis(u.href, ['auto', 'sniff', 'ytdlp'].includes(mode) ? mode : 'auto');
      return send(res, 200, publicAnalysis(a));
    }

    let m = /^\/api\/analyze\/([\w]+)$/.exec(pathname);
    if (m) {
      const a = analyses.get(m[1]);
      if (!a) return send(res, 404, { error: 'Phiên phân tích đã hết hạn, hãy phân tích lại' });
      if (req.method === 'DELETE') {
        a.ctrl.abort();
        return send(res, 200, { ok: true });
      }
      return send(res, 200, publicAnalysis(a));
    }

    if (pathname === '/api/download' && req.method === 'POST') {
      const { analysisId, sourceId, optionId, transcode } = await readJson(req);
      const a = analyses.get(analysisId);
      if (!a || !a.result) return send(res, 404, { error: 'Phiên phân tích đã hết hạn, hãy phân tích lại' });
      const job = createJob(a, sourceId, optionId, !!transcode);
      return send(res, 200, publicJob(job));
    }

    if (pathname === '/api/jobs' && req.method === 'GET') {
      return send(res, 200, [...jobs.values()].sort((a, b) => b.created - a.created).map(publicJob));
    }

    m = /^\/api\/jobs\/([\w]+)(\/file|\/cancel)?$/.exec(pathname);
    if (m) {
      const job = jobs.get(m[1]);
      if (!job) return send(res, 404, { error: 'Không tìm thấy lượt tải' });
      if (m[2] === '/file') {
        if (job.status !== 'done') return send(res, 409, { error: 'File chưa sẵn sàng' });
        return await serveFile(req, res, job);
      }
      if (m[2] === '/cancel' && req.method === 'POST') {
        if (job.status === 'queued') {
          job.status = 'canceled';
          job.statusText = 'Đã hủy';
        } else job.ctrl?.abort();
        return send(res, 200, publicJob(job));
      }
      if (req.method === 'DELETE') {
        job.ctrl?.abort();
        jobs.delete(job.id);
        if (job.dir) rm(job.dir, { recursive: true, force: true }).catch(() => {});
        return send(res, 200, { ok: true });
      }
      return send(res, 200, publicJob(job));
    }

    send(res, 404, { error: 'API không tồn tại' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: e.message || String(e) });
  }
});

async function main() {
  await rm(WORK, { recursive: true, force: true }).catch(() => {});
  await mkdir(WORK, { recursive: true });
  const [ytdlp, ffmpeg] = await Promise.all([detectYtdlp(), hasFfmpeg()]);
  status.ytdlp = ytdlp;
  status.ytdlpVersion = ytdlpVersion;
  status.ffmpeg = ffmpeg;
  getBrowser()
    .then(() => (status.browser = browserName))
    .catch((e) => console.warn('⚠ ' + e.message));

  server.listen(PORT, HOST, () => {
    console.log(`\n  HD Video Downloader đang chạy tại: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
    console.log(`  yt-dlp : ${ytdlp ? ytdlpVersion : 'chưa cài (pip install yt-dlp)'}`);
    console.log(`  ffmpeg : ${ffmpeg ? 'có' : 'không có'}`);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await closeBrowser();
    process.exit(0);
  });
}

main();
