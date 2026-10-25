import { magneticButton, downloadButton, stretchySwitch, radioCards, dayNightSwitch, createToaster, orbitSpinner, queueBar, statusPill } from './lucian/elements.js';

const $ = (s, el = document) => el.querySelector(s);
const form = $('#form');
const input = $('#url');
const field = $('#field');
const box = $('#analysis');
const jobsEl = $('#jobs');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const toaster = createToaster();

let currentAnalysis = null;
let pollTimer = null;
const autoSave = new Set(); // lượt tải người dùng bấm trong phiên này -> tự lưu khi xong
const saved = new Set();
const lastStatus = new Map();
const jobButtons = new Map(); // jobId -> nút tải #004 đang theo dõi lượt tải đó

// ---------- tiện ích ----------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', 'i');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '#i-' + name);
  s.append(u);
  return s;
}
function fmtBytes(n) {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
  return n.toFixed(i >= 2 ? 1 : 0) + ' ' + u[i];
}
function fmtDuration(sec) {
  if (!sec || !isFinite(sec)) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
function fmtEta(sec) {
  if (!sec || !isFinite(sec)) return '';
  if (sec < 60) return Math.ceil(sec) + ' giây';
  if (sec < 3600) return Math.ceil(sec / 60) + ' phút';
  return (sec / 3600).toFixed(1) + ' giờ';
}
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.login) {
    location.href = '/login.html';
    throw new Error('Cần đăng nhập');
  }
  if (!res.ok) throw new Error(data.error || 'Lỗi ' + res.status);
  return data;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toast = (kind, title, sub, action) => toaster.push(kind, title, sub, action);

function confetti(fromEl) {
  if (reduceMotion || !fromEl) return;
  const r = fromEl.getBoundingClientRect();
  const colors = ['#7B61FF', '#3D8BFF', '#1FB89A', '#FFB547', '#FF6B8B'];
  for (let i = 0; i < 36; i++) {
    const c = el('i', 'confetti');
    const a = Math.random() * Math.PI * 2;
    const v = 80 + Math.random() * 160;
    Object.assign(c.style, { left: r.left + r.width / 2 + 'px', top: r.top + r.height / 2 + 'px', background: colors[i % colors.length], animationDelay: Math.random() * 0.08 + 's' });
    c.style.setProperty('--dx', Math.cos(a) * v + 'px');
    c.style.setProperty('--dy', Math.sin(a) * v - 60 + 'px');
    c.style.setProperty('--rot', (Math.random() * 720 - 360).toFixed(0) + 'deg');
    document.body.append(c);
    setTimeout(() => c.remove(), 1300);
  }
}

// ---------- giao diện sáng / tối (#021) ----------
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};
$('#themeSlot').append(
  dayNightSwitch({
    night: isDark(),
    onChange(night) {
      document.documentElement.dataset.theme = night ? 'dark' : 'light';
      try {
        localStorage.setItem('theme', document.documentElement.dataset.theme);
      } catch {}
    },
  }).root
);

// ---------- nút Phân tích (#002) ----------
const go = magneticButton({ label: 'Phân tích link', done: 'Đang tìm video…' });
$('#goSlot').append(go.root);

