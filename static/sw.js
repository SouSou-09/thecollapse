importScripts('/worksheets/uv/uv.bundle.js');
importScripts('/worksheets/uv/uv.config.js');
importScripts('/worksheets/uv/uv.sw.js');

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

self.addEventListener('fetch', event =>
    event.respondWith(
        sw.fetch(event)
    )
);
