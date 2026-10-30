// =====================================================
//  TheCollapse — Account Manager (server-auth edition)
//  全ページ共通で読み込む。
//  認証はサーバー側 (/api/auth/*) で行い、パスワードは
//  scrypt + salt でハッシュ化してサーバーが保持する。
//  セッションは HttpOnly Cookie で管理されるため、
//  クライアント側にパスワードハッシュを一切保持しない。
//  ユーザーデータは worksheets/data/<username>.json に保存し、
//  サーバーがログイン中の本人のみ読み書きを許可する。
//  ゲスト時は localStorage にフォールバック。
// =====================================================

// =====================================================
//  TC_COOKIES — プロキシCookieの保存ポリシー管理 (v2.3.0)
//  UVのCookieはIndexedDB('__op'/'cookies')に保存される。
//  ここでは「サイト別に保存する/しない」を選べるようにする。
//   - 'save'    : 端末に残す（ログイン中はアカウントにも同期）
//   - 'session' : ブラウザを閉じるまでだけ有効（次回起動時に削除・同期しない）
// =====================================================
const TC_COOKIES = (() => {
  const POLICY_KEY = 'tc_cookie_policy';
  const SESSION_FLAG = 'tc_ck_session';
  const DB_NAME = '__op';

  // 登録ドメイン(サイト単位)の簡易判定: example.co.jp / example.com
  const SLD = new Set(['co', 'ne', 'or', 'ac', 'go', 'ed', 'gr', 'ad', 'com', 'org', 'net', 'gov', 'edu']);
  function baseDomain(host) {
    host = String(host || '').toLowerCase().replace(/^\./, '').replace(/:\d+$/, '');
    if (!host || /^[\d.]+$/.test(host) || host.indexOf(':') >= 0) return host;
    const p = host.split('.');
    if (p.length <= 2) return host;
    const tld = p[p.length - 1], sld = p[p.length - 2];
    const n = (tld.length === 2 && SLD.has(sld)) ? 3 : 2;
    return p.slice(-n).join('.');
  }

  // ---- ポリシー ----
  function _normalize(p) {
    const out = { default: 'save', sites: {} };
    if (p && typeof p === 'object') {
      if (p.default === 'session') out.default = 'session';
      if (p.sites && typeof p.sites === 'object') {
        for (const k of Object.keys(p.sites)) {
          const v = p.sites[k];
          if (v === 'save' || v === 'session') out.sites[baseDomain(k)] = v;
        }
      }
    }
    return out;
  }
  function getPolicy() {
    try { return _normalize(JSON.parse(localStorage.getItem(POLICY_KEY) || 'null')); }
    catch { return _normalize(null); }
  }
  function _store(p, sync) {
    p = _normalize(p);
    try { localStorage.setItem(POLICY_KEY, JSON.stringify(p)); } catch {}
    if (sync && typeof window !== 'undefined' && window.TC_ACCOUNT && window.TC_ACCOUNT.saveCookiePolicy) {
      try { window.TC_ACCOUNT.saveCookiePolicy(p); } catch {}
    }
    return p;
  }
  function setDefault(mode) {
    const p = getPolicy(); p.default = mode === 'session' ? 'session' : 'save'; return _store(p, true);
  }
  // mode: 'save' | 'session' | null(既定に従う)
  function setSitePolicy(host, mode) {
    const p = getPolicy(); const b = baseDomain(host);
    if (!b) return p;
    if (mode === 'save' || mode === 'session') p.sites[b] = mode; else delete p.sites[b];
    return _store(p, true);
  }
  function policyFor(host) {
    const p = getPolicy(); const b = baseDomain(host);
    return p.sites[b] || p.default;
  }
  function applyRemotePolicy(p) { if (p) _store(p, false); }
  function shouldPersist(cookie) { return policyFor(cookie && cookie.domain) === 'save'; }

  // ---- IndexedDB ----
  function _open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = e => {
        const store = e.target.result.createObjectStore('cookies', { keyPath: 'id' });
        store.createIndex('path', 'path');
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function readAll() {
    try {
      const db = await _open();
      return await new Promise((resolve, reject) => {
        const req = db.transaction('cookies', 'readonly').objectStore('cookies').getAll();
        req.onsuccess = () => { db.close(); resolve(req.result || []); };
        req.onerror = () => { db.close(); reject(req.error); };
      });
    } catch { return []; }
  }
  function _toDate(v) {
    if (v === undefined || v === null) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    const d = new Date(v); return isNaN(d.getTime()) ? null : d;
  }
  function _expired(c, now) {
    const set = _toDate(c.set);
    if (set && c.maxAge && set.getTime() + c.maxAge * 1000 < now) return true;
    const exp = _toDate(c.expires);
    if (exp && exp.getTime() < now) return true;
    return false;
  }
  // 結合(マージ)書き込み。既存を消さない。同じidは新しい方(set日時)を採用。
  async function mergeIn(cookies) {
    if (!cookies || !cookies.length) return 0;
    const now = Date.now();
    try {
      const db = await _open();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('cookies', 'readwrite');
        const store = tx.objectStore('cookies');
        const getAll = store.getAll();
        let n = 0;
        getAll.onsuccess = () => {
          const have = new Map((getAll.result || []).map(c => [c.id, c]));
          for (const c of cookies) {
            if (!c || !c.id || _expired(c, now)) continue;
            const item = { ...c };
            const set = _toDate(item.set), exp = _toDate(item.expires);
            if (set) item.set = set; else delete item.set;
            if (exp) item.expires = exp; else delete item.expires;
            const cur = have.get(item.id);
            const curSet = cur && _toDate(cur.set);
            if (cur && curSet && set && curSet.getTime() >= set.getTime()) continue;
            store.put(item); n++;
          }
        };
        tx.oncomplete = () => { db.close(); resolve(n); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      });
    } catch (e) { console.warn('[TC_COOKIES] mergeIn failed:', e); return 0; }
  }
  async function deleteWhere(pred) {
    try {
      const db = await _open();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('cookies', 'readwrite');
        const store = tx.objectStore('cookies');
        const getAll = store.getAll();
        let n = 0;
        getAll.onsuccess = () => {
          for (const c of (getAll.result || [])) if (pred(c)) { store.delete(c.id); n++; }
        };
        tx.oncomplete = () => { db.close(); resolve(n); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      });
    } catch { return 0; }
  }
  const deleteSite = (host) => { const b = baseDomain(host); return deleteWhere(c => baseDomain(c.domain) === b); };
  const deleteAll = () => deleteWhere(() => true);

  // 保存対象(ポリシー'save'・未期限切れ)のCookieだけを返す（アカウント同期用）
  async function readPersistable() {
    const now = Date.now();
    return (await readAll()).filter(c => !_expired(c, now) && shouldPersist(c));
  }
  // サイト別の件数一覧
  async function listSites() {
    const map = new Map();
    for (const c of await readAll()) {
      const b = baseDomain(c.domain);
      if (!b) continue;
      map.set(b, (map.get(b) || 0) + 1);
    }
    return map;
  }
  // ブラウザを閉じた後の最初の起動時だけ、'session'サイトのCookieを消す
  async function purgeSessionCookiesOnce() {
    try { if (sessionStorage.getItem(SESSION_FLAG)) return 0; sessionStorage.setItem(SESSION_FLAG, '1'); } catch {}
    return deleteWhere(c => !shouldPersist(c));
  }

  return { baseDomain, getPolicy, setDefault, setSitePolicy, policyFor, applyRemotePolicy,
    shouldPersist, readAll, mergeIn, deleteSite, deleteAll, readPersistable, listSites,
    purgeSessionCookiesOnce };
})();
window.TC_COOKIES = TC_COOKIES;