// ---------- nhận diện trang ----------
const PLATFORMS = [
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'YouTube', '#ff3b3b'],
  [/(^|\.)tiktok\.com$/, 'TikTok', '#14b8c4'],
  [/(^|\.)(facebook\.com|fb\.watch)$/, 'Facebook', '#3b82f6'],
  [/(^|\.)instagram\.com$/, 'Instagram', '#e1306c'],
  [/(^|\.)(twitter\.com|x\.com)$/, 'X', '#71717a'],
  [/(^|\.)vimeo\.com$/, 'Vimeo', '#1ab7ea'],
  [/(^|\.)dailymotion\.com$/, 'Dailymotion', '#2b7cff'],
  [/(^|\.)(bilibili\.com|bilibili\.tv)$/, 'Bilibili', '#00a1d6'],
  [/(^|\.)twitch\.tv$/, 'Twitch', '#9146ff'],
  [/(^|\.)reddit\.com$/, 'Reddit', '#ff4500'],
];
function detectPlatform(text) {
  let u;
  try {
    u = new URL(text.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (/\.(m3u8|mpd|mp4|webm|mkv|mov)(\?|$)/i.test(u.pathname)) return ['Link trực tiếp', '#119C72'];
  const p = PLATFORMS.find(([re]) => re.test(u.hostname));
  return p ? [p[1], p[2]] : [u.hostname.replace(/^www\./, ''), '#6A57F2'];
}
function updatePlatform() {
  const p = detectPlatform(input.value);
  const badge = $('#platform');
  $('#clearBtn').hidden = !input.value;
  if (!p) return (badge.hidden = true);
  if (badge.textContent !== p[0] || badge.hidden) {
    badge.textContent = p[0];
    badge.style.setProperty('--pc', p[1]);
    badge.hidden = false;
    badge.style.animation = 'none';
    void badge.offsetWidth;
    badge.style.animation = '';
  }
}
input.addEventListener('input', updatePlatform);
$('#clearBtn').onclick = () => {
  input.value = '';
  updatePlatform();
  input.focus();
};

// ---------- dán / kéo thả / phím tắt ----------
$('#pasteBtn').onclick = async () => {
  try {
    const t = (await navigator.clipboard.readText()).trim();
    if (t) {
      input.value = t;
      updatePlatform();
      form.requestSubmit();
    }
  } catch {
    input.focus();
    toast('info', 'Trình duyệt chặn đọc clipboard', 'Hãy bấm Ctrl + V vào ô link');
  }
};
input.addEventListener('paste', () =>
  setTimeout(() => {
    updatePlatform();
    if (/^https?:\/\//.test(input.value.trim())) form.requestSubmit();
  }, 0)
);
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== input && !e.ctrlKey && !e.metaKey && !/input|textarea/i.test(document.activeElement?.tagName)) {
    e.preventDefault();
    input.focus();
    input.select();
  }
});
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer.types].some((t) => t === 'text/uri-list' || t === 'text/plain')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) (dragDepth = 0), document.body.classList.remove('dragging');
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const t = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').split('\n')[0].trim();
  if (/^https?:\/\//.test(t)) {
    input.value = t;
    updatePlatform();
    form.requestSubmit();
  }
});

// ---------- phân tích (#080) ----------
const STEP_TITLES = [
  [/yt-dlp/i, 'Đang hỏi thông tin video'],
  [/khởi động/i, 'Đang mở trình duyệt ẩn'],
  [/mở trang/i, 'Đang mở trang'],
  [/bấm phát/i, 'Đang tìm và bấm phát video'],
  [/bắt được/i, 'Đã bắt được luồng video'],
  [/phân tích/i, 'Đang đọc các mức chất lượng'],
  [/đọc link/i, 'Đang đọc link trực tiếp'],
];
const stepTitle = (t) => (STEP_TITLES.find(([re]) => re.test(t || '')) || [0, 'Đang chuẩn bị'])[1];

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = input.value.trim();
  if (!detectPlatform(url)) {
    field.classList.remove('shake');
    void field.offsetWidth;
    field.classList.add('shake');
    toast('err', 'Link chưa hợp lệ', 'Cần bắt đầu bằng http:// hoặc https://');
    return;
  }
  if (currentAnalysis && currentAnalysis.status === 'running') api('/api/analyze/' + currentAnalysis.id, { method: 'DELETE' }).catch(() => {});
  go.play();
  go.btn.disabled = true;
  field.classList.add('busy');

  let myId = null;
  const spin = orbitSpinner({
    title: 'Đang chuẩn bị',
    sub: '0 giây',
    cancelLabel: 'Huỷ',
    onCancel: () => {
      if (myId) api('/api/analyze/' + myId, { method: 'DELETE' }).catch(() => {});
      currentAnalysis = null;
      spin.update('Đã huỷ', 'Dán link khác để thử lại');
      go.btn.disabled = false;
      field.classList.remove('busy');
    },
  });
  box.hidden = false;
  box.textContent = '';
  box.classList.add('bare');
  box.append(spin.root);
  const t0 = performance.now();
  const tick = setInterval(() => spin.update(null, ((performance.now() - t0) / 1000).toFixed(1) + ' giây'), 100);

  try {
    let a = await api('/api/analyze', { method: 'POST', body: { url, mode: 'auto' } });
    myId = a.id;
    currentAnalysis = a;
    while (a.status === 'running') {
      spin.update(stepTitle(a.statusText));
      await sleep(600);
      if (currentAnalysis?.id !== myId) return; // đã huỷ hoặc có lượt mới
      a = await api('/api/analyze/' + a.id);
      currentAnalysis = a;
    }
    clearInterval(tick);
    if (a.status === 'error') throw new Error(a.error);
    const n = a.result.sources.length;
    spin.done(a.result.best ? 'Đã tìm thấy video' : 'Xong', n ? `${n} nguồn · ${((performance.now() - t0) / 1000).toFixed(1)} giây` : '');
    await sleep(reduceMotion ? 0 : 900);
    renderResult(a);
  } catch (err) {
    if (currentAnalysis?.id !== myId && myId) return;
    showError(err.message);
  } finally {
    clearInterval(tick);
    go.btn.disabled = false;
    field.classList.remove('busy');
  }
});

