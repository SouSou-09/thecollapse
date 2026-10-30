/* =====================================================================
   TheCollapse 広告ブロック: Service Worker 側 (v2.3.0)
   従来の広告ブロックはページ読み込み後にDOMを隠すだけで、広告の通信も
   スクリプト実行も止められなかった（読み込み後1.5秒/4秒で走査していたため
   表示済み広告・ポップアップ・追跡が残った）。
   ここではプロキシのService Worker内で
     1) 広告URLへのリクエストをネットワークに出す前に遮断
     2) HTMLの先頭に非表示CSSを注入（描画前から広告枠を隠す）
   を行う。ON/OFFはページからpostMessageで受け取りCache Storageに保存する。
   読み込み順: adblock-rules.js → このファイル
   ===================================================================== */
(function () {
  var CACHE = 'tc-ext-v1', KEY = '/__tc_adblock';
  var enabled = true, loaded = false;

  async function load() {
    try {
      var c = await caches.open(CACHE);
      var r = await c.match(KEY);
      if (r) enabled = (await r.text()) !== '0';
    } catch (e) {}
    loaded = true;
  }
  self.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.type !== 'tc-adblock') return;
    enabled = !!d.enabled; loaded = true;
    var p = caches.open(CACHE)
      .then(function (c) { return c.put(KEY, new Response(enabled ? '1' : '0')); })
      .catch(function () {});
    if (e.waitUntil) e.waitUntil(p);
  });

  function decodeTarget(url, cfg) {
    try {
      var base = self.location.origin + cfg.prefix;
      if (url.indexOf(base) !== 0) return null;
      var rest = url.slice(base.length).split('#')[0];
      var dec = cfg.decodeUrl(rest);
      return (typeof dec === 'string' && /^https?:\/\//i.test(dec)) ? dec : null;
    } catch (e) { return null; }
  }

  function blockedResponse(dest) {
    var h = { 'x-tc-adblock': 'blocked', 'cache-control': 'no-store' };
    switch (dest) {
      case 'script': case 'worker': case 'sharedworker':
        h['content-type'] = 'application/javascript'; return new Response('/* blocked by TheCollapse */', { status: 200, headers: h });
      case 'style':
        h['content-type'] = 'text/css'; return new Response('', { status: 200, headers: h });
      case 'iframe': case 'frame': case 'document':
        h['content-type'] = 'text/html'; return new Response('<!doctype html><title></title>', { status: 200, headers: h });
      default:
        return new Response(null, { status: 204, headers: h });
    }
  }

  function isHtml(res) {
    var ct = (res.headers && res.headers.get('content-type')) || '';
    return /text\/html/i.test(ct);
  }

  function injectStyle(html) {
    var css = (self.TC_AD_RULES && self.TC_AD_RULES.cssSelector) || '';
    if (!css) return html;
    var tag = '<style id="tc-adblock-sw">' + css + '{display:none!important;visibility:hidden!important;height:0!important;width:0!important;}</style>';
    var m = /<head[^>]*>/i.exec(html);
    if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
    return tag + html;
  }

  /* wrap(event, run, cfg)
       run: 元のプロキシ処理を実行して Response を返す関数
       cfg: { prefix, decodeUrl } */
  async function wrap(event, run, cfg) {
    if (!loaded) await load();
    if (!enabled || !self.TC_AD_RULES) return run();
    var req = event.request, dest = req.destination;
    var inProxy = req.url.indexOf(self.location.origin + cfg.prefix) === 0;
    if (inProxy) {
      // 最上位のタブ遷移(アプリ画面が親)は遮断しない。ページ内の子リクエストと
      // 広告iframe(リファラがプロキシURL)だけを遮断する。
      var refInProxy = (req.referrer || '').indexOf(self.location.origin + cfg.prefix) === 0;
      var isFrame = dest === 'iframe' || dest === 'frame' || dest === 'document';
      if (!isFrame || refInProxy) {
        var target = decodeTarget(req.url, cfg);
        if (target && self.TC_AD_RULES.urlBlocked(target)) return blockedResponse(dest);
      }
    }
    var res = await run();
    try {
      if (inProxy && (dest === 'document' || dest === 'iframe' || dest === 'frame') && res && res.status === 200 && isHtml(res)) {
        var text = await res.text();
        var headers = new Headers(res.headers);
        headers.delete('content-length');
        return new Response(injectStyle(text), { status: res.status, statusText: res.statusText, headers: headers });
      }
    } catch (e) {}
    return res;
  }

  self.TCAdblock = { wrap: wrap, isEnabled: async function () { if (!loaded) await load(); return enabled; } };
})();
