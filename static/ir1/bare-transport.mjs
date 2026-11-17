// bare-mux用トランスポート（bare v2旧ドラフト → /bare/）
// このサーバー(@nebula-services/bare-server-node)は旧v2ドラフト実装で:
// - x-bare-urlではなく x-bare-protocol/host/port/path の分解ヘッダーが必須
//   (protocolは ['http:','https:','ws:','wss:'] のコロン付き)
// - 上流へのメソッドは bareリクエスト自体のメソッドがそのまま使われる
//   (requestUtil.js: method: request.method)
// ブラウザはfetch応答を自動解凍するため、ここで受け取るbodyは「解凍済み」。
// 一方content-encoding/content-lengthヘッダは圧縮時の値のまま残るため、
// 素通しすると「解凍済みbody+gzip宣言」の矛盾応答になりSW経由で壊れる。
// → この2つは必ず除去して返す。UV SW自身は解凍を持たない(0実装)。
// 【重要】bare-serverは上流へ setHost:false で送るため、x-bare-headersにhostが無いと
// Hostヘッダー無しのHTTPリクエストになり、Cloudflare配下のサイトは必ず400 Bad Requestを返す。
// v1のBareClientは自前でhostを付けていたが、v3(UV SW)は付けない → ここで必ず付与する。
// request()はpostMessageで複製可能なプレーンオブジェクト
// {body, status, statusText, headers} を返すこと（ResponseはDataCloneErrorになる）。
// bare は x-bare-headers が長い（約3000文字超）と x-bare-headers-0, -1 … に分割して送受信する（各値は先頭に ';'）。
// Cookie が多いサイトや長いヘッダーを返すサイトで、結合しないと全ヘッダーが失われページが壊れる。
const BARE_MAX = 3072;
function joinBareHeaders(res) {
  const direct = res.headers.get('x-bare-headers');
  if (direct != null) return direct;
  const parts = [];
  res.headers.forEach((v, k) => {
    const m = /^x-bare-headers-(\d+)$/.exec(k);
    if (m) parts[+m[1]] = v.startsWith(';') ? v.slice(1) : v;
  });
  return parts.length ? parts.join('') : '{}';
}
function splitBareHeaders(obj, json) {
  if (json.length <= BARE_MAX) { obj['x-bare-headers'] = json; return obj; }
  for (let i = 0, n = 0; i < json.length; i += BARE_MAX) obj['x-bare-headers-' + (n++)] = ';' + json.slice(i, i + BARE_MAX);
  return obj;
}
// bare 自体のエラー（x-bare-status が無い応答）は原因が分かるよう例外にする（UVのエラーページに表示される）
async function bareError(r) {
  let detail = '';
  try { const j = JSON.parse(await r.text()); detail = [j.code, j.id, j.message].filter(Boolean).join(' / '); } catch (_) {}
  return new Error('bare server error ' + r.status + (detail ? ': ' + detail : ''));
}

const STRIP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
]);

