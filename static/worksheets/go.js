// ======= 状態 =======
let tabs = [];       // { id, title, url, favicon, isNew }
let activeTabId = null;
let tabCounter = 0;

const ENGINES = {
  google:     q => 'https://google.com/search?q='+encodeURIComponent(q),
  bing:       q => 'https://bing.com/search?q='+encodeURIComponent(q),
  duckduckgo: q => 'https://duckduckgo.com/?q='+encodeURIComponent(q),
  yahoo:      q => 'https://search.yahoo.co.jp/search?p='+encodeURIComponent(q),
  brave:      q => 'https://search.brave.com/search?q='+encodeURIComponent(q),
};
const ENGINE_ICONS = {
  google: `<svg width="18" height="18" viewBox="0 0 48 48"><path fill="#4285F4" d="M44.5 20H24v8.5h11.8C34.2 33.3 29.6 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.7 1.1 7.8 2.9l6-6C34.3 6.5 29.4 4.5 24 4.5 12.7 4.5 3.5 13.7 3.5 25S12.7 45.5 24 45.5c11 0 20-8 20-20.5 0-1.4-.1-2.7-.5-5z"/><path fill="#34A853" d="M6.3 15.7l7 5.1C15.1 17.2 19.2 14 24 14c3 0 5.7 1.1 7.8 2.9l6-6C34.3 6.5 29.4 4.5 24 4.5c-7.6 0-14.2 4.4-17.7 11.2z"/><path fill="#FBBC05" d="M24 45.5c5.3 0 10.1-1.8 13.8-4.8l-6.4-5.4C29.4 37.1 26.8 38 24 38c-5.5 0-10.2-3.6-11.9-8.6l-7 5.4C8.5 41.4 15.6 45.5 24 45.5z"/><path fill="#EA4335" d="M44.5 20H24v8.5h11.8c-.8 2.2-2.3 4.1-4.3 5.4l6.4 5.4C41.7 36.2 44.5 31 44.5 25c0-1.4-.1-2.7-.5-5z"/></svg>`,
  bing: `<svg width="18" height="18" viewBox="0 0 24 24" fill="#0078D4"><path d="M5 2l4 1.4v13.8l4.6-2.6L9 12.4 13 6l6 8-7.5 4.3L5 20V2z"/></svg>`,
  duckduckgo: `<svg width="18" height="18" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="#DE5833"/><circle cx="50" cy="42" r="22" fill="white"/><circle cx="58" cy="36" r="5" fill="#333"/><circle cx="60" cy="35" r="2" fill="white"/><path d="M35 65 Q50 80 65 65" stroke="#333" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`,
  yahoo: `<svg width="18" height="18" viewBox="0 0 48 48"><rect width="48" height="48" rx="8" fill="#720E9E"/><text x="7" y="36" font-family="Arial Black,sans-serif" font-weight="900" font-size="32" fill="white">Y!</text></svg>`,
  brave: `<svg width="18" height="18" viewBox="0 0 24 24"><path fill="#FB542B" d="M21.5 8.3l-.9-2.1-1.5 1-1.2-3.2L16.2 5 15 2 12 3.2 9 2 7.8 5 6.1 4 4.9 7.2l-1.5-1-.9 2.1.9.8-.4 1.5.9.3v1.6l1 .4.4 1.6 1.1.1.7 1.4 1.1-.2 1 1.2 1-.5 1 .5 1-1.2 1.1.2.7-1.4 1.1-.1.4-1.6 1-.4v-1.6l.9-.3-.4-1.5.9-.8zM12 17.5l-3-1.8-.7-2 .5-2 1.5-1.2H12h1.7l1.5 1.2.5 2-.7 2-3 1.8z"/></svg>`,
};
let currentEngine = localStorage.getItem('searchengine') || 'google';

// ======= ローディングオーバーレイ =======
function _showLoading(label) {
  const overlay = document.getElementById('tc-loading-overlay');
  const lbl = document.getElementById('tc-loading-label');
  if (overlay) overlay.style.display = 'flex';
  if (lbl && label) lbl.textContent = label;
}
function _hideLoading() {
  const overlay = document.getElementById('tc-loading-overlay');
  if (!overlay) return;
  overlay.style.opacity = '0';
  setTimeout(() => { overlay.style.display = 'none'; }, 300);
}

function _withTimeout(promise, ms = 8000, label = 'operation') {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// ======= 初期化 =======
window.addEventListener('DOMContentLoaded', async () => {
  // テーマ適用（HTMLの inline scriptでも行うが、DOMContentLoaded後も再適用）
  _applyTheme(getGoTheme());
  // タブ偽装を最初に適用
  applyGoCloak();

  _showLoading('読み込み中...');

  // ブラウザにストレージの永続化を依頼（Cookie/IndexedDBが自動削除されにくくなる）
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch {}
  // 「保存しない」設定のサイトのCookieは、ブラウザを閉じた後の最初の起動時に削除する
  try { if (typeof TC_COOKIES !== 'undefined') await TC_COOKIES.purgeSessionCookiesOnce(); } catch {}

  try {
    // アカウント復元
    if (typeof TC_ACCOUNT !== 'undefined') {
      _showLoading('アカウントを復元しています...');
      try {
        await _withTimeout(TC_ACCOUNT.restoreSession(), 8000, 'restoreSession');
      } catch (e) {
        try { console.warn('[go] restoreSession timeout/fail:', e && e.message); } catch {}
      }
      currentEngine = TC_ACCOUNT.getEngine();
      renderGoAccountUI();
      // ログイン中ならUV cookieをサーバーから復元
      if (TC_ACCOUNT.currentUser()) {
        _showLoading('セッションを復元しています...');
        try {
          await _withTimeout(TC_ACCOUNT.restoreCookies(), 7000, 'restoreCookies');
        } catch (e) {
          try { console.warn('[go] restoreCookies timeout/fail:', e && e.message); } catch {}
        }
      }
    }

    // セッションから最初のURL取得
    const initialURL = sessionStorage.getItem('uvURL');
    sessionStorage.removeItem('uvURL');

    // プロキシのService Workerを先に有効化しておく。
    // これをしないと、復元したタブのiframeが「Cannot GET /service/...」になる
    // （新しい端末・SW未登録の状態でタブを復元すると必ず発生していた）。
    _showLoading('プロキシを準備しています...');
    try { await _withTimeout(ensureProxyReady(), 8000, 'ensureProxyReady'); } catch (e) {
      try { console.warn('[go] ensureProxyReady timeout/fail:', e && e.message); } catch {}
    }

    try { localStorage.removeItem('tc_yt_edu_keys_v1'); } catch {}

    // 保存されたタブを復元、なければ新規
    _showLoading('タブを復元しています...');
    try {
      await _withTimeout(loadTabsFromStorage(), 8000, 'loadTabsFromStorage');
    } catch (e) {
      try { console.warn('[go] loadTabsFromStorage timeout/fail:', e && e.message); } catch {}
    }

    // 復号用にIR V1コーデックを読み込む（保存済みURLの符号方式の自動判定に使う）
    try { await _ir1(); } catch {}

    if (initialURL) {
      // 保存済みURLの符号方式を自動判定する（エンジン切替の前後で古いタブが壊れないように）。
      // IR V1(/ir1-service/)=base64、従来(/service/)=XOR。
      // 判定は「前方一致」だけでは不十分: デコード結果が https:// で始まるだけの壊れた
      // バイナリ混じり文字列を IR V1 と誤判定し、SW側の atob で InvalidCharacterError
      // エラーページになる事故があった。そこで
      //   (1) デコード結果が print ASCIIのみの完全な http(s) URL であること
      //   (2) 再符号化したら元の文字列と完全一致する（round-trip）こと
      // を厳密に確認する。どちらの符号とも一致しない壊れた値は復元せずスキップし、
      // 新規タブを開く（エラーページを開かない）。
      const strictHttpUrl = (s) => typeof s === 'string' && /^https?:\/\/[!-~]+$/i.test(s);
      let decodedInitial = null;
      try {
        const bIr = window.IR1 && window.IR1.codec && window.IR1.codec.base64;
        if (bIr && typeof bIr.decode === 'function') {
          const dIr = bIr.decode(initialURL);
          if (strictHttpUrl(dIr) && bIr.encode(dIr) === initialURL) decodedInitial = dIr;
        }
      } catch (e) {}
      if (!decodedInitial) {
        try {
          if (typeof __uv$config !== 'undefined' && __uv$config.decodeUrl) {
            const d1 = __uv$config.decodeUrl(initialURL);
            if (strictHttpUrl(d1) && __uv$config.encodeUrl(d1) === initialURL) decodedInitial = d1;
          }
        } catch (e) {}
      }
      let fullURL = null;
      if (decodedInitial) {
        // 現行エンジンの符号で張り直す（保存時の符号と現行エンジンの混在を根絶する）
        try { fullURL = await buildProxyUrl(decodedInitial); } catch (e) { fullURL = null; }
      } else {
        try { console.warn('[go] 復元用URLの符号を判定できなかったため復元をスキップ:', String(initialURL).slice(0, 60)); } catch (e) {}
      }

      // どのサイトもアプリ内（ブラウザモード）のタブでプロキシ経由で開く。
      // 新しいブラウザタブや about:blank のウィンドウは開かない。
      createTab(fullURL, true);
    } else if (tabs.length === 0) {
      createTab(null, false); // ニュータブ
    } else {
      // 前回アクティブだったタブを表示（無ければ最後のタブ）
      const lastActive = tabs.find(t => t.id === _restoredActiveId) || tabs[tabs.length - 1];
      setActiveTab(lastActive.id);
    }

    // どのタブも選ばれていない状態（保存タブの復元直後など）だと
    // コンテンツが空のままになるため、必ずどれかのタブを表示する
    if (activeTabId === null && tabs.length > 0) {
      setActiveTab(tabs[tabs.length - 1].id);
    }

    renderBookmarkBtn();
    document.addEventListener('click', e => {
      // 「外側をクリックしたら閉じる」処理。
      let changed = false;
      [
        ['#bookmark-panel', 'bookmark'],
        ['#history-panel', 'history'],
        ['#more-options-panel', 'more'],
        ['#ext-panel', 'ext'],
        ['#cookie-panel', 'cookie'],
      ].forEach(([selector, key]) => {
        const panel = document.querySelector(selector);
        if (!panel || !panel.classList.contains('open')) return;
        if (panel.contains(e.target)) return;
        if (e.target.closest(`[data-panel-toggle="${key}"]`)) return;
        panel.classList.remove('open');
        changed = true;
      });
      const acctMenu = document.getElementById('go-account-menu');
      if (acctMenu && acctMenu.style.display === 'block' && !acctMenu.contains(e.target)) {
        acctMenu.style.display = 'none';
        changed = true;
      }
      if (changed) _syncMobileScrim();
    });
  } catch (e) {
    try { console.error('[go] initialization error:', e); } catch {}
    if (tabs.length === 0) createTab(null, false);
  } finally {
    _hideLoading();
  }


  // ページを離れる前にUV cookieをサーバーへ保存
  window.addEventListener('beforeunload', () => {
    if (typeof TC_ACCOUNT !== 'undefined' && TC_ACCOUNT.currentUser()) {
      TC_ACCOUNT.saveCookies();
    }
  });

  // 他タブ/他端末でデータが変わったら（account.js が tc:datasync を発火）
  // 履歴・ブックマークのキャッシュを取り直し、開いているパネルを再描画する。
  // これにより複数端末・複数タブ間で履歴とブックマークが同期表示される。
  window.addEventListener('tc:datasync', async () => {
    if (typeof TC_ACCOUNT === 'undefined' || !TC_ACCOUNT.currentUser()) return;
    try {
      await _syncBookmarks();
      await _syncHistory();
      renderBookmarkBtn();
      if (document.getElementById('history-panel')?.classList.contains('open')) {
        renderHistoryList();
      }
      if (document.getElementById('bookmark-panel')?.classList.contains('open')) {
        renderBookmarkList();
      }
    } catch (e) {
      try { console.warn('[go] datasync error:', e && e.message); } catch {}
    }
  });
});

// ======= タブ管理 =======
function createTab(url, switchTo = true) {
  const id = ++tabCounter;
  const tab = { id, title: url ? 'Loading...' : 'New Tab', url: url || null, favicon: null, isNew: !url };
  tabs.push(tab);
  saveTabsToStorage();
  renderTabs();
  renderTabContent(tab);
  if (switchTo || tabs.length === 1) setActiveTab(id);
  return id;
}

// 復元タブは表示するまでiframeを作らない（全タブが同時に読み込まれて重くなるのを防ぐ）
function ensureTabLoaded(tab) {
  if (!tab || !tab.lazy) return;
  tab.lazy = false;
  renderTabContent(tab);
}

function setActiveTab(id) {
  activeTabId = id;
  ensureTabLoaded(tabs.find(t => t.id === id));
  // タブUI更新（旧タブ一覧の .tab）
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', parseInt(t.dataset.id) === id);
  });
  // 上部タブストリップの見た目を同期（これがないと、ストリップから
  // タブを押して移動してもアクティブ表示が前のタブのまま残る）
  syncTabStripActive(id);
  // コンテンツ切替
  document.querySelectorAll('.tab-content').forEach(c => {
    c.classList.toggle('active', parseInt(c.dataset.id) === id);
  });
  const tab = tabs.find(t => t.id === id);
  if (tab) {
    document.getElementById('address-input').value = tab.isNew ? '' : (tab.displayUrl || tab.url || '');
    updateNavButtons();
    renderBookmarkBtn();
    // 開発者ツールが開いていたら表示中タブの内容に切り替える
    if (window.DevTools) setTimeout(() => DevTools.onTabChange(), 100);
    saveTabsToStorage(); // 「今見ているタブ」も保存する
  }
}

