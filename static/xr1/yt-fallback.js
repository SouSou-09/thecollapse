/* TheCollapse: YouTube の再生方式の切り替え（Service Worker 側）
   YouTube の通常の再生（MSE + SABR）は、動画データの要求ごとに再生トークン（PO トークン）の証明を求める。
   証明が通らない環境では、サーバーは先頭 60 秒分だけ配信して止める（yt-pot.js のサーバー発行トークンでも通らない
   環境がある）。一方、MSE が無いブラウザ向けの通常ファイル再生（itag 18・360p）にはこの検査が無い。
   そこで、証明が拒否されたのを検知したら、以後のモバイル版 YouTube のページでは MSE を隠して、プレーヤー自身に
   通常ファイル再生を選ばせる。証明が通る環境では何も変えない（高画質のまま）。
   通常ファイル再生のほうが失敗した場合は、元の再生方式へ戻す。 */
(function () {
  'use strict';

  var CACHE = 'tc-yt-fallback';
  var KEY = '/xr1/yt-fallback-state';
  var ON_MS = 12 * 60 * 60 * 1000; // 判定が変わる場合に備え、一定時間で通常の再生方式を試し直す
  var OFF_MS = 60 * 60 * 1000; // 通常ファイル再生が失敗したあと、切り替えを見送る時間
  var MOBILE_HOST_RE = /^m\.youtube\.com$/i;
  // ページ側（下の PAGE_SCRIPT）から、通常ファイル再生の失敗を知らせるための宛先。YouTube には送らない
  var FAIL_SIGNAL_RE = /^https:\/\/m\.youtube\.com\/__tc_yt_fallback_fail(\?|$)/i;

  var state = null; // { on: boolean, until: number }。null = 未読込

  function load() {
    if (state) return Promise.resolve(state);
    return caches.open(CACHE)
      .then(function (c) { return c.match(KEY); })
      .then(function (r) { return r ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (s) {
        if (!state) state = s && typeof s.until === 'number' ? { on: !!s.on, until: s.until } : { on: false, until: 0 };
        return state;
      });
  }

  function save(on, ms) {
    state = { on: on, until: Date.now() + ms };
    return caches.open(CACHE)
      .then(function (c) { return c.put(KEY, new Response(JSON.stringify(state))); })
      .catch(function () {});
  }

  // アプリ本体の画面へ知らせる。開いている YouTube のタブを読み込み直して、再生方式を反映させる
  function notifyApp(text) {
    try { self.TCYtDiag.log(text); } catch (e) {}
    var proxyBase = self.location.origin + __uv$config.prefix;
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
      clients.forEach(function (c) {
        if (c.url.indexOf(proxyBase) === 0) return;
        try { c.postMessage({ msg: 'tcYtFallback' }); } catch (e) {}
      });
    }).catch(function () {});
  }

  // ページ内の他のスクリプトより先に実行する。HLS も不可にして、どの端末でも同じ通常ファイル再生にそろえる
  // （HLS は端末のメディア機能が直接取得しに行くため、プロキシを通せない）。
  // 通常ファイルの読み込みに失敗したら FAIL_SIGNAL_RE の宛先へ知らせる。
  var PAGE_SCRIPT = '<script>(function(){try{var w=window,sent=0;' +
    '["ManagedMediaSource","MediaSource","WebKitMediaSource"].forEach(function(k){' +
    'try{Object.defineProperty(w,k,{value:void 0,configurable:true,writable:true})}catch(e){}});' +
    'var p=w.HTMLMediaElement&&w.HTMLMediaElement.prototype;if(p){var o=p.canPlayType;' +
    'p.canPlayType=function(t){return /mpegurl/i.test(String(t))?"":o.apply(this,arguments)}}' +
    'document.addEventListener("error",function(e){var t=e.target;' +
    'if(sent||!t||t.tagName!=="VIDEO"||!t.error||!t.currentSrc||/^blob:/.test(t.currentSrc))return;sent=1;' +
    'fetch("https://m.youtube.com/__tc_yt_fallback_fail?code="+t.error.code,{method:"POST"}).catch(function(){})},true);' +
    '}catch(e){}})();</script>';

  self.TCYtFallback = {
    active: function () {
      return load().then(function (s) { return s.on && s.until > Date.now(); });
    },
    // 再生トークンの証明が拒否されたときに呼ぶ。切り替え済み、または見送り中なら何もしない。
    trip: function () {
      return load().then(function (s) {
        if (s.until > Date.now()) return false;
        return save(true, ON_MS).then(function () {
          notifyApp('再生トークンの証明が通らないため、MSE を使わない再生(360p)に切り替えます');
          return true;
        });
      });
    },
    // 通常ファイル再生が失敗したときに呼ぶ。元の再生方式へ戻し、しばらく切り替えを見送る。
    fail: function (why) {
      return load().then(function (s) {
        if (!s.on || s.until <= Date.now()) return false;
        return save(false, OFF_MS).then(function () {
          notifyApp('MSE を使わない再生に失敗したため(' + why + ')、元の再生方式へ戻します');
          return true;
        });
      });
    },
    isMobileHost: function (hostname) { return MOBILE_HOST_RE.test(hostname); },
    isFailSignal: function (remote) { return FAIL_SIGNAL_RE.test(remote); },
    patchHtml: function (html) {
      var m = /<head\b[^>]*>/i.exec(html);
      if (!m) return html;
      var at = m.index + m[0].length;
      return html.slice(0, at) + PAGE_SCRIPT + html.slice(at);
    },
  };
})();
