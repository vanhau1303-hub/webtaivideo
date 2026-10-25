// Từ một nguồn media (HLS/DASH/file): liệt kê các mức chất lượng và lập kế hoạch tải.
import { parseM3U8, pickAudio } from './hls.js';
import { parseMPD, pickDashAudio } from './dash.js';
import { fetchText, fetchBytes } from './net.js';
import { qualityLabel, fmtBitrate } from './util.js';
import { parseSidx } from './mp4.js';

export function codecName(codecs) {
  const c = (codecs || '').toLowerCase();
  if (/av01/.test(c)) return 'AV1';
  if (/hvc|hev|dvh/.test(c)) return 'H.265';
  if (/vp0?9/.test(c)) return 'VP9';
  if (/avc/.test(c)) return 'H.264';
  return '';
}

const byQuality = (a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0);

/**
 * src: { url, kind, headers, width?, height?, duration?, size?, contentType? }
 * Trả về { kind, options: [...], duration, live, drm, error? }
 */
export async function analyzeSource(src, signal) {
  try {
    if (src.kind === 'hls') return await analyzeHls(src, signal);
    if (src.kind === 'dash') return await analyzeDash(src, signal);
    return analyzeFile(src);
  } catch (e) {
    return { kind: src.kind, options: [], error: e.message || String(e) };
  }
}

function analyzeFile(src) {
  return {
    kind: 'file',
    duration: src.duration || 0,
    options: [
      {
        id: 'file',
        label: qualityLabel(src.height, src.width) || 'Gốc',
        height: src.height || 0,
        width: src.width || 0,
        bandwidth: 0,
        codec: '',
        sizeEstimate: src.size || 0,
        note: (src.contentType || '').replace('video/', '').toUpperCase(),
        sel: { file: src.url },
      },
    ],
  };
}

async function analyzeHls(src, signal) {
  const headers = src.headers;
  const text = await fetchText(src.url, { headers, signal });
  const pl = parseM3U8(text, src.url);
  if (pl.type === 'media') {
    return {
      kind: 'hls',
      duration: pl.duration,
      live: pl.live,
      drm: pl.drm,
      isMediaPlaylist: true,
      options: [
        {
          id: 'v0',
          label: qualityLabel(src.height, src.width) || 'Gốc',
          height: src.height || 0,
          width: src.width || 0,
          bandwidth: 0,
          codec: '',
          note: pl.kind === 'fmp4' ? 'fMP4' : 'TS',
          disabled: pl.drm || pl.live,
          reason: pl.drm ? 'Có DRM' : pl.live ? 'Đang phát trực tiếp' : '',
          sel: { video: src.url, audio: null },
        },
      ],
    };
  }

  const options = pl.variants
    .map((v, i) => {
      const audio = pickAudio(pl, v);
      return {
        id: 'v' + i,
        label: qualityLabel(v.height, v.width) || fmtBitrate(v.bandwidth) || 'Biến thể ' + (i + 1),
        height: v.height,
        width: v.width,
        bandwidth: v.bandwidth,
        codec: codecName(v.codecs),
        note: [codecName(v.codecs), v.frameRate > 30 ? Math.round(v.frameRate) + 'fps' : '', fmtBitrate(v.bandwidth)]
          .filter(Boolean)
          .join(' · '),
        disabled: pl.drm,
        reason: pl.drm ? 'Có DRM' : '',
        sel: { video: v.url, audio: audio ? audio.url : null },
      };
    })
    .sort(byQuality);

  let duration = 0;
  let live = false;
  let drm = pl.drm;
  const best = options[0];
  if (best) {
    try {
      const media = parseM3U8(await fetchText(best.sel.video, { headers, signal }), best.sel.video);
      duration = media.duration;
      live = media.live;
      drm = drm || media.drm;
    } catch {}
  }
  for (const o of options) {
    if (duration && o.bandwidth) o.sizeEstimate = (o.bandwidth * duration) / 8;
    if (drm || live) {
      o.disabled = true;
      o.reason = drm ? 'Có DRM' : 'Đang phát trực tiếp';
    }
  }
  return { kind: 'hls', duration, live, drm, options };
}