function closeTab(id, e) {
  e && e.stopPropagation();
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const wasActive = activeTabId === id;
  tabs.splice(idx, 1);

  // DOM削除（タブストリップ・コンテンツ・旧タブ一覧のすべて）
  document.querySelector(`.strip-tab[data-id="${id}"]`)?.remove();
  document.querySelector(`.tab[data-id="${id}"]`)?.remove();
  const contentEl = document.querySelector(`.tab-content[data-id="${id}"]`);
  if (contentEl) {
    // iframe を先に空にしてから外す（動画や音声が鳴り続けるのを防ぐ）
    const frame = contentEl.querySelector('iframe');
    if (frame) { try { frame.src = 'about:blank'; } catch {} }
    contentEl.remove();
  }
  saveTabsToStorage();

  if (tabs.length === 0) {
    renderTabs();
    createTab(null, false);
    return;
  }
  // ストリップを再描画しないと、閉じたタブが画面上に残ってしまう
  renderTabs();
  if (wasActive) {
    const next = tabs[Math.min(idx, tabs.length - 1)];
    setActiveTab(next.id);
  } else {
    syncTabStripActive(activeTabId);
  }
}

function newTab() {
  createTab(null, true);
}

// 上部タブストリップのアクティブ表示だけを（再生成せずに）更新する
function syncTabStripActive(id) {
  const list = document.getElementById('tab-strip-list');
  if (!list) return;
  list.querySelectorAll('.strip-tab').forEach(el => {
    const on = parseInt(el.dataset.id) === id;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  // アクティブタブが隠れているときだけスクロールする（毎回スクロールすると操作が落ち着かない）
  const el = list.querySelector('.strip-tab.active');
  if (!el) return;
  const lr = list.getBoundingClientRect();
  const tr = el.getBoundingClientRect();
  if (tr.left < lr.left || tr.right > lr.right) {
    el.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }
}

function renderTabs() {
  // タブカウントバッジ（互換用）
  const badge = document.getElementById('tab-count-badge');
  if (badge) badge.textContent = tabs.length;

  // タブストリップ（上部タブバー）を更新
  const stripList = document.getElementById('tab-strip-list');
  if (!stripList) return;
  stripList.innerHTML = '';
  tabs.forEach(tab => {
    const el = document.createElement('div');
    el.className = 'strip-tab' + (tab.id === activeTabId ? ' active' : '');
    el.dataset.id = tab.id;
    el.title = tab.title || 'New Tab';
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', tab.id === activeTabId ? 'true' : 'false');
    el.innerHTML = `
      ${tab.favicon
        ? `<img class="strip-tab-favicon" src="${escHtml(tab.favicon)}" onerror="this.style.display='none'">`
        : `<svg class="strip-tab-favicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;flex-shrink:0"><circle cx="12" cy="12" r="10"/></svg>`
      }
      <span class="strip-tab-title">${escHtml(tab.title || (tab.isNew ? 'New Tab' : 'Loading…'))}</span>
      <button class="strip-tab-close" type="button" title="タブを閉じる" aria-label="タブを閉じる"
              onclick="event.stopPropagation();closeTab(${tab.id},event)">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    `;
    el.addEventListener('click', ev => {
      if (ev.target.closest('.strip-tab-close')) return;
      setActiveTab(tab.id);
    });
    // 中クリック（ホイール押し込み）でも閉じられるように
    el.addEventListener('auxclick', ev => {
      if (ev.button === 1) { ev.preventDefault(); closeTab(tab.id, ev); }
    });
    stripList.appendChild(el);
  });

  // アクティブタブが見えるようにスクロール
  syncTabStripActive(activeTabId);
}

// ======= タブ一覧機能は削除済み（互換用の空スタブ）=======
function renderTabsModal() {}
function selectTabFromModal(id) { setActiveTab(id); }
function openTabsModal() {}
function closeTabsModal() {}
function closeTabsModalOutside(e) {}

// ======= 共有（Safari 風の共有ボタン）=======
async function shareCurrentPage() {
  const tab = tabs.find(t => t.id === activeTabId);
  const url = (tab && tab.url) ? tab.url : '';
  const title = (tab && tab.title) ? tab.title : document.title;
  if (!url) {
    if (typeof log === 'function') log('共有できるURLがありません', 'warn');
    return;
  }
  // Web Share API が使えれば OS のシェアシートを開く
  if (navigator.share) {
    try {
      await navigator.share({ title, url });
      return;
    } catch (e) {
      // ユーザーがキャンセルした場合などはフォールバックしない
      if (e && e.name === 'AbortError') return;
    }
  }
  // フォールバック：クリップボードへコピー
  try {
    await navigator.clipboard.writeText(url);
    if (typeof log === 'function') log('URLをコピーしました: ' + url, 'ok');
  } catch {
    if (typeof log === 'function') log('URLのコピーに失敗しました', 'err');
  }
}

function focusAddressInput() {
  const input = document.getElementById('address-input');
  if (input) {
    input.focus();
    input.select();
  }
}

function renderTabContent(tab) {
  const area = document.getElementById('content-area');
  const div = document.createElement('div');
  div.className = 'tab-content' + (tab.id === activeTabId ? ' active' : '');
  div.dataset.id = tab.id;

  if (tab.isNew || !tab.url) {
    div.innerHTML = buildNewTabHTML(tab.id);
    area.appendChild(div);
    // エンジン初期化
    setTimeout(() => initNewTabEngine(tab.id), 0);
  } else {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:relative;flex:1;overflow:hidden;display:flex;flex-direction:column;';
    const iframe = document.createElement('iframe');
    iframe.className = 'browser-frame';
    iframe.src = tab.url;
    iframe.id = 'frame-' + tab.id;
    // window.open によるポップアップ(X の OAuth ログイン等)を許可するための権限。
    // これがないとプロキシ内のページから window.open が呼べず、Apple / Google /
    // 電話番号ログインのポップアップがブロックされる。
    iframe.setAttribute('allow',
      'accelerometer; autoplay; clipboard-read; clipboard-write; encrypted-media; ' +
      'fullscreen; gyroscope; picture-in-picture; ' +
      'web-share; publickey-credentials-get; screen-wake-lock');
    iframe.setAttribute('referrerpolicy', 'same-origin');
    iframe.onload = () => {
      scheduleExtensions(iframe);
      onFrameLoad(tab.id, iframe);
      // 内部ナビゲーション(SPA pushState等)追跡トラッカーを起動
      attachFrameTracker(tab.id, iframe);
      // 開発者ツール: ページ読み込み完了で console / エラー / 通信フックを確実に張り直し、Elements を更新
      if (window.DevTools) {
        DevTools.watchFrame(tab.id, iframe);
        if (tab.id === activeTabId) setTimeout(() => DevTools.refresh(), 100);
      }
    };
    wrapper.appendChild(iframe);
    // 読み込み開始直後から console / エラー / 通信を収集する
    if (window.DevTools) DevTools.watchFrame(tab.id, iframe);
    div.appendChild(wrapper);
    area.appendChild(div);
  }
}

function onFrameLoad(tabId, iframe) {
  try {
    // iframeの「現在の」URLを取得して表示URL更新。
    // iframe.src は最初に指定したURLのままで、リンク遷移後は古いページを指してしまう
    // （履歴に同じページが二重に記録され、タブ復元も前のページに戻っていた）。
    let src = iframe.src;
    try {
      const cur = iframe.contentWindow.location.href;
      if (cur && cur !== 'about:blank') src = cur;
    } catch {}
    const decoded = decodeProxyUrl(src);
    const tab = tabs.find(t => t.id === tabId);
    if (tab) {
      tab.url = src;
      tab.displayUrl = decoded;
      tab.isNew = false;
      // タイトル更新を試みる
      try {
        const title = iframe.contentDocument?.title;
        if (title) { tab.title = title; }
        else { tab.title = decoded || 'Page'; }
      } catch { tab.title = decoded || 'Page'; }
      // ファビコン
      try {
        const u = new URL(decoded);
        tab.favicon = 'https://www.google.com/s2/favicons?domain=' + u.hostname + '&sz=32';
      } catch {}
      saveTabsToStorage();
      renderTabs();
      if (tabId === activeTabId) {
        document.getElementById('address-input').value = decoded || src;
        updateNavButtons();
        renderBookmarkBtn();
      }
      // ログ
      addLog(`ページ読み込み完了: ${(decoded || src).slice(0, 60)}`, 'ok');
      setLogStatus('idle', 'Ready');
      // 履歴に追記
      addHistoryEntry({ title: tab.title, url: decoded || src, favicon: tab.favicon || '' });
    }
  } catch(e) {}
}

function decodeProxyUrl(src) {
  if (!src) return '';
  try {
    for (const p of ['/ir1-service/', '/service3/']) {
      const idx = src.indexOf(p);
      if (idx >= 0 && window.IR1) {
        // フルURL(http://host/ir1-service/xxx)でも相対(/ir1-service/xxx)でも復号する
        let rest = src.slice(idx + p.length).split('#')[0];
        const q = rest.indexOf('?'); if (q >= 0) rest = rest.slice(0, q);
        try { return window.IR1.codec.base64.decode(rest); } catch (e) {}
      }
    }
    if (src.includes('/service/') && typeof __uv$config !== 'undefined') {
      const encoded = src.split('/service/')[1];
      return __uv$config.decodeUrl ? __uv$config.decodeUrl(encoded) : encoded;
    }
  } catch {}
  return src;
}

// ======= iframe内部ナビゲーション追跡 (Task 3) =======
// onFrameLoad は完全な onload 発火時しか呼ばれない。UVプロキシ内での
// SPA式 pushState/replaceState ナビゲーションは onload を発火せず、
// iframe.src も更新されないことがあるため、アドレスバーが古いままになる。
// このトラッカーは contentWindow.location.href のポーリングと src 属性の
// MutationObserver で内部ナビゲーションを検知し、アドレスバー・タブ・履歴を同期する。
function attachFrameTracker(tabId, iframe) {
  if (!iframe) return;
  // 既存のトラッカーがあればクリーンアップ
  if (iframe._tcTracker) {
    try { clearInterval(iframe._tcTracker.interval); } catch {}
    try { iframe._tcTracker.observer && iframe._tcTracker.observer.disconnect(); } catch {}
  }
  let lastLoc = '';
  const tracker = { interval: null, observer: null };
  iframe._tcTracker = tracker;

  function sync() {
    let loc = '';
    try { loc = iframe.contentWindow.location.href; } catch {}
    if (!loc || loc === 'about:blank' || loc === lastLoc) return;
    lastLoc = loc;
    syncFrameLocation(tabId, iframe, loc);
  }

  // src 属性変化を監視（フルナビゲーションの補助）
  try {
    tracker.observer = new MutationObserver(() => {
      const s = iframe.src;
      if (s && s !== 'about:blank') sync();
    });
    tracker.observer.observe(iframe, { attributes: true, attributeFilter: ['src'] });
  } catch {}

  // contentWindow.location.href をポーリング（SPA内部ナビゲーション検知）
  tracker.interval = setInterval(() => {
    if (!document.body.contains(iframe)) {
      try { clearInterval(tracker.interval); } catch {}
      try { tracker.observer && tracker.observer.disconnect(); } catch {}
      return;
    }
    sync();
  }, 1000);
}

// トラッカー検知時のアドレスバー・タブ・履歴同期
function syncFrameLocation(tabId, iframe, loc) {
  try {
    const decoded = decodeProxyUrl(loc);
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    // 同一URLなら更新不要（onFrameLoad と重複しないようガード）
    if (tab.url === loc && tab.displayUrl === decoded) return;
    tab.url = loc;
    tab.displayUrl = decoded;
    tab.isNew = false;
    try {
      const title = iframe.contentDocument?.title;
      if (title) tab.title = title;
      else if (decoded) tab.title = decoded;
    } catch { if (decoded) tab.title = decoded; }
    try {
      const u = new URL(decoded);
      tab.favicon = 'https://www.google.com/s2/favicons?domain=' + u.hostname + '&sz=32';
    } catch {}
    saveTabsToStorage();
    renderTabs();
    if (tabId === activeTabId) {
      document.getElementById('address-input').value = decoded || loc;
      updateNavButtons();
      renderBookmarkBtn();
    }
    addHistoryEntry({ title: tab.title, url: decoded || loc, favicon: tab.favicon || '' });
  } catch(e) {}
}

// ======= ニュータブHTML (index.htmlデザイン準拠) =======
function buildNewTabHTML(tabId) {
  return `
  <div class="newtab-page" id="nt-${tabId}">
    <div class="nt-logo">
      <div class="nt-logo-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="white"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
      </div>
      <span class="nt-logo-text">TheCollapse</span>
    </div>

    <div class="nt-search-wrapper" id="nt-sw-${tabId}">
      <div class="nt-search-input-row">
        <button class="nt-engine-btn" id="nt-eb-${tabId}" onclick="ntToggleEngine(${tabId}, event)">
          <span id="nt-ei-${tabId}"></span>
        </button>
        <form onsubmit="ntSearch(event, ${tabId})" style="width:100%">
          <input type="text" class="nt-search-input" id="nt-si-${tabId}" placeholder="Search or type URL" autocomplete="off">
        </form>
        <button class="nt-search-submit" onclick="ntSearch(event, ${tabId})">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </button>
        <div class="nt-engine-menu" id="nt-em-${tabId}">
          <div class="nt-engine-option" id="nt-eo-google-${tabId}" onclick="ntSetEngine('google', ${tabId})">
            ${ENGINE_ICONS.google} Google <div class="nt-engine-dot"></div>
          </div>
          <div class="nt-engine-option" id="nt-eo-bing-${tabId}" onclick="ntSetEngine('bing', ${tabId})">
            ${ENGINE_ICONS.bing} Bing <div class="nt-engine-dot"></div>
          </div>
          <div class="nt-engine-option" id="nt-eo-duckduckgo-${tabId}" onclick="ntSetEngine('duckduckgo', ${tabId})">
            ${ENGINE_ICONS.duckduckgo} DuckDuckGo <div class="nt-engine-dot"></div>
          </div>
          <div class="nt-engine-option" id="nt-eo-yahoo-${tabId}" onclick="ntSetEngine('yahoo', ${tabId})">
            ${ENGINE_ICONS.yahoo} Yahoo! Japan <div class="nt-engine-dot"></div>
          </div>
          <div class="nt-engine-option" id="nt-eo-brave-${tabId}" onclick="ntSetEngine('brave', ${tabId})">
            ${ENGINE_ICONS.brave} Brave <div class="nt-engine-dot"></div>
          </div>
        </div>
      </div>
    </div>

    <div class="nt-shortcuts">
      <a class="nt-shortcut" href="#" onclick="ntGoTo('https://google.com', ${tabId}, event)">
        <div class="nt-shortcut-icon"><img src="https://www.google.com/s2/favicons?domain=google.com&sz=32" alt="Google"></div>
        <span class="nt-shortcut-label">Google</span>
      </a>
      <a class="nt-shortcut" href="#" onclick="ntGoTo('https://youtube.com', ${tabId}, event)">
        <div class="nt-shortcut-icon"><img src="https://www.google.com/s2/favicons?domain=youtube.com&sz=32" alt="YouTube"></div>
        <span class="nt-shortcut-label">YouTube</span>
      </a>
      <a class="nt-shortcut" href="#" onclick="ntGoTo('https://discord.com', ${tabId}, event)">
        <div class="nt-shortcut-icon"><img src="https://www.google.com/s2/favicons?domain=discord.com&sz=32" alt="Discord"></div>
        <span class="nt-shortcut-label">Discord</span>
      </a>
      <a class="nt-shortcut" href="#" onclick="ntGoTo('https://github.com', ${tabId}, event)">
        <div class="nt-shortcut-icon"><img src="https://www.google.com/s2/favicons?domain=github.com&sz=32" alt="GitHub"></div>
        <span class="nt-shortcut-label">GitHub</span>
      </a>
    </div>
  </div>`;
}

function initNewTabEngine(tabId) {
  ntApplyEngine(currentEngine, tabId, false);
}

function ntApplyEngine(e, tabId, save = true) {
  currentEngine = e;
  if (save) {
    localStorage.setItem('searchengine', e);
    if (typeof TC_ACCOUNT !== 'undefined') TC_ACCOUNT.saveEngine(e);
  }
  const icon = document.getElementById('nt-ei-' + tabId);
  const inp  = document.getElementById('nt-si-' + tabId);
  if (icon) icon.innerHTML = ENGINE_ICONS[e] || ENGINE_ICONS.google;
  if (inp)  inp.placeholder = `Search ${e.charAt(0).toUpperCase()+e.slice(1)} or type URL`;
  document.querySelectorAll(`[id^="nt-eo-"]`).forEach(el => {
    if (el.id.endsWith('-' + tabId)) el.classList.remove('selected');
  });
  const opt = document.getElementById(`nt-eo-${e}-${tabId}`);
  if (opt) opt.classList.add('selected');
}

function ntToggleEngine(tabId, e) {
  e.stopPropagation();
  document.getElementById('nt-em-' + tabId)?.classList.toggle('open');
}

function ntSetEngine(e, tabId) {
  ntApplyEngine(e, tabId);
  document.getElementById('nt-em-' + tabId)?.classList.remove('open');
}

function ntSearch(e, tabId) {
  e.preventDefault();
  const q = document.getElementById('nt-si-' + tabId)?.value.trim();
  if (!q) return;
  navigateTab(tabId, q);
}

function ntGoTo(url, tabId, e) {
  e.preventDefault();
  navigateTab(tabId, url);
}

// ======= ナビゲーション =======
function navigateTab(tabId, query) {
  let url = '';
  try {
    const u = new URL(query);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') u.protocol = 'https:';
    url = u.toString();
  } catch {
    url = /^[a-z]+\.[a-z]{2,}$/i.test(query) ? 'https://' + query : ENGINES[currentEngine](query);
  }

  // どのサイトもアプリ内（ブラウザモード）のタブでプロキシ経由で開く。
  // 新しいブラウザタブや about:blank のウィンドウは開かない。
  if (typeof __uv$config === 'undefined') { return; }
  ensureProxyReady()
    .then(async () => {
      const proxyUrl = await buildProxyUrl(url);
      const tab = tabs.find(t => t.id === tabId);
      if (!tab) return;
      const content = document.querySelector(`.tab-content[data-id="${tabId}"]`);
      if (!content) return;
      // ニュータブページを置換してiframeに
      content.innerHTML = '';
      const iframe = document.createElement('iframe');
      iframe.className = 'browser-frame';
      iframe.src = proxyUrl;
      iframe.id = 'frame-' + tabId;
      // window.open によるポップアップ(X の OAuth ログイン等)を許可するための権限。
      iframe.setAttribute('allow',
        'accelerometer; autoplay; clipboard-read; clipboard-write; encrypted-media; ' +
        'fullscreen; gyroscope; picture-in-picture; ' +
        'web-share; publickey-credentials-get; screen-wake-lock');
      iframe.setAttribute('referrerpolicy', 'same-origin');
      iframe.onload = () => {
        scheduleExtensions(iframe);
        onFrameLoad(tabId, iframe);
        // 内部ナビゲーション(SPA pushState等)追跡トラッカーを起動
        attachFrameTracker(tabId, iframe);
        if (window.DevTools) {
          DevTools.watchFrame(tabId, iframe);
          if (tabId === activeTabId) setTimeout(() => DevTools.refresh(), 100);
        }
      };
      content.appendChild(iframe);
      if (window.DevTools) DevTools.watchFrame(tabId, iframe);
      tab.url = proxyUrl;
      tab.displayUrl = url;
      tab.isNew = false;
      tab.title = 'Loading...';
      document.getElementById('address-input').value = url;
      saveTabsToStorage();
      renderTabs();
      addLog(`ナビゲート: ${url.slice(0, 60)}`, 'info');
      setLogStatus('active', 'Loading...');
    }).catch(err => console.error(err));
}


// プロキシ(Service Worker)を使える状態にする。エンジン別にSW登録→有効化まで待つ。
// IR V1エンジンはbare-muxのトランスポートも設定する。広告ブロックのON/OFFもSWへ伝える。
const _proxyReady = {};
function ensureProxyReady() {
  const prefix = enginePrefix();
  if (_proxyReady[prefix]) return _proxyReady[prefix];
  const p = (async () => {
    if (prefix === '/ir1-service/') {
      try {
        const { BareMuxConnection } = await import('/baremux/index.mjs');
        const conn = new BareMuxConnection('/baremux/worker.js?v=13');
        await conn.setTransport('/ir1/bare-transport.mjs?v=13', []);
      } catch (e) { console.warn('[go] bare-mux init failed', e); }
    }
    const reg = await navigator.serviceWorker.register(engineSWUrl(), { scope: prefix });
    await _waitForSWActive(reg);
    if (reg.active && !navigator.serviceWorker.controller) {
      await new Promise(r => setTimeout(r, 120));
    }
    try { syncAdblockToSW(); } catch (e) {}
    return reg;
  })();
  _proxyReady[prefix] = p;
  p.catch(() => { delete _proxyReady[prefix]; });
  return p;
}

// サービスワーカーが「有効(activated)」になるまで待つ。
// 有効になる前にプロキシ iframe を作ると、その読み込みが SW に横取りされず
// サーバーに届いて 404 になる（Cannot GET /service/...）。
function _waitForSWActive(reg) {
  return new Promise(resolve => {
    if (!reg) return resolve();
    if (reg.active) return resolve();
    const worker = reg.installing || reg.waiting;
    if (!worker) return resolve();
    if (worker.state === 'activated') return resolve();
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') resolve();
    });
    // 念のため（有効化に失敗しても操作を止めない）
    setTimeout(resolve, 3000);
  });
}

