const $ = (s, el = document) => el.querySelector(s);
const form = $('#form');
const input = $('#url');
const field = $('#field');
const goBtn = $('#goBtn');
const box = $('#analysis');
const jobsEl = $('#jobs');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let currentAnalysis = null;
let pollTimer = null;
const autoSave = new Set(); // lượt tải người dùng bấm trong phiên này -> tự lưu khi xong
const saved = new Set();
const lastStatus = new Map();

// ---------- tiện ích ----------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', ('i ' + cls).trim());
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

// ---------- hiệu ứng ----------
// Gợn sóng khi bấm nút
document.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('.btn');
  if (!b || b.disabled || reduceMotion) return;
  const r = b.getBoundingClientRect();
  const d = Math.max(r.width, r.height);
  const s = el('span', 'ripple');
  Object.assign(s.style, { width: d + 'px', height: d + 'px', left: e.clientX - r.left - d / 2 + 'px', top: e.clientY - r.top - d / 2 + 'px' });
  b.append(s);
  setTimeout(() => s.remove(), 650);
});

function toast(text, type = '') {
  const t = el('div', 'toast ' + type);
  t.append(icon(type === 'ok' ? 'check' : type === 'err' ? 'alert' : 'sparkle'), el('span', '', text));
  $('#toasts').append(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 320);
  }, 3600);
}

function confetti(fromEl) {
  if (reduceMotion) return;
  const r = (fromEl || goBtn).getBoundingClientRect();
  const colors = ['#ff4d6d', '#ff8a3d', '#8b5cf6', '#22d3ee', '#34d399', '#fbbf24'];
  for (let i = 0; i < 36; i++) {
    const c = el('i', 'confetti');
    const a = Math.random() * Math.PI * 2;
    const v = 80 + Math.random() * 160;
    Object.assign(c.style, {
      left: r.left + r.width / 2 + 'px',
      top: r.top + r.height / 2 + 'px',
      background: colors[i % colors.length],
      animationDelay: Math.random() * 0.08 + 's',
    });
    c.style.setProperty('--dx', Math.cos(a) * v + 'px');
    c.style.setProperty('--dy', Math.sin(a) * v - 60 + 'px');
    c.style.setProperty('--rot', (Math.random() * 720 - 360).toFixed(0) + 'deg');
    document.body.append(c);
    setTimeout(() => c.remove(), 1300);
  }
}

// ---------- giao diện sáng / tối ----------
$('#themeBtn').onclick = () => {
  const root = document.documentElement;
  const isDark = root.dataset.theme ? root.dataset.theme === 'dark' : !matchMedia('(prefers-color-scheme: light)').matches;
  root.dataset.theme = isDark ? 'light' : 'dark';
  try {
    localStorage.setItem('theme', root.dataset.theme);
  } catch {}
};

