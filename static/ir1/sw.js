/*global UVServiceWorker,__uv$config*/
// TheCollapse: IR V1（UV V3ベース）用 Service Worker（広域互換・広告ブロック対応版）
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

const STRIP_SEC_RESPONSE_HEADERS = [
  'content-security-policy',
  'content-security-policy-report-only',
  'x-webkit-csp',
  'x-content-security-policy',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'x-frame-options',
  'x-content-type-options',
  'strict-transport-security',
  'permissions-policy',
  'feature-policy',
  'clear-site-data',
  'nel',
  'report-to',
  'reporting-endpoints',
];

const JS_MIME_RE = /^(application\/(javascript|x-javascript|ecmascript)|text\/(javascript|ecmascript|jscript|js))\b/i;

// ── 1) リクエスト送信前フック（request） ──
ir.on('request', (event) => {
  try {
    const ctx = event.data;
    if (!ctx || !ctx.headers || !ctx.url) return;
    const targetUrl = ctx.url instanceof URL ? ctx.url : new URL(String(ctx.url));
    const h = ctx.headers;

    // 不正な Referer / Origin（about:blank, null, プロキシ自身のオリジン）を除去してターゲット基準に補正
    if (h.referer && (/^about:/i.test(h.referer) || h.referer.startsWith(self.location.origin))) {
      delete h.referer;
    }
    if (h.origin && (/^(about:|null$)/i.test(h.origin) || h.origin === self.location.origin)) {
      delete h.origin;
    }

    const method = String(ctx.method || 'GET').toUpperCase();
    const isMutating = !['GET', 'HEAD'].includes(method);

    // POST 等の状態変更リクエストや API 通信で Origin / Referer が欠けていると
    // CSRF 保護（Call of War ログイン・登録、G123 認証 API 等）で 400 / 403 エラーになるため補完する
    if (!h.referer) {
      h.referer = targetUrl.origin + '/';
    }
    if (isMutating && !h.origin) {
      try {
        h.origin = new URL(h.referer).origin;
      } catch (e) {
        h.origin = targetUrl.origin;
      }
    }

    if (!h['accept-language'] && navigator.language) {
      const langs = Array.isArray(navigator.languages) && navigator.languages.length
        ? navigator.languages.join(',')
        : navigator.language;
      h['accept-language'] = langs;
    }
  } catch (e) {}
});

// ── 2) レスポンス改変前フック（beforemod） ──
// - UV 標準の `uv.sw.js` は `Promise.resolve(t.cookie.setCookies(...))` を await せずに応答を返すため、
//   ログイン/登録 POST 直後のリダイレクトや次リクエスト・WebSocket で IndexedDB にまだ Cookie が書かれておらず、
//   セッションが剥がれる致命的な競合がある。ここで Set-Cookie を先に IndexedDB へ書き込み・通知まで完了させておけば
//   確定後に応答が返る。
// - DuckDuckGo 等が HTML を HTTP 202 Accepted で返す場合の 200 正規化
// - ES Module（`<script type="module">` / 動的 `import()`）の Strict MIME チェック失敗を防止
ir.on('beforemod', async (event) => {
  try {
    const resCtx = event.data;
    if (!resCtx || !resCtx.headers) return;
    const req = resCtx.request && resCtx.request.request;
    const dest = (req && req.destination) || '';
    const targetUrl = resCtx.url instanceof URL ? resCtx.url : new URL(String(resCtx.url));
    const ct = String(resCtx.getHeader('content-type') || '');

    // Set-Cookie の同期コミットを保証するために事前保存を保持（後段 response でも await できるよう Promise を記録）
    if (resCtx.headers['set-cookie'] && resCtx.ultraviolet && resCtx.ultraviolet.cookie) {
      const uv = resCtx.ultraviolet;
      const rawSetCookie = resCtx.headers['set-cookie'];
      delete resCtx.headers['set-cookie'];
      resCtx.__cookieCommitPromise = (async () => {
        try {
          const db = await uv.cookie.db();
          await uv.cookie.setCookies(rawSetCookie, db, uv.meta);
          const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
          for (const client of clients) {
            try { client.postMessage({ msg: 'updateCookies', url: uv.meta.url.href }); } catch (_) {}
          }
        } catch (_) {}
      })();
    }

    if (resCtx.status === 202 && /text\/html/i.test(ct) && (dest === 'document' || dest === 'iframe' || dest === 'frame')) {
      resCtx.status = 200;
      resCtx.statusText = 'OK';
    }

    const isJsPath = /\.(m?js|cjs)(\?|$)/i.test(targetUrl.pathname);
    if (dest === 'script' || dest === 'worker' || dest === 'sharedworker') {
      if (!ct || !JS_MIME_RE.test(ct)) {
        if (isJsPath || /javascript|ecmascript|text\/plain|octet-stream/i.test(ct)) {
          resCtx.headers['content-type'] = 'text/javascript; charset=utf-8';
        }
      }
    }
  } catch (e) {}
});

