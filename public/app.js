const $ = (s, el = document) => el.querySelector(s);
const form = $('#form');
const input = $('#url');
const goBtn = $('#goBtn');
const box = $('#analysis');
const jobsEl = $('#jobs');

let currentAnalysis = null;
let pollTimer = null;
const autoSave = new Set(); // job do người dùng bấm tải trong phiên này -> tự lưu khi xong
const saved = new Set();

// ---------- tiện ích ----------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
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
  if (!res.ok) throw new Error(data.error || 'Lỗi ' + res.status);
  return data;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- dán link ----------
$('#pasteBtn').onclick = async () => {
  try {
    const t = (await navigator.clipboard.readText()).trim();
    if (t) {
      input.value = t;
      form.requestSubmit();
    }
  } catch {
    input.focus();
  }
};
input.addEventListener('paste', () => setTimeout(() => /^https?:\/\//.test(input.value.trim()) && form.requestSubmit(), 0));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = input.value.trim();
  if (!url) return;
  const mode = form.mode.value;
  if (currentAnalysis && currentAnalysis.status === 'running') api('/api/analyze/' + currentAnalysis.id, { method: 'DELETE' }).catch(() => {});
  goBtn.disabled = true;
  showLoading('Đang bắt đầu…');
  try {
    let a = await api('/api/analyze', { method: 'POST', body: { url, mode } });
    currentAnalysis = a;
    const started = Date.now();
    while (a.status === 'running') {
      showLoading(a.statusText, Math.round((Date.now() - started) / 1000));
      await sleep(700);
      a = await api('/api/analyze/' + a.id);
      if (currentAnalysis.id !== a.id) return; // đã có lượt phân tích mới
      currentAnalysis = a;
    }
    if (a.status === 'error') throw new Error(a.error);
    renderResult(a);
  } catch (err) {
    showError(err.message);
  } finally {
    goBtn.disabled = false;
  }
});

function showLoading(text, secs) {
  box.hidden = false;
  box.textContent = '';
  const row = el('div', 'loading');
  row.append(el('div', 'spinner'));
  const t = el('div', 'grow', text || 'Đang xử lý…');
  row.append(t);
  if (secs) row.append(el('span', 'muted small', secs + ' giây'));
  box.append(row);
}

function showError(msg) {
  box.hidden = false;
  box.textContent = '';
  box.append(el('div', 'warn err', 'Không lấy được video.\n' + msg));
  const hint = el('p', 'muted small', 'Mẹo: thử chế độ khác ở trên (Quét trang / yt-dlp), hoặc mở link trong trình duyệt xem video có phát được không.');
  box.append(hint);
}

// ---------- kết quả phân tích ----------
const KIND_LABEL = { hls: 'HLS', dash: 'DASH', file: 'FILE', ytdlp: 'yt-dlp' };
const VIA_LABEL = { sniff: 'Quét trang', ytdlp: 'yt-dlp', direct: 'Link trực tiếp' };

function optionText(o) {
  const parts = [o.label];
  if (o.note) parts.push(o.note);
  if (o.sizeEstimate) parts.push('~' + fmtBytes(o.sizeEstimate));
  if (o.disabled) parts.push('(' + o.reason + ')');
  return parts.join(' — ');
}

