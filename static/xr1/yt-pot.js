/* TheCollapse: YouTube の再生トークン（PO トークン）をサーバー発行のものへ載せ替える（Service Worker 側）
   プロキシ配下のページが発行したトークンは動画サーバーに有効と認められず、60 秒で配信が止まる
   （理由は /yt-pot.js 参照）。動画データの要求(SABR)に入っているトークンを、サーバーが動画 ID に
   束縛して発行したものへ差し替える。動画 ID が分からない・発行できないときは要求を変えない。 */
(function () {
  'use strict';

  var VP_RE = /^https:\/\/[^/]*\.googlevideo\.com\/videoplayback\?/i;
  var YT_RE = /^https:\/\/[^/]*\.youtube(-nocookie)?\.com\//i;
  var PLAYER_RE = /\/youtubei\/v1\/player(\?|$)/;
  var ID_RE = /^[A-Za-z0-9_-]{11}$/;
  var PAGE_ID_RE = /^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/;
  var TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
  var RETRY_MS = 30 * 1000;
  var FETCH_TIMEOUT_MS = 8000;
  var MAX_ENTRIES = 200;
  // 動画 ID 束縛のトークンは 90 バイト前後。これより長いものは別の値（訪問者データ等）に束縛されている
  var MAX_VIDEO_BOUND_TOKEN = 110;

  var cpnToVideo = new Map(); // 再生ごとの ID(cpn) -> 動画 ID
  var tokens = new Map();     // 動画 ID -> { promise, at }

  function put(map, key, value) {
    map.delete(key);
    if (map.size >= MAX_ENTRIES) map.delete(map.keys().next().value);
    map.set(key, value);
  }
  function param(url, name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(url);
    return m ? m[1] : '';
  }
  function remember(cpn, videoId) {
    if (cpn && ID_RE.test(videoId)) put(cpnToVideo, cpn, videoId);
  }

  // YouTube 宛ての通信から「再生ごとの ID -> 動画 ID」を覚える
  function learn(request, remote) {
    try {
      if (!YT_RE.test(remote)) return;
      remember(param(remote, 'cpn'), param(remote, 'docid') || param(remote, 'video_id'));
      if (request.method === 'POST' && PLAYER_RE.test(remote)) {
        request.clone().json().then(function (body) {
          if (body) remember(body.cpn, body.videoId);
        }).catch(function () {});
      }
    } catch (e) {}
  }

  function videoIdFromPage(proxied) {
    try {
      var base = self.location.origin + __uv$config.prefix;
      if (!proxied || proxied.indexOf(base) !== 0) return '';
      var url = new URL(__uv$config.decodeUrl(proxied.slice(base.length).split('#')[0]));
      if (!YT_RE.test(url.href)) return '';
      var id = url.pathname === '/watch' ? url.searchParams.get('v') || '' : (PAGE_ID_RE.exec(url.pathname) || [])[1] || '';
      return ID_RE.test(id) ? id : '';
    } catch (e) {
      return '';
    }
  }

  async function resolveVideoId(event, remote) {
    var id = cpnToVideo.get(param(remote, 'cpn')) || videoIdFromPage(event.request.referrer);
    if (id) return id;
    try {
      var client = event.clientId ? await self.clients.get(event.clientId) : null;
      return videoIdFromPage(client && client.url);
    } catch (e) {
      return '';
    }
  }

  function fromBase64Url(text) {
    var bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function fetchToken(videoId) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, FETCH_TIMEOUT_MS);
    return fetch('/xr1/yt-pot?v=' + videoId, { signal: ctl.signal, cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (body) {
      var token = fromBase64Url(String(body.token || ''));
      if (!token.length) throw new Error('empty token');
      return token;
    }).finally(function () {
      clearTimeout(timer);
    });
  }

  // 失敗は null（短時間だけ覚えて、毎回の要求を待たせない）
  function getToken(videoId) {
    var hit = tokens.get(videoId);
    if (hit && Date.now() - hit.at < (hit.failed ? RETRY_MS : TOKEN_TTL_MS)) return hit.promise;
    var entry = { at: Date.now(), failed: false, promise: null };
    entry.promise = fetchToken(videoId).catch(function () {
      entry.failed = true;
      return null;
    });
    put(tokens, videoId, entry);
    return entry.promise;
  }

  /* ── protobuf の最小限の読み書き ── */
  function readVarint(buf, pos) {
    var v = 0, s = 1, c;
    do {
      if (pos >= buf.length) return null;
      c = buf[pos++];
      v += (c & 0x7f) * s;
      s *= 128;
    } while (c & 0x80);
    return [v, pos];
  }
  function writeVarint(v) {
    var out = [];
    while (v > 0x7f) { out.push((v % 128) | 0x80); v = Math.floor(v / 128); }
    out.push(v);
    return out;
  }
  // 最上位のフィールドを [番号, ワイヤ型, 開始, 値の開始, 終了] で列挙する。壊れていたら null。
  function scan(buf) {
    var out = [], p = 0;
    while (p < buf.length) {
      var start = p, key = readVarint(buf, p);
      if (!key) return null;
      var wire = key[0] & 7, field = Math.floor(key[0] / 8), body = key[1], end;
      if (wire === 0) { var v = readVarint(buf, body); if (!v) return null; end = v[1]; }
      else if (wire === 1) end = body + 8;
      else if (wire === 5) end = body + 4;
      else if (wire === 2) { var len = readVarint(buf, body); if (!len) return null; body = len[1]; end = body + len[0]; }
      else return null;
      if (end > buf.length) return null;
      out.push([field, wire, start, body, end]);
      p = end;
    }
    return out;
  }
  function concat(parts) {
    var size = 0, i;
    for (i = 0; i < parts.length; i++) size += parts[i].length;
    var out = new Uint8Array(size), p = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], p); p += parts[i].length; }
    return out;
  }
  function lengthDelimited(field, payload) {
    return concat([writeVarint(field * 8 + 2), writeVarint(payload.length), payload]);
  }
  function find(fields, n) {
    for (var i = 0; i < fields.length; i++) if (fields[i][0] === n && fields[i][1] === 2) return fields[i];
    return null;
  }

  // VideoPlaybackAbrRequest.streamer_context(19).po_token(2) を差し替える。対象外なら null。
  function replacePoToken(buf, token) {
    var top = scan(buf);
    var ctx = top && find(top, 19);
    if (!ctx) return null;
    var inner = buf.subarray(ctx[3], ctx[4]);
    var fields = scan(inner);
    if (!fields) return null;
    var po = find(fields, 2);
    var encoded = lengthDelimited(2, token);
    var newInner;
    if (po) {
      if (inner[po[3]] === 0x32 && po[4] - po[3] > MAX_VIDEO_BOUND_TOKEN) return null;
      newInner = concat([inner.subarray(0, po[2]), encoded, inner.subarray(po[4])]);
    } else {
      newInner = concat([inner, encoded]);
    }
    return concat([buf.subarray(0, ctx[2]), lengthDelimited(19, newInner), buf.subarray(ctx[4])]);
  }

  async function replaceInRequest(event, remote) {
    var request = event.request;
    var videoId = await resolveVideoId(event, remote);
    if (!videoId) return { request: null, note: 'srv=noid' };
    var token = await getToken(videoId);
    if (!token) return { request: null, note: 'srv=fail' };
    var body = replacePoToken(new Uint8Array(await request.clone().arrayBuffer()), token);
    if (!body) return { request: null, note: 'srv=skip' };
    var init = {
      method: 'POST',
      headers: request.headers,
      body: body,
      mode: request.mode === 'navigate' ? 'same-origin' : request.mode,
      credentials: request.credentials,
      signal: request.signal,
    };
    // 上流へ送る Referer の元になるので引き継ぐ
    if (request.referrer && request.referrer.indexOf(self.location.origin) === 0) init.referrer = request.referrer;
    return { request: new Request(request.url, init), note: 'srv=ok' };
  }

  self.TCYtPot = {
    /* 動画データの要求なら、トークンを載せ替えた Request を作る。
       戻り値: 対象外は null。対象なら Promise<{ request, note }>（request は載せ替えできなかったら null、
       note は診断ログ用: srv=ok / noid(動画 ID 不明) / fail(発行失敗) / skip(載せ替え対象外) / err）。 */
    prepare: function (event, remote) {
      learn(event.request, remote);
      if (event.request.method !== 'POST' || !VP_RE.test(remote)) return null;
      return replaceInRequest(event, remote).catch(function () {
        return { request: null, note: 'srv=err' };
      });
    },
  };
})();
