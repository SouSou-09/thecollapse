// bare-mux用トランスポート（bare v2 / v3 → /bare/）
// - HTTP: bare v2 (`/bare/v2/`) を使用。206 Partial Content / 304 Not Modified を x-bare-pass-status で維持し、
//   動画・音声・ゲームバイナリアセットの Range リクエストに対応する。
//   ブラウザ fetch が自動解凍した body に対して圧縮時の content-encoding / content-length / transfer-encoding が
//   残ると二重解凍・長さ不一致になるため除去する。
// - WebSocket: bare v3（`/bare/v3/`・1往復・Cookie 自動付与・Set-Cookie 永続化）を優先使用し、
//   ハンドシェイク失敗時は bare v2（`/bare/v2/ws-new-meta` + `/bare/v2/`）へ自動フォールバックする。
//   ArrayBufferView / Blob / ArrayBuffer いずれのバイナリ送受信も正確に保つ。

const BARE_MAX = 3072;

function joinBareHeaders(res) {
  const direct = res.headers.get('x-bare-headers');
  if (direct != null) return direct;
  const parts = [];
  res.headers.forEach((v, k) => {
    const m = /^x-bare-headers-(\d+)$/i.exec(k);
    if (m) parts[+m[1]] = v.startsWith(';') ? v.slice(1) : v;
  });
  return parts.length ? parts.join('') : '{}';
}

function splitBareHeaders(obj, json) {
  if (json.length <= BARE_MAX) {
    obj['x-bare-headers'] = json;
    return obj;
  }
  for (let i = 0, n = 0; i < json.length; i += BARE_MAX) {
    obj['x-bare-headers-' + (n++)] = ';' + json.slice(i, i + BARE_MAX);
  }
  return obj;
}

async function bareError(r) {
  let detail = '';
  try {
    const j = JSON.parse(await r.text());
    detail = [j.code, j.id, j.message].filter(Boolean).join(' / ');
  } catch (_) {}
  return new Error('bare server error ' + r.status + (detail ? ': ' + detail : ''));
}

const STRIP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

// WebSocket ハンドシェイク時に IndexedDB ('__op' / 'cookies') から該当ホストの Cookie を読み出して付与する。
// （Call of War・G123・雀魂等のゲームサーバーは WS Upgrade 時の Cookie でセッション認証を行うため必須）
function matchCookieForWs(cookie, urlObj) {
  if (!cookie || !cookie.name) return false;
  const now = Date.now();
  if (cookie.set) {
    const setMs = new Date(cookie.set).getTime();
    if (!isNaN(setMs) && cookie.maxAge != null && cookie.maxAge !== '') {
      const ma = Number(cookie.maxAge);
      if (!isNaN(ma) && setMs + ma * 1000 < now) return false;
    }
  }
  if (cookie.expires) {
    const expMs = new Date(cookie.expires).getTime();
    if (!isNaN(expMs) && expMs < now) return false;
  }
  const host = String(urlObj.hostname || '').toLowerCase();
  const rawDom = String(cookie.domain || '').toLowerCase();
  const dom = rawDom.startsWith('.') ? rawDom.slice(1) : rawDom;
  if (!host || !dom) return false;
  if (rawDom.startsWith('.')) {
    if (host !== dom && !host.endsWith('.' + dom)) return false;
  } else {
    if (host !== dom) return false;
  }
  if (cookie.secure && urlObj.protocol === 'ws:') return false;
  const cPath = cookie.path || '/';
  const reqPath = urlObj.pathname || '/';
  if (cPath !== '/' && reqPath !== cPath && !reqPath.startsWith(cPath.endsWith('/') ? cPath : cPath + '/')) {
    return false;
  }
  return true;
}

