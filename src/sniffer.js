// Cơ chế giống Cốc Cốc: mở trang trong trình duyệt thật (chạy ẩn), bấm phát video,
// rồi "nghe" toàn bộ request mạng để bắt link luồng video (m3u8 / mpd / mp4) kèm header & cookie.
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { classifyMedia, normalizeMediaUrl } from './util.js';

const MIN_FILE_SIZE = 300 * 1024;

const CANDIDATES = [
  { name: 'Google Chrome', opts: { channel: 'chrome' } },
  { name: 'Microsoft Edge', opts: { channel: 'msedge' } },
  ...[
    'C:\\Program Files\\CocCoc\\Browser\\Application\\browser.exe',
    'C:\\Program Files (x86)\\CocCoc\\Browser\\Application\\browser.exe',
    process.env.LOCALAPPDATA && process.env.LOCALAPPDATA + '\\CocCoc\\Browser\\Application\\browser.exe',
  ]
    .filter((p) => p && existsSync(p))
    .map((p) => ({ name: 'Cốc Cốc', opts: { executablePath: p } })),
];

// Nút "Play" phổ biến của các trình phát (video.js, JW Player, Plyr, Clappr, Flowplayer, DPlayer, ArtPlayer, ...)
const PLAY_SELECTORS = [
  '.vjs-big-play-button',
  '.jw-display-icon-display',
  '.jw-icon-playback',
  '.plyr__control--overlaid',
  '.ytp-large-play-button',
  '.fp-play',
  '.dplayer-mobile-play',
  '.art-control-play',
  '.player-poster.clickable',
  '.mejs__overlay-button',
  '.btn-play',
  '.play-button',
  '.play-btn',
  'button[aria-label*="play" i]',
  'button[title*="play" i]',
  '[class*="play-icon" i]',
];

let browserPromise = null;
export let browserName = '';

async function launch() {
  const errors = [];
  for (const c of CANDIDATES) {
    try {
      const browser = await chromium.launch({
        ...c.opts,
        headless: true,
        args: [
          '--autoplay-policy=no-user-gesture-required',
          '--mute-audio',
          '--disable-blink-features=AutomationControlled',
          '--no-first-run',
          '--no-default-browser-check',
        ],
      });
      browserName = c.name;
      browser.on('disconnected', () => (browserPromise = null));
      return browser;
    } catch (e) {
      errors.push(`${c.name}: ${e.message.split('\n')[0]}`);
    }
  }
  throw new Error('Không mở được trình duyệt ẩn. Cần cài Chrome, Edge hoặc Cốc Cốc.\n' + errors.join('\n'));
}

export function getBrowser() {
  if (!browserPromise) browserPromise = launch().catch((e) => ((browserPromise = null), Promise.reject(e)));
  return browserPromise;
}