// ── 3) 最終レスポンスフック（response） ──
// - UV 標準の `content-disposition: inline; filename="..."` 自動付与バグ（ファイル保存ダイアログ誤爆）を除去
// - 圧縮関連ヘッダー・セキュリティ制限ヘッダーの完全除去（206 Partial Content のみ非圧縮時の content-length を維持）
// - SharedWorker（destination === 'sharedworker'）にも UV スクリプト注入と書き換えを適用
// - CORS 許可ヘッダーを付与し、プロキシ内からの fetch / フォント / WebGL アセット取得を全面許可
ir.on('response', (event) => {
  try {
    const resCtx = event.data;
    if (!resCtx || !resCtx.headers) return;
    const req = resCtx.request && resCtx.request.request;
    const dest = (req && req.destination) || '';
    const isDoc = dest === 'document' || dest === 'iframe' || dest === 'frame';

    delete resCtx.headers['content-encoding'];
    if (resCtx.status !== 206) {
      delete resCtx.headers['content-length'];
    }
    delete resCtx.headers['transfer-encoding'];

    for (const h of STRIP_SEC_RESPONSE_HEADERS) {
      delete resCtx.headers[h];
    }

    if (isDoc) {
      const cd = String(resCtx.getHeader('content-disposition') || '');
      if (/^\s*inline\b/i.test(cd)) {
        delete resCtx.headers['content-disposition'];
      }
    }

    resCtx.headers['access-control-allow-origin'] = '*';
    resCtx.headers['access-control-allow-credentials'] = 'true';
    resCtx.headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD';
    resCtx.headers['access-control-allow-headers'] = '*';
    resCtx.headers['access-control-expose-headers'] = '*';

    if (resCtx.__cookieCommitPromise) {
      const commitPromise = resCtx.__cookieCommitPromise;
      const status = resCtx.status;
      const statusText = resCtx.statusText;
      const headers = { ...resCtx.headers };
      const body = resCtx.body;
      event.respondWith((async () => {
        await commitPromise;
        return new Response(body, { status, statusText, headers });
      })());
    }
  } catch (e) {}
});