function showError(msg) {
  box.hidden = false;
  box.classList.remove('bare');
  box.textContent = '';
  const c = el('div', 'err-card');
  const ic = el('div', 'ic');
  ic.append(icon('alert'));
  const body = el('div');
  body.append(el('b', '', 'Không lấy được video'));
  body.append(el('div', 'muted small', 'Hãy mở link trong trình duyệt xem video có phát được không, và dán đúng link của trang xem video (không phải trang danh sách).'));
  body.append(el('pre', '', msg));
  c.append(ic, body);
  box.append(c);
}

// ---------- kết quả ----------
const KIND_LABEL = { hls: 'HLS', dash: 'DASH', file: 'FILE', ytdlp: 'yt-dlp' };
const VIA_LABEL = { sniff: 'Quét trang', ytdlp: 'yt-dlp', direct: 'Link trực tiếp' };
const CODEC_GRAD = {
  AV1: 'linear-gradient(140deg,#8B6CFF,#5B8CFF)',
  VP9: 'linear-gradient(140deg,#22C3A6,#0EA5E9)',
  'H.265': 'linear-gradient(140deg,#FF8A5B,#FF5B8A)',
  'H.264': 'linear-gradient(140deg,#B5B2BD,#8E8A97)',
};

function optionText(o) {
  const parts = [o.label];
  if (o.note) parts.push(o.note);
  if (o.sizeEstimate) parts.push('~' + fmtBytes(o.sizeEstimate));
  if (o.disabled) parts.push('(' + o.reason + ')');
  return parts.join(' — ');
}
function placeholder() {
  const p = el('div', 'thumb-ph');
  p.append(icon('film'));
  return p;
}

