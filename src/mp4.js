// Xử lý ISO-BMFF (MP4 phân mảnh): đọc box, đọc sidx, ghép track video + audio thành một file MP4.

export function readBoxes(u8, start = 0, end = u8.length) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    let hdr = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = Number(dv.getBigUint64(p + 8));
      hdr = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < hdr || p + size > end) break;
    out.push({ type, start: p, end: p + size, hdr });
    p += size;
  }
  return out;
}

const find = (u8, box, type, extra = 0) => readBoxes(u8, box.start + box.hdr + extra, box.end).find((b) => b.type === type);
const findPath = (u8, box, ...types) => {
  let cur = box;
  for (const t of types) {
    cur = cur && find(u8, cur, t);
  }
  return cur || null;
};

function dvOf(u8) {
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}

function makeBox(type, parts) {
  const len = 8 + parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  dvOf(out).setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let o = 8;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Đọc sidx -> danh sách byte range của từng subsegment (moof+mdat) */
export function parseSidx(u8, fileOffset) {
  const sidx = readBoxes(u8).find((b) => b.type === 'sidx');
  if (!sidx) return null;
  const dv = dvOf(u8);
  let p = sidx.start + sidx.hdr;
  const version = u8[p];
  p += 4 + 4; // version/flags + reference_ID
  const timescale = dv.getUint32(p);
  p += 4;
  let firstOffset;
  if (version === 0) {
    firstOffset = dv.getUint32(p + 4);
    p += 8;
  } else {
    firstOffset = Number(dv.getBigUint64(p + 8));
    p += 16;
  }
  p += 2; // reserved
  const count = dv.getUint16(p);
  p += 2;
  let offset = fileOffset + sidx.end + firstOffset;
  const refs = [];
  for (let i = 0; i < count; i++) {
    const size = dv.getUint32(p) & 0x7fffffff;
    const dur = dv.getUint32(p + 4);
    refs.push({ start: offset, end: offset + size - 1, duration: dur / timescale });
    offset += size;
    p += 12;
  }
  return refs;
}

function patchTrackIdInTrak(trak, newId) {
  const tkhd = find(trak, { start: 0, end: trak.length, hdr: 8 }, 'tkhd');
  if (!tkhd) return;
  const v = trak[tkhd.start + tkhd.hdr];
  dvOf(trak).setUint32(tkhd.start + tkhd.hdr + (v === 1 ? 20 : 12), newId);
}

function mdhdTimescale(moov) {
  const root = { start: 0, end: moov.length, hdr: 8 };
  const mdhd = findPath(moov, root, 'trak', 'mdia', 'mdhd');
  if (!mdhd) return 0;
  const p = mdhd.start + mdhd.hdr;
  return dvOf(moov).getUint32(p + (moov[p] === 1 ? 20 : 12));
}

/**
 * Gom các fragment (moof+mdat) của MỘT track. Mỗi chunk đưa vào phải bắt đầu/kết thúc đúng ranh giới box
 * (init segment, media segment, hoặc cả file).
 */
export class FragmentCollector {
  constructor(newTrackId) {
    this.trackId = newTrackId;
    this.ftyp = null;
    this.moov = null;
    this.timescale = 0;
    this.fragments = []; // {time, blob, size}
    this.size = 0;
  }

  add(u8) {
    const boxes = readBoxes(u8);
    let moofStart = -1;
    for (const b of boxes) {
      if (b.type === 'ftyp' && !this.ftyp) this.ftyp = u8.slice(b.start, b.end);
      else if (b.type === 'moov' && !this.moov) {
        this.moov = u8.slice(b.start, b.end);
        this.timescale = mdhdTimescale(this.moov) || 1;
      } else if (b.type === 'moof') moofStart = b.start;
      else if (b.type === 'mdat' && moofStart >= 0) {
        this._push(u8.slice(moofStart, b.end));
        moofStart = -1;
      }
    }
  }

  _push(frag) {
    const root = { start: 0, end: frag.length, hdr: 0 };
    const moof = find(frag, root, 'moof');
    let time = null;
    for (const traf of readBoxes(frag, moof.start + moof.hdr, moof.end).filter((b) => b.type === 'traf')) {
      const tfhd = find(frag, traf, 'tfhd');
      if (tfhd) dvOf(frag).setUint32(tfhd.start + tfhd.hdr + 4, this.trackId);
      const tfdt = find(frag, traf, 'tfdt');
      if (tfdt && time == null) {
        const p = tfdt.start + tfdt.hdr;
        time = frag[p] === 1 ? Number(dvOf(frag).getBigUint64(p + 4)) : dvOf(frag).getUint32(p + 4);
      }
    }
    const seconds = time != null ? time / (this.timescale || 1) : this.fragments.length * 1e-3;
    this.fragments.push({ time: seconds, blob: new Blob([frag]) });
    this.size += frag.length;
  }
}

/** Ghép track video + audio (đều là fMP4) thành một Blob MP4 */
export function mergeTracks(video, audio) {
  if (!video.moov || !audio.moov) throw new Error('Thiếu init segment (moov) để ghép');
  const vRoot = { start: 0, end: video.moov.length, hdr: 8 };
  const aRoot = { start: 0, end: audio.moov.length, hdr: 8 };
  const vBoxes = readBoxes(video.moov, 8);
  const aBoxes = readBoxes(audio.moov, 8);
  const sl = (u8, b) => u8.slice(b.start, b.end);

  const mvhdBox = vBoxes.find((b) => b.type === 'mvhd');
  const mvhd = sl(video.moov, mvhdBox);
  dvOf(mvhd).setUint32(mvhd.length - 4, 3); // next_track_ID

  const vtrak = sl(video.moov, vBoxes.find((b) => b.type === 'trak'));
  const atrak = sl(audio.moov, aBoxes.find((b) => b.type === 'trak'));
  patchTrackIdInTrak(vtrak, 1);
  patchTrackIdInTrak(atrak, 2);

  const trexOf = (moov, root, id) => {
    const trex = findPath(moov, root, 'mvex', 'trex');
    let out;
    if (trex) out = sl(moov, trex);
    else {
      out = new Uint8Array(32);
      dvOf(out).setUint32(0, 32);
      out.set([0x74, 0x72, 0x65, 0x78], 4); // 'trex'
      dvOf(out).setUint32(16, 1); // default_sample_description_index
    }
    dvOf(out).setUint32(12, id);
    return out;
  };
  const mvexParts = [];
  const mehd = findPath(video.moov, vRoot, 'mvex', 'mehd');
  if (mehd) mvexParts.push(sl(video.moov, mehd));
  mvexParts.push(trexOf(video.moov, vRoot, 1), trexOf(audio.moov, aRoot, 2));

  const moov = makeBox('moov', [mvhd, vtrak, atrak, makeBox('mvex', mvexParts)]);

  // Xen kẽ fragment theo thời gian để phát mượt
  const frags = [...video.fragments, ...audio.fragments].sort((a, b) => a.time - b.time);
  const parts = [];
  if (video.ftyp) parts.push(video.ftyp);
  parts.push(moov, ...frags.map((f) => f.blob));
  return new Blob(parts, { type: 'video/mp4' });
}
