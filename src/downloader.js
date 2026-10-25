// Bộ máy tải phía server: tải segment song song, giải mã AES-128, ghi ra đĩa, ghép bằng ffmpeg.
import { createWriteStream } from 'node:fs';
import { rm, stat, rename } from 'node:fs/promises';
import path from 'node:path';
import { buildPlan } from './analyze.js';
import { fetchBytes, streamFile } from './net.js';
import { runFfmpeg, ffmpegPipe } from './ffmpeg.js';

const CONCURRENCY = 8;
const WINDOW = 32; // số segment tối đa nằm chờ trong RAM để ghi đúng thứ tự

const EXT = { ts: 'ts', fmp4: 'mp4', webm: 'webm', aac: 'aac', mp3: 'mp3' };

/** Một số trang chèn header ảnh giả (PNG/JPG) trước dữ liệu TS — cắt bỏ phần đó */
export function fixTs(u8) {
  if (u8[0] === 0x47) return u8;
  const limit = Math.min(u8.length - 376, 65536);
  for (let i = 0; i < limit; i++) {
    if (u8[i] === 0x47 && u8[i + 188] === 0x47 && u8[i + 376] === 0x47) return u8.subarray(i);
  }
  return u8;
}

function openWriter(file) {
  const ws = createWriteStream(file);
  let failed = null;
  ws.on('error', (e) => (failed = e));
  return {
    async write(u8) {
      if (failed) throw failed;
      if (!ws.write(u8)) await new Promise((r) => ws.once('drain', r));
    },
    close: () => new Promise((resolve, reject) => ws.end((e) => (e || failed ? reject(e || failed) : resolve()))),
    destroy: () => ws.destroy(),
  };
}

function extFromFile(url, contentType) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('webm')) return 'webm';
  if (ct.includes('matroska')) return 'mkv';
  if (ct.includes('quicktime')) return 'mov';
  const m = /\.(mp4|webm|mkv|mov|m4v|ogv|flv)(?:$|\?)/i.exec(new URL(url).pathname);
  return m ? m[1].toLowerCase() : 'mp4';
}

/**
 * Tải theo kế hoạch vào thư mục workDir.
 * job: { source: {url, kind, headers}, sel }
 * onStream({ file, ext, size }): gọi khi video chỉ có một luồng và file kết quả bắt đầu được ghi dần —
 *   khi đó máy con có thể nhận file ngay trong lúc đang tải (xem /api/jobs/:id/stream).
 * Trả về { file, ext } (đường dẫn file cuối cùng)
 */
