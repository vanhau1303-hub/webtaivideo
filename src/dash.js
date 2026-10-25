// Phân tích manifest DASH (.mpd). Cần DOMParser nên chỉ chạy trong popup/trang quản lý.
import { resolveUrl } from './util.js';

const kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el, name) => kids(el, name)[0] || null;

export function parseIsoDuration(s) {
  if (!s) return 0;
  const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    s.trim()
  );
  if (!m) return 0;
  const [, y, mo, d, h, mi, se] = m.map((x) => Number(x) || 0);
  return y * 31536000 + mo * 2592000 + d * 86400 + h * 3600 + mi * 60 + se;
}

function parseRange(str) {
  if (!str) return null;
  const [a, b] = str.split('-').map(Number);
  return { start: a, end: b };
}

function withBase(base, el) {
  const b = kid(el, 'BaseURL');
  return b && b.textContent.trim() ? resolveUrl(base, b.textContent.trim()) : base;
}

function fillTemplate(tpl, vars) {
  return tpl.replace(/\$(RepresentationID|Number|Bandwidth|Time|)(?:%0(\d+)d)?\$/g, (all, name, width) => {
    if (name === '') return '$';
    let v = String(vars[name]);
    if (width) v = v.padStart(Number(width), '0');
    return v;
  });
}

function hasDrm(...els) {
  return els.some((el) => kids(el, 'ContentProtection').length > 0);
}

function mergedTemplate(...els) {
  // Thuộc tính SegmentTemplate kế thừa từ Period -> AdaptationSet -> Representation
  const tpls = els.map((el) => kid(el, 'SegmentTemplate')).filter(Boolean);
  if (!tpls.length) return null;
  const attrs = {};
  let timeline = null;
  for (const t of tpls) {
    for (const a of t.attributes) attrs[a.name] = a.value;
    const tl = kid(t, 'SegmentTimeline');
    if (tl) timeline = tl;
  }
  return { attrs, timeline };
}

function buildSegments(rep, as, period, base, periodDuration) {
  const vars = { RepresentationID: rep.getAttribute('id') || '', Bandwidth: rep.getAttribute('bandwidth') || '' };

  // 1) SegmentTemplate
  const tpl = mergedTemplate(period, as, rep);
  if (tpl) {
    const { attrs, timeline } = tpl;
    const timescale = Number(attrs.timescale) || 1;
    const startNumber = attrs.startNumber != null ? Number(attrs.startNumber) : 1;
    const init = attrs.initialization ? { url: resolveUrl(base, fillTemplate(attrs.initialization, vars)), range: null } : null;
    const segments = [];
    if (timeline) {
      const endTime = periodDuration * timescale;
      let t = 0;
      let number = startNumber;
      const ss = kids(timeline, 'S');
      ss.forEach((s, i) => {
        if (s.hasAttribute('t')) t = Number(s.getAttribute('t'));
        const d = Number(s.getAttribute('d'));
        let r = Number(s.getAttribute('r') || 0);
        if (r < 0) {
          const next = ss[i + 1];
          const until = next && next.hasAttribute('t') ? Number(next.getAttribute('t')) : endTime;
          r = Math.max(0, Math.ceil((until - t) / d) - 1);
        }
        for (let k = 0; k <= r; k++) {
          segments.push({ url: resolveUrl(base, fillTemplate(attrs.media, { ...vars, Number: number, Time: t })), range: null });
          t += d;
          number++;
        }
      });
    } else if (attrs.duration) {
      const segDur = Number(attrs.duration) / timescale;
      const count = Math.ceil(periodDuration / segDur - 1e-6);
      for (let k = 0; k < count; k++) {
        const number = startNumber + k;
        const time = Math.round(k * Number(attrs.duration));
        segments.push({ url: resolveUrl(base, fillTemplate(attrs.media, { ...vars, Number: number, Time: time })), range: null });
      }
    }
    return { init, segments, sidx: null };
  }

  // 2) SegmentList
  const list = kid(rep, 'SegmentList') || kid(as, 'SegmentList');
  if (list) {
    const ini = kid(list, 'Initialization');
    const init = ini
      ? { url: resolveUrl(base, ini.getAttribute('sourceURL') || base), range: parseRange(ini.getAttribute('range')) }
      : null;
    const segments = kids(list, 'SegmentURL').map((s) => ({
      url: s.getAttribute('media') ? resolveUrl(base, s.getAttribute('media')) : base,
      range: parseRange(s.getAttribute('mediaRange')),
    }));
    return { init, segments, sidx: null };
  }

  // 3) SegmentBase (một file, có sidx) hoặc chỉ BaseURL
  const sb = kid(rep, 'SegmentBase') || kid(as, 'SegmentBase');
  if (sb && sb.getAttribute('indexRange')) {
    const ini = kid(sb, 'Initialization');
    return {
      init: null,
      segments: [],
      sidx: {
        url: base,
        indexRange: parseRange(sb.getAttribute('indexRange')),
        initRange: ini ? parseRange(ini.getAttribute('range')) : null,
      },
    };
  }
  return { init: null, segments: [{ url: base, range: null }], sidx: null, wholeFile: true };
}

