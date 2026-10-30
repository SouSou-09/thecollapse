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

// 広告ブロック(v2.3.0): 広告URLの通信遮断とHTMLへの早期CSS注入をSW内で行う
self.addEventListener('fetch', event =>
    event.respondWith(
        self.TCAdblock.wrap(event, () => sw.fetch(event), { prefix: __uv$config.prefix, decodeUrl: __uv$config.decodeUrl })
    )
);
