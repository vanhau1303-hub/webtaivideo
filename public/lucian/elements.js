// Phần tử tương tác chuyển từ Lucian UX/UI Prompt (https://lucianlabs.dev/uxui-prompt/) — MIT License, xem lucian/LICENSE.txt.
// Mỗi hàm tạo phần tử, gắn hành vi gốc (giữ thời lượng, đường cong chuyển động) và nối với dữ liệu thật của web.

const rm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const html = (s) => {
  const t = document.createElement('template');
  t.innerHTML = s.trim();
  return t.content.firstElementChild;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Lucian UX/UI Prompt #002 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#002
   Nút "Phân tích": hút theo con trỏ, mũi tên bắn ra khi bấm. onClick gọi hành động thật. */
export function magneticButton({ label, done, onClick }) {
  const root = html(`<div class="ux u002" data-state="idle">
    <span class="u002-glow" aria-hidden="true"></span>
    <div class="u002-mag"><button class="u002-btn" type="submit">
      <span class="u002-fill" aria-hidden="true"></span>
      <span class="u002-txt"><span>${esc(label)}</span><span aria-hidden="true">${esc(done)}</span></span>
      <span class="u002-orb" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6"/></svg><svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6"/></svg></span>
    </button></div>
    <span class="u002-live" aria-live="polite"></span></div>`);
  const btn = root.querySelector('.u002-btn');
  const mag = root.querySelector('.u002-mag');
  const txt = root.querySelector('.u002-txt');
  const orb = root.querySelector('.u002-orb');
  const live = root.querySelector('.u002-live');
  let t = 0;
  root.addEventListener('pointermove', (e) => {
    if (rm()) return;
    const r = btn.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const p = Math.max(0, 1 - Math.hypot(dx, dy) / 240);
    mag.style.translate = (dx * 0.12 * p).toFixed(1) + 'px ' + (dy * 0.22 * p).toFixed(1) + 'px';
    txt.style.translate = (dx * 0.05 * p).toFixed(1) + 'px ' + (dy * 0.08 * p).toFixed(1) + 'px';
    orb.style.translate = (dx * 0.1 * p).toFixed(1) + 'px ' + (dy * 0.14 * p).toFixed(1) + 'px';
  });
  root.addEventListener('pointerleave', () => {
    mag.style.translate = txt.style.translate = orb.style.translate = '0px 0px';
  });
  const play = () => {
    clearTimeout(t);
    root.dataset.state = 'idle';
    void btn.offsetWidth;
    root.dataset.state = 'go';
    live.textContent = done;
    t = setTimeout(() => {
      if (root.isConnected) (root.dataset.state = 'idle'), (live.textContent = '');
    }, rm() ? 900 : 1900);
  };
  if (onClick) btn.addEventListener('click', onClick);
  return { root, btn, play };
}

/* Lucian UX/UI Prompt #004 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#004
   Nút tải: thanh tiến độ chạy theo tiến trình tải thật; bấm khi đang tải = huỷ. */
export function downloadButton({ fileName, ext, sizeText, label, onStart, onCancel }) {
  const root = html(`<div class="ux u004" data-state="idle">
    <p class="u004-file"><span class="u004-pdf" aria-hidden="true" data-ext="${esc(ext.toUpperCase())}"></span><span class="t"></span><small></small></p>
    <button class="u004-btn" type="button">
      <span class="u004-track" aria-hidden="true"><span class="u004-bar"></span></span>
      <span class="u004-idle" aria-hidden="true">
        <span class="u004-arw"><svg viewBox="0 0 24 24"><g class="u004-a"><path d="M12 4.5v11M7 11l5 5 5-5"/></g><path d="M5 19.5h14"/></svg></span>
        <b></b><small></small>
      </span>
      <span class="u004-run" aria-hidden="true"><b class="u004-pct">0%</b><small class="u004-eta">Đang chuẩn bị…</small></span>
      <span class="u004-ok" aria-hidden="true"><i><svg viewBox="0 0 16 16"><path d="M3.5 8.4l3 3 6-6.4"/></svg></i><span>Đã lưu vào máy</span></span>
    </button>
    <span class="u004-live" aria-live="polite"></span></div>`);
  const btn = root.querySelector('.u004-btn');
  const pct = root.querySelector('.u004-pct');
  const eta = root.querySelector('.u004-eta');
  const live = root.querySelector('.u004-live');
  const timers = [];
  const later = (fn, ms) => timers.push(setTimeout(() => root.isConnected && fn(), ms));
  const api = {
    root,
    setInfo({ fileName, sizeText, label }) {
      root.querySelector('.u004-file .t').textContent = fileName;
      root.querySelector('.u004-file small').textContent = sizeText || '';
      root.querySelector('.u004-idle b').textContent = label;
      root.querySelector('.u004-idle small').textContent = sizeText || '';
      btn.setAttribute('aria-label', label + (sizeText ? ', ' + sizeText : ''));
    },
    setExt(e) {
      root.querySelector('.u004-pdf').dataset.ext = e.toUpperCase();
    },
    progress(p, text) {
      if (root.dataset.state !== 'run') return;
      btn.style.setProperty('--p', Math.max(0, Math.min(1, p)).toFixed(4));
      pct.textContent = Math.floor(p * 100) + '%';
      if (text != null) eta.textContent = text;
    },
    run() {
      timers.forEach(clearTimeout);
      btn.style.setProperty('--p', 0);
      pct.textContent = '0%';
      eta.textContent = 'Đang chuẩn bị…';
      root.dataset.state = 'run';
      live.textContent = 'Bắt đầu tải';
    },
    finish() {
      root.dataset.state = 'fold';
      live.textContent = 'Tải xong';
      later(() => (root.dataset.state = 'done'), rm() ? 100 : 650);
    },
    reset() {
      timers.forEach(clearTimeout);
      root.dataset.state = 'idle';
      btn.style.setProperty('--p', 0);
      live.textContent = '';
    },
  };
  api.setInfo({ fileName, sizeText, label });
  btn.addEventListener('click', () => {
    const s = root.dataset.state;
    if (s === 'run') {
      onCancel?.();
      api.reset();
      live.textContent = 'Đã huỷ tải';
      return;
    }
    if (s !== 'idle') return api.reset();
    api.run();
    onStart?.(api);
  });
  return api;
}

/* Lucian UX/UI Prompt #013 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#013
   Công tắc co giãn: bật chế độ H.264 tương thích mọi máy. */
export function stretchySwitch({ title, offText, onText, onChange }) {
  const root = html(`<div class="ux u013">
    <div class="u013-slot"><button class="u013-sw" type="button" role="switch" aria-checked="false">
      <span class="u013-knob" aria-hidden="true"><svg viewBox="0 0 24 24"><path class="u013-x" d="M7.5 7.5l9 9M16.5 7.5l-9 9"/><path class="u013-v" d="M5.5 12.5l4.5 4.5 8.5-9"/></svg></span>
    </button></div>
    <div class="u013-txt"><b class="u013-lab">${esc(title)}</b>
      <span class="u013-sub" aria-live="polite"><span>${esc(offText)}</span><span>${esc(onText)}</span></span></div></div>`);
  const sw = root.querySelector('.u013-sw');
  const knob = root.querySelector('.u013-knob');
  const lab = root.querySelector('.u013-lab');
  const id = 'u013-l-' + Math.random().toString(36).slice(2, 7);
  lab.id = id;
  sw.setAttribute('aria-labelledby', id);
  let on = false;
  let t = 0;
  const K = 0.6; // tỉ lệ thu nhỏ trong .u013-sw
  function set(v, silent) {
    on = v;
    root.classList.toggle('is-on', v);
    sw.setAttribute('aria-checked', String(v));
    if (!rm()) {
      root.classList.add('is-stretch');
      clearTimeout(t);
      t = setTimeout(() => root.classList.remove('is-stretch'), 170);
    }
    if (!silent) onChange?.(v);
  }
  let drag = null;
  sw.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, moved: false, start: on ? 72 : 8 };
    sw.setPointerCapture(e.pointerId);
  });
  sw.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.x) / K;
    if (Math.abs(dx) > 4) drag.moved = true;
    if (!drag.moved) return;
    root.classList.add('is-drag');
    knob.style.left = Math.max(8, Math.min(72, drag.start + dx)) + 'px';
    knob.style.width = 60 + Math.min(18, Math.abs(dx) * 0.25) + 'px';
  });
  const end = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    root.classList.remove('is-drag');
    const x = parseFloat(knob.style.left || (on ? 72 : 8));
    knob.style.left = knob.style.width = '';
    if (d.moved) {
      set(x > 40);
      sw._skip = true;
    }
  };
  sw.addEventListener('pointerup', end);
  sw.addEventListener('pointercancel', end);
  sw.addEventListener('click', () => {
    if (sw._skip) return (sw._skip = false);
    set(!on);
  });
  return { root, set: (v) => set(v, true), get: () => on };
}

