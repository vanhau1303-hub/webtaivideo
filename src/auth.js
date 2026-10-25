// Bảo vệ web bằng mật khẩu khi đưa ra Internet (bật khi có APP_PASSWORD).
import crypto from 'node:crypto';

const COOKIE = 'vdl_session';
const MAX_AGE = 30 * 24 * 3600; // 30 ngày
const attempts = new Map(); // ip -> { count, until }

const password = () => process.env.APP_PASSWORD || '';
// Ghép cả mật khẩu vào khoá ký: đổi mật khẩu là mọi phiên đăng nhập cũ hết hiệu lực
const secret = () => (process.env.SESSION_SECRET || '') + ':' + password();

export const authEnabled = () => !!password();

function sign(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('base64url');
}

function readCookie(req, name) {
  const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)').exec(req.headers.cookie || '');
  return m ? m[1] : '';
}

export function clientIp(req) {
  return req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
}

export function isAuthed(req) {
  if (!authEnabled()) return true;
  // Trình giám sát (run.js) gọi nội bộ bằng token riêng
  const internal = process.env.INTERNAL_TOKEN;
  if (internal && req.headers['x-internal-token'] === internal) return true;
  const raw = readCookie(req, COOKIE);
  const [exp, sig] = raw.split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  const expected = sign(exp);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

/** Trả về { ok, cookie?, error? } */
export function tryLogin(req, given) {
  const ip = clientIp(req);
  const a = attempts.get(ip) || { count: 0, until: 0 };
  if (a.until > Date.now()) {
    return { ok: false, error: `Sai quá nhiều lần, thử lại sau ${Math.ceil((a.until - Date.now()) / 60000)} phút` };
  }
  const want = Buffer.from(password());
  const got = Buffer.from(String(given || ''));
  const ok = want.length === got.length && crypto.timingSafeEqual(want, got);
  if (!ok) {
    a.count++;
    if (a.count >= 8) Object.assign(a, { count: 0, until: Date.now() + 15 * 60000 });
    attempts.set(ip, a);
    return { ok: false, error: 'Sai mật khẩu' };
  }
  attempts.delete(ip);
  const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return { ok: true, cookie: `${COOKIE}=${exp}.${sign(exp)}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${secure}` };
}

export function logoutCookie() {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

/** Khi mở ra Internet: không cho quét địa chỉ nội bộ (router, máy trong LAN, chính server) */
export function isPrivateHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return h.includes(':');
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
