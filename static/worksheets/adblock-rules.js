/* =====================================================================
   TheCollapse 広告ブロック 共通ルール (v2.3.0)
   ページ(go.js)とプロキシのService Worker(sw.js / uv3/tc-sw.js)の両方が
   読み込む唯一のルール定義。ここを編集すればネットワーク遮断(SW)と
   表示非表示(ページ)の両方に反映される。
   ===================================================================== */
(function (root) {
var CSS_LIST = [
  // AdSense / Google Publisher Tag
  'ins.adsbygoogle', 'ins[data-ad-slot]', '[data-ad-client]',
  '[id^="google_ads"]', '[id^="div-gpt-ad"]', '[id^="aswift"]', '[id^="gpt_unit"]',
  'iframe[id^="google_ads_iframe"]', '[data-google-query-id]',
  // Taboola / Outbrain
  '[id^="taboola-"]', '[class*="taboola"]', '[class*="outbrain"]', '[id^="outbrain"]', '.OUTBRAIN',
  // 広告クラス/IDのトークン（先頭・トークン境界のみに一致させ "read-" 等の誤爆を防ぐ）
  '[class^="ad-"]', '[class*=" ad-"]', '[id^="ad-"]', '[id*=" ad-"]',
  '[class*="adsbygoogle"]', '[class*="advert"]', '[class*="AdSlot"]', '[class*="adbox" i]',
  // ポップアップ / 割り込み広告
  '[class*="popunder"]', '[id*="popunder"]', '[class*="interstitial"]', '[id*="interstitial"]',
  'amp-ad', 'amp-embed', 'amp-fx-flying-carpet',
  // URL根拠の判定（広告ドメイン・パス・アフィリエイトリンク）はJS側で復号して行う
  // （プロキシがURLをエンコードするため属性セレクタでは一致しない）
  // 汎用の広告ラベル
  '[aria-label*="advertisement" i]', '[title*="advertisement" i]',
  // 広告コンテナで頻出するクラス・ID（アダルトサイトのウィジェット含む）
  '[class*="exoclick"]', '[id*="exoclick"]',
  '[class*="adbanner" i]', '[id*="adbanner" i]',
  '[class*="ad-slot" i]', '[id*="ad-slot" i]', '[class*="adslot" i]', '[id*="adslot" i]',
  '[class*="clickunder"]', '[id*="clickunder"]',
  '[class*="preroll"]', '[id*="preroll"]',
  '[class*="overlay-ad"]', '[id*="overlay-ad"]',
  '[class*="sponsor"]', '[id*="sponsor"]',
  // アフィリエイト等の広告リンクもJS側のURL判定で非表示にする
  // WordPress系まとめサイト（エロ漫画まとめ等）の広告コンテナ
  '[class*="ad-wrap"]', '[class*="ad-area"]', '[class*="ad-box"]', '[class*="ad-space"]',
  '[class*="ad-label"]', '[class*="adsense"]', '[id*="adsense"]', '[class*="my-ad"]',
  '[class*="post-ad"]', '[class*="article-ad"]', '[class*="entry-ad"]', '[class*="single-ad"]',
  '[id*="ad-wrap"]', '[id*="ad-area"]', '[id*="ad-box"]'
];
// 既知の広告配信ドメイン（URL一致はJS側で復号して照合する）

var DOMAINS = [
  'doubleclick.net', 'googlesyndication', 'googleadservices', 'adservice', 'amazon-adsystem',
  'adnxs', 'adsafeprotected', 'adform', 'adroll', 'adsrvr', 'bidswitch', 'sharethrough',
  '33across', 'criteo', 'taboola', 'outbrain', 'mgid', 'revcontent', 'propellerads',
  'propellerclick', 'propellertracking', 'adsterra', 'exoclick', 'exdynsrv', 'magsrv',
  'realsrv', 'hilltopads', 'popads', 'popcash', 'popmyads', 'trafficfactory', 'trafficjunky',
  'trafficstars', 'tsyndicate', 'juicyads', 'plugrush', 'ero-advertising', 'eroadvertising',
  'clickadu', 'zeropark', 'admaven', 'ad-maven', 'galaksion', 'adspyglass', 'adcash',
  'aducdn', 'onclickads', 'onclckds', 'adsupply', 'adsco.re', 'evaadm', 'evadav',
  'waframedia', 'smartadserver', 'openx.net', 'teads.tv', 'media.net', 'moatads',
  'scorecardresearch', 'pubmatic', 'zedo', 'adcolony', 'applovin', 'vungle', 'inmobi',
  'startapp', 'adskeeper', 'dditscdn', 'badoink', 'stripcash',
  // 日本のまとめサイト系（裏広告 / 出会い系 / 広告リンク短縮）
  'pcmax', 'happymail', 'wakuwaku', 'i2i.jp', 'zucks', 'adf.ly'
];

  // ネットワーク遮断(SW)用: ホスト名の部分一致。JS側はURL全体も照合する。
  // パス根拠の広告（ホストは正規ドメインでも広告スクリプトと分かるもの）
  var PATH_PATTERNS = [
    /\/pagead\//i, /adsbygoogle/i, /\/gampad\//i, /\/show_ads/i, /\/ads\/ga-audiences/i,
    /\/adserver\//i, /\/adview\//i, /doubleclick/i, /\/afs\/ads/i
  ];
  // ホスト名がこれらと完全一致/サブドメイン一致するものは常に遮断
  var HOST_SUFFIXES = [
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com',
    'amazon-adsystem.com', 'adnxs.com', 'adsafeprotected.com', 'criteo.com', 'criteo.net',
    'taboola.com', 'outbrain.com', 'mgid.com', 'revcontent.com', 'popads.net', 'popcash.net',
    'exoclick.com', 'exdynsrv.com', 'magsrv.com', 'realsrv.com', 'trafficjunky.net',
    'trafficstars.com', 'tsyndicate.com', 'juicyads.com', 'plugrush.com', 'clickadu.com',
    'propellerads.com', 'adsterra.com', 'hilltopads.net', 'adcash.com', 'ad-maven.com',
    'adf.ly', 'pubmatic.com', 'openx.net', 'rubiconproject.com', 'moatads.com',
    'scorecardresearch.com', 'smartadserver.com', 'teads.tv', 'adskeeper.com', 'onclickads.net'
  ];

  function hostBlocked(host) {
    host = String(host || '').toLowerCase();
    if (!host) return false;
    for (var i = 0; i < HOST_SUFFIXES.length; i++) {
      var s = HOST_SUFFIXES[i];
      if (host === s || host.length > s.length && host.slice(-s.length - 1) === '.' + s) return true;
    }
    for (var j = 0; j < DOMAINS.length; j++) {
      if (host.indexOf(DOMAINS[j]) !== -1) return true;
    }
    return false;
  }
  // 復号済みの元URL(文字列)が広告かどうか
  function urlBlocked(url) {
    var u;
    try { u = new URL(String(url)); } catch (e) { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (hostBlocked(u.hostname)) return true;
    var pq = u.pathname + u.search;
    for (var i = 0; i < PATH_PATTERNS.length; i++) if (PATH_PATTERNS[i].test(pq)) return true;
    return false;
  }

  root.TC_AD_RULES = {
    cssSelector: CSS_LIST.join(','),
    domains: DOMAINS,
    hostBlocked: hostBlocked,
    urlBlocked: urlBlocked
  };
})(typeof self !== 'undefined' ? self : this);
