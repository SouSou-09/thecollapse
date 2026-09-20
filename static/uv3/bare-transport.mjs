// bare-mux用トランスポート（bare v2旧ドラフト → /bare/）
// このサーバー(@nebula-services/bare-server-node)は旧v2ドラフト実装で:
// - x-bare-urlではなく x-bare-protocol/host/port/path の分解ヘッダーが必須
//   (protocolは ['http:','https:','ws:','wss:'] のコロン付き)
// - 上流へのメソッドは bareリクエスト自体のメソッドがそのまま使われる
//   (requestUtil.js: method: request.method) ので、GETはGETで送ること。
//   常にPOSTで送ると全リクエストが上流でPOST扱いになり405/404になる。
// またrequest()はpostMessageで複製可能なプレーンオブジェクト
// {body, status, statusText, headers} を返すこと（ResponseはDataCloneErrorになる）。
export default class BareTransport {
  constructor(_args) { this.base = '/bare/'; this.ready = false; }
  async init() { this.ready = true; console.log('[uv3] bare-transport v4 loaded'); }
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
    let outBody = r.body;
    const ce = String(outHeaders['content-encoding'] || '').toLowerCase();
    if ((ce === 'gzip' || ce === 'deflate') && outBody) {
      try {
        outBody = outBody.pipeThrough(new DecompressionStream(ce));
        delete outHeaders['content-encoding'];
        delete outHeaders['content-length'];
      } catch (e) {}
    }
    return {
      body: outBody,
      status,
      statusText: r.headers.get('x-bare-status-text') || '',
      headers: outHeaders,
    };
  }
  connect(_url, _protocols, _headers, _onopen, _onmessage, _onclose, _onerror) {
    throw new Error('WebSocket over /service3/ is not supported yet');
  }
}
