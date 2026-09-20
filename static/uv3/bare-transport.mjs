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
// request()はpostMessageで複製可能なプレーンオブジェクト
// {body, status, statusText, headers} を返すこと（ResponseはDataCloneErrorになる）。
export default class BareTransport {
  constructor(_args) { this.base = '/bare/'; this.ready = false; }
  async init() { this.ready = true; console.log('[uv3] bare-transport v7 loaded'); }
  async request(remote, method, body, headers, _signal) {
    const u = new URL(String(remote));
    const m = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'].includes(method) ? method : 'GET';
    const h = {};
    for (const [k, v] of Object.entries(headers || {})) h[String(k).toLowerCase()] = v;
    const r = await fetch(this.base + 'v2/', {
      method: m,
      headers: {
        'x-bare-protocol': u.protocol,
        'x-bare-host': u.hostname,
        'x-bare-port': String(u.port || (u.protocol === 'https:' ? 443 : 80)),
        'x-bare-path': u.pathname + u.search,
        'x-bare-headers': JSON.stringify(h),
      },
      body: ['GET', 'HEAD'].includes(m) ? undefined : (body ?? undefined),
    });
    let outHeaders = {};
    try { outHeaders = JSON.parse(r.headers.get('x-bare-headers') || '{}'); } catch (e) {}
    const status = Number(r.headers.get('x-bare-status')) || r.status;
    delete outHeaders['content-encoding'];
    delete outHeaders['content-length'];
    delete outHeaders['transfer-encoding'];
    outHeaders['x-uv3-transport'] = 'v7';
    return {
      body: r.body,
      status,
      statusText: r.headers.get('x-bare-status-text') || '',
      headers: outHeaders,
    };
  }
  connect(_url, _protocols, _headers, _onopen, _onmessage, _onclose, _onerror) {
    throw new Error('WebSocket over /service3/ is not supported yet');
  }
}