function openCookieDb() {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let settled = false;
    const done = (db) => { if (!settled) { settled = true; resolve(db || null); } };
    const timer = setTimeout(() => done(null), 800);
    try {
      const req = indexedDB.open('__op', 1);
      req.onupgradeneeded = (e) => {
        try {
          const store = e.target.result.createObjectStore('cookies', { keyPath: 'id' });
          store.createIndex('path', 'path');
        } catch (_) {}
      };
      req.onerror = () => { clearTimeout(timer); done(null); };
      req.onsuccess = () => { clearTimeout(timer); done(req.result); };
    } catch (_) {
      clearTimeout(timer);
      done(null);
    }
  });
}

async function readCookiesForWs(urlObj) {
  const db = await openCookieDb();
  if (!db) return '';
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        try { db.close(); } catch (_) {}
        resolve(v || '');
      }
    };
    const timer = setTimeout(() => done(''), 800);
    try {
      const tx = db.transaction('cookies', 'readonly');
      const getAll = tx.objectStore('cookies').getAll();
      getAll.onsuccess = () => {
        clearTimeout(timer);
        const list = Array.isArray(getAll.result) ? getAll.result : [];
        const pairs = [];
        for (const c of list) {
          if (matchCookieForWs(c, urlObj)) {
            pairs.push(`${c.name}=${c.value}`);
          }
        }
        done(pairs.join('; '));
      };
      getAll.onerror = () => { clearTimeout(timer); done(''); };
    } catch (_) {
      clearTimeout(timer);
      done('');
    }
  });
}

function parseSetCookieHeader(raw, urlObj) {
  if (!raw || typeof raw !== 'string') return null;
  const parts = raw.split(';').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const eq = parts[0].indexOf('=');
  if (eq <= 0) return null;
  const cookie = {
    name: parts[0].slice(0, eq).trim(),
    value: parts[0].slice(eq + 1).trim(),
    domain: urlObj.hostname,
    path: '/',
    httpOnly: false,
    secure: false,
    set: new Date().toISOString(),
  };
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    const idx = p.indexOf('=');
    const k = (idx >= 0 ? p.slice(0, idx) : p).trim().toLowerCase();
    const v = idx >= 0 ? p.slice(idx + 1).trim() : '';
    if (k === 'domain' && v) cookie.domain = v;
    else if (k === 'path' && v) cookie.path = v;
    else if (k === 'expires' && v) {
      const d = new Date(v);
      if (!isNaN(d.getTime())) cookie.expires = d.toISOString();
    } else if (k === 'max-age' && v) {
      const n = Number(v);
      if (!isNaN(n)) cookie.maxAge = n;
    } else if (k === 'secure') cookie.secure = true;
    else if (k === 'httponly') cookie.httpOnly = true;
    else if (k === 'samesite' && v) cookie.sameSite = v;
  }
  cookie.id = `${cookie.domain}@${cookie.path}@${cookie.name}`;
  return cookie;
}

async function saveWsSetCookies(setCookies, urlObj) {
  if (!Array.isArray(setCookies) || !setCookies.length) return;
  const db = await openCookieDb();
  if (!db) return;
  try {
    const tx = db.transaction('cookies', 'readwrite');
    const store = tx.objectStore('cookies');
    for (const raw of setCookies) {
      const parsed = parseSetCookieHeader(raw, urlObj);
      if (parsed) store.put(parsed);
    }
    await new Promise((resolve) => {
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    });
  } catch (_) {
  } finally {
    try { db.close(); } catch (_) {}
  }
}

async function normalizeBody(body, method) {
  if (['GET', 'HEAD'].includes(method) || body == null) return undefined;
  // SharedWorker 内での fetch(..., { body: ReadableStream }) は duplex:'half' が必須かつ
  // 一部環境で失敗するため、ArrayBuffer に実体化して確実に送信する
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    try {
      return await new Response(body).arrayBuffer();
    } catch (_) {
      return undefined;
    }
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    try {
      return await body.arrayBuffer();
    } catch (_) {
      return body;
    }
  }
  return body;
}

function normalizeWsOutgoing(data) {
  if (typeof data === 'string' || data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  return data;
}

const HOP_BY_HOP_REQ_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
]);

