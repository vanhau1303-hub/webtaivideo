// Tiện ích dùng chung.

const SEGMENT_RE = /(^|[\/_-])(seg|segment|chunk|frag|fragment|init)[-_]?\d*\.(mp4|m4v|webm)$/i;

/** Phân loại URL/Content-Type: 'hls' | 'dash' | 'file' | null */
export function classifyMedia(url, contentType = '') {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  // YouTube trả từng mảnh (range/SABR) — không tải trực tiếp được
  if (/(^|\.)googlevideo\.com$/.test(u.hostname)) return null;
  const path = u.pathname.toLowerCase();
  const ct = contentType.toLowerCase().split(';')[0].trim();
  if (path.endsWith('.m3u8') || ct.includes('mpegurl')) return 'hls';
  if (path.endsWith('.mpd') || ct === 'application/dash+xml') return 'dash';
  if (/\.(ts|m4s|aac|m4a|mp3|vtt|webvtt|srt|key|cmfv|cmfa)$/.test(path)) return null;
  if (ct === 'video/mp2t' || ct === 'video/iso.segment' || ct === 'audio/mp4') return null;
  const extHit = /\.(mp4|webm|mkv|mov|m4v|ogv)$/.test(path);
  const ctHit = /^video\/(mp4|webm|x-matroska|quicktime|ogg|x-m4v)$/.test(ct);
  if (extHit || ctHit) {
    if (SEGMENT_RE.test(path)) return null;
    return 'file';
  }
  return null;
}

/** Bỏ tham số byte-range khỏi URL file để không bị trùng lặp */
export function normalizeMediaUrl(url) {
  try {
    const u = new URL(url);
    for (const p of ['range', 'bytestart', 'byteend']) u.searchParams.delete(p);
    return u.href;
  } catch {
    return url;
  }
}

export function resolveUrl(base, rel) {
  return new URL(rel, base).href;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function sanitizeFilename(name, maxLen = 110) {
  let s = (name || 'video')
    .replace(/[<>:"/\\|?*\u0000-\u001f~]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  s = s.replace(/[. ]+$/, '');
  return s || 'video';
}

export function fmtBytes(n) {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return n.toFixed(i >= 2 ? 1 : 0) + ' ' + u[i];
}

export function fmtBitrate(bps) {
  if (!bps) return '';
  return bps >= 1e6 ? (bps / 1e6).toFixed(1) + ' Mbps' : Math.round(bps / 1e3) + ' kbps';
}

export function fmtDuration(sec) {
  if (!sec || !isFinite(sec)) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

export function qualityLabel(height, width) {
  if (!height) return '';
  // Video dọc: dùng cạnh ngắn để gọi tên chất lượng
  const p = width && width < height ? width : height;
  if (p >= 4320) return '8K';
  if (p >= 2160) return '4K';
  if (p >= 1440) return '1440p';
  return p + 'p';
}
