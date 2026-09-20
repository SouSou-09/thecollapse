// BareTransport実装（TOMPHTTP bare v2プロトコル → /bare/）
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
    let bareHeaders = {};
    try { bareHeaders = JSON.parse(r.headers.get('x-bare-headers') || '{}'); } catch (e) {}
    const status = Number(r.headers.get('x-bare-status')) || r.status;
    const resp = new Response(r.body, { status, statusText: r.headers.get('x-bare-status-text') || undefined, headers: bareHeaders });
    resp.finalURL = String(remote);
    return resp;
  }
  connect(_url, _protocols, _headers, _onopen, _onmessage, _onclose, _onerror) {
    throw new Error('WebSocket over /service3/ is not supported yet');
  }
}