/* Lucian UX/UI Prompt #015 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#015
   Thẻ chọn: mỗi thẻ là một mức chất lượng; khung trượt tới thẻ được chọn. */
export function radioCards({ items, selected, onSelect, summary }) {
  const root = html(`<div class="ux u015"><div class="u015-grp" role="radiogroup" aria-label="Chất lượng"><span class="u015-frame" aria-hidden="true"></span></div>
    <p class="u015-cta" aria-live="polite"><span class="u015-sel"></span><b class="u015-sum"></b></p></div>`);
  const grp = root.querySelector('.u015-grp');
  const frame = root.querySelector('.u015-frame');
  const sel = root.querySelector('.u015-sel');
  const sum = root.querySelector('.u015-sum');
  const opts = items.map((it) => {
    const o = html(`<button class="u015-opt" type="button" role="radio" aria-checked="false">
      <span class="u015-dot" aria-hidden="true"></span>
      <span class="u015-ic" style="--g:${it.grad}" aria-hidden="true">${esc(it.icon)}</span>
      <span class="u015-txt"><b>${esc(it.title)}${it.badge ? ` <em>${esc(it.badge)}</em>` : ''}</b><small>${esc(it.sub)}</small></span>
      <span class="u015-price"><b>${esc(it.right)}</b><small>${esc(it.rightSub || ' ')}</small></span></button>`);
    o.disabled = !!it.disabled;
    o._item = it;
    grp.append(o);
    return o;
  });
  const enabled = () => opts.filter((o) => !o.disabled);
  function place(o) {
    frame.style.top = o.offsetTop + 'px';
    frame.style.height = o.offsetHeight + 'px';
  }
  function choose(o, focus, silent) {
    opts.forEach((x) => {
      const on = x === o;
      x.setAttribute('aria-checked', String(on));
      x.tabIndex = on ? 0 : -1;
    });
    place(o);
    const s = summary(o._item);
    sel.textContent = s[0];
    sum.textContent = s[1];
    if (focus) o.focus();
    if (!silent) onSelect?.(o._item);
  }
  opts.forEach((o) => {
    o.addEventListener('click', () => choose(o));
    o.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const en = enabled();
      choose(en[(en.indexOf(o) + d + en.length) % en.length], true);
    });
  });
  const first = opts.find((o) => o._item.id === selected) || enabled()[0];
  // Đặt khung sau khi phần tử đã vào trang (cần offsetTop)
  const init = () => {
    if (!first) return;
    frame.style.transition = 'none';
    choose(first, false, true);
    requestAnimationFrame(() => requestAnimationFrame(() => (frame.style.transition = '')));
  };
  new ResizeObserver(() => {
    const cur = opts.find((o) => o.getAttribute('aria-checked') === 'true');
    if (cur) place(cur);
  }).observe(grp);
  return {
    root,
    init,
    select(id) {
      const o = opts.find((x) => x._item.id === id);
      if (o) choose(o, false, true);
    },
    clear() {
      opts.forEach((x) => x.setAttribute('aria-checked', 'false'));
      frame.style.height = '0px';
    },
  };
}