function onAddressKey(e) {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    e.stopPropagation();
    const q = e.target.value.trim();
    if (!q || !activeTabId) return;
    navigateTab(activeTabId, q);
  }
}

function goBack() {
  const iframe = document.getElementById('frame-' + activeTabId);
  if (iframe) try { iframe.contentWindow.history.back(); } catch {}
}
function goForward() {
  const iframe = document.getElementById('frame-' + activeTabId);
  if (iframe) try { iframe.contentWindow.history.forward(); } catch {}
}
function reloadTab() {
  const iframe = document.getElementById('frame-' + activeTabId);
  if (iframe) try { iframe.contentWindow.location.reload(); } catch { iframe.src = iframe.src; }
}
// 親ページ(index.html)に埋め込まれて表示されているか
function isEmbedded() {
  try { return window.parent && window.parent !== window; } catch { return true; }
}
function requestCloseBrowser() {
  // オーバーレイ埋め込み時はページ遷移せず、親へ閉じる要求を送る
  // （アドレスバーを .com のまま保つ）。
  if (isEmbedded()) {
    try { window.parent.postMessage({ type: 'tc-browser-close' }, location.origin); return true; } catch {}
  }
  return false;
}
function goHome() {
  if (requestCloseBrowser()) return;
  location.href = '../index.html';
}
function updateNavButtons() {
  const tab = tabs.find(t => t.id === activeTabId);
  const backBtn = document.getElementById('back-btn');
  const forwardBtn = document.getElementById('forward-btn');
  if (backBtn) backBtn.disabled = !tab || tab.isNew;
  if (forwardBtn) forwardBtn.disabled = !tab || tab.isNew;
}