export async function runDownload(job, workDir, { signal, onProgress, onStatus, onStream }) {
  const { source, sel } = job;
  const headers = source.headers || {};
  onStatus?.('Đang đọc manifest…');
  const plan = await buildPlan(source, sel, signal);

  const stats = { doneUnits: 0, totalUnits: 0, bytes: 0, totalBytes: 0 };
  for (const t of plan.tracks) if (t.kind !== 'file') stats.totalUnits += t.segments.length + (t.init ? 1 : 0);
  const report = () => onProgress?.({ ...stats });

  // ---- File trực tiếp ----
  if (plan.tracks[0].kind === 'file') {
    const t = plan.tracks[0];
    const out = path.join(workDir, 'output.stream');
    const w = openWriter(out);
    let ct = '';
    onStatus?.('Đang tải…');
    try {
      await streamFile(t.url, {
        headers,
        signal,
        onTotal: (total, type) => {
          stats.totalBytes = total;
          ct = type;
          onStream?.({ file: out, ext: extFromFile(t.url, ct), size: total || 0 });
        },
        onChunk: async (u8) => {
          await w.write(u8);
          stats.bytes += u8.length;
          report();
        },
      });
      await w.close();
    } catch (e) {
      w.destroy();
      throw e;
    }
    return { file: out, ext: extFromFile(t.url, ct), streamed: true };
  }

  // ---- HLS / DASH ----
  const keyCache = new Map();
  const getKey = (url) => {
    if (!keyCache.has(url)) {
      keyCache.set(
        url,
        fetchBytes(url, { headers, signal }).then((raw) =>
          crypto.subtle.importKey('raw', raw.subarray(0, 16), 'AES-CBC', false, ['decrypt'])
        )
      );
    }
    return keyCache.get(url);
  };

  const fetchItem = async (item, kind) => {
    let data = await fetchBytes(item.url, {
      headers,
      range: item.range,
      signal,
      onBytes: (n) => {
        stats.bytes += n;
        report();
      },
    });
    if (item.key) {
      const key = await getKey(item.key.url);
      data = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: item.key.iv }, key, data));
    }
    if (kind === 'ts') data = fixTs(data);
    return data;
  };

  // ---- Một luồng duy nhất: ghi thẳng ra file kết quả để máy con nhận dần ----
  const single = plan.tracks.length === 1 ? plan.tracks[0] : null;
  if (single && onStream && !job.transcode && ['ts', 'fmp4', 'webm'].includes(single.kind)) {
    return await downloadStreaming(single, workDir, { fetchItem, stats, report, signal, onStatus, onStream });
  }

  const trackFiles = [];
  for (let ti = 0; ti < plan.tracks.length; ti++) {
    const track = plan.tracks[ti];
    onStatus?.(plan.tracks.length > 1 ? `Đang tải ${track.role === 'audio' ? 'âm thanh' : 'video'}…` : 'Đang tải…');
    const file = path.join(workDir, `track${ti}.${EXT[track.kind] || 'bin'}`);
    const w = openWriter(file);
    const items = [];
    if (track.init) items.push(track.init);
    items.push(...track.segments);
    try {
      await downloadOrdered(
        items,
        (it) => fetchItem(it, track.kind),
        async (u8) => {
          await w.write(u8);
          stats.doneUnits++;
          report();
        },
        signal
      );
      await w.close();
    } catch (e) {
      w.destroy();
      throw e;
    }
    trackFiles.push({ file, kind: track.kind, role: track.role });
  }

  return await finalize(trackFiles, workDir, { signal, onStatus });
}

/**
 * fMP4/WebM: nối thẳng các đoạn (đã là định dạng phát được).
 * TS: đưa qua ffmpeg đổi sang MP4 phân mảnh ngay trong lúc tải (copy stream, không nén lại).
 */
async function downloadStreaming(track, workDir, { fetchItem, stats, report, signal, onStatus, onStream }) {
  const out = path.join(workDir, 'output.stream');
  const w = openWriter(out);
  const ext = track.kind === 'webm' ? 'webm' : 'mp4';
  const items = [];
  if (track.init) items.push(track.init);
  items.push(...track.segments);
  onStatus?.('Đang tải…');

  let ff = null;
  let pump = null;
  if (track.kind === 'ts') {
    ff = ffmpegPipe(
      ['-f', 'mpegts', '-i', 'pipe:0', '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1'],
      { signal }
    );
    pump = (async () => {
      for await (const chunk of ff.stdout) await w.write(chunk);
    })();
  }
  onStream({ file: out, ext, size: 0 });

  const toFf = (u8) =>
    new Promise((resolve, reject) => {
      if (ff.stdin.destroyed) return reject(new Error('ffmpeg đã dừng'));
      ff.stdin.write(u8, (e) => (e ? reject(e) : resolve()));
    });
  try {
    await downloadOrdered(
      items,
      (it) => fetchItem(it, track.kind),
      async (u8) => {
        await (ff ? toFf(u8) : w.write(u8));
        stats.doneUnits++;
        report();
      },
      signal
    );
    if (ff) {
      ff.stdin.end();
      await Promise.all([ff.done, pump]);
    }
    await w.close();
  } catch (e) {
    if (ff) ff.stdin.destroy();
    w.destroy();
    throw e;
  }
  return { file: out, ext, streamed: true };
}