export default class BareTransport {
  constructor(_args) {
    this.base = '/bare/';
    this.ready = false;
  }

  async init() {
    this.ready = true;
    console.log('[ir1] bare-transport v13 loaded');
  }

  async request(remote, method, body, headers, signal) {
    const u = new URL(String(remote));
    const upperMethod = String(method || 'GET').toUpperCase();
    const m = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'].includes(upperMethod) ? upperMethod : 'GET';
    const h = {};
    for (const [k, v] of Object.entries(headers || {})) {
      const lk = String(k).toLowerCase();
      if (HOP_BY_HOP_REQ_HEADERS.has(lk)) continue;
      if (v != null) h[lk] = v;
    }
    h['host'] = u.host;
    h['accept-encoding'] = 'gzip, deflate';

    const preparedBody = await normalizeBody(body, m);

    const bareReqHeaders = splitBareHeaders({
      'x-bare-protocol': u.protocol,
      'x-bare-host': u.hostname,
      'x-bare-port': String(u.port || (u.protocol === 'https:' ? 443 : 80)),
      'x-bare-path': u.pathname + u.search,
      'x-bare-pass-status': '206, 304',
    }, JSON.stringify(h));

    const fetchInit = {
      method: m,
      headers: bareReqHeaders,
      body: preparedBody,
      // bare は全リクエストが同一URLなのでブラウザのHTTPキャッシュを絶対に使わない（別サイトの応答が混ざる）
      cache: 'no-store',
    };
    if (signal) fetchInit.signal = signal;

    const r = await fetch(this.base + 'v2/', fetchInit);
    if (!r.headers.has('x-bare-status') && r.status !== 304 && !r.ok) throw await bareError(r);

    let rawHeaders = {};
    try { rawHeaders = JSON.parse(joinBareHeaders(r)); } catch (_) {}

    const status = Number(r.headers.get('x-bare-status')) || r.status;
    const outHeaders = {};
    for (const [k, v] of Object.entries(rawHeaders || {})) {
      const lk = String(k).toLowerCase();
      if (STRIP_RESPONSE_HEADERS.has(lk)) {
        // 206 Partial Content（Range 指定の無圧縮バイナリ応答）かつ上流が非圧縮の場合のみ content-length を保持
        if (lk === 'content-length' && status === 206 && !rawHeaders['content-encoding'] && !rawHeaders['Content-Encoding']) {
          outHeaders[lk] = v;
        }
        continue;
      }
      outHeaders[lk] = v;
    }
    outHeaders['x-ir1-transport'] = 'v13';

    return {
      body: [101, 204, 205, 304].includes(status) ? null : r.body,
      status,
      statusText: r.headers.get('x-bare-status-text') || '',
      headers: outHeaders,
    };
  }