/* Lucian UX/UI Prompt #021 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#021
   Công tắc ngày–đêm: đổi giao diện sáng / tối của web. */
export function dayNightSwitch({ night, onChange }) {
  const root = html(`<div class="ux u021">
    <button class="u021-sw" type="button" role="switch" aria-checked="false" aria-label="Giao diện tối">
      <span class="u021-halo" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="u021-stars" aria-hidden="true"><i style="left:30px;top:20px"></i><i style="left:58px;top:56px;animation-delay:-.6s;width:3px;height:3px"></i><i style="left:86px;top:26px;animation-delay:-1.2s"></i><i style="left:44px;top:72px;animation-delay:-1.8s;width:3px;height:3px"></i><i style="left:110px;top:60px;animation-delay:-.9s;width:2px;height:2px"></i><i style="left:20px;top:46px;animation-delay:-1.5s;width:2px;height:2px"></i></span>
      <span class="u021-clouds" aria-hidden="true"><i></i><i></i></span>
      <span class="u021-knob" aria-hidden="true"><span class="u021-moon"><i></i><i></i><i></i></span></span>
    </button></div>`);
  const sw = root.querySelector('.u021-sw');
  const set = (v) => {
    root.classList.toggle('is-night', v);
    sw.setAttribute('aria-checked', String(v));
  };
  set(night);
  sw.addEventListener('click', () => {
    const v = !root.classList.contains('is-night');
    set(v);
    onChange?.(v);
  });
  return { root };
}

