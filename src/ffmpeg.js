// Gọi ffmpeg (bản đóng gói sẵn trong ffmpeg-static, hoặc ffmpeg trong PATH).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

let ffmpegPath = null;
try {
  const mod = await import('ffmpeg-static');
  if (mod.default && existsSync(mod.default)) ffmpegPath = mod.default;
} catch {}
if (!ffmpegPath) ffmpegPath = 'ffmpeg';

export const FFMPEG = ffmpegPath;

/** onProgress(seconds, speed): thời điểm đã xử lý tới (giây) và tốc độ so với thời gian thực */
export function runFfmpeg(args, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const pre = ['-hide_banner', '-loglevel', 'error', '-y'];
    if (onProgress) pre.push('-progress', 'pipe:1', '-nostats');
    const p = spawn(ffmpegPath, [...pre, ...args], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    if (onProgress) {
      let buf = '';
      let time = 0;
      p.stdout.on('data', (d) => {
        buf += d;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const l of lines) {
          const [k, v] = l.split('=');
          if (k === 'out_time_us' || k === 'out_time_ms') time = Number(v) / 1e6 || time;
          else if (k === 'speed') onProgress(time, parseFloat(v) || 0);
        }
      });
    }
    p.on('error', reject);
    const onAbort = () => p.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort);
    p.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(signal.reason || new DOMException('Aborted', 'AbortError'));
      code === 0 ? resolve() : reject(new Error('ffmpeg lỗi: ' + err.trim().split('\n').pop()));
    });
  });
}

export async function hasFfmpeg() {
  try {
    await runFfmpeg(['-version']);
    return true;
  } catch {
    return false;
  }
}
