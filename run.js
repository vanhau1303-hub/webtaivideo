// Trình giám sát chạy trên máy nhà:
//  1) chạy server.js (tự bật lại nếu lỗi)
//  2) mở Cloudflare Tunnel và báo link mới cho Worker video4urduck
//  3) mỗi phút kiểm tra GitHub; có code mới thì git pull + khởi động lại (chờ các lượt tải đang chạy xong)
import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadEnv } from './src/env.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(ROOT, '.env'));
const exec = promisify(execFile);

const PORT = Number(process.env.PORT) || 8686;
const RELAY_URL = process.env.RELAY_URL || ''; // https://video4urduck.<tài-khoản>.workers.dev
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';
const UPDATE_INTERVAL = Number(process.env.UPDATE_INTERVAL_SEC || 60) * 1000;
const BRANCH = process.env.UPDATE_BRANCH || 'main';
const INTERNAL_TOKEN = crypto.randomBytes(24).toString('hex');
const RESTART_SELF = 75; // start.bat thấy mã này sẽ chạy lại run.js (khi chính run.js được cập nhật)

const log = (...a) => console.log(new Date().toLocaleTimeString('vi-VN'), ...a);

// ---------------- server.js ----------------
let server = null;
let stopping = false;

function startServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, INTERNAL_TOKEN },
  });
  const me = server;
  me.on('exit', (code) => {
    if (stopping || server !== me) return;
    log(`⚠ server.js dừng (mã ${code}), bật lại sau 3 giây`);
    setTimeout(startServer, 3000);
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server || server.exitCode !== null) return resolve();
    const s = server;
    server = null;
    s.once('exit', resolve);
    s.kill();
    setTimeout(() => s.kill('SIGKILL'), 5000);
  });
}

async function health() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { headers: { 'x-internal-token': INTERNAL_TOKEN } });
    return await r.json();
  } catch {
    return null;
  }
}

// ---------------- Cloudflare Tunnel ----------------
function findCloudflared() {
  const cands = [
    process.env.CLOUDFLARED,
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  ].filter(Boolean);
  return cands.find((p) => existsSync(p)) || 'cloudflared';
}

let tunnelUrl = '';
function startTunnel() {
  const bin = findCloudflared();
  const p = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], { windowsHide: true });
  let announced = false;
  const onData = (d) => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(d.toString());
    if (m && !announced) {
      announced = true;
      tunnelUrl = m[0];
      log('🌐 Tunnel:', tunnelUrl);
      announce();
    }
  };
  p.stdout.on('data', onData);
  p.stderr.on('data', onData);
  p.on('error', (e) => log('⚠ Không chạy được cloudflared:', e.message));
  p.on('exit', (code) => {
    if (stopping) return;
    log(`⚠ Tunnel dừng (mã ${code}), mở lại sau 5 giây`);
    tunnelUrl = '';
    setTimeout(startTunnel, 5000);
  });
  tunnel = p;
}
let tunnel = null;

async function announce() {
  if (!RELAY_URL || !RELAY_TOKEN || !tunnelUrl) return;
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch(`${RELAY_URL}/__tunnel`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RELAY_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ target: tunnelUrl }),
      });
      if (r.ok) return log('✅ Đã cập nhật địa chỉ cố định:', RELAY_URL, '(có hiệu lực sau ~1 phút)');
      log('⚠ Worker từ chối cập nhật:', r.status);
      return;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
}

// ---------------- Tự cập nhật từ GitHub ----------------
const git = (...args) => exec('git', args, { cwd: ROOT, windowsHide: true }).then((r) => r.stdout.trim());
const fileHash = (f) => {
  try {
    return crypto.createHash('sha1').update(readFileSync(path.join(ROOT, f))).digest('hex');
  } catch {
    return '';
  }
};

// Trạng thái của bản đang chạy — có commit mới (kéo từ GitHub hoặc commit ngay trên máy) thì khởi động lại
const running = { head: '', lock: fileHash('package-lock.json'), run: fileHash('run.js'), env: fileHash('.env') };
let pendingSince = 0;
let checking = false;

async function checkUpdate() {
  if (checking) return;
  checking = true;
  try {
    running.head ||= await git('rev-parse', 'HEAD');
    await git('fetch', '--quiet', 'origin', BRANCH).catch((e) => log('⚠ Không kết nối được GitHub:', e.message.split('\n')[0]));
    const [local, remote] = await Promise.all([git('rev-parse', 'HEAD'), git('rev-parse', `origin/${BRANCH}`).catch(() => '')]);
    let pull = false;
    if (remote && local !== remote) {
      const base = await git('merge-base', 'HEAD', `origin/${BRANCH}`);
      if (base === local) pull = true; // GitHub mới hơn máy
      // ngược lại: máy có commit chưa push — vẫn chạy bản trên máy
    }
    const envChanged = fileHash('.env') !== running.env;
    if (!pull && local === running.head && !envChanged) return;

    // Đợi các lượt tải/phân tích đang chạy xong (tối đa 30 phút)
    const h = await health();
    if (h && (h.active || h.analyzing)) {
      pendingSince ||= Date.now();
      if (Date.now() - pendingSince < 30 * 60000) return log(`⏳ Có bản mới, chờ ${h.active} lượt tải xong rồi cập nhật`);
    }
    pendingSince = 0;

    if (pull) {
      log('⬇ Có bản mới trên GitHub, đang cập nhật…');
      await git('pull', '--ff-only', '--quiet', 'origin', BRANCH);
    }
    const head = await git('rev-parse', 'HEAD');
    if (head !== running.head) log('✓ Bản mới:', await git('log', '-1', '--format=%h %s'));
    running.head = head;
    if (envChanged) {
      running.env = fileHash('.env');
      log('🔑 File .env thay đổi (mật khẩu / cấu hình), áp dụng lại');
    }
    if (fileHash('package-lock.json') !== running.lock) {
      log('📦 Thư viện thay đổi, chạy npm install…');
      await exec(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: ROOT, shell: true });
      running.lock = fileHash('package-lock.json');
    }
    if (fileHash('run.js') !== running.run) {
      log('🔁 Trình giám sát được cập nhật, khởi động lại toàn bộ…');
      return shutdown(RESTART_SELF);
    }
    await stopServer();
    startServer();
    log('🔁 Đã khởi động lại server với bản mới');
  } catch (e) {
    log('⚠ Lỗi kiểm tra cập nhật:', e.message.split('\n')[0]);
  } finally {
    checking = false;
  }
}

// ---------------- Khởi động ----------------
async function shutdown(code = 0) {
  stopping = true;
  tunnel?.kill();
  await stopServer();
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

log('🚀 Khởi động HD Video Downloader');
if (!process.env.APP_PASSWORD) log('⚠ Chưa đặt APP_PASSWORD trong .env — web mở cho tất cả mọi người!');
startServer();
if (process.env.TUNNEL !== '0') startTunnel();
if (existsSync(path.join(ROOT, '.git'))) {
  git('rev-parse', 'HEAD').then((h) => (running.head = h)).catch(() => {});
  setInterval(checkUpdate, UPDATE_INTERVAL);
}