/* Lucian UX/UI Prompt #070 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#070
   Thông báo xếp chồng: thông báo mới nổi lên trước, rê chuột để xoè ra, vuốt ngang để bỏ. */
export function createToaster() {
  const root = html(`<div class="ux u070"><div class="u070-zone" role="region" aria-label="Thông báo" tabindex="-1"><div class="u070-live" aria-live="polite"></div></div></div>`);
  document.body.append(root);
  const zone = root.querySelector('.u070-zone');
  const live = root.querySelector('.u070-live');
  const ICON = {
    ok: '<svg viewBox="0 0 18 18"><path d="M4 9.4l3.2 3.2L14 5.6"/></svg>',
    err: '<svg viewBox="0 0 18 18"><path d="M9 5v5M9 13h.01"/></svg>',
    info: '<svg viewBox="0 0 18 18"><path d="M3.5 4.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>',
    wait: '<i></i>',
  };
  const COLOR = { ok: 'var(--ux-mint)', err: 'var(--ux-danger)', info: 'var(--ux-accent)', wait: 'var(--ux-warn)' };
  const list = [];
  let open = false;
  const DUR = 4500;
  function layout() {
    let acc = 0;
    list.forEach((t, i) => {
      const el = t.el;
      el.classList.toggle('back', !open && i > 0);
      if (open) {
        el.style.setProperty('--y', -acc + 'px');
        el.style.setProperty('--s', 1);
        el.style.setProperty('--o', 1);
        acc += el.offsetHeight + 8;
      } else {
        el.style.setProperty('--y', -(i * 14) + 'px');
        el.style.setProperty('--s', (1 - i * 0.06).toFixed(2));
        el.style.setProperty('--o', i > 2 ? 0 : 1);
      }
      el.style.zIndex = 50 - i;
      el.inert = !open && i > 0;
    });
    root.classList.toggle('has-items', list.length > 0);
  }
  function remove(t, dir) {
    const i = list.indexOf(t);
    if (i < 0) return;
    list.splice(i, 1);
    t.el.classList.add('leave');
    if (dir) t.el.style.setProperty('--dir', dir), t.el.classList.add('side');
    setTimeout(() => t.el.remove(), 450);
    layout();
  }
  function push(kind, title, sub, action) {
    const el = document.createElement('div');
    el.className = 'u070-t enter';
    el.style.setProperty('--c', COLOR[kind] || COLOR.info);
    el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    el.innerHTML =
      '<span class="u070-ic" aria-hidden="true">' + (ICON[kind] || ICON.info) + '</span><span class="u070-tx"><b></b><small></small></span>' +
      (action ? '<a class="u070-act"></a>' : '') +
      '<button class="u070-x" type="button" aria-label="Đóng"><svg viewBox="0 0 14 14"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/></svg></button><span class="u070-bar" aria-hidden="true"></span>';
    el.querySelector('b').textContent = title;
    el.querySelector('small').textContent = sub || '';
    if (!sub) el.querySelector('small').remove();
    const t = { el, left: DUR };
    if (action) {
      const a = el.querySelector('.u070-act');
      a.textContent = action.label;
      if (action.href) a.href = action.href;
      a.addEventListener('click', () => (action.onClick?.(), remove(t)));
    }
    zone.append(el);
    list.unshift(t);
    void el.offsetWidth;
    el.classList.remove('enter');
    layout();
    live.textContent = title;
    el.querySelector('.u070-x').addEventListener('click', () => remove(t));
    let sx = 0;
    let dx = 0;
    let down = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button,a')) return;
      down = true;
      sx = e.clientX;
      dx = 0;
      el.setPointerCapture(e.pointerId);
      el.classList.add('drag');
    });
    el.addEventListener('pointermove', (e) => {
      if (!down) return;
      dx = e.clientX - sx;
      el.style.setProperty('--dx', dx + 'px');
      el.style.setProperty('--o', Math.max(0.2, 1 - Math.abs(dx) / 260));
    });
    const end = () => {
      if (!down) return;
      down = false;
      el.classList.remove('drag');
      if (Math.abs(dx) > 90) remove(t, dx > 0 ? 1 : -1);
      else el.style.setProperty('--dx', '0px'), layout();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    return t;
  }
  let last = performance.now();
  (function loop(now) {
    const dt = now - last;
    last = now;
    if (!open)
      list.slice().forEach((t, i) => {
        if (i > 0) return;
        t.left -= dt;
        t.el.style.setProperty('--left', Math.max(0, t.left / DUR).toFixed(3));
        if (t.left <= 0) remove(t);
      });
    requestAnimationFrame(loop);
  })(last);
  const setOpen = (v) => {
    if (open !== v) (open = v), layout();
  };
  zone.addEventListener('pointerenter', (e) => e.pointerType === 'mouse' && setOpen(true));
  zone.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && !zone.contains(document.activeElement) && setOpen(false));
  zone.addEventListener('focusin', () => setOpen(true));
  zone.addEventListener('focusout', (e) => !zone.contains(e.relatedTarget) && setOpen(false));
  zone.addEventListener('click', (e) => !e.target.closest('button,a') && list.length > 1 && setOpen(!open));
  return { push };
}

