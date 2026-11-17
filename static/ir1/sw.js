/*global UVServiceWorker,__uv$config*/
// TheCollapse: IR V1（UV V3ベース）用 Service Worker（広告ブロック対応版 v3.0.0）
// 標準の dist/sw.js と同じ構成に、広告ブロック(通信遮断+早期CSS注入)と
// ナビゲーション時の意図しないファイル保存ダイアログ防止処理を追加している。
importScripts('/ir1/ir.bundle.js');
importScripts('/ir1/ir.config.js');
importScripts(__uv$config.sw || '/ir1/ir.sw.js');
importScripts('/worksheets/adblock-rules.js');
importScripts('/worksheets/adblock-sw.js');

const ir = new UVServiceWorker();

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => { try { await self.clients.claim(); } catch (e) {} })());
});

// ドキュメント/iframe ナビゲーション応答から不正なエンコーディング宣言や空ファイル名付き
// Content-Disposition を除去し、URL入力や検索の Enter で「ファイルを保存」が出る問題を防止する。
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

async function handleRequest(event) {
  if (ir.route(event)) {
    const dest = event.request.destination;
    const res = await self.TCAdblock.wrap(
      event,
      () => ir.fetch(event),
      { prefix: __uv$config.prefix, decodeUrl: __uv$config.decodeUrl }
    );
    return sanitizeNavResponse(res, dest);
  }
  return await fetch(event.request);
}

self.addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event));
});
