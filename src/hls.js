// Phân tích playlist HLS (.m3u8): master playlist và media playlist.
import { resolveUrl } from './util.js';

export function parseAttrs(str) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) {
    let v = m[2];
    if (v.startsWith('"')) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function parseByteRange(str, prevEnd) {
  // "n[@o]" -> {start, end} (end bao gồm)
  const [len, off] = str.split('@');
  const start = off != null ? Number(off) : prevEnd;
  return { start, end: start + Number(len) - 1 };
}

function isDrmKey(attrs) {
  const method = (attrs.METHOD || 'NONE').toUpperCase();
  if (method === 'NONE') return false;
  const fmt = (attrs.KEYFORMAT || 'identity').toLowerCase();
  return method !== 'AES-128' || fmt !== 'identity';
}

function seqIv(seq) {
  const iv = new Uint8Array(16);
  let n = BigInt(seq);
  for (let i = 15; i >= 0 && n > 0n; i--) {
    iv[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return iv;
}

function hexIv(hex) {
  hex = hex.replace(/^0x/i, '').padStart(32, '0');
  const iv = new Uint8Array(16);
  for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
  return iv;
}

export function parseM3U8(text, baseUrl) {
  if (!text.replace(/^﻿/, '').trimStart().startsWith('#EXTM3U')) {
    throw new Error('Không phải playlist HLS hợp lệ');
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return text.includes('#EXT-X-STREAM-INF') ? parseMaster(lines, baseUrl) : parseMedia(lines, baseUrl);
}

function parseMaster(lines, baseUrl) {
  const variants = [];
  const audioGroups = {};
  let drm = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttrs(line.slice(18));
      let uri = '';
      while (++i < lines.length) {
        if (!lines[i].startsWith('#')) {
          uri = lines[i];
          break;
        }
      }
      if (!uri) continue;
      const [w, h] = (a.RESOLUTION || '').split('x').map(Number);
      variants.push({
        url: resolveUrl(baseUrl, uri),
        bandwidth: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH) || 0,
        peakBandwidth: Number(a.BANDWIDTH) || 0,
        width: w || 0,
        height: h || 0,
        codecs: a.CODECS || '',
        frameRate: Number(a['FRAME-RATE']) || 0,
        audioGroup: a.AUDIO || '',
      });
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(line.slice(13));
      if ((a.TYPE || '').toUpperCase() !== 'AUDIO') continue;
      const g = (audioGroups[a['GROUP-ID']] ||= []);
      g.push({
        name: a.NAME || '',
        lang: a.LANGUAGE || '',
        isDefault: (a.DEFAULT || '').toUpperCase() === 'YES',
        url: a.URI ? resolveUrl(baseUrl, a.URI) : null,
      });
    } else if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      if (isDrmKey(parseAttrs(line.slice(19)))) drm = true;
    }
  }
  // Bỏ các biến thể chỉ có audio
  const videoVariants = variants.filter((v) => {
    if (v.height) return true;
    const c = v.codecs.toLowerCase();
    return !c || /avc|hvc|hev|av01|vp0?9|dvh|dvav/.test(c);
  });
  return { type: 'master', variants: videoVariants.length ? videoVariants : variants, audioGroups, drm };
}

/** Chọn bản audio tốt nhất của một nhóm; trả về null nếu audio đã nằm sẵn trong video. */
export function pickAudio(master, variant) {
  const group = master.audioGroups[variant.audioGroup];
  if (!group || !group.length) return null;
  if (group.some((r) => !r.url)) return null; // có bản audio "muxed" trong luồng video
  return group.find((r) => r.isDefault) || group[0];
}

function parseMedia(lines, baseUrl) {
  const segments = [];
  let mediaSeq = 0;
  let duration = 0;
  let endList = false;
  let drm = false;
  let key = null;
  let map = null;
  let segDur = 0;
  let byteRange = null;
  let lastRangeEnd = 0;
  let lastRangeUrl = '';
  let playlistType = '';

  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      segDur = parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSeq = Number(line.slice(22)) || 0;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      byteRange = line.slice(17);
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(line.slice(11));
      if (isDrmKey(a)) drm = true;
      const method = (a.METHOD || 'NONE').toUpperCase();
      key =
        method === 'AES-128' && a.URI
          ? { method, url: resolveUrl(baseUrl, a.URI), iv: a.IV ? hexIv(a.IV) : null }
          : null;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice(11));
      const url = resolveUrl(baseUrl, a.URI);
      map = { url, range: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      endList = true;
    } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      playlistType = line.slice(21).toUpperCase();
    } else if (!line.startsWith('#')) {
      const url = resolveUrl(baseUrl, line);
      let range = null;
      if (byteRange) {
        range = parseByteRange(byteRange, url === lastRangeUrl ? lastRangeEnd + 1 : 0);
        lastRangeEnd = range.end;
        lastRangeUrl = url;
      }
      const seq = mediaSeq + segments.length;
      segments.push({
        url,
        range,
        duration: segDur,
        key: key ? { ...key, iv: key.iv || seqIv(seq) } : null,
        map,
      });
      duration += segDur;
      segDur = 0;
      byteRange = null;
    }
  }

  const first = segments[0];
  let kind = 'ts';
  if (first && first.map) kind = 'fmp4';
  else if (first && /\.(aac|adts)(\?|$)/i.test(first.url)) kind = 'aac';
  else if (first && /\.(mp3)(\?|$)/i.test(first.url)) kind = 'mp3';

  return {
    type: 'media',
    segments,
    duration,
    live: !endList && playlistType !== 'VOD',
    drm,
    kind,
    init: first && first.map ? first.map : null,
  };
}