/** Ghép/đổi container bằng ffmpeg (copy stream, không nén lại → giữ nguyên chất lượng) */
async function finalize(tracks, workDir, { signal, onStatus }) {
  const allWebm = tracks.every((t) => t.kind === 'webm');
  const ext = allWebm ? 'webm' : 'mp4';
  const out = path.join(workDir, 'output.' + ext);
  const args = [];
  for (const t of tracks) args.push('-i', t.file);
  // Track audio riêng thay cho audio (nếu có) nằm sẵn trong luồng video
  if (tracks.length === 2) args.push('-map', '0:v:0', '-map', '1:a:0');
  args.push('-c', 'copy');
  if (ext === 'mp4') {
    if (tracks.some((t) => t.kind === 'ts' || t.kind === 'aac')) args.push('-bsf:a', 'aac_adtstoasc');
    args.push('-movflags', '+faststart');
  }
  args.push(out);

  onStatus?.(tracks.length === 2 ? 'Đang ghép video + âm thanh…' : 'Đang đóng gói MP4…');
  try {
    await runFfmpeg(args, { signal });
    await Promise.all(tracks.map((t) => rm(t.file, { force: true })));
    return { file: out, ext };
  } catch (e) {
    if (signal?.aborted) throw e;
    await rm(out, { force: true });
    // Không có ffmpeg / ghép lỗi: trả file gốc nếu chỉ có 1 track
    if (tracks.length === 1) {
      const t = tracks[0];
      const raw = path.join(workDir, 'output.' + (EXT[t.kind] || 'bin'));
      await rename(t.file, raw);
      return { file: raw, ext: EXT[t.kind] || 'bin', warning: 'Không đóng gói được sang MP4: ' + e.message };
    }
    throw e;
  }
}

/** Tải song song nhưng giao kết quả cho consume() đúng thứ tự, có giới hạn bộ nhớ */
async function downloadOrdered(items, fetcher, consume, signal) {
  const results = new Map();
  let next = 0;
  let idx = 0;
  let waiters = [];
  let failed = null;
  let draining = Promise.resolve();
  const wake = () => {
    const w = waiters;
    waiters = [];
    w.forEach((r) => r());
  };
  const drain = () =>
    (draining = draining.then(async () => {
      while (results.has(next) && !failed) {
        const data = results.get(next);
        results.delete(next);
        await consume(data);
        next++;
        wake();
      }
    }));

  const worker = async () => {
    while (idx < items.length && !failed) {
      const i = idx++;
      while (i - next > WINDOW && !failed) await new Promise((r) => waiters.push(r));
      if (failed) return;
      try {
        results.set(i, await fetcher(items[i]));
      } catch (e) {
        failed = failed || e;
        wake();
        return;
      }
      drain().catch((e) => {
        failed = failed || e;
        wake();
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  await draining.catch(() => {});
  if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
  if (failed) throw new Error(`Lỗi tải segment: ${failed.message || failed}`);
  if (next !== items.length) throw new Error('Thiếu segment khi ghép');
}

export async function fileSize(f) {
  return (await stat(f)).size;
}

/**
 * Chuyển mã sang H.264 + AAC trong MP4 để phát được trên mọi thiết bị (TV, điện thoại cũ, Windows chưa có codec).
 * Giữ nguyên độ phân giải; CRF 18 cho chất lượng gần như không nhìn ra khác biệt.
 */
export async function transcodeH264(file, workDir, { duration, signal, onProgress, onStatus }) {
  const out = path.join(workDir, 'output.h264.mp4');
  onStatus?.('Đang chuyển sang H.264…');
  await runFfmpeg(
    [
      '-i', file,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'faster', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-profile:v', 'high',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      out,
    ],
    {
      signal,
      onProgress: (sec, speed) => onProgress?.({ encodeProgress: duration ? Math.min(1, sec / duration) : 0, encodeSpeed: speed }),
    }
  );
  await rm(file, { force: true });
  return { file: out, ext: 'mp4' };
}
