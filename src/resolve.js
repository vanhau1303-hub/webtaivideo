// Từ một link bất kỳ -> danh sách nguồn video + chất lượng, chọn sẵn bản cao nhất.
import { analyzeSource } from './analyze.js';
import { sniffPage } from './sniffer.js';
import { ytdlpInfo, ytdlpOptions } from './ytdlp.js';
import { classifyMedia, hostOf, qualityLabel } from './util.js';

const MAX_MANIFESTS = 12;

// Trang có extractor riêng trong yt-dlp và chạy tốt hơn quét mạng
const YTDLP_FIRST = /(^|\.)(youtube\.com|youtu\.be|facebook\.com|fb\.watch|tiktok\.com|instagram\.com|twitter\.com|x\.com|vimeo\.com|dailymotion\.com|bilibili\.com|bilibili\.tv|twitch\.tv|reddit\.com|soundcloud\.com|threads\.net|zingmp3\.vn|nhaccuatui\.com|vk\.com|ok\.ru|rumble\.com|streamable\.com|pinterest\.com|linkedin\.com|weibo\.com|douyin\.com|kick\.com)$/i;

let seq = 0;
const newId = (p) => p + (++seq).toString(36) + Date.now().toString(36).slice(-4);

/**
 * mode: 'auto' | 'sniff' | 'ytdlp'
 * Trả về { title, thumbnail, pageUrl, via, sources: [...], best }
 */
export async function resolveLink(url, { mode = 'auto', ytdlpReady, signal, onStatus } = {}) {
  const host = hostOf(url);
  const directKind = classifyMedia(url);

  // 1) Link trực tiếp tới file/manifest
  if (directKind && mode !== 'ytdlp') {
    onStatus?.('Đang đọc link trực tiếp…');
    const src = { id: newId('s'), url, kind: directKind, headers: {} };
    src.info = await analyzeSource(src, signal);
    return finish({ title: decodeURIComponent(new URL(url).pathname.split('/').pop() || 'video'), pageUrl: url, via: 'direct', sources: [src] });
  }

  const errors = [];
  const tryYtdlp = async () => {
    onStatus?.('Đang lấy thông tin bằng yt-dlp…');
    const info = await ytdlpInfo(url, { signal });
    const { options, drm, duration } = ytdlpOptions(info);
    const extractor = (info.extractor_key || info.extractor || '').toLowerCase();
    return finish({
      title: info.title || '',
      thumbnail: info.thumbnail || '',
      pageUrl: info.webpage_url || url,
      via: 'ytdlp',
      extractor,
      sources: [
        {
          id: newId('s'),
          url: info.webpage_url || url,
          kind: 'ytdlp',
          name: `${info.extractor_key || 'yt-dlp'}${info.uploader ? ' · ' + info.uploader : ''}`,
          headers: {},
          info: { kind: 'ytdlp', duration, drm, options },
        },
      ],
    });
  };

  // 2) Trang lớn: thử yt-dlp trước
  if (ytdlpReady && (mode === 'ytdlp' || (mode === 'auto' && YTDLP_FIRST.test(host)))) {
    try {
      const r = await tryYtdlp();
      if (r.best || mode === 'ytdlp') return r;
    } catch (e) {
      if (signal?.aborted) throw e;
      errors.push('yt-dlp: ' + e.message);
      if (mode === 'ytdlp') throw new Error(errors.join('\n'));
    }
  }

  // 3) Cơ chế giống Cốc Cốc: mở trang, bấm phát, bắt luồng
  try {
    const r = await sniffAndAnalyze(url, { signal, onStatus });
    if (r.best) return r;
    // Không bắt được gì: thử yt-dlp (extractor generic đôi khi tìm ra link trong HTML)
    if (ytdlpReady && mode === 'auto' && !YTDLP_FIRST.test(host)) {
      try {
        const y = await tryYtdlp();
        if (y.best) return y;
      } catch (e) {
        if (signal?.aborted) throw e;
        errors.push('yt-dlp: ' + e.message);
      }
    }
    r.errors = errors;
    return r;
  } catch (e) {
    if (signal?.aborted) throw e;
    errors.push(e.message);
    throw new Error(errors.join('\n'));
  }
}