function renderResult(a) {
  const r = a.result;
  box.hidden = false;
  box.textContent = '';

  const head = el('div', 'result-head');
  const thumb = el('div', 'result-thumb');
  if (r.thumbnail) thumb.style.backgroundImage = `url("${r.thumbnail.replace(/"/g, '%22')}")`;
  head.append(thumb);
  const info = el('div', 'result-info');
  info.append(el('h3', 'result-title', r.title || 'Video'));
  const chips = el('div', 'chips');
  const bestSrc = r.best && r.sources.find((s) => s.id === r.best.sourceId);
  const bestOpt = bestSrc && bestSrc.options.find((o) => o.id === r.best.optionId);
  if (bestOpt) chips.append(el('span', 'chip accent', bestOpt.label));
  if (bestOpt?.codec) chips.append(el('span', 'chip', bestOpt.codec));
  if (r.duration) chips.append(el('span', 'chip', fmtDuration(r.duration)));
  if (bestOpt?.sizeEstimate) chips.append(el('span', 'chip', '~' + fmtBytes(bestOpt.sizeEstimate)));
  chips.append(el('span', 'chip', VIA_LABEL[r.via] + (r.browser ? ' · ' + r.browser : '')));
  info.append(chips);

  if (bestOpt) {
    const row = el('div', 'best-row');
    const btn = el('button', 'btn primary big', `⬇ Tải ${bestOpt.label}`);
    btn.title = 'Bản nét nhất' + (bestOpt.note ? ' — ' + bestOpt.note : '');
    btn.onclick = () => startDownload(a.id, bestSrc.id, bestOpt.id, btn);
    row.append(btn);
    const c = r.bestCompat;
    if (c) {
      const cSrc = r.sources.find((s) => s.id === c.sourceId);
      const cOpt = cSrc.options.find((o) => o.id === c.optionId);
      const cbtn = el('button', 'btn big compat', `⬇ ${cOpt.label} H.264`);
      cbtn.title = c.transcode
        ? 'Trang không có sẵn bản H.264: tải bản nét nhất rồi chuyển sang H.264 (lâu hơn)'
        : 'Bản H.264 + AAC có sẵn, phát được trên mọi máy';
      cbtn.onclick = () => startDownload(a.id, cSrc.id, cOpt.id, cbtn, c.transcode);
      row.append(cbtn);
    } else if (bestOpt.note) row.append(el('span', 'muted small', bestOpt.note));
    info.append(row);
    if (c) {
      const why = c.transcode
        ? `Bản nét nhất dùng ${bestOpt.codec}, một số TV hoặc máy cũ không phát được. Nút H.264 sẽ tải về rồi chuyển mã sang H.264 (giữ ${bestOpt.label}, mất thêm thời gian).`
        : `Bản nét nhất dùng ${bestOpt.codec}, một số TV hoặc máy cũ không phát được. Nút H.264 tải bản tương thích mọi máy cao nhất có sẵn.`;
      info.append(el('p', 'muted small compat-note', why));
    }
  } else {
    const reasons = r.sources.map((s) => s.error || (s.drm ? 'Nội dung có DRM' : s.live ? 'Livestream' : '')).filter(Boolean);
    const msg = r.sources.length
      ? 'Có luồng video nhưng không tải được. ' + [...new Set(reasons)].join('; ')
      : 'Không bắt được luồng video nào trên trang này.';
    info.append(el('div', 'warn', msg + (r.errors?.length ? '\n' + r.errors.join('\n') : '')));
  }
  head.append(info);
  box.append(head);

  if (r.sources.length > 1 || (r.sources[0] && r.sources[0].options.length > 1)) {
    const wrap = el('div', 'sources');
    wrap.append(el('div', 'sources-head', `Chọn chất lượng khác · ${r.sources.length} nguồn`));
    const SHOW = 5;
    r.sources.forEach((s, i) => {
      const node = renderSource(a.id, s);
      if (i >= SHOW) node.hidden = true;
      wrap.append(node);
    });
    if (r.sources.length > SHOW) {
      const more = el('button', 'more', `Xem thêm ${r.sources.length - SHOW} nguồn`);
      more.onclick = () => {
        wrap.querySelectorAll('.source[hidden]').forEach((n) => (n.hidden = false));
        more.remove();
      };
      wrap.append(more);
    }
    box.append(wrap);
  }
}

function renderSource(analysisId, s) {
  const node = el('div', 'source');
  const badge = el('span', 'badge ' + s.kind, KIND_LABEL[s.kind] || s.kind);
  node.append(badge);
  const name = el('span', 'source-name', s.name);
  name.title = s.url;
  node.append(name);
  const meta = [];
  if (s.duration) meta.push(fmtDuration(s.duration));
  if (s.size) meta.push(fmtBytes(s.size));
  if (s.playing) meta.push('đang phát');
  node.append(el('span', 'source-meta', meta.join(' · ')));

  if (s.error) {
    node.append(el('div', 'warn err', 'Không đọc được: ' + s.error));
    return node;
  }
  const row = el('div', 'source-row');
  const select = el('select');
  for (const o of s.options) {
    const opt = new Option(optionText(o), o.id);
    opt.disabled = !!o.disabled;
    select.append(opt);
  }
  const firstOk = s.options.find((o) => !o.disabled);
  const btn = el('button', 'btn', 'Tải');
  if (firstOk) select.value = firstOk.id;
  else btn.disabled = true;
  btn.onclick = () => startDownload(analysisId, s.id, select.value, btn);
  row.append(select, btn);
  node.append(row);
  if (!firstOk) node.append(el('div', 'warn', s.drm ? 'Nội dung có DRM — không thể tải.' : s.live ? 'Livestream — chưa hỗ trợ.' : 'Không có chất lượng nào tải được.'));
  return node;
}