  // WebSocket (v13): bare v3 プロトコル（/bare/v3/）優先 + bare v2 自動フォールバック + Cookie 読み書き完全対応
  connect(url, protocols, headers, onopen, onmessage, onclose, onerror) {
    const u = new URL(String(url));
    const protoList = Array.isArray(protocols) ? protocols.map(String).filter(Boolean) : (protocols ? [String(protocols)] : []);
    let ws = null;
    let wantClose = null;
    let closed = false;
    let handshakeDone = false;
    const queue = [];

    const safeCloseCode = (c) => {
      const n = Number(c);
      if (n === 1000 || (n >= 3000 && n <= 4999)) return n;
      return 1000;
    };

    const fail = (err) => {
      if (closed) return;
      closed = true;
      try { onerror(err); } catch (_) {}
      try { onclose(1006, ''); } catch (_) {}
    };

    const deliverMessage = (data) => {
      if (data instanceof Blob) {
        data.arrayBuffer().then((ab) => {
          if (!closed) {
            try { onmessage(ab); } catch (_) {}
          }
        }).catch(() => {});
        return;
      }
      if (ArrayBuffer.isView(data)) {
        const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        try { onmessage(ab); } catch (_) {}
        return;
      }
      try { onmessage(data); } catch (_) {}
    };

    const flushQueue = () => {
      while (queue.length && ws && ws.readyState === WebSocket.OPEN) {
        const item = queue.shift();
        if (item instanceof Blob) {
          item.arrayBuffer().then((ab) => {
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(ab);
          }).catch(() => {});
        } else {
          ws.send(normalizeWsOutgoing(item));
        }
      }
    };

    const connectV2Fallback = async (reqHeaders) => {
      const v2SendHeaders = { ...reqHeaders };
      if (protoList.length) {
        v2SendHeaders['Sec-WebSocket-Protocol'] = protoList.join(', ');
      }
      const metaRes = await fetch(this.base + 'v2/ws-new-meta', {
        method: 'GET',
        headers: splitBareHeaders({
          'x-bare-protocol': u.protocol,
          'x-bare-host': u.hostname,
          'x-bare-port': String(u.port || (u.protocol === 'wss:' ? 443 : 80)),
          'x-bare-path': u.pathname + u.search,
          'x-bare-forward-headers': 'accept-language',
        }, JSON.stringify(v2SendHeaders)),
        cache: 'no-store',
      });
      if (!metaRes.ok) throw await bareError(metaRes);
      const id = (await metaRes.text()).trim();
      if (!id) throw new Error('Empty bare v2 ws meta id');

      if (wantClose) {
        closed = true;
        try { onclose(safeCloseCode(wantClose[0]), wantClose[1] || ''); } catch (_) {}
        return;
      }

      const wsEndpoint = (self.location.protocol === 'https:' ? 'wss://' : 'ws://') + self.location.host + this.base + 'v2/';
      ws = new WebSocket(wsEndpoint, [id]);
      ws.binaryType = 'arraybuffer';

      ws.onopen = async () => {
        if (wantClose) {
          try { ws.close(safeCloseCode(wantClose[0]), wantClose[1] || ''); } catch (_) {}
          return;
        }
        let negotiatedProto = '';
        try {
          const mr = await fetch(this.base + 'v2/ws-meta', {
            method: 'GET',
            headers: { 'x-bare-id': id },
            cache: 'no-store',
          });
          if (mr.ok) {
            const metaJson = await mr.json();
            const rh = (metaJson && metaJson.headers) || {};
            for (const [hk, hv] of Object.entries(rh)) {
              if (hk.toLowerCase() === 'sec-websocket-protocol' && hv) {
                negotiatedProto = Array.isArray(hv) ? String(hv[0] || '') : String(hv);
              } else if (hk.toLowerCase() === 'set-cookie' && hv) {
                saveWsSetCookies(Array.isArray(hv) ? hv : [hv], u).catch(() => {});
              }
            }
          }
        } catch (_) {}
        handshakeDone = true;
        try { onopen(negotiatedProto); } catch (_) {}
        flushQueue();
      };

      ws.onmessage = (ev) => {
        if (!handshakeDone) return;
        deliverMessage(ev.data);
      };

      ws.onclose = (ev) => {
        if (closed) return;
        closed = true;
        if (!handshakeDone) {
          try { onerror(new Error('Bare v2 WebSocket closed before open')); } catch (_) {}
        }
        try { onclose(ev.code || 1005, ev.reason || ''); } catch (_) {}
      };

      ws.onerror = () => {
        if (!handshakeDone) {
          fail(new Error('Bare v2 WebSocket error'));
        } else {
          try { onerror(new Error('WebSocket error')); } catch (_) {}
        }
      };
    };

    (async () => {
      const reqHeaders = {};
      for (const [k, v] of Object.entries(headers || {})) {
        if (v == null) continue;
        const lk = k.toLowerCase();
        if (lk === 'connection' || lk === 'upgrade' || lk === 'sec-websocket-key' || lk === 'sec-websocket-version') continue;
        reqHeaders[k] = String(v);
      }
      if (!Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'host')) {
        reqHeaders['Host'] = u.host;
      }
      if (!Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'origin')) {
        reqHeaders['Origin'] = (u.protocol === 'wss:' ? 'https://' : 'http://') + u.host;
      }
      if (!Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'user-agent') && typeof navigator !== 'undefined' && navigator.userAgent) {
        reqHeaders['User-Agent'] = navigator.userAgent;
      }
      if (!Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'cookie')) {
        const ck = await readCookiesForWs(u);
        if (ck) reqHeaders['Cookie'] = ck;
      }

      if (wantClose) {
        closed = true;
        try { onclose(safeCloseCode(wantClose[0]), wantClose[1] || ''); } catch (_) {}
        return;
      }

      const wsEndpoint = (self.location.protocol === 'https:' ? 'wss://' : 'ws://') + self.location.host + this.base + 'v3/';
      let fallbackTriggered = false;
      const tryFallback = (reasonErr) => {
        if (fallbackTriggered || handshakeDone || closed || wantClose) return;
        fallbackTriggered = true;
        try { if (ws) ws.close(); } catch (_) {}
        ws = null;
        connectV2Fallback(reqHeaders).catch(() => fail(reasonErr || new Error('WebSocket connection failed')));
      };

      ws = new WebSocket(wsEndpoint);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        if (wantClose) {
          try { ws.close(safeCloseCode(wantClose[0]), wantClose[1] || ''); } catch (_) {}
          return;
        }
        try {
          ws.send(JSON.stringify({
            type: 'connect',
            remote: u.toString(),
            protocols: protoList,
            headers: reqHeaders,
            forwardHeaders: ['accept-language'],
          }));
        } catch (e) {
          tryFallback(e);
        }
      };

      ws.onmessage = (ev) => {
        if (!handshakeDone) {
          let pkt = null;
          try {
            pkt = typeof ev.data === 'string' ? JSON.parse(ev.data) : null;
          } catch (_) {
            pkt = null;
          }
          if (!pkt || pkt.type !== 'open') {
            tryFallback(new Error('Bare v3 WS handshake failed'));
            return;
          }
          handshakeDone = true;
          if (Array.isArray(pkt.setCookies) && pkt.setCookies.length) {
            saveWsSetCookies(pkt.setCookies, u).catch(() => {});
          }
          try { onopen(pkt.protocol || ''); } catch (_) {}
          flushQueue();
          return;
        }
        deliverMessage(ev.data);
      };

      ws.onclose = (ev) => {
        if (fallbackTriggered) return;
        if (!handshakeDone && !wantClose) {
          tryFallback(new Error('WebSocket closed before open'));
          return;
        }
        if (closed) return;
        closed = true;
        try { onclose(ev.code || 1005, ev.reason || ''); } catch (_) {}
      };

      ws.onerror = () => {
        if (fallbackTriggered) return;
        if (!handshakeDone && !wantClose) {
          tryFallback(new Error('WebSocket error before open'));
        } else if (handshakeDone) {
          try { onerror(new Error('WebSocket error')); } catch (_) {}
        }
      };
    })().catch(fail);

    const send = (data) => {
      if (ws && handshakeDone && ws.readyState === WebSocket.OPEN) {
        if (data instanceof Blob) {
          data.arrayBuffer().then((ab) => {
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(ab);
          }).catch(() => {});
        } else {
          ws.send(normalizeWsOutgoing(data));
        }
      } else if (!closed) {
        queue.push(data);
      }
    };

    const close = (code, reason) => {
      const c = safeCloseCode(code);
      const r = typeof reason === 'string' ? reason.slice(0, 120) : '';
      wantClose = [c, r];
      if (ws && ws.readyState <= WebSocket.OPEN) {
        try { ws.close(c, r); } catch (_) { try { ws.close(); } catch (_2) {} }
      }
    };

    return [send, close];
  }
}
