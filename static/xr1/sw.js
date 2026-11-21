/*global UVServiceWorker,__uv$config*/
// TheCollapse: XR V1（UV V3ベース）用 Service Worker（広域互換・広告ブロック対応版）
importScripts('/xr1/xr.bundle.js');
importScripts('/xr1/xr.config.js');
importScripts(__uv$config.sw || '/xr1/xr.sw.js');
importScripts('/worksheets/adblock-rules.js');
importScripts('/worksheets/adblock-sw.js');
importScripts('/xr1/yt-diag.js');

const xr = new UVServiceWorker();

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

// ── YouTube BotGuard（attestation）対策 ──
// YouTube は BotGuard チャレンジを実行して得た integrity token から再生用の PO トークンを作る。
// チャレンジ発行（Create）とトークン発行（GenerateIT）は、リクエストの Origin / Referer と、チャレンジを実際に
// 実行したページのオリジンとの一致を検証する。プロキシ配下ではヘッダーが youtube.com、実行オリジンがプロキシに
// なるため検証に落ち、`GenerateIT` がフォールバックトークンしか返さない。正規の PO トークンが無いと動画サーバーは
// 先頭 60 秒分しか配信せず、エラーも出ないまま 59〜60 秒で再生が止まる。対策として:
//  1. Create / GenerateIT から Origin / Referer を外す（オリジンに束縛されないチャレンジになる）
//  2. HTML に `window.ytAtN({'R': '<att/get 応答 JSON>'})` で埋め込まれた発行済みチャレンジ
//     （bgChallenge。youtube.com に束縛済み）を除去
//  3. 埋め込みチャレンジ前提の共有インスタンス（html5_use_shared_owl_instance）を無効化し、
//     プレーヤー自身に 1. の Create を呼ばせる
const YT_ATT_HOST_RE = /(^|\.)(youtube\.com|youtube-nocookie\.com)$/i;
const YT_ATT_LITERAL_RE = /(ytAtN\(\s*\{\s*'R'\s*:\s*')((?:[^'\\]|\\[\s\S])*)(')/;
const YT_BG_HOST_RE = /(^|\.)(youtube\.com|youtube-nocookie\.com|googleapis\.com)$/i;
const YT_BG_PATH_RE = /\/(api\/jnn\/v1|\$rpc\/google\.internal\.waa\.v1\.Waa)\/(Create|GenerateIT)$/;
const YT_SHARED_BG_FLAG_RE = /(html5_use_shared_owl_instance(?:=|%3D|\\u003d|\\x3d))true/gi;

function decodeJsStringLiteral(lit) {
  return lit.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[\s\S])/g, (m, esc) => {
    if (esc[0] === 'x' || esc[0] === 'u') {
      return esc.length > 1 ? String.fromCharCode(parseInt(esc.slice(1), 16)) : esc;
    }
    switch (esc) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      case '0': return '\0';
      default: return esc;
    }
  });
}

function encodeJsStringLiteral(str) {
  return str.replace(/[^A-Za-z0-9 _.,:;!?*+@#$%^()~\-]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x100
      ? '\\x' + code.toString(16).padStart(2, '0')
      : '\\u' + code.toString(16).padStart(4, '0');
  });
}

function stripYtBgChallengeFromJson(text) {
  try {
    if (text.indexOf('bgChallenge') === -1) return text;
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || !data.bgChallenge) return text;
    delete data.bgChallenge;
    return JSON.stringify(data);
  } catch (e) {
    return text;
  }
}

function patchYtBotGuardHtml(html) {
  try {
    html = html.replace(YT_SHARED_BG_FLAG_RE, '$1false');
    if (html.indexOf('ytAtN') === -1 || html.indexOf('bgChallenge') === -1) return html;
    return html.replace(YT_ATT_LITERAL_RE, (m, head, lit, tail) => {
      const json = decodeJsStringLiteral(lit);
      const stripped = stripYtBgChallengeFromJson(json);
      return stripped === json ? m : head + encodeJsStringLiteral(stripped) + tail;
    });
  } catch (e) {
    return html;
  }
}

