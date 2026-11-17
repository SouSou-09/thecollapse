importScripts('/worksheets/uv/uv.bundle.js');
importScripts('/worksheets/uv/uv.config.js');
importScripts('/worksheets/uv/uv.sw.js');
importScripts('/worksheets/adblock-rules.js');
importScripts('/worksheets/adblock-sw.js');

const sw = new UVServiceWorker();

// ── 重要 ────────────────────────────────────────────────
// Ultraviolet 本体のサービスワーカーは skipWaiting / clients.claim を呼ばないため、
// 登録直後はページがまだ SW に制御されておらず、/service/ への最初のリクエストが
// 横取りされずにサーバーへ届いて 404 ("Cannot GET /service/...") になる。
// ここで待たずに制御を奪うことで、最初のナビゲーションからプロキシが機能する。
self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        (async () => {
            try { await self.clients.claim(); } catch (e) {}
        })()
    );
});

function sanitizeNavResponse(res, dest) {
    if (!res) return res;
    const isDoc = dest === 'document' || dest === 'iframe' || dest === 'frame';
    const hasBadEnc = res.headers && (res.headers.has('content-encoding') || res.headers.has('transfer-encoding'));
    const cd = (isDoc && res.headers && res.headers.get('content-disposition')) || '';
    const hasInlineCd = isDoc && /^\s*inline\b/i.test(cd);
    if (!hasBadEnc && !hasInlineCd) return res;
    const headers = new Headers(res.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    headers.delete('transfer-encoding');
    if (hasInlineCd) headers.delete('content-disposition');
    return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
    });
}

// 広告ブロック(v2.3.0): 広告URLの通信遮断とHTMLへの早期CSS注入をSW内で行う
self.addEventListener('fetch', event => {
    const dest = event.request.destination;
    event.respondWith(
        self.TCAdblock.wrap(event, () => sw.fetch(event), { prefix: __uv$config.prefix, decodeUrl: __uv$config.decodeUrl })
            .then(res => sanitizeNavResponse(res, dest))
    );
});
