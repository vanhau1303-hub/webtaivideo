// Dùng yt-dlp cho các trang lớn có extractor riêng (YouTube, Facebook, TikTok, X, Vimeo, ...).
import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { FFMPEG } from './ffmpeg.js';
import { qualityLabel, fmtBitrate } from './util.js';
import { codecName } from './analyze.js';

const CANDIDATES = [
  ['yt-dlp', []],
  ['python', ['-m', 'yt_dlp']],
  ['py', ['-m', 'yt_dlp']],
];
let cmd = null;
export let ytdlpVersion = '';

function run(bin, args, { signal, timeoutMs, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    let out = '';
    let err = '';
    let buf = '';
    p.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      out += s;
      if (onLine) {
        buf += s;
        const lines = buf.split(/\r?\n|\r/);
        buf = lines.pop();
        lines.forEach(onLine);
      }
    });
    p.stderr.on('data', (d) => (err = (err + d.toString('utf8')).slice(-8000)));
    p.on('error', reject);
    const kill = () => p.kill('SIGKILL');
    const timer = timeoutMs ? setTimeout(kill, timeoutMs) : null;
    signal?.addEventListener('abort', kill);
    p.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      if (signal?.aborted) return reject(signal.reason || new DOMException('Aborted', 'AbortError'));
      if (code === 0) resolve(out);
      else {
        const msg = err.split('\n').filter((l) => /ERROR/.test(l)).pop() || err.trim().split('\n').pop() || `mã lỗi ${code}`;
        reject(new Error(msg.replace(/^ERROR:\s*/, '')));
      }
    });
  });
}

export async function detectYtdlp() {
  for (const [bin, pre] of CANDIDATES) {
    try {
      ytdlpVersion = (await run(bin, [...pre, '--version'], { timeoutMs: 15000 })).trim();
      cmd = [bin, pre];
      return true;
    } catch {}
  }
  return false;
}

const ytdlp = (args, opts) => run(cmd[0], [...cmd[1], ...args], opts);

/** Lấy thông tin video + danh sách định dạng */
export async function ytdlpInfo(url, { signal } = {}) {
  if (!cmd) throw new Error('Chưa cài yt-dlp');
  const json = await ytdlp(['-J', '--no-playlist', '--no-warnings', '--ffmpeg-location', FFMPEG, url], {
    signal,
    timeoutMs: 60000,
  });
  let info = JSON.parse(json);
  if (info._type === 'playlist' && info.entries && info.entries.length) info = info.entries[0];
  return info;
}