function userAgentFor(browser) {
  const major = (browser.version().match(/\d+/) || ['130'])[0];
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

// Chạy trong từng frame: bật tiếng tắt, ép phát mọi thẻ <video>, trả về thông tin video
function pokeVideos() {
  const out = [];
  const walk = (root) => {
    root.querySelectorAll('video').forEach((v) => out.push(v));
    root.querySelectorAll('*').forEach((el) => el.shadowRoot && walk(el.shadowRoot));
  };
  walk(document);
  return out.map((v) => {
    try {
      v.muted = true;
      if (v.paused) v.play().catch(() => {});
    } catch {}
    return {
      src: v.currentSrc || v.src || '',
      sources: [...v.querySelectorAll('source')].map((s) => s.src).filter(Boolean),
      width: v.videoWidth,
      height: v.videoHeight,
      duration: isFinite(v.duration) ? v.duration : 0,
      playing: !v.paused && !v.ended && v.readyState > 2,
      frameUrl: location.href,
    };
  });
}

/**
 * Quét một trang. Trả về { title, thumbnail, pageUrl, items, videos, cookies, userAgent, browser }
 */
export async function sniffPage(url, { timeoutMs = 30000, onStatus, signal } = {}) {
  onStatus?.('Đang khởi động trình duyệt ẩn…');
  const browser = await getBrowser();
  const userAgent = userAgentFor(browser);
  const context = await browser.newContext({
    userAgent,
    locale: 'vi-VN',
    viewport: { width: 1366, height: 768 },
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { 'accept-language': 'vi-VN,vi;q=0.9,en;q=0.8' },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const found = new Map();
  const deadline = Date.now() + timeoutMs;
  let mainPage = null;

  const onResponse = async (response) => {
    try {
      const status = response.status();
      if (status < 200 || status >= 300) return;
      const reqUrl = response.url();
      const headers = response.headers();
      const ct = headers['content-type'] || '';
      const kind = classifyMedia(reqUrl, ct);
      if (!kind) return;
      let size = 0;
      const cr = headers['content-range'];
      const m = cr && /\/(\d+)\s*$/.exec(cr);
      size = m ? Number(m[1]) : Number(headers['content-length']) || 0;
      if (kind === 'file' && size && size < MIN_FILE_SIZE) return;
      const req = response.request();
      const reqHeaders = await req.allHeaders().catch(() => req.headers());
      const key = normalizeMediaUrl(reqUrl);
      if (!found.has(key)) onStatus?.(`Đã bắt được luồng ${kind.toUpperCase()}…`);
      found.set(key, {
        url: key,
        kind,
        contentType: ct.split(';')[0].trim(),
        size: kind === 'file' ? size : 0,
        referer: reqHeaders.referer || '',
        origin: reqHeaders.origin || '',
        frameUrl: (() => {
          try {
            return req.frame().url();
          } catch {
            return '';
          }
        })(),
        time: Date.now(),
      });
    } catch {}
  };

  context.on('response', onResponse);
  // Đóng popup quảng cáo mở ra khi bấm vào trình phát
  context.on('page', (p) => {
    if (mainPage && p !== mainPage) p.close().catch(() => {});
  });

  try {
    const page = (mainPage = await context.newPage());
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    signal?.addEventListener('abort', () => context.close().catch(() => {}));

    onStatus?.('Đang mở trang…');
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(30000, timeoutMs) });
    } catch (e) {
      if (!found.size) throw new Error('Không mở được trang: ' + e.message.split('\n')[0]);
    }

    onStatus?.('Đang tìm và bấm phát video…');
    let videos = [];
    let foundAt = 0;
    for (let round = 0; Date.now() < deadline; round++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      // Ép phát video trong mọi frame (kể cả iframe nhúng trình phát)
      videos = [];
      for (const frame of page.frames()) {
        const r = await frame.evaluate(pokeVideos).catch(() => []);
        videos.push(...r);
      }
      // Bấm nút play / giữa trình phát ở vài vòng đầu (vòng sau để vượt lớp quảng cáo che)
      if (round < 5 && !hasManifest(found)) await clickPlay(page);

      const ready = hasManifest(found) || videos.some((v) => v.playing && /^https?:/.test(v.src)) || found.size > 0;
      if (ready && !foundAt) foundAt = Date.now();
      // Chờ thêm chút sau khi bắt được để gom đủ playlist con / audio
      if (foundAt && Date.now() - foundAt > 3500) break;
      await page.waitForTimeout(1200);
    }

    const title = await page.title().catch(() => '');
    const thumbnail = await page
      .evaluate(() => {
        const m = document.querySelector('meta[property="og:image"], meta[name="twitter:image"]');
        if (m && m.content) return new URL(m.content, location.href).href;
        const v = document.querySelector('video[poster]');
        return v ? v.poster : '';
      })
      .catch(() => '');
    const ogTitle = await page
      .evaluate(() => document.querySelector('meta[property="og:title"]')?.content || '')
      .catch(() => '');
    const cookies = (await context.cookies().catch(() => [])).map(({ name, value, domain, path }) => ({ name, value, domain, path }));

    return {
      title: (ogTitle || title || '').trim(),
      thumbnail,
      pageUrl: page.url(),
      items: [...found.values()],
      videos,
      cookies,
      userAgent,
      browser: browserName,
    };
  } finally {
    context.off('response', onResponse);
    await context.close().catch(() => {});
  }
}

function hasManifest(found) {
  for (const v of found.values()) if (v.kind === 'hls' || v.kind === 'dash') return true;
  return false;
}

// Bấm như người thật (theo toạ độ chuột): nếu có lớp quảng cáo che, cú bấm đầu sẽ "ăn" quảng cáo,
// popup bị đóng, và vòng sau bấm trúng nút Play.
async function clickPlay(page) {
  for (const frame of page.frames()) {
    for (const sel of PLAY_SELECTORS) {
      const loc = frame.locator(sel).first();
      if (!(await loc.isVisible().catch(() => false))) continue;
      const b = await loc.boundingBox().catch(() => null);
      if (b && b.width > 0) {
        await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2).catch(() => {});
        return;
      }
    }
  }
  // Không thấy nút: bấm vào giữa thẻ video / iframe lớn nhất trên trang
  const box = await page
    .evaluate(() => {
      const els = [...document.querySelectorAll('video, iframe, [class*="player" i], [id*="player" i]')];
      let best = null;
      let bestArea = 0;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (r.width > 200 && r.height > 120 && area > bestArea) (best = el), (bestArea = area);
      }
      if (!best) return null;
      best.scrollIntoView({ block: 'center' });
      const r = best.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })
    .catch(() => null);
  if (box) await page.mouse.click(box.x, box.y).catch(() => {});
}

export async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    await b?.close().catch(() => {});
  }
}