const TC_ACCOUNT = (() => {
  // ---- 開発者アカウント（デベロッパータグを表示する専用ユーザー） ----
  const TC_DEV_USERS = ['sousou09'];

  // ---- 内部状態 ----
  // _current は { username, icon, bg, createdAt, admin } など公開情報のみ。
  // パスワードハッシュは保持しない。
  let _current = null;

  // ---- ユーザーデータの単一インメモリキャッシュ ----
  // 以前は saveHistory / saveTabs / saveBookmarks がそれぞれ独立に
  // _getData()（サーバー再読込）→ 一部フィールドだけ書き換え → 全体を書き戻し
  // を行っていたため、500ms のデバウンス窓内で複数の保存が走ると
  // 後勝ちで互いの変更を上書きし、履歴・タブの同期が失われていた（lost update）。
  // ここでは「読み込んだ 1 個のドキュメント」を常に共有し、各保存はその
  // 同じオブジェクトを書き換えるだけにすることで競合を解消する。
  let _docCache = null;          // 現在ログイン中ユーザーの完全なデータドキュメント
  let _docCacheUser = null;      // _docCache が属する username
  let _docLoadPromise = null;    // 読み込み中の重複リクエスト合流用

  // 他タブ/他端末からの変更を受け取るためのチャネル
  let _bc = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') _bc = new BroadcastChannel('tc_account_sync');
  } catch { _bc = null; }

  function _dataPath(username) {
    return `/worksheets/data/${encodeURIComponent(username)}.json`;
  }

  // _docCache を初期化/破棄
  function _resetDocCache(username = null) {
    _docCache = null;
    _docCacheUser = username;
    _docLoadPromise = null;
  }

  // 他タブへ「データが更新された」ことを通知（自タブの再読込は不要）
  function _broadcastChange(username) {
    try { _bc && _bc.postMessage({ type: 'data-changed', username, ts: Date.now() }); } catch {}
    // BroadcastChannel 非対応環境向けに localStorage シグナルも併用
    try { localStorage.setItem('tc_sync_ping', JSON.stringify({ username, ts: Date.now() })); } catch {}
  }

  // すべての認証/データ系 fetch は Cookie を送るため credentials:'same-origin'
  function _fetch(url, opts = {}) {
    return fetch(url, { credentials: 'same-origin', ...opts });
  }

  async function _api(path, { method = 'GET', body } = {}) {
    const res = await _fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const msg = (data && data.error) ? data.error : `エラー (${res.status})`;
      throw new Error(msg);
    }
    return data;
  }

  // ---- データファイル既定値 ----
  function _defaultData(username) {
    return { username, history: [], bookmarks: [], tabs: [], tabCounter: 0, searchEngine: 'google', bg: null };
  }

  // 書き込み用内部ヘルパー（本人のファイルのみ。サーバーが認可）
  async function _writeDataImmediate(username, data) {
    let serverOk = false;
    // 新旧判定用の更新時刻（サーバー版とIndexedDB版のどちらが新しいか比べる）
    data.updatedAt = Date.now();
    // 先に端末(IndexedDB)へ書く。ページ終了で通信が途切れても次回起動時にサーバーへ反映できる。
    const idbPromise = _writeIDB(username, data);
    try {
      const body = JSON.stringify(data);
      // fetch の keepalive はボディ64KBまで。超えるとfetch自体が例外になり、
      // 履歴が増えた途端にサーバー保存が一切行われなくなっていた(v2.3.0修正)。
      const res = await _fetch(_dataPath(username), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: body.length < 60000,
      });
      if (res.ok) serverOk = true;
    } catch {}
    await idbPromise;
    return serverOk;
  }

  // IndexedDB へのバックアップ書き込み（オフライン/通信断対策）
  async function _writeIDB(username, data) {
    try {
      await new Promise((resolve, reject) => {
        const req = indexedDB.open('tc_userdata', 1);
        req.onupgradeneeded = e => {
          e.target.result.createObjectStore('files', { keyPath: 'username' });
        };
        req.onsuccess = e => {
          const db = e.target.result;
          const tx = db.transaction('files', 'readwrite');
          tx.objectStore('files').put({ username, data: JSON.stringify(data) });
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => { db.close(); reject(tx.error); };
        };
        req.onerror = () => reject(req.error);
      });
    } catch {}
  }

  // デバウンス書き込み（500ms）
  const _pendingWrites = new Map();
  function _writeData(username, data, { immediate = false } = {}) {
    if (immediate) {
      const p = _pendingWrites.get(username);
      if (p) { clearTimeout(p.timer); _pendingWrites.delete(username); }
      return _writeDataImmediate(username, data);
    }
    let entry = _pendingWrites.get(username);
    if (entry) {
      entry.data = data;
      clearTimeout(entry.timer);
    } else {
      entry = { data, timer: null, promise: null, resolve: null };
      entry.promise = new Promise(r => { entry.resolve = r; });
      _pendingWrites.set(username, entry);
    }
    entry.timer = setTimeout(async () => {
      const e = _pendingWrites.get(username);
      if (!e) return;
      _pendingWrites.delete(username);
      const ok = await _writeDataImmediate(username, e.data);
      e.resolve(ok);
    }, 500);
    return entry.promise;
  }

  async function _flushPendingWrites() {
    const entries = [..._pendingWrites.entries()];
    _pendingWrites.clear();
    for (const [username, e] of entries) {
      clearTimeout(e.timer);
      const ok = await _writeDataImmediate(username, e.data);
      e.resolve(ok);
    }
  }

  async function _readIDB(username) {
    return new Promise((resolve) => {
      const req = indexedDB.open('tc_userdata', 1);
      req.onupgradeneeded = e => {
        e.target.result.createObjectStore('files', { keyPath: 'username' });
      };
      req.onsuccess = e => {
        const db = e.target.result;
        const tx = db.transaction('files', 'readonly');
        const get = tx.objectStore('files').get(username);
        get.onsuccess = () => {
          db.close();
          if (get.result) {
            try { resolve(JSON.parse(get.result.data)); } catch { resolve(null); }
          } else { resolve(null); }
        };
        get.onerror = () => { db.close(); resolve(null); };
      };
      req.onerror = () => resolve(null);
    });
  }

  // サーバー（本人のみ許可）→ IndexedDB → 既定値 の順でドキュメントを取得（キャッシュ無視）
  async function _fetchDataFromSource(username) {
    let server = null;
    try {
      const res = await _fetch(_dataPath(username), { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        if (json && json.username) server = json;
      }
    } catch {}
    const idb = await _readIDB(username);
    // 端末側(IndexedDB)の方が新しい = サーバーへ書き損ねた変更が残っている
    // （ページ終了時の通信断・サーバー再起動など）。新しい方を採用してサーバーへ再送する。
    if (idb && idb.username === username && (!server || (idb.updatedAt || 0) > (server.updatedAt || 0))) {
      if (server) {
        // 他端末で増えた履歴などを失わないよう、配列は和集合でマージ
        idb.history = _mergeHistory(idb.history, server.history);
        idb.bookmarks = _mergeBy(idb.bookmarks, server.bookmarks, b => b.url);
      }
      _pendingResync = username;
      return idb;
    }
    if (server) return server;
    return _defaultData(username);
  }
  let _pendingResync = null;
  function _mergeBy(a, b, keyFn) {
    const seen = new Set(), out = [];
    for (const x of [...(a || []), ...(b || [])]) {
      const k = keyFn(x); if (seen.has(k)) continue; seen.add(k); out.push(x);
    }
    return out;
  }
  function _mergeHistory(a, b) {
    return _mergeBy(a, b, h => h.time + '|' + h.url).sort((x, y) => y.time - x.time).slice(0, 500);
  }

  // 単一インメモリキャッシュを介してドキュメントを返す。
  // すべての getter / setter はこの「同じオブジェクト」を共有することで、
  // フィールドごとの保存が互いを上書きする lost update を防ぐ。
  async function _getData(username) {
    // 別ユーザーに切り替わったらキャッシュを捨てる
    if (_docCacheUser !== username) _resetDocCache(username);
    if (_docCache) return _docCache;
    if (_docLoadPromise) return _docLoadPromise;
    _docLoadPromise = (async () => {
      const doc = await _fetchDataFromSource(username);
      // 取得の途中でユーザーが変わっていなければ採用
      if (_docCacheUser === username) _docCache = doc;
      _docLoadPromise = null;
      if (_pendingResync === username) {
        _pendingResync = null;
        try { _writeData(username, doc); } catch {}
      }
      return _docCache || doc;
    })();
    return _docLoadPromise;
  }

  // 強制的にサーバーから読み直してキャッシュを更新（他タブ/他端末の変更取り込み用）。
  // 進行中の保留書き込みは先に flush して、自分の未保存変更を失わないようにする。
  async function _refreshData(username) {
    if (!username) return null;
    try { await _flushPendingWrites(); } catch {}
    const doc = await _fetchDataFromSource(username);
    if (_docCacheUser === username) _docCache = doc;
    return doc;
  }

  // キャッシュ済みドキュメントを安全に書き換えて永続化する共通ヘルパー。
  // mutator は同じ参照のオブジェクトを直接編集する。
  async function _mutate(username, mutator, opts = {}) {
    const d = await _getData(username);
    mutator(d);
    const p = _writeData(username, d, opts);
    _broadcastChange(username);
    return p;
  }

  // ---- ゲストストレージ（localStorage） ----
  const GUEST = {
    getHistory:    () => { try { return JSON.parse(localStorage.getItem('tc_history') || '[]'); } catch { return []; } },
    saveHistory:   (v) => localStorage.setItem('tc_history', JSON.stringify(v)),
    getBookmarks:  () => { try { return JSON.parse(localStorage.getItem('tc_bookmarks') || '[]'); } catch { return []; } },
    saveBookmarks: (v) => localStorage.setItem('tc_bookmarks', JSON.stringify(v)),
    getTabs:       () => { try { return JSON.parse(localStorage.getItem('tc_tabs') || '[]'); } catch { return []; } },
    saveTabs:      (v, ctr) => { localStorage.setItem('tc_tabs', JSON.stringify(v)); localStorage.setItem('tc_tabCounter', ctr); },
    getTabCounter: () => parseInt(localStorage.getItem('tc_tabCounter') || '0'),
    getActiveTab:  () => { const v = localStorage.getItem('tc_activeTab'); return v == null ? null : parseInt(v); },
    saveActiveTab: (v) => { if (v == null) localStorage.removeItem('tc_activeTab'); else localStorage.setItem('tc_activeTab', v); },
    getEngine:     () => localStorage.getItem('searchengine') || 'google',
    saveEngine:    (v) => localStorage.setItem('searchengine', v),
    getBg:         () => localStorage.getItem('tc_bg') || null,
    saveBg:        (v) => v ? localStorage.setItem('tc_bg', v) : localStorage.removeItem('tc_bg'),
  };

  // ---- 公開 API ----
  const API = {
    currentUser: () => _current ? _current.username : null,
    currentAccount: () => _current,
    // 専用ユーザー（開発者）かどうか
    isDev: (name) => TC_DEV_USERS.indexOf(name) >= 0,

    // アカウント作成（サーバーで scrypt ハッシュ化・セッション発行）
    async createAccount(username, password, iconDataUrl) {
      if (!username || !password) throw new Error('ユーザー名とパスワードは必須です');
      const data = await _api('/api/auth/register', {
        method: 'POST',
        body: { username, password, icon: iconDataUrl || null },
      });
      // 登録と同時にサーバーがセッション Cookie を設定する
      _current = data.user;
      localStorage.setItem('tc_active_user', _current.username);
      // データファイル初期化（新規ユーザーのキャッシュも初期化）
      const initData = _defaultData(username);
      initData.icon = _current.icon || null;
      initData.createdAt = _current.createdAt;
      _resetDocCache(username);
      _docCache = initData;
      await _writeData(username, initData);
      return _current;
    },

    // ログイン
    async login(username, password) {
      if (!username || !password) throw new Error('ユーザー名とパスワードは必須です');
      const data = await _api('/api/auth/login', {
        method: 'POST',
        body: { username, password },
      });
      _current = data.user;
      // 別ユーザーの可能性があるためデータキャッシュをリセットしてから読み直す
      _resetDocCache(_current.username);
      // searchEngine をキャッシュ
      try {
        const d = await _getData(_current.username);
        if (d.searchEngine) _current.engine = d.searchEngine;
      } catch {}
      localStorage.setItem('tc_active_user', _current.username);
      return _current;
    },

    // ログアウト
    async logout() {
      // ログアウト前に未保存の変更を確実に書き出す
      try { await _flushPendingWrites(); } catch {}
      try { await _api('/api/auth/logout', { method: 'POST' }); } catch {}
      _current = null;
      _resetDocCache(null);
      localStorage.removeItem('tc_active_user');
    },

    // セッション復元（サーバーの Cookie セッションを参照）
    async restoreSession() {
      try {
        const data = await _api('/api/auth/me');
        if (data && data.user) {
          _current = data.user;
          _resetDocCache(_current.username);
          try {
            const d = await _getData(_current.username);
            if (d.searchEngine) _current.engine = d.searchEngine;
          } catch {}
          localStorage.setItem('tc_active_user', _current.username);
          return true;
        }
      } catch {}
      _current = null;
      _resetDocCache(null);
      localStorage.removeItem('tc_active_user');
      return false;
    },

    // アカウント情報更新（アイコン・背景・パスワード）。サーバーで本人確認。
    async updateAccount(fields) {
      if (!_current) return;
      const body = {};
      if ('icon' in fields) body.icon = fields.icon;
      if ('bg' in fields) body.bg = fields.bg;
      // 旧実装の passwordHash は廃止。新しいパスワードは平文をサーバーに送り
      // サーバー側で scrypt ハッシュ化する（HTTPS 前提）。
      if ('password' in fields && fields.password) body.password = fields.password;
      if (Object.keys(body).length === 0) return;
      try {
        const data = await _api('/api/auth/update', { method: 'POST', body });
        if (data && data.user) {
          const engine = _current.engine;
          _current = data.user;
          if (engine) _current.engine = engine;
        }
      } catch (e) {
        throw e;
      }
    },

    // アカウント削除（サーバーでパスワード再確認）
    async deleteAccount(username, password) {
      // username 引数は互換のために受けるが、サーバーはセッションの本人のみ削除する
      await _api('/api/auth/delete', { method: 'POST', body: { password } });
      // 削除に成功したら保留中の書き込みは破棄してキャッシュも消す
      _pendingWrites.clear();
      if (_current && _current.username === username) {
        _current = null;
        _resetDocCache(null);
        localStorage.removeItem('tc_active_user');
      }
    },

    // 旧 API 互換: アカウント一覧はクライアントに公開しない
    getAccountList() { return []; },

    // ---- データ操作（ログイン状態で自動切替） ----
    async getHistory() {
      if (!_current) return GUEST.getHistory();
      const d = await _getData(_current.username);
      return d.history || [];
    },
    async saveHistory(v) {
      if (!_current) { GUEST.saveHistory(v); return; }
      await _mutate(_current.username, d => { d.history = v; });
    },
    async getBookmarks() {
      if (!_current) return GUEST.getBookmarks();
      const d = await _getData(_current.username);
      return d.bookmarks || [];
    },
    async saveBookmarks(v) {
      if (!_current) { GUEST.saveBookmarks(v); return; }
      await _mutate(_current.username, d => { d.bookmarks = v; });
    },
    async getTabs() {
      if (!_current) return { tabs: GUEST.getTabs(), counter: GUEST.getTabCounter(), activeId: GUEST.getActiveTab() };
      const d = await _getData(_current.username);
      return { tabs: d.tabs || [], counter: d.tabCounter || 0, activeId: d.activeTabId == null ? null : d.activeTabId };
    },
    async saveTabs(tabs, counter, activeId) {
      if (!_current) { GUEST.saveTabs(tabs, counter); GUEST.saveActiveTab(activeId); return; }
      await _mutate(_current.username, d => { d.tabs = tabs; d.tabCounter = counter; d.activeTabId = activeId == null ? null : activeId; });
    },
    getEngine() {
      if (!_current) return GUEST.getEngine();
      return _current.engine || 'google';
    },
    async saveEngine(v) {
      if (!_current) { GUEST.saveEngine(v); return; }
      _current.engine = v;
      await _mutate(_current.username, d => { d.searchEngine = v; });
    },
    getBg() {
      if (!_current) return GUEST.getBg();
      return _current.bg || null;
    },
    async saveBg(v) {
      if (!_current) { GUEST.saveBg(v); return; }
      await API.updateAccount({ bg: v });
    },

    // ---- UV Cookie 保存・復元（ログインユーザーのみ・サイト別ポリシー対応）----
    // 'save' のサイトのCookieだけをアカウントへ保存する。'session' のサイトは同期しない。
    async saveCookies() {
      if (!_current) return;
      try {
        const cookies = await TC_COOKIES.readPersistable();
        await _mutate(_current.username, d => { d.uvCookies = cookies; d.cookiePolicy = TC_COOKIES.getPolicy(); });
      } catch (e) {
        console.warn('[TC_ACCOUNT] saveCookies failed:', e);
      }
    },

    // アカウントのCookieを端末へ「結合」する（端末にあるCookieは消さない）。
    async restoreCookies() {
      if (!_current) return;
      try {
        const d = await _getData(_current.username);
        if (d.cookiePolicy) TC_COOKIES.applyRemotePolicy(d.cookiePolicy);
        if (d.uvCookies && d.uvCookies.length > 0) {
          // 保存しない設定のサイトのCookieは復元しない
          await TC_COOKIES.mergeIn(d.uvCookies.filter(c => TC_COOKIES.shouldPersist(c)));
        }
      } catch (e) {
        console.warn('[TC_ACCOUNT] restoreCookies failed:', e);
      }
    },

    async saveCookiePolicy(policy) {
      if (!_current) return;
      await _mutate(_current.username, d => { d.cookiePolicy = policy; });
    },

    // 他タブ/他端末の変更を取り込むため、サーバーから読み直す。
    // 戻り値は最新ドキュメント（呼び出し側でキャッシュ再描画に使える）。
    async refresh() {
      if (!_current) return null;
      return _refreshData(_current.username);
    },

    // 変更通知を購読する。callback(username) が呼ばれたら呼び出し側で再読込する。
    onSyncChange(callback) {
      if (typeof callback !== 'function') return () => {};
      const handlers = [];
      if (_bc) {
        const h = (ev) => {
          const data = ev && ev.data;
          if (data && data.type === 'data-changed') callback(data.username);
        };
        _bc.addEventListener('message', h);
        handlers.push(() => _bc.removeEventListener('message', h));
      }
      if (typeof window !== 'undefined') {
        const sh = (ev) => {
          if (ev.key === 'tc_sync_ping' && ev.newValue) {
            try { callback(JSON.parse(ev.newValue).username); } catch { callback(null); }
          }
        };
        window.addEventListener('storage', sh);
        handlers.push(() => window.removeEventListener('storage', sh));
      }
      return () => { handlers.forEach(fn => fn()); };
    },

    async flush() {
      await _flushPendingWrites();
    },

    async appendHistoryEntry(entry) {
      if (!_current) {
        const cur = GUEST.getHistory();
        cur.unshift(entry);
        GUEST.saveHistory(cur.slice(0, 500));
        return;
      }
      await _mutate(_current.username, d => {
        d.history = d.history || [];
        const last = d.history[0];
        if (last && last.url === entry.url && (Date.now() - last.time) < 5000) return;
        d.history.unshift(entry);
        if (d.history.length > 500) d.history = d.history.slice(0, 500);
      });
    },
  };

  // ── 自動保存 ─────────────────────────────────
  if (typeof window !== 'undefined') {
    const _finalSave = async () => {
      try {
        if (_current) {
          try {
            const cookies = await TC_COOKIES.readPersistable();
            const d = await _getData(_current.username);
            d.uvCookies = cookies;
            await _writeData(_current.username, d, { immediate: true });
          } catch {}
        }
        await _flushPendingWrites();
      } catch (e) {
        console.warn('[TC_ACCOUNT] finalSave error:', e);
      }
    };
    window.addEventListener('pagehide', _finalSave);
    window.addEventListener('beforeunload', () => {
      _flushPendingWrites();
    });
    // タブが再びアクティブになったとき、他タブ/他端末での変更をサーバーから取り込む。
    // 取り込んだら 'tc:datasync' を発火し、ページ側（go.js 等）が再描画できるようにする。
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible' || !_current) return;
      try {
        await _refreshData(_current.username);
        window.dispatchEvent(new CustomEvent('tc:datasync', { detail: { username: _current.username } }));
      } catch {}
    });
    setInterval(async () => {
      if (!_current) return;
      try {
        const cookies = await TC_COOKIES.readPersistable();
        if (!cookies || cookies.length === 0) return;
        await _mutate(_current.username, d => { d.uvCookies = cookies; });
      } catch {}
    }, 30000);

    // 他タブからの変更通知を受けたらサーバーから読み直して再描画イベントを発火。
    // （自タブの保存でも broadcast するが BroadcastChannel は送信元に届かないため
    //  自タブ二重更新は起きない。localStorage 経由のシグナルも別タブにのみ届く。）
    API.onSyncChange(async (username) => {
      if (!_current || (username && username !== _current.username)) return;
      try {
        await _refreshData(_current.username);
        window.dispatchEvent(new CustomEvent('tc:datasync', { detail: { username: _current.username } }));
      } catch {}
    });
  }

  return API;
})();

// グローバルに公開
window.TC_ACCOUNT = TC_ACCOUNT;