async function analyzeDash(src, signal) {
  const mpd = parseMPD(await fetchText(src.url, { headers: src.headers, signal }), src.url);
  const options = mpd.videos
    .map((v) => {
      const codec = codecName(v.codecs);
      // H.264 đi với AAC để file phát được trên mọi thiết bị
      const audio = pickDashAudio(mpd, v, { preferAac: codec === 'H.264' });
      const bw = v.bandwidth + (audio ? audio.bandwidth : 0);
      return {
        id: 'r' + v.id,
        label: qualityLabel(v.height, v.width) || fmtBitrate(v.bandwidth),
        height: v.height,
        width: v.width,
        bandwidth: bw,
        codec,
        sizeEstimate: mpd.duration ? (bw * mpd.duration) / 8 : 0,
        note: [codecName(v.codecs), fmtBitrate(v.bandwidth)].filter(Boolean).join(' · '),
        disabled: v.drm || mpd.live,
        reason: v.drm ? 'Có DRM' : mpd.live ? 'Đang phát trực tiếp' : '',
        sel: { videoId: v.id, audioId: audio ? audio.id : null },
      };
    })
    .sort(byQuality);
  return { kind: 'dash', duration: mpd.duration, live: mpd.live, drm: mpd.drm, options };
}

// ---------------- Lập kế hoạch tải ----------------
/**
 * plan: { tracks: [{ role, kind, init, segments, url? }], duration }
 * kind: 'ts' | 'fmp4' | 'webm' | 'aac' | 'mp3' | 'file'
 */
export async function buildPlan(source, sel, signal) {
  const headers = source.headers;
  if (source.kind === 'file') {
    return { tracks: [{ role: 'main', kind: 'file', url: sel.file || source.url }] };
  }
  if (source.kind === 'hls') {
    const tracks = [];
    const load = async (url, role) => {
      const pl = parseM3U8(await fetchText(url, { headers, signal }), url);
      if (pl.type !== 'media') throw new Error('Playlist con không hợp lệ');
      if (pl.drm) throw new Error('Luồng có DRM, không thể tải');
      if (pl.live) throw new Error('Luồng đang phát trực tiếp, chưa hỗ trợ');
      tracks.push({ role, kind: pl.kind, init: pl.init, segments: pl.segments });
      return pl;
    };
    const v = await load(sel.video, sel.audio ? 'video' : 'main');
    if (sel.audio) await load(sel.audio, 'audio');
    return { tracks, duration: v.duration };
  }
  if (source.kind === 'dash') {
    const mpd = parseMPD(await fetchText(source.url, { headers, signal }), source.url);
    const v = mpd.videos.find((r) => r.id === sel.videoId);
    if (!v) throw new Error('Không tìm thấy chất lượng đã chọn trong manifest');
    const a = sel.audioId ? mpd.audios.find((r) => r.id === sel.audioId) : null;
    const tracks = [];
    for (const [rep, role] of [[v, a ? 'video' : 'main'], [a, 'audio']]) {
      if (!rep) continue;
      if (rep.drm) throw new Error('Luồng có DRM, không thể tải');
      tracks.push({ role, kind: rep.kind, ...(await resolveDashRep(rep, headers, signal)) });
    }
    return { tracks, duration: mpd.duration };
  }
  throw new Error('Loại nguồn không hỗ trợ');
}

async function resolveDashRep(rep, headers, signal) {
  if (!rep.sidx) return { init: rep.init, segments: rep.segments };
  const { url, indexRange, initRange } = rep.sidx;
  const start = initRange ? Math.min(initRange.start, indexRange.start) : 0;
  const head = await fetchBytes(url, { headers, range: { start, end: indexRange.end }, signal });
  const refs = parseSidx(head.subarray(indexRange.start - start), indexRange.start);
  if (!refs || !refs.length) return { init: null, segments: [{ url, range: null }] };
  return {
    init: { url, range: initRange || { start: 0, end: indexRange.start - 1 } },
    segments: refs.map((r) => ({ url, range: { start: r.start, end: r.end } })),
  };
}