function sanitizeFinalResponse(res, dest) {
  if (!res || !res.headers) return res;
  const isDoc = dest === 'document' || dest === 'iframe' || dest === 'frame';
  const hasBadEnc = res.headers.has('content-encoding') || res.headers.has('transfer-encoding');
  const cd = (isDoc && res.headers.get('content-disposition')) || '';
  const hasInlineCd = isDoc && /^\s*inline\b/i.test(cd);
  if (!hasBadEnc && !hasInlineCd) return res;
  const headers = new Headers(res.headers);
  headers.delete('content-encoding');
  if (res.status !== 206) headers.delete('content-length');
  headers.delete('transfer-encoding');
  if (hasInlineCd) headers.delete('content-disposition');
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

// 書き換え漏れした相対パスが `/ir1-service/` 無しで同一オリジンへ飛んできた際、
// referrer が `/ir1-service/` 配下なら元サイトの URL に復元してプロキシへ救済ルーティングする
const APP_OWN_PREFIXES = [
  '/ir1/',
  '/ir1-service/',
  '/service/',
  '/service3/',
  '/bare/',
  '/baremux/',
  '/uv/',
  '/worksheets/',
  '/icons/',
  '/api/news',
  '/api/version',
  '/api/auth/',
  '/api/sns',
  '/api/push',
  '/sw.js',
  '/pwa-sw.js',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/__diag/',
];

function tryRescueUnrewrittenRequest(event) {
  try {
    const req = event.request;
    const reqUrl = new URL(req.url);
    if (reqUrl.origin !== self.location.origin) return null;
    const p = reqUrl.pathname;
    if (p === '/' || p === '/index.html') return null;
    for (const own of APP_OWN_PREFIXES) {
      if (p === own || p.startsWith(own)) return null;
    }
    const ref = req.referrer || '';
    if (!ref.startsWith(self.location.origin + __uv$config.prefix)) return null;
    const refTarget = __uv$config.decodeUrl(ref.slice((self.location.origin + __uv$config.prefix).length));
    if (!refTarget || !/^https?:\/\//i.test(refTarget)) return null;
    const refOrigin = new URL(refTarget).origin;
    const rescuedRemote = refOrigin + reqUrl.pathname + reqUrl.search;
    const rescuedProxyUrl = self.location.origin + __uv$config.prefix + __uv$config.encodeUrl(rescuedRemote);
    const init = {
      method: req.method,
      headers: req.headers,
      mode: req.mode === 'navigate' ? 'same-origin' : req.mode,
      credentials: req.credentials,
      redirect: req.redirect,
      referrer: req.referrer,
    };
    if (!['GET', 'HEAD'].includes(req.method.toUpperCase())) {
      init.body = req.body;
      init.duplex = 'half';
    }
    return new Request(rescuedProxyUrl, init);
  } catch (e) {
    return null;
  }
}

async function handleRequest(event) {
  if (event.request.method === 'OPTIONS' && ir.route(event)) {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD',
        'access-control-allow-headers': '*',
        'access-control-allow-credentials': 'true',
        'access-control-max-age': '86400',
      },
    });
  }

  if (ir.route(event)) {
    // YouTube が読み込む Web Animations ポリフィルはプロキシ内で
    // 「Cannot read properties of null (reading 'cancel')」を連発して描画を止める。
    // モダンブラウザは標準対応なので、ポリフィルだけ空スクリプトに差し替える。
    try {
      const remote = __uv$config.decodeUrl(event.request.url.slice((self.location.origin + __uv$config.prefix).length));
      if (/\/web-animations-next(-lite)?(\.min)?[^/]*\.js(\?|$)/i.test(remote) || /web-animations-next-lite\.min\.js/i.test(remote)) {
        return new Response('/* TheCollapse: web-animations polyfill disabled (native Web Animations used) */', {
          status: 200,
          headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' },
        });
      }
    } catch (e) {}
    const dest = event.request.destination;
    const res = await self.TCAdblock.wrap(
      event,
      () => ir.fetch(event),
      { prefix: __uv$config.prefix, decodeUrl: __uv$config.decodeUrl }
    );
    return sanitizeFinalResponse(res, dest);
  }

  const rescued = tryRescueUnrewrittenRequest(event);
  if (rescued) {
    const fakeEvent = { request: rescued };
    const dest = event.request.destination;
    const res = await self.TCAdblock.wrap(
      fakeEvent,
      () => ir.fetch(fakeEvent),
      { prefix: __uv$config.prefix, decodeUrl: __uv$config.decodeUrl }
    );
    return sanitizeFinalResponse(res, dest);
  }

  return await fetch(event.request);
}

self.addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event));
});