// ── 1) リクエスト送信前フック（request） ──
xr.on('request', (event) => {
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

    // YouTube BotGuard: Create / GenerateIT には Origin / Referer を付けない（理由は上の「YouTube BotGuard 対策」参照）
    if (method === 'POST' && YT_BG_HOST_RE.test(targetUrl.hostname) && YT_BG_PATH_RE.test(targetUrl.pathname)) {
      delete h.origin;
      delete h.referer;
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
xr.on('beforemod', async (event) => {
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

    // YouTube: ページ埋め込みの BotGuard チャレンジを除去（理由は上の「YouTube BotGuard 対策」参照）
    if (/text\/html/i.test(ct) && (dest === 'document' || dest === 'iframe' || dest === 'frame') &&
        YT_ATT_HOST_RE.test(targetUrl.hostname) && resCtx.raw && typeof resCtx.raw.text === 'function') {
      const raw = resCtx.raw;
      const origText = raw.text.bind(raw);
      raw.text = async () => patchYtBotGuardHtml(await origText());
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
xr.on('response', (event) => {
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

const IMA_SDK_RE = /^https?:\/\/imasdk\.googleapis\.com\/js\/sdkloader\//i;
const NICO_HOST_RE = /(^|\.)nicovideo\.jp$/i;

// リクエストを出したページ（プロキシ先）のホスト名。分からなければ空文字。
async function requestPageHost(event) {
  const base = self.location.origin + __uv$config.prefix;
  const hostOf = (url) => {
    try {
      if (!url || url.indexOf(base) !== 0) return '';
      return new URL(__uv$config.decodeUrl(url.slice(base.length).split('#')[0])).hostname;
    } catch (e) {
      return '';
    }
  };
  try {
    const client = event.clientId ? await self.clients.get(event.clientId) : null;
    const host = hostOf(client && client.url);
    if (host) return host;
  } catch (e) {}
  return hostOf(event.request.referrer);
}

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

// 書き換え漏れした相対パスが `/xr1-service/` 無しで同一オリジンへ飛んできた際、
// referrer が `/xr1-service/` 配下なら元サイトの URL に復元してプロキシへ救済ルーティングする
const APP_OWN_PREFIXES = [
  '/xr1/',
  '/xr1-service/',
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
  if (event.request.method === 'OPTIONS' && xr.route(event)) {
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

  if (xr.route(event)) {
    // YouTube が読み込む Web Animations ポリフィルはプロキシ内で
    // 「Cannot read properties of null (reading 'cancel')」を連発して描画を止める。
    // モダンブラウザは標準対応なので、ポリフィルだけ空スクリプトに差し替える。
    let remote = '';
    try {
      remote = __uv$config.decodeUrl(event.request.url.slice((self.location.origin + __uv$config.prefix).length));
      if (/\/web-animations-next(-lite)?(\.min)?[^/]*\.js(\?|$)/i.test(remote) || /web-animations-next-lite\.min\.js/i.test(remote)) {
        return new Response('/* TheCollapse: web-animations polyfill disabled (native Web Animations used) */', {
          status: 200,
          headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' },
        });
      }
      // ニコニコ動画: Google IMA SDK（動画広告）はプロキシ配下では広告を再生できず、完了・失敗の通知も返さない。
      // そのためプレロール広告の終了を待つプレーヤーが、本編を再生しないまま止まる。
      // SDK 本体を空スクリプトにして「広告なし」として本編へ進ませる（広告ブロックの ON/OFF に依存させない）。
      // `google.ima` 未定義を想定していないサイトを壊さないよう、動作確認済みのニコニコ動画のページに限定する。
      if (IMA_SDK_RE.test(remote) && NICO_HOST_RE.test(await requestPageHost(event))) {
        return new Response('/* TheCollapse: IMA SDK disabled (video ads cannot play through the proxy) */', {
          status: 200,
          headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
    } catch (e) {}
    const dest = event.request.destination;
    const ytDiag = self.TCYtDiag.begin(event.request, remote);
    let res = await self.TCAdblock.wrap(
      event,
      () => xr.fetch(event),
      { prefix: __uv$config.prefix, decodeUrl: __uv$config.decodeUrl }
    );
    if (ytDiag) { try { res = ytDiag(res) || res; } catch (e) {} }
    return sanitizeFinalResponse(res, dest);
  }

  const rescued = tryRescueUnrewrittenRequest(event);
  if (rescued) {
    const fakeEvent = { request: rescued };
    const dest = event.request.destination;
    const res = await self.TCAdblock.wrap(
      fakeEvent,
      () => xr.fetch(fakeEvent),
      { prefix: __uv$config.prefix, decodeUrl: __uv$config.decodeUrl }
    );
    return sanitizeFinalResponse(res, dest);
  }

  return await fetch(event.request);
}

self.addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event));
});