async function startDownload(analysisId, sourceId, optionId, btn, transcode = false) {
  btn.disabled = true;
  try {
    const job = await api('/api/download', { method: 'POST', body: { analysisId, sourceId, optionId, transcode } });
    autoSave.add(job.id);
    btn.textContent = '✓ Đã thêm';
    refreshJobs();
    document.querySelector('.downloads').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    btn.disabled = false;
    alert('Lỗi: ' + e.message);
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
      $('.remove', node).onclick = () => api(`/api/jobs/${j.id}`, { method: 'DELETE' }).then(refreshJobs);
      $('.save', node).href = `/api/jobs/${j.id}/file`;
    }
    if (jobsEl.children[i] !== node) jobsEl.insertBefore(node, jobsEl.children[i] || null);
    updateJob(node, j);
  });
}

function updateJob(node, j) {
  node.className = 'job ' + j.status;
  const bar = $('.bar', node);
  bar.hidden = j.status === 'error' || j.status === 'canceled';
  bar.classList.toggle('indet', j.status === 'running' && !j.progress);
  $('i', bar).style.width = Math.floor(j.progress * 100) + '%';

  let st = j.statusText || '';
  let sp = '';
  if (j.status === 'running' && j.encoding) {
    if (j.progress) st += ' ' + Math.floor(j.progress * 100) + '%';
    if (j.encodeSpeed) {
      sp = j.encodeSpeed.toFixed(1) + '× thời gian thực';
      if (j.progress > 0.01) sp += ' · còn ' + fmtEta(((1 - j.progress) / j.progress) * ((Date.now() - (node._encStart ||= Date.now())) / 1000));
    }
  } else if (j.status === 'running') {
    if (j.progress) st += ' ' + Math.floor(j.progress * 100) + '%';
    const parts = [];
    parts.push(fmtBytes(j.bytes) + (j.totalBytes ? ' / ' + fmtBytes(j.totalBytes) : ''));
    if (j.totalUnits) parts.push(`${j.doneUnits}/${j.totalUnits} đoạn`);
    if (j.speed) parts.push(fmtBytes(j.speed) + '/s');
    if (j.speed && j.totalBytes > j.bytes) parts.push('còn ' + fmtEta((j.totalBytes - j.bytes) / j.speed));
    else if (j.speed && j.totalUnits && j.progress > 0.02) {
      const est = j.bytes / j.progress;
      parts.push('còn ' + fmtEta((est - j.bytes) / j.speed));
    }
    sp = parts.join(' · ');
  } else if (j.status === 'done') {
    st = '✓ Hoàn tất';
    sp = fmtBytes(j.size) + ' · .' + j.ext;
  } else if (j.status === 'error') st = 'Lỗi: ' + j.error;
  $('.st', node).textContent = st;
  $('.sp', node).textContent = sp;
  const warn = $('.job-warn', node);
  warn.hidden = !j.warning;
  warn.textContent = j.warning || '';

  const active = j.status === 'running' || j.status === 'queued';
  $('.save', node).hidden = j.status !== 'done';
  $('.cancel', node).hidden = !active;
  $('.remove', node).hidden = active;

  // Tự lưu file về máy khi tải xong
  if (j.status === 'done' && autoSave.has(j.id) && !saved.has(j.id)) {
    saved.add(j.id);
    $('.save', node).click();
  }
}

// ---------- trạng thái server ----------
api('/api/status')
  .then((s) => {
    const parts = [];
    parts.push(s.browser ? 'Trình duyệt ẩn: ' + s.browser : 'Đang mở trình duyệt ẩn…');
    parts.push(s.ytdlp ? 'yt-dlp ' + s.ytdlpVersion : 'chưa có yt-dlp');
    parts.push(s.ffmpeg ? 'ffmpeg ✓' : 'chưa có ffmpeg');
    $('#engine').textContent = parts.join(' · ');
  })
  .catch(() => ($('#engine').textContent = 'Không kết nối được server'));

refreshJobs();
input.focus();
