/*global UVServiceWorker,__uv$config*/
// TheCollapse: Ultraviolet v3 用 Service Worker（広告ブロック対応版 v2.3.0）
// 標準の dist/sw.js と同じ構成に、広告ブロック(通信遮断+早期CSS注入)を追加している。
importScripts('/uv3/uv.bundle.js');
importScripts('/uv3/uv.config.js');
importScripts(__uv$config.sw || '/uv3/uv.sw.js');
importScripts('/worksheets/adblock-rules.js');
importScripts('/worksheets/adblock-sw.js');

const uv = new UVServiceWorker();

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => { try { await self.clients.claim(); } catch (e) {} })());
});

async function handleRequest(event) {
  if (uv.route(event)) {
    return await self.TCAdblock.wrap(event, () => uv.fetch(event), { prefix: __uv$config.prefix, decodeUrl: __uv$config.decodeUrl });
  }
  return await fetch(event.request);
}

self.addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event));
});