function renderResult(a) {
  const r = a.result;
  box.hidden = false;
  box.classList.remove('bare');
  box.textContent = '';

  const bestSrc = r.best && r.sources.find((s) => s.id === r.best.sourceId);
  const bestOpt = bestSrc && bestSrc.options.find((o) => o.id === r.best.optionId);

  const grid = el('div', 'result');
  const tw = el('div', 'thumb-wrap');
  if (r.thumbnail) {
    const img = el('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.src = r.thumbnail;
    const play = el('span', 'play');
    play.append(icon('play'));
    img.onerror = () => (img.replaceWith(placeholder()), play.remove());
    tw.append(img, play);
  } else tw.append(placeholder());
  if (r.duration) tw.append(el('span', 'dur', fmtDuration(r.duration)));
  grid.append(tw);

  const info = el('div', 'r-info');
  info.append(el('h3', 'r-title', r.title || 'Video'));
  const chips = el('div', 'chips');
  if (bestOpt) chips.append(el('span', 'chip hot', '★ ' + bestOpt.label));
  if (bestOpt?.codec) chips.append(el('span', 'chip', bestOpt.codec));
  chips.append(el('span', 'chip', VIA_LABEL[r.via] + (r.browser ? ' · ' + r.browser : '')));
  info.append(chips);
  grid.append(info);
  box.append(grid);

  if (!bestOpt) {
    const reasons = r.sources.map((s) => s.error || (s.drm ? 'Nội dung có DRM' : s.live ? 'Livestream' : '')).filter(Boolean);
    const msg = r.sources.length ? 'Có luồng video nhưng không tải được. ' + [...new Set(reasons)].join('; ') : 'Không bắt được luồng video nào trên trang này.';
    info.append(el('div', 'note', msg + (r.errors?.length ? '\n' + r.errors.join('\n') : '')));
    return;
  }

  // Lựa chọn hiện tại
  let sel = { sourceId: bestSrc.id, optionId: bestOpt.id, transcode: false };
  const optOf = (s) => r.sources.find((x) => x.id === s.sourceId).options.find((x) => x.id === s.optionId);
  let compat = null;

  // Chọn chất lượng (#015)
  const lr = el('div', 'label-row');
  lr.append(el('span', '', 'Chất lượng'));
  info.append(lr);
  const cards = radioCards({
    items: bestSrc.options.map((o) => ({
      id: o.id,
      title: o.label,
      badge: o.id === bestOpt.id ? 'Nét nhất' : o.codec === 'H.264' && o.id === r.bestCompat?.optionId ? 'Mọi máy' : '',
      sub: o.disabled ? o.reason : [o.codec, (o.note || '').split(' · ').filter((x) => x !== o.codec).join(' · ')].filter(Boolean).join(' · ') || 'Bản gốc',
      icon: (o.codec || 'MP4').replace('H.', 'H'),
      grad: CODEC_GRAD[o.codec] || 'linear-gradient(140deg,#7B61FF,#3D8BFF)',
      right: o.sizeEstimate ? '~' + fmtBytes(o.sizeEstimate) : '',
      rightSub: o.sizeEstimate ? 'ước tính' : '',
      disabled: !!o.disabled,
    })),
    selected: bestOpt.id,
    summary: (it) => [`Đã chọn ${it.title}`, it.right || ''],
    onSelect(it) {
      sel = { sourceId: bestSrc.id, optionId: it.id, transcode: false };
      if (compat) compat.set(false);
      paint();
    },
  });
  info.append(cards.root);
  cards.init();

  // Công tắc H.264 (#013)
  const c = r.bestCompat;
  if (c) {
    const cSrc = r.sources.find((s) => s.id === c.sourceId);
    const cOpt = cSrc.options.find((o) => o.id === c.optionId);
    compat = stretchySwitch({
      title: 'Tương thích mọi máy (H.264)',
      offText: `Bản nét nhất dùng ${bestOpt.codec} — TV/máy cũ có thể không phát được`,
      onText: c.transcode ? `Chuyển sang H.264, giữ ${cOpt.label} (lâu hơn)` : `Tải ${cOpt.label} H.264 có sẵn`,
      onChange(on) {
        if (on) {
          sel = { sourceId: cSrc.id, optionId: cOpt.id, transcode: c.transcode };
          if (cSrc.id === bestSrc.id && !c.transcode) cards.select(cOpt.id);
          else cards.clear();
        } else {
          sel = { sourceId: bestSrc.id, optionId: bestOpt.id, transcode: false };
          cards.select(bestOpt.id);
        }
        paint();
      },
    });
    info.append(compat.root);
  }

  // Nút tải (#004)
  let activeJob = null;
  const dl = downloadButton({
    fileName: r.title || 'video',
    ext: 'mp4',
    sizeText: '',
    label: 'Tải xuống',
    async onStart(btn) {
      try {
        const job = await api('/api/download', { method: 'POST', body: { analysisId: a.id, sourceId: sel.sourceId, optionId: sel.optionId, transcode: sel.transcode } });
        activeJob = job.id;
        autoSave.add(job.id);
        jobButtons.set(job.id, btn);
        toast('wait', `Bắt đầu tải ${job.quality}`, r.title || '');
        refreshJobs();
      } catch (e) {
        btn.reset();
        toast('err', 'Không bắt đầu tải được', e.message);
      }
    },
    onCancel() {
      if (activeJob) {
        api(`/api/jobs/${activeJob}/cancel`, { method: 'POST' }).then(refreshJobs).catch(() => {});
        jobButtons.delete(activeJob);
        activeJob = null;
      }
    },
  });
  const row = el('div', 'cta-row');
  row.append(dl.root);
  info.append(row);

  function paint() {
    const o = optOf(sel);
    const label = `Tải ${o.label}${compat?.get() ? ' H.264' : ''}`;
    dl.setInfo({ fileName: r.title || 'video', sizeText: o.sizeEstimate ? '~' + fmtBytes(o.sizeEstimate) : '', label });
    dl.setExt(r.via === 'ytdlp' || bestSrc.kind !== 'file' ? 'mp4' : 'mp4');
  }
  paint();

  // Các nguồn khác
  const others = r.sources.filter((s) => s.id !== bestSrc.id);
  if (others.length) {
    const d = el('details', 'more-src');
    const sum = el('summary');
    sum.append(icon('chev'), el('span', '', `Nguồn khác trên trang (${others.length})`));
    d.append(sum);
    const list = el('div', 'src-list');
    others.forEach((s, i) => {
      const n = renderSource(a.id, s);
      n.style.animationDelay = i * 40 + 'ms';
      list.append(n);
    });
    d.append(list);
    box.append(d);
  }
}

function renderSource(analysisId, s) {
  const node = el('div', 'src');
  node.append(el('span', 'badge ' + s.kind, KIND_LABEL[s.kind] || s.kind));
  const name = el('span', 'src-name', s.name);
  name.title = s.url;
  node.append(name);
  const meta = [];
  if (s.duration) meta.push(fmtDuration(s.duration));
  if (s.size) meta.push(fmtBytes(s.size));
  if (s.playing) meta.push('đang phát');
  node.append(el('span', 'src-meta', meta.join(' · ')));
  if (s.error) {
    node.append(el('div', 'note err', 'Không đọc được: ' + s.error));
    return node;
  }
  const row = el('div', 'src-row');
  const select = el('select');
  for (const o of s.options) {
    const opt = new Option(optionText(o), o.id);
    opt.disabled = !!o.disabled;
    select.append(opt);
  }
  const firstOk = s.options.find((o) => !o.disabled);
  const btn = el('button', 'btn');
  btn.type = 'button';
  btn.append(icon('save'), el('span', 'label', 'Tải'));
  if (firstOk) select.value = firstOk.id;
  else btn.disabled = true;
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const job = await api('/api/download', { method: 'POST', body: { analysisId, sourceId: s.id, optionId: select.value } });
      autoSave.add(job.id);
      toast('wait', `Bắt đầu tải ${job.quality}`);
      refreshJobs();
    } catch (e) {
      btn.disabled = false;
      toast('err', 'Không bắt đầu tải được', e.message);
    }
  };
  row.append(select, btn);
  node.append(row);
  if (!firstOk) node.append(el('div', 'note', s.drm ? 'Nội dung có DRM — không thể tải.' : s.live ? 'Livestream — chưa hỗ trợ.' : 'Không có chất lượng nào tải được.'));
  return node;
}