/** Chuyển kết quả yt-dlp thành danh sách chất lượng */
export function ytdlpOptions(info) {
  const formats = (info.formats || []).filter((f) => f.vcodec && f.vcodec !== 'none' && f.height);
  const audio = (info.formats || [])
    .filter((f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none')
    .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];
  const byHeight = new Map();
  for (const f of formats) {
    const h = Math.min(f.height, f.width || f.height); // video dọc dùng cạnh ngắn
    const cur = byHeight.get(h);
    if (!cur || (f.tbr || 0) > (cur.tbr || 0)) byHeight.set(h, f);
  }
  const drm = (info.formats || []).length > 0 && (info.formats || []).every((f) => f.has_drm);
  const options = [...byHeight.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([h, f]) => {
      const size = (f.filesize || f.filesize_approx || 0) + (f.acodec === 'none' && audio ? audio.filesize || audio.filesize_approx || 0 : 0);
      const field = f.width && f.width < f.height ? 'width' : 'height';
      return {
        id: 'h' + h,
        label: qualityLabel(f.height, f.width),
        height: f.height,
        width: f.width || 0,
        bandwidth: (f.tbr || 0) * 1000,
        codec: codecName(f.vcodec),
        sizeEstimate: size,
        note: [codecName(f.vcodec) || f.vcodec?.split('.')[0], f.fps > 30 ? Math.round(f.fps) + 'fps' : '', fmtBitrate((f.tbr || 0) * 1000)]
          .filter(Boolean)
          .join(' · '),
        disabled: !!f.has_drm,
        reason: f.has_drm ? 'Có DRM' : '',
        sel: { format: `bv*[${field}=${h}]+ba/b[${field}=${h}]/bv*[${field}<=${h}]+ba/b` },
      };
    });
  // Bản H.264 + AAC cao nhất (tương thích mọi máy), nếu bản nét nhất dùng codec khác
  const avc = formats
    .filter((f) => /^avc/i.test(f.vcodec || '') && !f.has_drm)
    .sort((a, b) => Math.min(b.height, b.width || b.height) - Math.min(a.height, a.width || a.height) || (b.tbr || 0) - (a.tbr || 0))[0];
  if (avc && options[0] && options[0].codec !== 'H.264') {
    const aac = (info.formats || [])
      .filter((f) => f.vcodec === 'none' && /^mp4a/i.test(f.acodec || ''))
      .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];
    const size = (avc.filesize || avc.filesize_approx || 0) + (avc.acodec === 'none' && aac ? aac.filesize || aac.filesize_approx || 0 : 0);
    const h = Math.min(avc.height, avc.width || avc.height);
    const field = avc.width && avc.width < avc.height ? 'width' : 'height';
    options.push({
      id: 'h264',
      label: qualityLabel(avc.height, avc.width),
      height: avc.height,
      width: avc.width || 0,
      bandwidth: (avc.tbr || 0) * 1000,
      codec: 'H.264',
      compat: true,
      sizeEstimate: size,
      note: ['H.264 + AAC', avc.fps > 30 ? Math.round(avc.fps) + 'fps' : '', fmtBitrate((avc.tbr || 0) * 1000)].filter(Boolean).join(' · '),
      sel: {
        format: `bv*[vcodec^=avc][${field}=${h}]+ba[acodec^=mp4a]/bv*[vcodec^=avc][${field}=${h}]+ba/b[vcodec^=avc]/bv*[vcodec^=avc]+ba/b`,
      },
    });
  }
  if (!options.length) {
    options.push({ id: 'best', label: 'Tốt nhất', height: 0, width: 0, codec: '', note: '', sel: { format: 'bv*+ba/b' } });
  }
  return { options, drm, duration: info.duration || 0 };
}

/**
 * Tải bằng yt-dlp vào workDir. Trả về { file, ext }
 */
export async function ytdlpDownload(url, format, workDir, { signal, onProgress, onStatus } = {}) {
  if (!cmd) throw new Error('Chưa cài yt-dlp');
  let stage = 0;
  const stats = { bytes: 0, totalBytes: 0, speed: 0, stage: 0 };
  onStatus?.('Đang tải…');
  await ytdlp(
    [
      '-f', format,
      '--no-playlist',
      '--no-warnings',
      '--newline',
      '--no-mtime',
      '--merge-output-format', 'mp4',
      '--ffmpeg-location', FFMPEG,
      '-N', '6',
      '--retries', '10',
      '--fragment-retries', '10',
      '-o', path.join(workDir, 'output.%(ext)s'),
      '--progress-template', 'download:PROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s',
      url,
    ],
    {
      signal,
      onLine: (line) => {
        if (line.startsWith('PROG ')) {
          const [, d, t, te, sp] = line.split(' ');
          stats.bytes = Number(d) || 0;
          stats.totalBytes = Number(t) || Number(te) || 0;
          stats.speed = Number(sp) || 0;
          stats.stage = stage;
          onProgress?.({ ...stats });
        } else if (line.includes('[download] Destination:')) {
          stage++;
          onStatus?.(stage > 1 ? 'Đang tải âm thanh…' : 'Đang tải video…');
        } else if (/^\[(Merger|VideoRemuxer|FixupM3u8|VideoConvertor)\]/.test(line)) {
          onStatus?.('Đang ghép video + âm thanh…');
        }
      },
    }
  );
  // Tìm file kết quả (lớn nhất, bỏ file tạm)
  const files = (await readdir(workDir)).filter((f) => f.startsWith('output.') && !/\.(part|ytdl|temp)$/.test(f) && !/\.f\d+\./.test(f));
  if (!files.length) throw new Error('yt-dlp không tạo ra file');
  let best = null;
  for (const f of files) {
    const s = (await stat(path.join(workDir, f))).size;
    if (!best || s > best.size) best = { f, size: s };
  }
  return { file: path.join(workDir, best.f), ext: path.extname(best.f).slice(1) };
}