// ======= ブックマーク =======
function getBookmarks() {
  if (typeof TC_ACCOUNT !== 'undefined' && TC_ACCOUNT.currentUser()) {
    // 同期的に返せないため、キャッシュを利用
    return window._bmCache || [];
  }
  try { return JSON.parse(localStorage.getItem('tc_bookmarks') || '[]'); } catch { return []; }
}
async function _syncBookmarks() {
  if (typeof TC_ACCOUNT !== 'undefined') {
    window._bmCache = await TC_ACCOUNT.getBookmarks();
    window._bmLoaded = true;
  }
}
// ログイン中はブックマークをアカウント側から読み込んでキャッシュする。
// 読み込み前に保存すると、既存のブックマークを上書きして消してしまうため、
// 書き込みの前に必ず一度読み込みを済ませる。
async function _ensureBookmarksLoaded() {
  if (typeof TC_ACCOUNT === 'undefined') return;
  if (window._bmLoaded) return;
  if (TC_ACCOUNT.currentUser()) {
    try { await _syncBookmarks(); } catch {}
  }
  window._bmLoaded = true;
}
function saveBookmarks(bms) {
  if (typeof TC_ACCOUNT !== 'undefined') {
    window._bmCache = bms;
    TC_ACCOUNT.saveBookmarks(bms);
  } else {
    localStorage.setItem('tc_bookmarks', JSON.stringify(bms));
  }
}