// ---------- nhận diện trang ----------
const PLATFORMS = [
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'YouTube', '#ff3b3b'],
  [/(^|\.)tiktok\.com$/, 'TikTok', '#25d0ee'],
  [/(^|\.)(facebook\.com|fb\.watch)$/, 'Facebook', '#3b82f6'],
  [/(^|\.)instagram\.com$/, 'Instagram', '#e1306c'],
  [/(^|\.)(twitter\.com|x\.com)$/, 'X', '#a1a1aa'],
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
  if (/\.(m3u8|mpd|mp4|webm|mkv|mov)(\?|$)/i.test(u.pathname)) return ['Link trực tiếp', '#34d399'];
  const p = PLATFORMS.find(([re]) => re.test(u.hostname));
  return p ? [p[1], p[2]] : [u.hostname.replace(/^www\./, ''), '#a78bfa'];
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
    toast('Trình duyệt chặn đọc clipboard — hãy bấm Ctrl + V vào ô link');
  }
};
input.addEventListener('paste', () =>
  setTimeout(() => {
    updatePlatform();
    if (/^https?:\/\//.test(input.value.trim())) form.requestSubmit();
  }, 0)
);
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== input && !e.ctrlKey && !e.metaKey) {
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

// ---------- phân tích ----------
const STEPS = [
  { label: 'Nhận diện link', re: /bắt đầu|đọc link|yt-dlp|khởi động/i },
  { label: 'Mở trang và bấm phát video', re: /mở trang|bấm phát/i },
  { label: 'Bắt luồng video', re: /bắt được/i },
  { label: 'Phân tích các mức chất lượng', re: /phân tích|không thấy/i },
];

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = input.value.trim();
  if (!detectPlatform(url)) {
    field.classList.remove('shake');
    void field.offsetWidth;
    field.classList.add('shake');
    toast('Link chưa hợp lệ — cần bắt đầu bằng http:// hoặc https://', 'err');
    return;
  }
  if (currentAnalysis && currentAnalysis.status === 'running') api('/api/analyze/' + currentAnalysis.id, { method: 'DELETE' }).catch(() => {});
  goBtn.disabled = true;
  goBtn.classList.add('loading');
  field.classList.add('busy');
  const view = showSteps();
  try {
    let a = await api('/api/analyze', { method: 'POST', body: { url, mode: 'auto' } });
    currentAnalysis = a;
    while (a.status === 'running') {
      view.update(a.statusText);
      await sleep(600);
      a = await api('/api/analyze/' + a.id);
      if (currentAnalysis.id !== a.id) return; // đã có lượt phân tích mới
      currentAnalysis = a;
    }
    view.stop();
    if (a.status === 'error') throw new Error(a.error);
    renderResult(a);
  } catch (err) {
    view.stop();
    showError(err.message);
  } finally {
    goBtn.disabled = false;
    goBtn.classList.remove('loading');
    field.classList.remove('busy');
  }
});

function showSteps() {
  box.hidden = false;
  box.textContent = '';
  const head = el('div', 'steps-head');
  head.append(el('b', '', 'Đang tìm video…'));
  const timer = el('span', 'timer', '0.0s');
  head.append(timer);
  const list = el('div', 'steps');
  const nodes = STEPS.map((s) => {
    const n = el('div', 'step');
    const b = el('span', 'b');
    b.append(icon('check'));
    n.append(b, el('span', '', s.label));
    list.append(n);
    return n;
  });
  const detail = el('div', 'step-detail', 'Đang bắt đầu…');
  const sk = el('div', 'skeleton');
  sk.innerHTML =
    '<div class="sk" style="aspect-ratio:16/9"></div><div class="col"><div class="sk" style="height:22px;width:80%"></div><div class="sk" style="height:16px;width:45%"></div><div class="sk" style="height:56px"></div></div>';
  box.append(head, list, detail, sk);

  let idx = 0;
  const paint = () => nodes.forEach((n, i) => (n.className = 'step' + (i < idx ? ' done' : i === idx ? ' active' : '')));
  paint();
  const t0 = performance.now();
  const tick = setInterval(() => (timer.textContent = ((performance.now() - t0) / 1000).toFixed(1) + 's'), 100);
  return {
    update(text) {
      detail.textContent = text || '';
      STEPS.forEach((s, i) => s.re.test(text || '') && i > idx && (idx = i));
      paint();
    },
    stop() {
      clearInterval(tick);
    },
  };
}

