// bare-mux用トランスポート（TOMPHTTP bare v2プロトコル → /bare/）
// 重要: request()は「Responseオブジェクト」ではなく、postMessageで構造化複製できる
// プレーンなオブジェクト {body, status, statusText, headers} を返すこと。
// Responseをそのまま返すとSharedWorker→SWのpostMessageでDataCloneErrorになる。
export default class BareTransport {
  constructor(_args) { this.base = '/bare/'; this.ready = false; }
  async init() { this.ready = true; }
  async request(remote, method, body, headers, _signal) {
    const h = {};
    for (const [k, v] of Object.entries(headers || {})) h[String(k).toLowerCase()] = v;
    const r = await fetch(this.base + 'v2/', {
      method: 'POST',
      headers: {
        'x-bare-url': String(remote),
        'x-bare-headers': JSON.stringify(h),
        'x-bare-forward-headers': '[]',
      },
      body: ['GET', 'HEAD'].includes(method) ? undefined : (body ?? undefined),
    });
    let outHeaders = {};
    try { outHeaders = JSON.parse(r.headers.get('x-bare-headers') || '{}'); } catch (e) {}
    const status = Number(r.headers.get('x-bare-status')) || r.status;
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