/* Lucian UX/UI Prompt #080 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#080
   Vòng quỹ đạo: hiển thị khi đang phân tích link, chữ theo trạng thái thật; xong thì thu về dấu check. */
export function orbitSpinner({ title, sub, cancelLabel, onCancel }) {
  const root = html(`<div class="ux u080">
    <div class="u080-sys" aria-hidden="true">
      <div class="u080-o" style="--d:210px;--t:-18deg"></div><div class="u080-o" style="--d:150px;--t:24deg"></div><div class="u080-o" style="--d:100px;--t:-58deg"></div>
      <span class="u080-wave"></span><span class="u080-core"><svg viewBox="0 0 34 34"><path d="M9 17.5l5.5 5.5L25.5 12"/></svg></span>
    </div>
    <div class="u080-msg" role="status" aria-live="polite"><div class="u080-t"></div><p class="u080-sub"></p></div>
    <button class="u080-b" type="button"></button></div>`);
  const tWrap = root.querySelector('.u080-t');
  const subEl = root.querySelector('.u080-sub');
  const btn = root.querySelector('.u080-b');
  const sys = root.querySelector('.u080-sys');
  const core = root.querySelector('.u080-core');
  let state = 'run';
  const O = [
    [105, -18, 5.5, '#22C3A6', 12],
    [75, 24, 3.6, '#FF6B8B', 10],
    [50, -58, 2.2, '#FFB547', 9],
  ];
  const planets = [];
  O.forEach((o, i) =>
    [0, Math.PI].forEach((ph, k) => {
      const p = document.createElement('i');
      p.className = 'u080-p';
      p.style.setProperty('--c', o[3]);
      p.style.setProperty('--s', (k ? o[4] - 4 : o[4]) + 'px');
      if (k) p.style.opacity = '.7';
      sys.insertBefore(p, core);
      planets.push({ el: p, o, ph: ph + i });
    })
  );
  let orbitT = 0;
  let lastF = performance.now();
  function orbit(now) {
    if (!root.isConnected) return;
    if (state === 'run' && !rm()) orbitT += (now - lastF) / 1000;
    lastF = now;
    planets.forEach((p) => {
      const o = p.o;
      const a = p.ph + (orbitT * Math.PI * 2) / o[2];
      const tl = (o[1] * Math.PI) / 180;
      const x = Math.cos(a) * o[0];
      const y = Math.sin(a) * o[0] * 0.38;
      const rx = x * Math.cos(tl) - y * Math.sin(tl);
      const ry = x * Math.sin(tl) + y * Math.cos(tl);
      p.el.style.transform = 'translate(' + (115 + rx).toFixed(1) + 'px,' + (100 + ry).toFixed(1) + 'px)';
      p.el.style.zIndex = Math.sin(a) < 0 ? 0 : 2;
    });
    if (state !== 'done') requestAnimationFrame(orbit);
  }
  let current = '';
  function setTitle(txt) {
    if (txt === current) return;
    current = txt;
    const old = tWrap.querySelector('b:not(.out)');
    const b = document.createElement('b');
    b.textContent = txt;
    b.className = 'in';
    tWrap.appendChild(b);
    void b.offsetWidth;
    b.className = '';
    if (old) (old.className = 'out'), setTimeout(() => old.remove(), 450);
  }
  setTitle(title);
  subEl.textContent = sub || '';
  btn.textContent = cancelLabel;
  btn.addEventListener('click', () => {
    if (state !== 'run') return;
    state = 'stop';
    root.classList.add('is-paused');
    onCancel?.();
  });
  requestAnimationFrame(orbit);
  return {
    root,
    update(title, sub) {
      if (title) setTitle(title);
      if (sub != null) subEl.textContent = sub;
    },
    done(title, sub) {
      state = 'done';
      root.classList.add('is-done');
      btn.hidden = true;
      setTitle(title);
      subEl.textContent = sub || '';
    },
  };
}