// ---------- danh sách tải (#083) ----------
async function refreshJobs() {
  clearTimeout(pollTimer);
  let list = [];
  try {
    list = await api('/api/jobs');
    renderJobs(list);
  } catch {}
  const active = list.some((j) => j.status === 'running' || j.status === 'queued');
  pollTimer = setTimeout(refreshJobs, active ? 1000 : 5000);
}

function renderJobs(list) {
  $('#noJobs').hidden = list.length > 0;
  $('#jobCount').textContent = list.length;
  const ids = new Set(list.map((j) => j.id));
  [...jobsEl.children].forEach((n) => !ids.has(n.dataset.id) && n.remove());
  list.forEach((j, i) => {
    let node = jobsEl.querySelector(`[data-id="${j.id}"]`);
    if (!node) {
      node = $('#tplJob').content.firstElementChild.cloneNode(true);
      node.dataset.id = j.id;
      $('.job-title', node).textContent = `${j.title} [${j.quality}]`;
      $('.job-title', node).title = j.pageUrl || '';
      if (j.thumbnail) $('.thumb', node).style.backgroundImage = `url("${j.thumbnail.replace(/"/g, '%22')}")`;
      node._qb = queueBar();
      $('.qb', node).append(node._qb.root);
      node._pill = statusPill('', 'var(--ux-warn)');
      $('.job-head', node).append(node._pill);
      $('.cancel', node).onclick = () => api(`/api/jobs/${j.id}/cancel`, { method: 'POST' }).then(refreshJobs);
      $('.remove', node).onclick = () => {
        node.classList.add('leaving');
        setTimeout(() => api(`/api/jobs/${j.id}`, { method: 'DELETE' }).then(refreshJobs), 300);
      };
      $('.save', node).href = `/api/jobs/${j.id}/file`;
    }
    if (jobsEl.children[i] !== node) jobsEl.insertBefore(node, jobsEl.children[i] || null);
    updateJob(node, j);
  });
}