export default class BareTransport {
  constructor(_args) { this.base = '/bare/'; this.ready = false; }
  async init() { this.ready = true; console.log('[ir1] bare-transport v11 loaded'); }
  async request(remote, method, body, headers, _signal) {
    const u = new URL(String(remote));
    const m = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'].includes(method) ? method : 'GET';
    const h = {};
    for (const [k, v] of Object.entries(headers || {})) h[String(k).toLowerCase()] = v;
    h['host'] = u.host; // 非デフォルトポートも含む(例 example.com:8080)
    const r = await fetch(this.base + 'v2/', {
      method: m,
      headers: splitBareHeaders({
        'x-bare-protocol': u.protocol,
        'x-bare-host': u.hostname,
        'x-bare-port': String(u.port || (u.protocol === 'https:' ? 443 : 80)),
        'x-bare-path': u.pathname + u.search,
      }, JSON.stringify(h)),
      body: ['GET', 'HEAD'].includes(m) ? undefined : (body ?? undefined),
    });
    if (!r.headers.has('x-bare-status') && !r.ok) throw await bareError(r);
    let rawHeaders = {};
    try { rawHeaders = JSON.parse(joinBareHeaders(r)); } catch (e) {}
    const outHeaders = {};
    for (const [k, v] of Object.entries(rawHeaders || {})) {
      const lk = String(k).toLowerCase();
      if (STRIP_RESPONSE_HEADERS.has(lk)) continue;
      outHeaders[lk] = v;
    }
    const status = Number(r.headers.get('x-bare-status')) || r.status;
    outHeaders['x-ir1-transport'] = 'v11';
    return {
      body: r.body,
      status,
      statusText: r.headers.get('x-bare-status-text') || '',
      headers: outHeaders,
    };
  }
  // WebSocket(v9): bare v2 の手順で /bare/v2/ にトンネルする。
  //   1) GET  /bare/v2/ws-new-meta  … 接続先(remote)とヘッダーを登録しIDを受け取る
  //   2) WS   /bare/v2/             … Sec-WebSocket-Protocol にIDだけを入れて接続（サーバーが上流へ中継）
  //   3) GET  /bare/v2/ws-meta      … 上流が選んだサブプロトコルを x-bare-headers から取得
  // bare-mux は connect(url, protocols, headers, onopen, onmessage, onclose, onerror) を呼び、
  // [send(data), close(code, reason)] を返すことを期待する。
  // 注意: Origin など UV が渡すヘッダーは上流へそのまま送る（多くのゲームサーバーはOriginを検証する）。
  connect(url, protocols, headers, onopen, onmessage, onclose, onerror) {
    const u = new URL(String(url));
    const h = {};
    for (const [k, v] of Object.entries(headers || {})) h[String(k).toLowerCase()] = v;
    h['host'] = u.host;
    // bare v2 は上流へのアップグレード要求ヘッダーをクライアント側で指定する必要がある
    h['connection'] = 'Upgrade';
    h['upgrade'] = 'websocket';
    if (protocols && protocols.length) h['sec-websocket-protocol'] = protocols.join(', ');
    let ws = null, wantClose = null, done = false, opened = false;
    const queue = [], inbox = [];
    const fail = (e) => { if (!done) { done = true; try { onerror(e); } catch (_) {} } };
    (async () => {
      const m = await fetch(this.base + 'v2/ws-new-meta', {
        headers: splitBareHeaders({
          'x-bare-protocol': u.protocol,
          'x-bare-host': u.hostname,
          'x-bare-port': String(u.port || (u.protocol === 'wss:' ? 443 : 80)),
          'x-bare-path': u.pathname + u.search,
        }, JSON.stringify(h)),
      });
      if (!m.ok) throw new Error('ws-new-meta failed: ' + m.status);
      const id = await m.text();
      const base = (self.location.protocol === 'https:' ? 'wss://' : 'ws://') + self.location.host + this.base + 'v2/';
      ws = new WebSocket(base, [id]);
      ws.binaryType = 'arraybuffer';
      ws.onopen = async () => {
        let proto = '';
        try {
          const r = await fetch(this.base + 'v2/ws-meta', { headers: { 'x-bare-id': id } });
          const xh = joinBareHeaders(r);
          const hd = JSON.parse(xh);
          // 上流のヘッダー名は大文字小文字が混在する（Sec-WebSocket-Protocol）ため小文字化して引く
          let sp;
          for (const k of Object.keys(hd)) if (k.toLowerCase() === 'sec-websocket-protocol') sp = hd[k];
          proto = Array.isArray(sp) ? sp[0] : (sp || '');
        } catch (_) {}
        if (wantClose) { try { ws.close(wantClose[0], wantClose[1]); } catch (_) {} return; }
        opened = true;
        onopen(proto);
        // open より前に届いたメッセージ（接続直後にサーバーが送る初期データ）を順序どおり渡す
        while (inbox.length) onmessage(inbox.shift());
        while (queue.length) ws.send(queue.shift());
      };
      ws.onmessage = (e) => { if (opened) onmessage(e.data); else inbox.push(e.data); };
      ws.onclose = (e) => {
        done = true;
        // open前に閉じられた場合も、受信済みデータを先に渡してから閉じる
        if (!opened) { opened = true; try { onopen(''); } catch (_) {} while (inbox.length) onmessage(inbox.shift()); }
        onclose(e.code, e.reason);
      };
      ws.onerror = () => fail('WebSocket error');
    })().catch(fail);
    const send = (data) => {
      if (ws && ws.readyState === 1) ws.send(data); else queue.push(data);
    };
    const close = (code, reason) => {
      if (ws && ws.readyState <= 1) { try { ws.close(code, reason); } catch (_) {} } else wantClose = [code, reason];
    };
    return [send, close];
  }
}