async function addBookmark() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || tab.isNew) return;
  await _ensureBookmarksLoaded();
  const bms = getBookmarks();
  const url = tab.displayUrl || tab.url || '';
  if (!url) return;
  if (bms.find(b => b.url === url)) {
    renderBookmarkBtn();
    return;
  }
  bms.push({ title: tab.title || url, url, favicon: tab.favicon || '' });
  saveBookmarks(bms);
  renderBookmarkBtn();
  // 一覧を開いたまま登録したときは、その場で反映されるようにする
  if (document.getElementById('bookmark-panel')?.classList.contains('open')) {
    renderBookmarkList();
  }
}

async function removeBookmark(url) {
  await _ensureBookmarksLoaded();
  const bms = getBookmarks().filter(b => b.url !== url);
  saveBookmarks(bms);
  renderBookmarkList();
  renderBookmarkBtn();
}

function renderBookmarkBtn() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || tab.isNew) return;
  const bms = getBookmarks();
  const url = tab.displayUrl || tab.url || '';
  const btn = document.getElementById('add-bookmark-btn');
  if (!btn) return;
  const isBookmarked = bms.some(b => b.url === url);
  btn.style.color = isBookmarked ? '#f0c040' : '';
}

async function toggleBookmarkPanel() {
  const panel = document.getElementById('bookmark-panel');
  if (!panel) return;
  const willOpen = !panel.classList.contains('open');
  closeAllPanels();
  if (willOpen) {
    panel.classList.add('open');
    _syncMobileScrim();
    renderBookmarkList();
    // ログイン中はまだ読み込めていないことがあるので、読み込んでから描き直す
    await _ensureBookmarksLoaded();
    renderBookmarkList();
  }
}

// 一覧は作り直すので、クリックは親要素でまとめて受ける（1回だけ登録）
function _initBookmarkListEvents(list) {
  if (!list || list._tcDelegated) return;
  list._tcDelegated = true;
  list.addEventListener('click', ev => {
    const del = ev.target.closest('.bm-item-del');
    if (del) {
      ev.stopPropagation();
      removeBookmark(del.dataset.url);
      return;
    }
    const item = ev.target.closest('.bm-item');
    if (item && item.dataset.url) openBookmark(item.dataset.url);
  });
}

function renderBookmarkList() {
  const bms = getBookmarks();
  const list = document.getElementById('bookmark-list');
  if (!list) return;
  _initBookmarkListEvents(list);
  const countEl = document.getElementById('bookmark-count');
  if (countEl) countEl.textContent = bms.length;
  if (bms.length === 0) {
    list.innerHTML = '<div class="bm-empty">ブックマークがありません</div>';
    return;
  }
  list.innerHTML = bms.map(b => {
    const { host } = _histUrlParts(b.url);
    const title = b.title || host || b.url;
    return `
    <div class="bm-item" data-url="${escHtml(b.url)}">
      <span class="bm-favicon">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
        ${b.favicon ? `<img src="${escHtml(b.favicon)}" alt="" onerror="this.remove()">` : ''}
      </span>
      <div class="bm-item-info">
        <div class="bm-item-title">${escHtml(title)}</div>
        <div class="bm-item-host">${escHtml(host)}</div>
      </div>
      <button class="bm-item-del" data-url="${escHtml(b.url)}" title="このブックマークを削除" aria-label="このブックマークを削除">✕</button>
    </div>`;
  }).join('');
}

function openBookmark(url) {
  closeAllPanels();
  if (activeTabId) {
    navigateTab(activeTabId, url);
  } else {
    const id = createTab(null, true);
    setTimeout(() => navigateTab(id, url), 50);
  }
}

// ======= 履歴 =======
const HISTORY_MAX = 500;

function getHistory() {
  if (typeof TC_ACCOUNT !== 'undefined') return window._histCache || [];
  try { return JSON.parse(localStorage.getItem('tc_history') || '[]'); } catch { return []; }
}
async function _syncHistory() {
  if (typeof TC_ACCOUNT !== 'undefined') {
    window._histCache = await TC_ACCOUNT.getHistory();
    // history-tracker.js が外部ページから localStorage に書いたエントリをマージ
    try {
      const local = JSON.parse(localStorage.getItem('tc_history') || '[]');
      if (local.length > 0) {
        const merged = [...local, ...(window._histCache || [])];
        const seen = new Set();
        window._histCache = merged
          .filter(h => { const k = h.time + '|' + h.url; if (seen.has(k)) return false; seen.add(k); return true; })
          .sort((a, b) => b.time - a.time)
          .slice(0, HISTORY_MAX);
        localStorage.removeItem('tc_history');
        TC_ACCOUNT.saveHistory(window._histCache);
      }
    } catch {}
  }
}
function saveHistory(hist) {
  if (typeof TC_ACCOUNT !== 'undefined') {
    window._histCache = hist;
    TC_ACCOUNT.saveHistory(hist);
  } else {
    localStorage.setItem('tc_history', JSON.stringify(hist));
  }
}

function addHistoryEntry({ title, url, favicon }) {
  if (!url) return;
  let hist = getHistory();
  // 同じURLでも毎回の訪問を記録（Chrome/Edgeと同じ挙動）
  // ただし直前の項目と完全に同じURL・かつ5秒以内のリロード等は除外
  const last = hist[0];
  if (last && last.url === url && (Date.now() - last.time) < 5000) {
    // 読み込み中はタイトルがURLのままのことがある。後からタイトルが取れたら更新する
    if (title && title !== url && last.title !== title) {
      last.title = title;
      if (favicon && !last.favicon) last.favicon = favicon;
      saveHistory(hist);
    }
    return;
  }
  hist.unshift({ title: title || url, url, favicon: favicon || '', time: Date.now() });
  if (hist.length > HISTORY_MAX) hist = hist.slice(0, HISTORY_MAX);
  saveHistory(hist);
}

function clearHistory() {
  if (!confirm('すべての履歴を削除しますか？')) return;
  window._histCache = [];
  if (typeof TC_ACCOUNT !== 'undefined') {
    TC_ACCOUNT.saveHistory([]);
  } else {
    localStorage.removeItem('tc_history');
  }
  renderHistoryList();
}

function toggleHistoryPanel() {
  const panel = document.getElementById('history-panel');
  if (!panel) return;
  const willOpen = !panel.classList.contains('open');
  closeAllPanels();
  if (willOpen) {
    panel.classList.add('open');
    _syncMobileScrim();
    renderHistoryList();
    const hs = document.getElementById('history-search');
    if (hs) hs.value = '';
  }
}

function renderHistoryList() {
  const hist = getHistory();
  const query = (document.getElementById('history-search')?.value || '').trim().toLowerCase();
  const list = document.getElementById('history-list');
  if (!list) return;
  _initHistoryListEvents(list);

  // 検索を消すボタンは、入力があるときだけ出す
  const clearBtn = document.getElementById('history-search-clear');
  if (clearBtn) clearBtn.style.display = query ? 'flex' : 'none';

  const filtered = query
    ? hist.filter(h => (h.title || '').toLowerCase().includes(query) || (h.url || '').toLowerCase().includes(query))
    : hist;

  // 見出しの件数バッジ
  const countEl = document.getElementById('history-count');
  if (countEl) {
    countEl.textContent = filtered.length;
    countEl.title = query ? `検索結果 ${filtered.length}件（全${hist.length}件）` : `全${hist.length}件`;
  }

  if (filtered.length === 0) {
    list.innerHTML = '<div class="hist-empty">' +
      (query ? '一致する履歴がありません' : '履歴がありません') + '</div>';
    return;
  }

  // 日付グループ化
  const groups = {};
  const now = new Date();
  filtered.forEach(h => {
    const d = new Date(h.time);
    let label;
    if (isSameDay(d, now)) label = '今日';
    else if (isSameDay(d, new Date(now - 86400000))) label = '昨日';
    else label = d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
    if (!groups[label]) groups[label] = [];
    groups[label].push(h);
  });

  list.innerHTML = Object.entries(groups).map(([label, items]) => `
    <div class="hist-group-label">${escHtml(label)}<span class="n">${items.length}</span></div>
    ${items.map(h => {
      const { host, path } = _histUrlParts(h.url);
      const title = h.title || host || h.url || '';
      return `
      <div class="hist-item" data-url="${escHtml(h.url)}" title="${escHtml(title)}&#10;${escHtml(h.url)}">
        <span class="hist-favicon">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          ${h.favicon ? `<img src="${escHtml(h.favicon)}" alt="" onerror="this.remove()">` : ''}
        </span>
        <div class="hist-item-info">
          <div class="hist-item-title">${escHtml(title)}</div>
          <div class="hist-item-meta">
            <span class="hist-item-host">${escHtml(host)}</span>
            <span class="hist-item-path">${escHtml(path)}</span>
          </div>
        </div>
        <span class="hist-item-time">${formatTime(h.time)}</span>
        <button class="hist-item-del" data-time="${h.time}" title="この履歴を削除" aria-label="この履歴を削除">✕</button>
      </div>`;
    }).join('')}
  `).join('');
}

