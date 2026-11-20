/*
 * XR V1: bare-mux SharedWorker（自己設定版）
 *
 * 標準の /baremux/worker.js は、ページ側が setTransport() を一度送った時にだけ通信方式（BareTransport）が
 * 設定される。ところが SharedWorker は
 *   - iPad / iPhone などでメモリ逼迫や長時間のバックグラウンドにより終了される
 *   - 全クライアントが閉じた後に再生成される
 * ことがあり、再生成された側には通信方式が設定されていない。
 * すると Service Worker からの全リクエストが「there are no bare clients」で即座（0〜30ms）に失敗し、
 * ページを再読み込みしても復旧しない（ニコニコ動画の再生中に全通信が FAILED になる現象）。
 *
 * → 起動した瞬間に自分で setTransport 相当を実行し、いつ再生成されても通信できる状態にする。
 */
importScripts('/baremux/worker.js');

(function () {
  var TRANSPORT = '/xr1/bare-transport.mjs?v=15';
  var originalOnConnect = self.onconnect;
  if (typeof originalOnConnect !== 'function') return;

  // bare-mux 本体のメッセージハンドラを内部ポートに接続し、そこへ "set" を送る
  var internal = new MessageChannel();
  var reply = new MessageChannel();
  reply.port1.onmessage = function () { /* set 完了通知（無視） */ };
  try {
    originalOnConnect({ ports: [internal.port1] });
    internal.port2.postMessage({
      message: {
        type: 'set',
        client: {
          function: 'const { default: BareTransport } = await import(' + JSON.stringify(TRANSPORT) + ');\n' +
            'return [BareTransport, ' + JSON.stringify(TRANSPORT) + '];',
          args: []
        }
      },
      port: reply.port2
    }, [reply.port2]);
  } catch (e) {
    console.error('[xr1] mux-worker auto-setup failed', e);
  }
})();