function jobText(j, node) {
  if (j.status === 'running' && j.encoding) {
    let sp = j.encodeSpeed ? j.encodeSpeed.toFixed(1) + '× thời gian thực' : '';
    if (j.progress > 0.01) sp += (sp ? ' · ' : '') + 'còn ' + fmtEta(((1 - j.progress) / j.progress) * ((Date.now() - (node._encStart ||= Date.now())) / 1000));
    return [j.statusText, sp];
  }
  if (j.status === 'running') {
    const parts = [fmtBytes(j.bytes) + (j.totalBytes ? ' / ' + fmtBytes(j.totalBytes) : '')];
    if (j.speed) parts.push(fmtBytes(j.speed) + '/s');
    if (j.speed && j.totalBytes > j.bytes) parts.push('còn ' + fmtEta((j.totalBytes - j.bytes) / j.speed));
    else if (j.speed && j.totalUnits && j.progress > 0.02) parts.push('còn ' + fmtEta((j.bytes / j.progress - j.bytes) / j.speed));
    return [j.statusText, parts.join(' · ')];
  }
  if (j.status === 'queued') return ['Đang chờ tới lượt', ''];
  if (j.status === 'done') return ['Đã xong', fmtBytes(j.size) + ' · .' + j.ext];
  if (j.status === 'error') return [j.error, ''];
  return ['Đã huỷ', ''];
}

function updateJob(node, j) {
  node.className = 'job ' + j.status + (node.classList.contains('leaving') ? ' leaving' : '');
  const [left, right] = jobText(j, node);
  const pct = j.status === 'running' && j.progress ? ' ' + Math.floor(j.progress * 100) + '%' : '';
  node._qb.set(j.status === 'done' ? 'done' : j.status === 'running' ? 'run' : j.status === 'queued' ? 'queued' : 'fail', j.progress, left, right);
  const PILL = {
    queued: ['Đang chờ', 'var(--ux-warn)'],
    running: [j.encoding ? 'Chuyển mã' : 'Đang tải', 'var(--ux-accent)'],
    done: ['Hoàn tất', 'var(--ux-mint)'],
    error: ['Lỗi', 'var(--ux-danger)'],
    canceled: ['Đã huỷ', 'var(--ux-ink-3)'],
  }[j.status];
  node._pill.textContent = PILL[0] + pct;
  node._pill.style.setProperty('--c', PILL[1]);
  const warn = $('.job-warn', node);
  warn.hidden = !j.warning;
  warn.textContent = j.warning || '';
  const active = j.status === 'running' || j.status === 'queued';
  $('.save', node).hidden = j.status !== 'done';
  $('.cancel', node).hidden = !active;
  $('.remove', node).hidden = active;

  // Nút tải lớn (#004) chạy theo lượt tải này
  const btn = jobButtons.get(j.id);
  if (btn) {
    if (j.status === 'running' || j.status === 'queued') {
      // Chữ trong nút ngắn gọn: tốc độ + thời gian còn lại
      const short = right.split(' · ').filter((x) => /\/s$|^còn |thời gian thực/.test(x)).join(' · ');
      btn.progress(j.progress || 0, j.status === 'queued' ? 'Đang chờ…' : short || (j.encoding ? 'Đang chuyển mã…' : 'Đang tải…'));
    }
    else if (j.status === 'done') btn.finish(), jobButtons.delete(j.id);
    else btn.reset(), jobButtons.delete(j.id);
  }

  // Thông báo khi trạng thái đổi (#070)
  const prev = lastStatus.get(j.id);
  lastStatus.set(j.id, j.status);
  if (prev && prev !== j.status) {
    if (j.status === 'done') toast('ok', 'Tải xong ' + j.quality, j.title, { label: 'Lưu', href: `/api/jobs/${j.id}/file` });
    else if (j.status === 'error') toast('err', 'Tải lỗi', j.error);
  }
  // Tự lưu file về máy khi tải xong
  if (j.status === 'done' && autoSave.has(j.id) && !saved.has(j.id)) {
    saved.add(j.id);
    confetti(node);
    $('.save', node).click();
  }
}

// ---------- trạng thái server ----------
api('/api/status')
  .then((s) => {
    const foot = $('#foot');
    const pill = (text, on) => foot.append(el('span', 'pill ' + (on ? 'on' : 'off'), text));
    pill(s.browser ? 'Trình duyệt ẩn: ' + s.browser : 'Đang mở trình duyệt ẩn', !!s.browser);
    pill(s.ytdlp ? 'yt-dlp ' + s.ytdlpVersion : 'Chưa có yt-dlp', s.ytdlp);
    pill(s.ffmpeg ? 'ffmpeg' : 'Chưa có ffmpeg', s.ffmpeg);
    $('#logoutBtn').hidden = !s.auth;
  })
  .catch(() => {});

refreshJobs();
if (matchMedia('(pointer: fine)').matches) input.focus();
