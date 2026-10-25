// Địa chỉ cố định video4urduck.<tài-khoản>.workers.dev -> chuyển tiếp về tunnel đang chạy trên máy nhà.
// Máy nhà (run.js) báo link tunnel mới qua POST /__tunnel mỗi lần khởi động.

const OFFLINE_HTML = `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Máy chủ đang tắt</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#f6f7f9;color:#15171c}
@media(prefers-color-scheme:dark){body{background:#111215;color:#eceef2}}div{max-width:420px;padding:24px;text-align:center}p{opacity:.7}</style>
</head><body><div><h1>Máy chủ đang tắt</h1><p>Máy tính chạy HD Video Downloader đang tắt hoặc mất mạng. Bật máy và chạy start.bat, sau khoảng 1 phút hãy tải lại trang.</p></div></body></html>`;

function offline(status = 503) {
  return new Response(OFFLINE_HTML, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // Máy nhà cập nhật link tunnel
    if (url.pathname === '/__tunnel') {
      if (req.method !== 'POST' || req.headers.get('authorization') !== `Bearer ${env.UPDATE_TOKEN}`) {
        return new Response('Forbidden', { status: 403 });
      }
      const { target } = await req.json();
      let t;
      try {
        t = new URL(target);
      } catch {
        return new Response('Bad target', { status: 400 });
      }
      if (t.protocol !== 'https:' || !t.hostname.endsWith('.trycloudflare.com')) return new Response('Bad target', { status: 400 });
      await env.KV.put('target', t.origin);
      return Response.json({ ok: true, target: t.origin });
    }

    const target = await env.KV.get('target');
    if (!target) return offline();

    const upstream = new URL(url.pathname + url.search, target);
    const headers = new Headers(req.headers);
    headers.delete('host');
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', 'https');

    let res;
    try {
      res = await fetch(upstream, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
        redirect: 'manual',
      });
    } catch {
      return offline(502);
    }
    // Tunnel không còn sống (máy tắt / link cũ)
    if (res.status === 530 || res.status === 1033 || (res.status === 502 && !res.headers.get('content-type')?.includes('json'))) {
      return offline();
    }

    const out = new Response(res.body, res);
    const loc = out.headers.get('location');
    if (loc && loc.startsWith(target)) out.headers.set('location', loc.slice(target.length) || '/');
    return out;
  },
};