// URLを「サイト名」と「パス」に分ける（履歴一覧で読みやすくするため）
function _histUrlParts(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const path = (u.pathname === '/' ? '' : u.pathname) + (u.search || '') + (u.hash || '');
    return { host, path };
  } catch {
    return { host: String(url || ''), path: '' };
  }
}

// 一覧は毎回作り直すので、クリックは親要素でまとめて受ける（1回だけ登録）
function _initHistoryListEvents(list) {
  if (!list || list._tcDelegated) return;
  list._tcDelegated = true;
  list.addEventListener('click', ev => {
    const del = ev.target.closest('.hist-item-del');
    if (del) {
      ev.stopPropagation();
      removeHistoryItem(del.dataset.time);
      return;
    }
    const item = ev.target.closest('.hist-item');
    if (item && item.dataset.url) openHistoryItem(item.dataset.url);
  });
}

function clearHistorySearch() {
  const input = document.getElementById('history-search');
  if (input) { input.value = ''; input.focus(); }
  renderHistoryList();
}

function openHistoryItem(url) {
  closeAllPanels();
  if (activeTabId) navigateTab(activeTabId, url);
  else { const id = createTab(null, true); setTimeout(() => navigateTab(id, url), 50); }
}

function removeHistoryItem(time) {
  const hist = getHistory().filter(h => String(h.time) !== String(time));
  saveHistory(hist);
  renderHistoryList();
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

// ======= 永続化 =======
let _lastCookieSave = 0;
function saveTabsToStorage() {
  const data = tabs.map(t => ({ id: t.id, title: t.title, url: t.url, displayUrl: t.displayUrl, favicon: t.favicon, isNew: t.isNew }));
  try {
    localStorage.setItem('tc_tabs', JSON.stringify(data));
    localStorage.setItem('tc_tabCounter', tabCounter);
    if (activeTabId != null) localStorage.setItem('tc_activeTab', activeTabId);
    if (typeof TC_ACCOUNT !== 'undefined') {
      TC_ACCOUNT.saveTabs(data, tabCounter, activeTabId);
      // Cookieの全件読み出しは重いので、保存は5秒に1回までに間引く
      if (TC_ACCOUNT.currentUser() && Date.now() - _lastCookieSave > 5000) {
        _lastCookieSave = Date.now();
        TC_ACCOUNT.saveCookies();
      }
    }
  } catch {}
}

let _restoredActiveId = null;
async function loadTabsFromStorage() {
  try {
    let saved = [], counter = 0, activeId = null;
    if (typeof TC_ACCOUNT !== 'undefined') {
      const d = await TC_ACCOUNT.getTabs();
      saved = d.tabs || []; counter = d.counter || 0; activeId = d.activeId;
      // 同時にブックマーク・履歴もキャッシュ
      await _syncBookmarks();
      await _syncHistory();
    } else {
      saved = JSON.parse(localStorage.getItem('tc_tabs') || '[]');
      counter = parseInt(localStorage.getItem('tc_tabCounter') || '0');
      const a = localStorage.getItem('tc_activeTab'); activeId = a == null ? null : parseInt(a);
    }
    if (!Array.isArray(saved)) saved = [];
    tabCounter = counter;
    _restoredActiveId = activeId;
    for (const t of saved) {
      if (!t || typeof t.id !== 'number') continue;
      tabCounter = Math.max(tabCounter, t.id);
      if (!t.isNew) {
        // 保存時のエンジン/オリジンに依存しないよう、元のURLから現在のエンジンの符号で張り直す
        let display = t.displayUrl;
        if (!display || !/^https?:\/\//i.test(display)) display = decodeProxyUrl(t.url);
        if (/^https?:\/\/[!-~]+$/i.test(display || '')) {
          t.displayUrl = display;
          try { t.url = await buildProxyUrl(display); } catch {}
        } else {
          // 壊れた保存URLはニュータブとして復元（エラーページを出さない）
          t.url = null; t.isNew = true; t.displayUrl = '';
        }
      }
      t.lazy = true; // 表示するときにiframeを作る
      tabs.push(t);
    }
    renderTabs();
  } catch {}
}

// ======= プロキシエンジン切替 =======
// v1 = /service/（Ultraviolet 1.0.11・従来） / ir1 = /ir1-service/（IR V1: UV V3ベースエンジン）
// 旧設定値 'v3' も 'ir1' として互換扱いする。
function isIrEngine() {
  try {
    const v = localStorage.getItem('dev_engine');
    return v === 'ir1' || v === 'v3';
  } catch (e) { return false; }
}
function enginePrefix() {
  return isIrEngine() ? '/ir1-service/' : '/service/';
}
function engineSWUrl() {
  return enginePrefix() === '/ir1-service/' ? '/ir1/sw.js' : '/sw.js';
}
let _ir1Promise = null;
function _ir1() {
  if (window.IR1) return Promise.resolve(window.IR1);
  if (!_ir1Promise) {
    _ir1Promise = new Promise(resolve => {
      const s = document.createElement('script');
      s.src = '/ir1/ir.bundle.js';
      s.onload = () => {
        // バンドルは UMD で window.Ultraviolet を生やす。将来のバージョンで
        // エクスポート形状が変わっても undefined を IR1 に入れない。
        const uv = window.Ultraviolet || (s.contentWindow && s.contentWindow.Ultraviolet) || null;
        if (uv && uv.codec && uv.codec.base64) {
          window.IR1 = uv;
        }
        try { delete window.Ultraviolet; } catch (e) {}
        resolve(window.IR1 || null);
      };
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
  }
  return _ir1Promise;
}
function _ir1Ready() {
  return enginePrefix() === '/ir1-service/' ? _ir1() : Promise.resolve();
}
function encodeForEngine(url) {
  try {
    if (enginePrefix() === '/ir1-service/' && window.IR1) return window.IR1.codec.base64.encode(url);
  } catch (e) {}
  return __uv$config.encodeUrl(url);
}
// URLからプロキシURLを構築する（エンジン設定に応じて符号方式も合わせる）。
// IR V1コーデックが読み込めない場合は従来エンジン(/service/)で開くことで
// 符号方式の不一致（atobエラー・Failed to load）を防ぐ。
async function buildProxyUrl(url) {
  if (enginePrefix() === '/ir1-service/') {
    let ir1 = null;
    try { ir1 = await _ir1(); } catch (e) { ir1 = null; }
    const bIr = ir1 && ir1.codec && ir1.codec.base64;
    if (bIr && typeof bIr.encode === 'function' && typeof bIr.decode === 'function') {
      // round-trip検証: SW側と同じcodecで復号して元に戻ることを保証する。
      // 復号が不一致・例外なら壊れた符号を /ir1-service/ に出さず従来エンジンへフォールバック。
      try {
        const enc = bIr.encode(url);
        if (typeof enc === 'string' && enc && bIr.decode(enc) === url) {
          return '/ir1-service/' + enc;
        }
        try { console.warn('[engine] IR V1コーデックのround-trip検証に失敗したため従来エンジンで開きます'); } catch (e) {}
      } catch (e) {
        try { console.warn('[engine] IR V1コーデックで符号化できず従来エンジンで開きます:', e && e.message); } catch (e2) {}
      }
    }
  }
  return '/service/' + __uv$config.encodeUrl(url);
}
window.setEngine = function(name) {
  try {
    const next = (name === 'ir1' || name === 'v3') ? 'ir1' : 'v1';
    localStorage.setItem('dev_engine', next);
    console.warn('[engine] ' + (next === 'ir1' ? 'IR V1' : 'UV v1') + ' に切替。再読み込みで反映されます');
  } catch (e) {}
};

// ======= ポップアップパネル排他制御 & スクリム同期 =======
function _syncMobileScrim() {
  const scrim = document.getElementById('mobile-panel-scrim');
  if (!scrim) return;
  const anyOpen = [
    '#bookmark-panel',
    '#history-panel',
    '#more-options-panel',
    '#ext-panel',
    '#cookie-panel',
  ].some(sel => document.querySelector(sel)?.classList.contains('open')) ||
    (document.getElementById('go-account-menu')?.style.display === 'block');
  scrim.classList.toggle('open', anyOpen);
}

function closeAllPanels() {
  ['#bookmark-panel', '#history-panel', '#more-options-panel', '#ext-panel', '#cookie-panel'].forEach(sel => {
    document.querySelector(sel)?.classList.remove('open');
  });
  const acct = document.getElementById('go-account-menu');
  if (acct) acct.style.display = 'none';
  _syncMobileScrim();
}

function openSinglePanel(kind) {
  closeAllPanels();
  if (kind === 'bookmark') {
    toggleBookmarkPanel();
  } else if (kind === 'history') {
    toggleHistoryPanel();
  } else if (kind === 'cookie') {
    toggleCookiePanel();
  } else if (kind === 'account') {
    toggleGoAccountMenu();
  }
}
window.closeAllPanels = closeAllPanels;
window.openSinglePanel = openSinglePanel;

// ======= その他メニュー =======
function toggleMoreOptions() {
  const panel = document.getElementById('more-options-panel');
  if (!panel) return;
  const willOpen = !panel.classList.contains('open');
  closeAllPanels();
  if (willOpen) {
    panel.classList.add('open');
    _syncMobileScrim();
  }
}

// ======= 拡張機能パネル（拡張機能ボタンで開閉） =======
// パネルは拡張機能ボタンの真下に開く（ボタンの位置から毎回計算・下に入りきらない場合は真上）
function toggleExtPanel() {
  const panel = document.getElementById('ext-panel');
  if (!panel) return;
  const willOpen = !panel.classList.contains('open');
  closeAllPanels();
  if (willOpen) {
    panel.classList.add('open');
    positionExtPanel();
    _syncMobileScrim();
  }
}
function positionExtPanel() {
  const panel = document.getElementById('ext-panel');
  const btn = document.getElementById('ext-btn');
  if (!panel || !btn) return;
  const r = btn.getBoundingClientRect();
  const w = panel.offsetWidth || 260;
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  panel.style.left = left + 'px';
  // 基本はボタンの真下に4pxの隙間で開く（ボタンの実位置基準）
  // 下に入りきらない場合は従来どおり真上に開く
  const h = panel.offsetHeight || 160;
  if (r.bottom + 4 + h + 8 <= window.innerHeight) {
    panel.style.top = (r.bottom + 4) + 'px';
    panel.style.bottom = 'auto';
  } else {
    panel.style.top = 'auto';
    panel.style.bottom = (window.innerHeight - r.top + 4) + 'px';
  }
}
window.addEventListener('resize', () => {
  const panel = document.getElementById('ext-panel');
  if (panel && panel.classList.contains('open')) positionExtPanel();
});
window.toggleExtPanel = toggleExtPanel;
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ======= 開発者ツール（Console / Elements）は devtools.js に統合 =======
// ここには互換用の小さなヘルパーだけ残す。
function _escHtml(text) {
  const d = document.createElement('div');
  d.textContent = String(text);
  return d.innerHTML;
}

// ======= UI非表示 =======
// body.ui-hidden クラスを「唯一の真実の源」にする。
// バーの表示/非表示も #content-area の余白もすべてこのクラスだけで制御し、
// インライン style.display とクラスの二重管理による当たり判定のズレを防ぐ。
function hideUI() {
  document.body.classList.add('ui-hidden');
  document.getElementById('show-ui-btn').classList.add('visible');
}
function showUI() {
  document.body.classList.remove('ui-hidden');
  document.getElementById('show-ui-btn').classList.remove('visible');
}

// ======= フルスクリーン =======
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

// ======= ズーム =======
let _zoomLevel = 100;
function applyZoom() {
  document.querySelectorAll('.browser-frame').forEach(f => {
    f.style.transformOrigin = 'top left';
    if (_zoomLevel === 100) {
      f.style.transform = '';
      f.style.width = '100%';
      f.style.height = '100%';
    } else {
      const scale = _zoomLevel / 100;
      f.style.transform = `scale(${scale})`;
      f.style.width = `${(100 / scale).toFixed(2)}%`;
      f.style.height = `${(100 / scale).toFixed(2)}%`;
    }
  });
  document.getElementById('zoom-level-display').textContent = _zoomLevel + '%';
}
function adjustZoom(delta) {
  _zoomLevel = Math.max(25, Math.min(300, _zoomLevel + delta));
  applyZoom();
  addLog(`ズーム: ${_zoomLevel}%`, 'info');
}
function resetZoom() {
  _zoomLevel = 100;
  applyZoom();
  addLog('ズームをリセット', 'info');
}
function toggleZoomPopup() {
  document.getElementById('zoom-popup').classList.toggle('open');
}

// ======= ズームポップアップ外クリックで閉じる =======
// （ログシステムは devtools.js に移行）
window.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('click', e => {
    const zp = document.getElementById('zoom-popup');
    if (zp && !zp.contains(e.target)) zp.classList.remove('open');
  });
});

// ======= テーマ管理（ダークモード / ライトモード / システム同期）=======
const GO_THEME_KEY = 'go_theme';

function _applyTheme(mode) {
  // mode: 'dark' | 'light' | 'system'
  let resolved = mode;
  if (mode === 'system') {
    resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', resolved);
}

function setGoTheme(mode) {
  // 'dark' | 'light' | 'system'
  localStorage.setItem(GO_THEME_KEY, mode);
  _applyTheme(mode);
}

function getGoTheme() {
  return localStorage.getItem(GO_THEME_KEY) || 'dark';
}

// システムテーマ変更を監視
try {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getGoTheme() === 'system') _applyTheme('system');
  });
} catch {}