async function sniffAndAnalyze(url, { signal, onStatus }) {
  const page = await sniffPage(url, { signal, onStatus });
  const baseHeaders = { userAgent: page.userAgent, cookies: page.cookies };

  // Gộp nguồn từ request mạng + thẻ <video> có src là file thật
  const map = new Map();
  for (const it of [...page.items].sort((a, b) => b.time - a.time)) {
    if (!map.has(it.url)) map.set(it.url, it);
  }
  for (const v of page.videos) {
    for (const src of [v.src, ...v.sources]) {
      if (!/^https?:/.test(src)) continue;
      const kind = classifyMedia(src) || 'file';
      const ex = map.get(src) || { url: src, kind, referer: v.frameUrl, time: Date.now() };
      Object.assign(ex, { width: v.width, height: v.height, duration: v.duration, playing: v.playing, frameUrl: v.frameUrl });
      map.set(src, ex);
    }
  }
  const sources = [...map.values()].map((it) => ({
    ...it,
    id: newId('s'),
    headers: {
      ...baseHeaders,
      referer: it.referer || it.frameUrl || page.pageUrl,
      origin: it.origin || '',
    },
  }));

  onStatus?.(sources.length ? `Đang phân tích ${sources.length} nguồn…` : 'Không thấy luồng video nào');
  const manifests = sources.filter((s) => s.kind !== 'file').slice(0, MAX_MANIFESTS);
  const files = sources.filter((s) => s.kind === 'file');
  await Promise.all([...manifests, ...files].map(async (s) => (s.info = await analyzeSource(s, signal))));
  const analyzed = sources.filter((s) => s.info);

  // Ẩn playlist con đã nằm trong master playlist
  const children = new Set();
  for (const s of analyzed) {
    if (s.kind === 'hls' && !s.info.isMediaPlaylist) {
      for (const o of s.info.options) {
        children.add(o.sel.video);
        if (o.sel.audio) children.add(o.sel.audio);
      }
    }
  }
  const visible = analyzed.filter((s) => !(s.kind === 'hls' && s.info.isMediaPlaylist && children.has(s.url)));

  // Gắn độ phân giải từ thẻ <video> đang phát cho playlist đơn lẻ
  const playing = page.videos.find((v) => v.playing && v.height) || page.videos.find((v) => v.height);
  const singles = visible.filter((s) => s.info.isMediaPlaylist);
  if (playing && singles.length === 1) {
    const o = singles[0].info.options[0];
    if (!o.height) {
      o.height = playing.height;
      o.width = playing.width;
      o.label = qualityLabel(playing.height, playing.width) || o.label;
    }
  }

  return finish({
    title: page.title,
    thumbnail: page.thumbnail,
    pageUrl: page.pageUrl,
    via: 'sniff',
    browser: page.browser,
    sources: visible,
  });
}

function pickBest(sources) {
  const cands = [];
  for (const s of sources) {
    const o = s.info.options.find((x) => !x.disabled);
    if (o) cands.push({ s, o, dur: s.info.duration || s.duration || 0 });
  }
  if (!cands.length) return null;
  // Bỏ nguồn quá ngắn so với video dài nhất (thường là quảng cáo)
  const maxDur = Math.max(...cands.map((c) => c.dur));
  const pool = cands.filter((c) => !c.dur || !maxDur || c.dur >= maxDur * 0.5);
  pool.sort(
    (a, b) =>
      (b.o.height || 0) - (a.o.height || 0) ||
      (b.s.playing ? 1 : 0) - (a.s.playing ? 1 : 0) ||
      (b.dur || 0) - (a.dur || 0) ||
      (b.o.bandwidth || b.o.sizeEstimate || 0) - (a.o.bandwidth || a.o.sizeEstimate || 0)
  );
  return { sourceId: pool[0].s.id, optionId: pool[0].o.id };
}

/**
 * Bản "tương thích mọi máy": H.264 cao nhất có sẵn. Nếu không nguồn nào có H.264
 * thì dùng bản nét nhất và chuyển mã sang H.264 bằng ffmpeg sau khi tải.
 * Trả về null khi bản nét nhất đã là H.264 (hoặc không rõ codec).
 */
function pickCompat(sources, best) {
  if (!best) return null;
  const bs = sources.find((s) => s.id === best.sourceId);
  const bo = bs.info.options.find((o) => o.id === best.optionId);
  if (!bo.codec || bo.codec === 'H.264') return null;
  const bestDur = bs.info.duration || bs.duration || 0;
  const cands = [];
  for (const s of sources) {
    const dur = s.info.duration || s.duration || 0;
    if (bestDur && dur && dur < bestDur * 0.5) continue;
    for (const o of s.info.options) if (o.codec === 'H.264' && !o.disabled) cands.push({ s, o });
  }
  cands.sort((a, b) => (b.o.height || 0) - (a.o.height || 0) || (b.o.bandwidth || 0) - (a.o.bandwidth || 0));
  if (cands.length) return { sourceId: cands[0].s.id, optionId: cands[0].o.id, transcode: false };
  return { sourceId: best.sourceId, optionId: best.optionId, transcode: true };
}

function finish(r) {
  r.best = pickBest(r.sources);
  r.bestCompat = pickCompat(r.sources, r.best);
  // Sắp xếp: nguồn chứa bản tốt nhất lên đầu
  r.sources.sort((a, b) => (b.id === r.best?.sourceId) - (a.id === r.best?.sourceId) || (b.info.options[0]?.height || 0) - (a.info.options[0]?.height || 0));
  r.duration = r.sources.find((s) => s.id === r.best?.sourceId)?.info.duration || 0;
  return r;
}
