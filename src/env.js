// Đọc file .env (KEY=VALUE) vào process.env. Mặc định không ghi đè biến đã đặt sẵn;
// override: true để giá trị trong .env luôn thắng (server đọc lại .env mỗi lần khởi động).
import { readFileSync } from 'node:fs';

export function loadEnv(file, { override = false } = {}) {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (override || process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