export function parseMPD(text, mpdUrl) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const mpd = doc.documentElement;
  if (!mpd || mpd.localName !== 'MPD') throw new Error('Không phải manifest DASH hợp lệ');
  const live = (mpd.getAttribute('type') || 'static') === 'dynamic';
  const total = parseIsoDuration(mpd.getAttribute('mediaPresentationDuration'));
  const periods = kids(mpd, 'Period');
  const mpdBase = withBase(mpdUrl, mpd);

  // Chọn Period dài nhất (bỏ qua các period quảng cáo ngắn)
  let best = null;
  periods.forEach((p, i) => {
    let dur = parseIsoDuration(p.getAttribute('duration'));
    if (!dur) {
      const start = parseIsoDuration(p.getAttribute('start'));
      const next = periods[i + 1];
      dur = next ? parseIsoDuration(next.getAttribute('start')) - start : total - start;
    }
    if (!best || dur > best.dur) best = { p, dur };
  });
  if (!best) throw new Error('Manifest không có Period');

  const period = best.p;
  const periodDuration = best.dur || total;
  const periodBase = withBase(mpdBase, period);
  const videos = [];
  const audios = [];

  for (const as of kids(period, 'AdaptationSet')) {
    const asMime = as.getAttribute('mimeType') || '';
    const asType = as.getAttribute('contentType') || asMime.split('/')[0];
    const trick = kids(as, 'EssentialProperty').some((e) => /trickmode/i.test(e.getAttribute('schemeIdUri') || ''));
    if (trick) continue;
    const asBase = withBase(periodBase, as);
    for (const rep of kids(as, 'Representation')) {
      const mime = rep.getAttribute('mimeType') || asMime;
      const type = (rep.getAttribute('contentType') || asType || mime.split('/')[0]).toLowerCase();
      if (type !== 'video' && type !== 'audio') continue;
      const codecs = rep.getAttribute('codecs') || as.getAttribute('codecs') || '';
      const base = withBase(asBase, rep);
      const segInfo = buildSegments(rep, as, period, base, periodDuration);
      const entry = {
        id: rep.getAttribute('id') || String(videos.length + audios.length),
        bandwidth: Number(rep.getAttribute('bandwidth')) || 0,
        width: Number(rep.getAttribute('width') || as.getAttribute('width')) || 0,
        height: Number(rep.getAttribute('height') || as.getAttribute('height')) || 0,
        codecs,
        mimeType: mime,
        lang: as.getAttribute('lang') || '',
        drm: hasDrm(as, rep),
        kind: /webm/i.test(mime) ? 'webm' : 'fmp4',
        ...segInfo,
      };
      (type === 'video' ? videos : audios).push(entry);
    }
  }

  return {
    live,
    duration: periodDuration,
    drm: [...videos, ...audios].some((r) => r.drm),
    videos,
    audios,
  };
}

/** Chọn audio tốt nhất, ưu tiên cùng định dạng container với video (và AAC nếu cần tương thích) */
export function pickDashAudio(mpd, video, { preferAac = false } = {}) {
  const same = mpd.audios.filter((a) => a.kind === video.kind && !a.drm);
  let pool = same.length ? same : mpd.audios.filter((a) => !a.drm);
  if (preferAac) {
    const aac = pool.filter((a) => /mp4a/i.test(a.codecs));
    if (aac.length) pool = aac;
  }
  return [...pool].sort((a, b) => b.bandwidth - a.bandwidth)[0] || null;
}