/* Lucian UX/UI Prompt #083 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#083
   Thanh hàng chờ → tiến độ cho mỗi lượt tải. */
export function queueBar() {
  const root = html(`<div class="ux u083">
    <div class="u083-trk" role="progressbar" aria-label="Tiến độ tải" aria-valuemin="0" aria-valuemax="100"><span class="u083-seg a" aria-hidden="true"></span><span class="u083-seg b" aria-hidden="true"></span><span class="u083-fill" aria-hidden="true"></span></div>
    <div class="u083-meta"><span class="u083-l"></span><span class="u083-r"></span></div></div>`);
  const trk = root.querySelector('.u083-trk');
  const fill = root.querySelector('.u083-fill');
  return {
    root,
    /** state: queued | run | done | fail ; p: 0..1 hoặc null (chưa biết) */
    set(state, p, left, right) {
      root.classList.toggle('is-det', state === 'done' || (state === 'run' && p > 0));
      root.classList.toggle('is-done', state === 'done');
      root.classList.toggle('is-fail', state === 'fail');
      const v = state === 'done' ? 1 : p || 0;
      fill.style.setProperty('--p', v);
      trk.setAttribute('aria-valuenow', Math.round(v * 100));
      root.querySelector('.u083-l').textContent = left || '';
      root.querySelector('.u083-r').textContent = right || '';
    },
  };
}

/** Nhãn trạng thái kiểu #083 (dùng ở tiêu đề mỗi lượt tải) */
export function statusPill(text, color) {
  const s = document.createElement('span');
  s.className = 'u083-pill';
  s.setAttribute('role', 'status');
  s.textContent = text;
  s.style.setProperty('--c', color);
  return s;
}