function showError(msg) {
  box.hidden = false;
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
  box.textContent = '';

  const bestSrc = r.best && r.sources.find((s) => s.id === r.best.sourceId);
  const bestOpt = bestSrc && bestSrc.options.find((o) => o.id === r.best.optionId);

  const grid = el('div', 'result');
  // Ảnh bìa
  const tw = el('div', 'thumb-wrap');
  if (r.thumbnail) {
    const img = el('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.src = r.thumbnail;
    img.onerror = () => {
      img.replaceWith(placeholder());
      tw.querySelector('.play')?.remove();
    };
    const play = el('span', 'play');
    play.append(icon('play'));
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

  // Chọn chất lượng
  let sel = { sourceId: bestSrc.id, optionId: bestOpt.id, transcode: false };
  let sw = null;
  const lr = el('div', 'label-row');
  lr.append(el('span', '', 'Chất lượng'));
  info.append(lr);
  const qs = el('div', 'qualities');
  const pills = [];
  bestSrc.options.forEach((o, i) => {
    const q = el('button', 'q');
    q.type = 'button';
    q.disabled = !!o.disabled;
    q.style.animationDelay = i * 35 + 'ms';
    q.append(el('b', '', o.label));
    const sub = [o.codec || (o.note || '').split(' · ')[0], o.sizeEstimate ? '~' + fmtBytes(o.sizeEstimate) : ''].filter(Boolean).join(' · ');
    q.append(el('small', '', o.disabled ? o.reason : sub || 'Gốc'));
    if (o.id === bestOpt.id) q.append(el('span', 'crown', 'NÉT NHẤT'));
    q.title = optionText(o);
    q.onclick = () => {
      sel = { sourceId: bestSrc.id, optionId: o.id, transcode: false };
      if (sw) sw.checked = false;
      paint();
    };
    pills.push([q, o]);
    qs.append(q);
  });
  info.append(qs);

  // Công tắc H.264
  const c = r.bestCompat;
  if (c) {
    const cSrc = r.sources.find((s) => s.id === c.sourceId);
    const cOpt = cSrc.options.find((o) => o.id === c.optionId);
    const lab = el('label', 'switch');
    sw = el('input');
    sw.type = 'checkbox';
    const txt = el('span', 'txt');
    txt.append(el('b', '', 'Tương thích mọi máy (H.264)'));
    txt.append(
      el(
        'small',
        '',
        c.transcode
          ? `Bản nét nhất dùng ${bestOpt.codec}. Bật để chuyển sang H.264, giữ ${cOpt.label} (lâu hơn).`
          : `Bản nét nhất dùng ${bestOpt.codec}, TV/máy cũ có thể không phát được. Bật để tải ${cOpt.label} H.264.`
      )
    );
    lab.append(sw, el('span', 'track'), txt);
    sw.onchange = () => {
      sel = sw.checked ? { sourceId: cSrc.id, optionId: cOpt.id, transcode: c.transcode } : { sourceId: bestSrc.id, optionId: bestOpt.id, transcode: false };
      paint();
    };
    info.append(lab);
  }

  // Nút tải
  const row = el('div', 'cta-row');
  const btn = el('button', 'btn primary big');
  btn.type = 'button';
  row.append(btn);
  info.append(row);
  btn.onclick = () => startDownload(a.id, sel.sourceId, sel.optionId, btn, sel.transcode);

  function paint() {
    pills.forEach(([q, o]) => q.classList.toggle('sel', sel.sourceId === bestSrc.id && o.id === sel.optionId && !sw?.checked));
    const s = r.sources.find((x) => x.id === sel.sourceId);
    const o = s.options.find((x) => x.id === sel.optionId);
    btn.textContent = '';
    btn.append(el('span', 'spin'), icon('download', 'arrow'), el('span', 'label', `Tải ${o.label}${sw?.checked ? ' H.264' : ''}`));
    if (o.sizeEstimate) btn.append(el('span', 'size', '· ~' + fmtBytes(o.sizeEstimate)));
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
  btn.append(el('span', 'spin'), icon('download'), el('span', 'label', 'Tải'));
  if (firstOk) select.value = firstOk.id;
  else btn.disabled = true;
  btn.onclick = () => startDownload(analysisId, s.id, select.value, btn);
  row.append(select, btn);
  node.append(row);
  if (!firstOk) node.append(el('div', 'note', s.drm ? 'Nội dung có DRM — không thể tải.' : s.live ? 'Livestream — chưa hỗ trợ.' : 'Không có chất lượng nào tải được.'));
  return node;
}

async function startDownload(analysisId, sourceId, optionId, btn, transcode = false) {
  btn.disabled = true;
  btn.classList.add('loading');
  try {
    const job = await api('/api/download', { method: 'POST', body: { analysisId, sourceId, optionId, transcode } });
    autoSave.add(job.id);
    btn.classList.remove('loading');
    btn.classList.add('ok');
    btn.textContent = '';
    btn.append(icon('check'), el('span', 'label', 'Đã thêm vào hàng chờ'));
    toast(`Bắt đầu tải ${job.quality}`, 'ok');
    refreshJobs();
    setTimeout(() => $('.downloads').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' }), 250);
  } catch (e) {
    btn.disabled = false;
    btn.classList.remove('loading');
    toast(e.message, 'err');
  }
}

// ---------- danh sách tải ----------
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

function updateJob(node, j) {
  const indet = j.status === 'running' && !j.progress;
  const leaving = node.classList.contains('leaving') ? ' leaving' : '';
  node.className = 'job ' + j.status + (j.encoding ? ' encoding' : '') + (indet ? ' indet' : '') + leaving;
  const p = j.status === 'done' ? 1 : j.progress;
  $('.fg', node).style.strokeDashoffset = (113.1 * (1 - p)).toFixed(1);
  $('.pct', node).textContent = Math.floor(p * 100) + '%';
  $('.bar > i', node).style.width = Math.floor(p * 100) + '%';

  const chip = { queued: 'Đang chờ', running: j.encoding ? 'Chuyển mã' : 'Đang tải', done: 'Hoàn tất', error: 'Lỗi', canceled: 'Đã huỷ' }[j.status];
  let st = '';
  let sp = '';
  if (j.status === 'running' && j.encoding) {
    st = j.statusText;
    if (j.encodeSpeed) {
      sp = j.encodeSpeed.toFixed(1) + '× thời gian thực';
      if (j.progress > 0.01) sp += ' · còn ' + fmtEta(((1 - j.progress) / j.progress) * ((Date.now() - (node._encStart ||= Date.now())) / 1000));
    }
  } else if (j.status === 'running') {
    st = j.statusText;
    const parts = [fmtBytes(j.bytes) + (j.totalBytes ? ' / ' + fmtBytes(j.totalBytes) : '')];
    if (j.speed) parts.push(fmtBytes(j.speed) + '/s');
    if (j.speed && j.totalBytes > j.bytes) parts.push('còn ' + fmtEta((j.totalBytes - j.bytes) / j.speed));
    else if (j.speed && j.totalUnits && j.progress > 0.02) parts.push('còn ' + fmtEta((j.bytes / j.progress - j.bytes) / j.speed));
    sp = parts.join(' · ');
  } else if (j.status === 'done') {
    sp = fmtBytes(j.size) + ' · .' + j.ext;
  } else if (j.status === 'error') st = j.error;
  $('.st-chip', node).textContent = chip;
  $('.st', node).textContent = st;
  $('.sp', node).textContent = sp;
  const warn = $('.job-warn', node);
  warn.hidden = !j.warning;
  warn.textContent = j.warning || '';

  const active = j.status === 'running' || j.status === 'queued';
  $('.save', node).hidden = j.status !== 'done';
  $('.cancel', node).hidden = !active;
  $('.remove', node).hidden = active;

  // Thông báo khi trạng thái đổi
  const prev = lastStatus.get(j.id);
  lastStatus.set(j.id, j.status);
  if (prev && prev !== j.status) {
    if (j.status === 'done') toast(`Tải xong: ${j.title} [${j.quality}]`, 'ok');
    else if (j.status === 'error') toast('Tải lỗi: ' + j.error, 'err');
  }
  // Tự lưu file về máy khi tải xong
  if (j.status === 'done' && autoSave.has(j.id) && !saved.has(j.id)) {
    saved.add(j.id);
    confetti($('.ring', node));
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