// ======= タブ偽装（クローク）起動時適用 =======
function applyGoCloak() {
  try {
    // 新形式（settings.html v2）: localStorage.getItem('sitename') / 'faviconurl'
    const sitename = localStorage.getItem('sitename') || '';
    const faviconurl = localStorage.getItem('faviconurl') || '';
    // 旧形式フォールバック: 'site-settings' JSON
    let oldSitename = '', oldFavicon = '';
    try {
      const oldSettings = JSON.parse(localStorage.getItem('site-settings') || '{}');
      oldSitename = oldSettings.siteName || '';
      oldFavicon = oldSettings.favicon || '';
    } catch {}

    const finalName = sitename || oldSitename;
    const finalFavicon = faviconurl || oldFavicon;

    if (finalName) document.title = finalName;

    if (finalFavicon) {
      let link = document.querySelector("link[rel='icon']");
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = finalFavicon;
    }
  } catch (e) {
    try { console.warn('[go] applyCloak error:', e && e.message); } catch {}
  }
}

// ======= go.html アカウントUI =======
function renderGoAccountUI() {
  if (typeof TC_ACCOUNT === 'undefined') return;
  const user = TC_ACCOUNT.currentAccount();
  const btn    = document.getElementById('go-account-btn');
  const avatar = document.getElementById('go-account-avatar');
  const ddName = document.getElementById('go-dd-name');
  const ddRole = document.getElementById('go-dd-role');
  const loggedIn  = document.getElementById('go-dd-loggedin');
  const loggedOut = document.getElementById('go-dd-loggedout');
  if (!btn) return;

  if (user) {
    if (user.icon) {
      avatar.innerHTML = `<img src="${user.icon}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
      btn.style.background = 'transparent';
    } else {
      avatar.textContent = user.username.slice(0,2).toUpperCase();
      btn.style.background = 'linear-gradient(135deg,#5b8fff,#a55bff)';
    }
    ddName.textContent = user.username;
    ddRole.textContent = 'ログイン中';
    if (loggedIn)  loggedIn.style.display  = 'block';
    if (loggedOut) loggedOut.style.display = 'none';
  } else {
    avatar.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
    btn.style.background = 'var(--surface2)';
    ddName.textContent = 'ゲスト';
    ddRole.textContent = 'ログインしていません';
    if (loggedIn)  loggedIn.style.display  = 'none';
    if (loggedOut) loggedOut.style.display = 'block';
  }
}

function toggleGoAccountMenu() {
  const menu = document.getElementById('go-account-menu');
  if (!menu) return;
  const willOpen = menu.style.display !== 'block';
  closeAllPanels();
  if (willOpen) {
    renderGoAccountUI();
    menu.style.display = 'block';
    _syncMobileScrim();
  }
}

function doGoLogout() {
  if (typeof TC_ACCOUNT !== 'undefined') TC_ACCOUNT.logout();
  document.getElementById('go-account-menu').style.display = 'none';
  renderGoAccountUI();
}

function goToHome() {
  if (requestCloseBrowser()) return;
  location.href = '../index.html';
}

// go-account-menu 外クリックで閉じる
document.addEventListener('click', e => {
  const menu = document.getElementById('go-account-menu');
  const btn  = document.getElementById('go-account-btn');
  if (menu && btn && !menu.contains(e.target) && !btn.contains(e.target)) {
    menu.style.display = 'none';
  }
});
// ======= 拡張機能: 広告ブロック（β / v2.2.0） =======
// ON/OFFは下段ナビの拡張機能ボタン（パズル）→ 拡張機能一覧パネルで行う。
// 仕組み: iframe 内に広告を隠すCSS（クラス/ID根拠）を注入しつつ、URL根拠の
// 判定はJS側で行う。プロキシ(/service/)はURLをエンコードしてsrc/hrefに書き込むため、
// CSSの属性セレクタ [src*="ドメイン"] では一切一致しない（v2.2.0で根本修正）。
// 動的に注入される広告も MutationObserver で監視して非表示にする。
const ADBLOCK_KEY = 'ext_adblock';
// ルール本体は adblock-rules.js（SWと共有）。ここでは参照するだけ。
const AD_CSS_SELECTOR = (window.TC_AD_RULES && window.TC_AD_RULES.cssSelector) || 'ins.adsbygoogle';
function adblockEnabled() { return localStorage.getItem(ADBLOCK_KEY) !== 'false'; }

// 属性値を復号して広告かどうか判定する（共通ルール TC_AD_RULES を使用）
function _adIsAdUrl(u, cfg) {
  if (!u) return false;
  const R = window.TC_AD_RULES;
  if (!R) return false;
  let dec = null;
  try {
    const prefix = (cfg && cfg.prefix) || '/service/';
    let v = String(u);
    const i = v.indexOf(prefix);
    if (cfg && cfg.decodeUrl && i >= 0) {
      let rest = v.slice(i + prefix.length).split('#')[0];
      dec = String(cfg.decodeUrl(rest) || '');
    }
  } catch (e) {}
  if (dec && R.urlBlocked(dec)) return true;
  // プロキシ化されていない生のURL（data-src など）
  if (/^https?:\/\//i.test(String(u)) && R.urlBlocked(String(u))) return true;
  return false;
}

// doc 内の要素を走査して URL根拠で広告と判断した要素をインライン非表示にする。
// 非表示にした要素はスタイルタグに記録し、トグルOFFで復元できるようにする。
function _adScanDoc(doc, st) {
  const hidden = st.__hidden;
  // フレーム側に __uv$config があればそちらを優先（v3エンジンのフレームでは復号方式が異なる）
  const cfg = (doc.defaultView && doc.defaultView.__uv$config) ||
    (typeof __uv$config !== 'undefined' ? __uv$config : null);
  const els = doc.querySelectorAll('iframe,img,embed,object,video,source,script,link,a');
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    if (el.__tcAdHidden) continue;
    let hit = false;
    const attrs = ['src', 'href', 'data-src'];
    for (let j = 0; j < attrs.length; j++) {
      const v = el.getAttribute(attrs[j]);
      if (v && _adIsAdUrl(v, cfg)) { hit = true; break; }
    }
    if (!hit) continue;
    hidden.push({ el: el, prev: (el.style && el.style.display) || '' });
    el.__tcAdHidden = true;
    try { el.style.setProperty('display', 'none', 'important'); } catch (e) {}
  }
}

// トグルOFF: 非表示にした要素を復元し、監視を停止してスタイルタグを外す
function _adTeardown(frame) {
  try {
    const doc = frame.contentDocument;
    if (!doc) return;
    const swSt = doc.getElementById('tc-adblock-sw');
    if (swSt) swSt.remove();
    const st = doc.getElementById('tc-adblock-style');
    if (!st) return;
    (st.__hidden || []).forEach(h => {
      try { h.el.style.display = h.prev; } catch (e) {}
      try { delete h.el.__tcAdHidden; } catch (e) {}
    });
    st.__hidden = [];
    if (st.__observer) { try { st.__observer.disconnect(); } catch (e) {} }
    st.__observer = null;
    st.remove();
  } catch (e) {}
}

function applyAdblock(frame) {
  if (!frame || !adblockEnabled()) return;
  try {
    const doc = frame.contentDocument;
    if (!doc || !doc.body) return;
    let st = doc.getElementById('tc-adblock-style');
    if (!st) {
      st = doc.createElement('style');
      st.id = 'tc-adblock-style';
      st.__hidden = [];
      // クラス/ID根拠の広告は従来どおりCSSで非表示（残り続けるため
      // 後から注入される広告も自動で隠れる。URL根拠は下のJS判定が担当）
      st.textContent = AD_CSS_SELECTOR +
        '{display:none!important;visibility:hidden!important;height:0!important;width:0!important;}';
      (doc.head || doc.documentElement).appendChild(st);
      // 動的に注入される広告を追跡（変化を400msに間引いて走査）
      try {
        const MO = (doc.defaultView && doc.defaultView.MutationObserver) ||
          (typeof window !== 'undefined' ? window.MutationObserver : null);
        if (MO) {
          let timer = 0;
          const obs = new MO(() => {
            if (timer) return;
            timer = setTimeout(() => {
              timer = 0;
              try { _adScanDoc(doc, st); } catch (e) {}
            }, 400);
          });
          obs.observe(doc.documentElement || doc, { childList: true, subtree: true, attributes: true });
          st.__observer = obs;
        }
      } catch (e) {}
    }
    // URL根拠の初回スキャン
    _adScanDoc(doc, st);
  } catch (e) { /* クロスオリジン等はβでは無視 */ }
}

// ON/OFF をプロキシのService Workerへ伝える（SW側で通信遮断・早期CSS注入を切り替える）
function syncAdblockToSW() {
  const msg = { type: 'tc-adblock', enabled: adblockEnabled() };
  if (!navigator.serviceWorker) return;
  navigator.serviceWorker.getRegistrations().then(regs => {
    regs.forEach(r => { const w = r.active || r.waiting || r.installing; if (w) { try { w.postMessage(msg); } catch (e) {} } });
  }).catch(() => {});
}
window.syncAdblockToSW = syncAdblockToSW;

function toggleAdblock() {
  localStorage.setItem(ADBLOCK_KEY, adblockEnabled() ? 'false' : 'true');
  syncAdblockToSW();
  updateAdblockBtn();
  document.querySelectorAll('iframe.browser-frame').forEach(f => {
    if (adblockEnabled()) { applyAdblock(f); return; }
    _adTeardown(f);
  });
}

function updateAdblockBtn() {
  const on = adblockEnabled();
  const sw = document.getElementById('ext-switch-adblock');
  if (sw) sw.classList.toggle('on', on);
  const row = document.getElementById('ext-row-adblock');
  if (row) row.classList.toggle('ext-off', !on);
}
window.toggleAdblock = toggleAdblock;
updateAdblockBtn();


// 全ての拡張機能をiframeへまとめて適用する統一フック。onload直後はDOMが
// 完全でないことが多いため、1.5秒後・4秒後にも再適用する。
// （従来はタブ復元経路でしか呼ばれておらず、アドレスバーから開いた
//   ページには一切適用されていなかった — v2.2.0で修正）
function applyAllExtensions(frame) {
  // 新しい拡張機能はここに追加する
  applyAdblock(frame);
}
function scheduleExtensions(frame) {
  applyAllExtensions(frame);
  setTimeout(() => applyAllExtensions(frame), 1500);
  setTimeout(() => applyAllExtensions(frame), 4000);
}

// ======= SNS共有ボタン（v2.2.0） =======
// 表示中のサイトをSNS(sns.html)に共有する。投稿機能自体は今後のアップデートで実装。
function currentShareTarget() {
  const frames = Array.from(document.querySelectorAll('iframe.browser-frame'));
  return frames.find(f => f.offsetParent !== null) || frames[frames.length - 1] || null;
}

// プロキシ(/service/)経由のURLから元のURLをベストエフォートで復元する
function prettySharedUrl(raw) {
  if (!raw) return '';
  try {
    let u = raw;
    const i = u.indexOf('/service/');
    if (i >= 0) u = u.slice(i + '/service/'.length);
    try { u = decodeURIComponent(u); } catch (e) {}
    if (!/^https?:/i.test(u) && /^[A-Za-z0-9_-]{8,}={0,2}$/.test(u)) {
      try { u = atob(u.replace(/-/g, '+').replace(/_/g, '/')); } catch (e) {}
    }
    return u;
  } catch (e) { return raw; }
}

function shareToSNS() {
  const f = currentShareTarget();
  let raw = '', title = '';
  if (f) {
    try { raw = f.contentWindow.location.href; } catch (e) { raw = f.src || ''; }
    try { title = (f.contentDocument && f.contentDocument.title) || ''; } catch (e) {}
    if (!raw) raw = f.src || '';
  }
  const draft = { url: prettySharedUrl(raw), title: title || '', at: Date.now() };
  try { localStorage.setItem('tc_sns_draft', JSON.stringify(draft)); } catch (e) {}
  window.open('/worksheets/sns.html?share=1', '_blank');
}
window.shareToSNS = shareToSNS;


// ======= Cookie: サイト別の保存設定（v2.3.0） =======
// 'save' = 端末に残す（ログイン中はアカウントにも同期） / 'session' = ブラウザを閉じると削除
function _activeSiteHost() {
  const tab = tabs.find(t => t.id === activeTabId);
  const u = tab && !tab.isNew ? (tab.displayUrl || decodeProxyUrl(tab.url)) : '';
  try { return new URL(u).hostname; } catch { return ''; }
}
async function renderCookiePanel() {
  const host = _activeSiteHost();
  const base = host ? TC_COOKIES.baseDomain(host) : '';
  const siteEl = document.getElementById('ck-site');
  const countEl = document.getElementById('ck-count');
  const noteEl = document.getElementById('ck-note');
  const seg = document.getElementById('ck-seg');
  if (!siteEl) return;
  siteEl.textContent = base || '（サイトが開かれていません）';
  seg.style.opacity = base ? '' : '.4';
  seg.style.pointerEvents = base ? '' : 'none';
  const pol = TC_COOKIES.getPolicy();
  const own = base ? pol.sites[base] : null;
  seg.querySelectorAll('button').forEach(b => {
    const m = b.dataset.mode;
    b.classList.toggle('on', m === 'default' ? !own : own === m);
  });
  const eff = base ? (own || pol.default) : pol.default;
  noteEl.textContent = own ? '' : '既定: ' + (pol.default === 'save' ? '保存する' : '保存しない') + '（設定ページで変更）';
  noteEl.title = eff;
  try {
    const map = await TC_COOKIES.listSites();
    countEl.textContent = base ? ('保存中のCookie: ' + (map.get(base) || 0) + '件') : '';
  } catch { countEl.textContent = ''; }
}
function toggleCookiePanel() {
  const panel = document.getElementById('cookie-panel');
  if (!panel) return;
  const willOpen = !panel.classList.contains('open');
  closeAllPanels();
  if (willOpen) {
    panel.classList.add('open');
    _syncMobileScrim();
    renderCookiePanel();
  }
}
async function setCookieModeForSite(mode) {
  const host = _activeSiteHost();
  if (!host) return;
  TC_COOKIES.setSitePolicy(host, mode);
  // 「保存する」へ変えたら今ある分もアカウントへ同期する
  try { if (TC_ACCOUNT.currentUser()) await TC_ACCOUNT.saveCookies(); } catch {}
  renderCookiePanel();
}
async function deleteCookiesForSite() {
  const host = _activeSiteHost();
  if (!host) return;
  if (!confirm(TC_COOKIES.baseDomain(host) + ' のCookieを削除しますか？\n（このサイトのログインが解除される場合があります）')) return;
  await TC_COOKIES.deleteSite(host);
  try { if (TC_ACCOUNT.currentUser()) await TC_ACCOUNT.saveCookies(); } catch {}
  renderCookiePanel();
  if (typeof addLog === 'function') addLog('Cookieを削除しました: ' + TC_COOKIES.baseDomain(host), 'ok');
}
window.toggleCookiePanel = toggleCookiePanel;
window.setCookieModeForSite = setCookieModeForSite;
window.deleteCookiesForSite = deleteCookiesForSite;
