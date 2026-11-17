/* ============================================================================
 * TheCollapse DevTools — Console と Elements を1つに統合した開発者ツール
 *
 *  ・単一のイベントストリーム (store) にログも DOM 変更も通信もすべて流す
 *  ・ログ → エレメント : ログ行の要素チップをクリックで Elements に飛ぶ
 *  ・エレメント → ログ : 選択中の要素に関するログ / 変更履歴(変更前→変更後)を Logs タブに表示
 *  ・ページ内(プロキシ越し iframe)の console / エラー / fetch / XHR を自動収集
 *  ・Elements は MutationObserver でリアルタイム更新、編集・Undo・要素ピッカー対応
 *
 *  公開 API : window.DevTools
 *  互換 API : addLog / setLogStatus / toggleLogPanel / toggleElementsPanel / _elemInspectActive
 * ========================================================================== */
(function () {
  'use strict';
  if (window.DevTools) return;

  /* ───────────── util ───────────── */
  const LS_KEY = 'tc.devtools.v2';
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  const pad = (n, w) => String(n).padStart(w || 2, '0');
  const clip = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; };
  function safe(fn, fb) { try { return fn(); } catch (e) { return fb; } }
  function decodeUrl(u) {
    try {
      if (typeof u === 'string' && /\/(ir1-service|service3?)\//.test(u) && typeof decodeProxyUrl === 'function') {
        const d = decodeProxyUrl(u);
        if (d) return d;
      }
    } catch (e) {}
    return u;
  }
  function copyText(t) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t); } catch (e) {}
    const ta = h('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
    return Promise.resolve();
  }
  function icon(name) {
    const P = {
      trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>',
      pause: '<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>',
      play: '<polygon points="7 4 20 12 7 20"/>',
      copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
      dl: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
      x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
      search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
      refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
      pick: '<path d="M3 3l7 17 2.5-7.5L20 10z"/>',
      undo: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
      panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="14" y1="3" x2="14" y2="21"/>',
      up: '<polyline points="18 15 12 9 6 15"/>',
      down: '<polyline points="6 9 12 15 18 9"/>',
      more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
      scroll: '<polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/>',
    };
    return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (P[name] || '') + '</svg>';
  }
  function btn(ic, title, cls) {
    const b = h('button', 'dt-btn' + (cls ? ' ' + cls : ''));
    b.type = 'button'; b.title = title; b.innerHTML = icon(ic);
    return b;
  }

  /* ───────────── 設定(永続化) ───────────── */
  const DEF = {
    tab: 'console', height: 320, time: 'abs', preserve: false, onlyTab: false, detail: true, detailTab: 'styles',
    levels: { error: true, warn: true, info: true, log: true, debug: true },
    cats: { app: true, console: true, error: true, net: true, dom: false, repl: true },
  };
  const S = Object.assign({}, DEF, safe(() => JSON.parse(localStorage.getItem(LS_KEY)), {}) || {});
  S.levels = Object.assign({}, DEF.levels, S.levels);
  S.cats = Object.assign({}, DEF.cats, S.cats);
  S.open = false;
  function saveSettings() {
    safe(() => localStorage.setItem(LS_KEY, JSON.stringify({
      tab: S.tab, height: S.height, time: S.time, preserve: S.preserve, onlyTab: S.onlyTab,
      detail: S.detail, detailTab: S.detailTab, levels: S.levels, cats: S.cats,
    })));
  }

  /* ───────────── フレーム管理 ───────────── */
  const frames = new Map(); // tabId -> { tabId, iframe, timer }
  function curTabId() { try { return activeTabId; } catch (e) { return null; } }
  function activeFrame() {
    const f = frames.get(curTabId());
    return f && f.iframe && f.iframe.isConnected ? f : null;
  }
  function docOf(iframe) { return safe(() => iframe.contentDocument || iframe.contentWindow.document, null); }

  /* ═════════════ 1. イベントストア（ログ・DOM変更・通信を全部ここに流す） ═════════════ */
  const store = [];
  const MAX = 1500, MAX_DOM = 300;
  let seq = 0, domCount = 0, pendingWhilePaused = 0, paused = false;
  const T0 = Date.now();
  const LEVELS = ['error', 'warn', 'info', 'log', 'debug'];
  const CAT_LABEL = { app: 'APP', console: 'PAGE', error: 'JS', net: 'NET', dom: 'DOM', repl: 'REPL' };

  function isPrim(v) { return v === null || (typeof v !== 'object' && typeof v !== 'function'); }

  /**
   * イベントを1本のストリームに追加する。
   * e = { level, cat, args[], tabId?, nodes?[], stack?, net? }
   */
  function emit(e) {
    e.level = LEVELS.includes(e.level) ? e.level : 'log';
    e.args = e.args || [];
    e.tabId = e.tabId == null ? curTabId() : e.tabId;
    e.nodes = e.nodes || [];
    e.ts = Date.now();
    e.count = 1;
    e.text = e.text || safe(() => e.args.map(a => (typeof a === 'string' ? a : previewOf(a, 1))).join(' ').toLowerCase(), '');
    // 直前と同一(プリミティブのみ)なら ×N に折りたたむ
    const last = store[store.length - 1];
    if (last && !e.net && !last.net && e.cat !== 'repl' && last.cat === e.cat && last.level === e.level &&
        last.tabId === e.tabId && last.args.length === e.args.length && e.args.every(isPrim) && last.args.every(isPrim) &&
        last.args.every((a, i) => a === e.args[i]) && e.ts - last.lastTs < 60000) {
      last.count++; last.lastTs = e.ts;
      updateRow(last);
      return last;
    }
    e.id = ++seq; e.lastTs = e.ts;
    store.push(e);
    if (e.cat === 'dom') {
      domCount++;
      if (domCount > MAX_DOM) { const i = store.findIndex(x => x.cat === 'dom'); if (i >= 0) dropAt(i); }
    }
    if (store.length > MAX) dropAt(0);
    if (paused) { pendingWhilePaused++; updateStats(); }
    else appendRow(e);
    return e;
  }
  function dropAt(i) {
    const [d] = store.splice(i, 1);
    if (d.cat === 'dom') domCount--;
    const r = rowEls.get(d.id);
    if (r) { r.remove(); rowEls.delete(d.id); }
  }

  /* ═════════════ 2. 値のプレビュー / 展開表示 ═════════════ */
  function typeOf(v) {
    if (v === null) return 'null';
    const t = typeof v;
    if (t === 'function') return 'function';
    if (t !== 'object') return t;
    const nt = safe(() => v.nodeType, 0);
    if (nt === 1) return 'element';
    if (nt === 3 || nt === 8 || nt === 9 || nt === 11) return 'node';
    if (safe(() => Array.isArray(v), false)) return 'array';
    if (isErr(v)) return 'error';
    return 'object';
  }
  function isErr(v) {
    const s = safe(() => Object.prototype.toString.call(v), '');
    return s === '[object Error]' || s === '[object DOMException]' || s === '[object ErrorEvent]';
  }
  function ctorName(v) { return safe(() => (v.constructor && v.constructor.name) || 'Object', 'Object'); }
  function nodeLabel(n) {
    if (!n) return '(null)';
    if (n.nodeType === 3) return '#text';
    if (n.nodeType === 8) return '#comment';
    if (n.nodeType === 9) return '#document';
    if (n.nodeType !== 1) return String(n.nodeName);
    let s = n.tagName.toLowerCase();
    if (n.id) s += '#' + n.id;
    const cls = typeof n.className === 'string' ? n.className.trim() : '';
    if (cls) s += '.' + cls.split(/\s+/).slice(0, 3).join('.');
    return s;
  }
  function errText(v) {
    return safe(() => (v.name || 'Error') + ': ' + (v.message || ''), String(v));
  }
  /** 1行プレビュー。depth=1 なら入れ子はさらに短く */
  function previewOf(v, depth) {
    try {
      const t = typeOf(v);
      switch (t) {
        case 'string': return depth > 0 ? JSON.stringify(clip(v, 60)) : v;
        case 'undefined': case 'null': case 'number': case 'boolean': case 'bigint': return String(v) + (t === 'bigint' ? 'n' : '');
        case 'symbol': return v.toString();
        case 'function': return 'ƒ ' + (safe(() => v.name, '') || '(anonymous)') + '()';
        case 'element': return '<' + nodeLabel(v) + '>';
        case 'node': return nodeLabel(v);
        case 'error': return errText(v);
        case 'array': {
          const n = v.length;
          if (depth > 0) return 'Array(' + n + ')';
          const items = [];
          for (let i = 0; i < Math.min(n, 5); i++) items.push(previewOf(v[i], 1));
          return 'Array(' + n + ') [' + items.join(', ') + (n > 5 ? ', …' : '') + ']';
        }
        default: {
          const cn = ctorName(v);
          const tag = safe(() => Object.prototype.toString.call(v), '');
          if (tag === '[object Date]') return safe(() => v.toISOString(), 'Date');
          if (tag === '[object RegExp]') return String(v);
          if (cn === 'Map' || cn === 'Set') return cn + '(' + v.size + ')';
          if (depth > 0) return cn === 'Object' ? '{…}' : cn;
          const ks = safe(() => Object.keys(v), []);
          const parts = ks.slice(0, 4).map(k => k + ': ' + safe(() => previewOf(v[k], 1), '(error)'));
          return (cn === 'Object' ? '' : cn + ' ') + '{' + parts.join(', ') + (ks.length > 4 ? ', …' : '') + '}';
        }
      }
    } catch (e) { return '[object]'; }
  }
  function nodeChip(node) {
    const c = h('span', 'dt-chip');
    c.textContent = '<' + nodeLabel(node) + '>';
    c.title = 'Elements で表示';
    c.addEventListener('click', ev => { ev.stopPropagation(); revealInElements(node); });
    return c;
  }
  function renderValue(v, top) {
    const t = typeOf(v);
    if (t === 'element') return nodeChip(v);
    if (t === 'string') { const s = h('span', 'dt-v dt-string'); s.textContent = top ? v : JSON.stringify(clip(v, 200)); return s; }
    if (t === 'array' || t === 'object' || t === 'function') return expandable(v, t);
    const s = h('span', 'dt-v dt-' + t);
    s.textContent = previewOf(v, 0);
    return s;
  }
  function expandable(v, t) {
    const wrap = h('span', 'dt-obj');
    const head = h('span', 'dt-obj-head');
    const caret = h('span', 'dt-oc'); head.appendChild(caret);
    head.appendChild(h('span', 'dt-v dt-' + t, previewOf(v, 0)));
    wrap.appendChild(head);
    let box = null;
    head.addEventListener('click', ev => {
      ev.stopPropagation();
      const open = wrap.classList.toggle('open');
      if (open && !box) { box = h('div', 'dt-props'); wrap.appendChild(box); fillProps(box, v); }
      if (box) box.style.display = open ? '' : 'none';
    });
    return wrap;
  }
  function fillProps(box, v) {
    const MAXK = 100;
    let entries = [];
    const cn = ctorName(v);
    try {
      if (cn === 'Map') entries = Array.from(v.entries()).map(([k, val], i) => ['[' + i + '] ' + previewOf(k, 1), val]);
      else if (cn === 'Set') entries = Array.from(v.values()).map((val, i) => ['[' + i + ']', val]);
      else {
        entries = Object.keys(v).map(k => [k, undefined]);
        if (Array.isArray(v)) entries.push(['length', v.length]);
      }
    } catch (e) {}
    if (!entries.length && typeof v === 'function') entries = [['source', clip(safe(() => Function.prototype.toString.call(v), ''), 1500)]];
    if (!entries.length) box.appendChild(h('div', 'dt-prop dt-muted', '(空)'));
    entries.slice(0, MAXK).forEach(([k, val]) => {
      if (val === undefined && !(cn === 'Map' || cn === 'Set' || k === 'length' || k === 'source')) val = safe(() => v[k], '(取得エラー)');
      const row = h('div', 'dt-prop');
      row.appendChild(h('span', 'dt-pk', k));
      row.appendChild(h('span', 'dt-pc', ': '));
      row.appendChild(renderValue(val, false));
      box.appendChild(row);
    });
    if (entries.length > MAXK) box.appendChild(h('div', 'dt-prop dt-muted', '… 他 ' + (entries.length - MAXK) + ' 件'));
  }
  /** console.log("%s は %d", ...) の書式指定に対応 */
  function formatArgs(args) {
    if (typeof args[0] !== 'string' || !/%[sdifoOjc%]/.test(args[0])) return args;
    let i = 1;
    const s = args[0].replace(/%([sdifoOjc%])/g, (m, c) => {
      if (c === '%') return '%';
      if (i >= args.length) return m;
      const a = args[i++];
      switch (c) {
        case 's': return isPrim(a) ? String(a) : previewOf(a, 1);
        case 'd': case 'i': return String(typeof a === 'object' ? NaN : parseInt(a, 10));
        case 'f': return String(typeof a === 'object' ? NaN : parseFloat(a));
        case 'c': return '';
        default: return previewOf(a, 1);
      }
    });
    return [s].concat(args.slice(i));
  }

  /* ═════════════ 3. ページ(iframe)への フック: console / error / fetch / XHR ═════════════ */
  const NET_PENDING = new Map();
  function hookWindow(win, f) {
    if (!win || win.__tcDt) return false;
    // about:blank やプロキシ(UV/IR V1)のハンドラ初期化前に fetch / XHR をラップすると、
    // 後から走る __uvHook がすでにラップ済みの fetch をさらに上書きする順序ズレや、
    // 遷移直前の初期 about:blank にフックが干渉する問題が起きる。
    // プロキシURL配下のフレームでは __uv の初期化完了を待ってからフックする。
    try {
      const href = String(win.location && win.location.href || '');
      if (!href || href === 'about:blank') return false;
      if (/\/(ir1-service|service3?)\//.test(href) && !win.__uv) return false;
    } catch (e) { return false; }
    try { Object.defineProperty(win, '__tcDt', { value: true, configurable: true }); } catch (e) { return false; }
    const tabId = f.tabId;

    // console
    const c = safe(() => win.console, null);
    if (c) {
      [['log', 'log'], ['info', 'info'], ['warn', 'warn'], ['error', 'error'], ['debug', 'debug'], ['trace', 'debug'], ['assert', 'error'], ['table', 'log']].forEach(([m, lv]) => {
        const orig = c[m];
        if (typeof orig !== 'function' || orig.__dt) return;
        const w = function () {
          try {
            let a = Array.prototype.slice.call(arguments);
            if (m === 'assert') { if (a[0]) return orig.apply(this, arguments); a = ['Assertion failed:'].concat(a.slice(1)); }
            const e = { level: lv, cat: 'console', args: formatArgs(a), tabId };
            e.nodes = e.args.filter(x => typeOf(x) === 'element');
            if (m === 'error' || m === 'warn' || m === 'trace') e.stack = safe(() => String(new win.Error().stack || '').split('\n').slice(2).join('\n'), '');
            emit(e);
          } catch (err) {}
          return orig.apply(this, arguments);
        };
        w.__dt = true;
        try { c[m] = w; } catch (e) {}
      });
      const oc = c.clear;
      if (typeof oc === 'function' && !oc.__dt) {
        const w = function () { try { if (!S.preserve) clearLogs(true, tabId); } catch (e) {} return oc.apply(this, arguments); };
        w.__dt = true; try { c.clear = w; } catch (e) {}
      }
    }

    // JS エラー / リソース読み込み失敗 / Promise reject / CSP 違反
    try {
      win.addEventListener('error', ev => {
        try {
          const t = ev.target;
          if (t && t !== win && t.tagName) {
            const src = t.currentSrc || t.src || t.href || '';
            emit({ level: 'error', cat: 'net', tabId, nodes: [t], args: ['リソース読み込み失敗 ', t, ' ' + decodeUrl(src)] });
          } else {
            const where = ev.filename ? decodeUrl(ev.filename) + ':' + ev.lineno + ':' + ev.colno : '';
            emit({ level: 'error', cat: 'error', tabId, args: [ev.message || 'Script error', where ? '  (' + where + ')' : ''], stack: safe(() => ev.error && ev.error.stack, '') });
          }
        } catch (e) {}
      }, true);
      win.addEventListener('unhandledrejection', ev => {
        try {
          const r = ev.reason;
          emit({ level: 'error', cat: 'error', tabId, args: ['Uncaught (in promise) ', isErr(r) ? errText(r) : r], stack: safe(() => r && r.stack, '') });
        } catch (e) {}
      });
      win.addEventListener('securitypolicyviolation', ev => {
        try { emit({ level: 'warn', cat: 'error', tabId, args: ['CSP違反: ' + ev.violatedDirective + ' ' + decodeUrl(ev.blockedURI || '')] }); } catch (e) {}
      });
    } catch (e) {}

    // fetch
    try {
      const of = win.fetch;
      if (typeof of === 'function' && !of.__dt) {
        const w = function (input, init) {
          let rec = null;
          try {
            const url = typeof input === 'string' ? input : (input && input.url) || String(input);
            const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
            rec = netBegin(tabId, method, url, 'fetch');
          } catch (e) {}
          const p = of.apply(this, arguments);
          if (rec) p.then(r => netEnd(rec, r.status, r.statusText), err => netEnd(rec, 0, '', err));
          return p;
        };
        w.__dt = true; win.fetch = w;
      }
      const X = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
      if (X && !X.open.__dt) {
        const oo = X.open, os = X.send;
        X.open = function (method, url) { try { this.__dtm = String(method).toUpperCase(); this.__dtu = String(url); } catch (e) {} return oo.apply(this, arguments); };
        X.send = function () {
          try {
            const rec = netBegin(tabId, this.__dtm || 'GET', this.__dtu || '', 'xhr');
            this.addEventListener('loadend', () => netEnd(rec, this.status, this.statusText));
          } catch (e) {}
          return os.apply(this, arguments);
        };
        X.open.__dt = true;
      }
    } catch (e) {}

    // ショートカットを iframe 内でも有効に（キャプチャ段階だとサイトのフォーム送信・Enter処理より先に介入するためバブル段階で登録）
    try { win.addEventListener('keydown', onKey, false); } catch (e) {}
    return true;
  }
  function netBegin(tabId, method, url, kind) {
    const shown = decodeUrl(url);
    const net = { method, url: shown, kind, status: null, ms: null, state: 'pending', t0: performance.now() };
    return emit({ level: 'info', cat: 'net', tabId, args: [], net, text: (method + ' ' + shown).toLowerCase() });
  }
  function netEnd(e, status, statusText, err) {
    const n = e.net;
    n.ms = Math.round(performance.now() - n.t0);
    n.status = status; n.statusText = statusText || '';
    n.state = err ? 'failed' : 'done';
    e.level = err || status >= 400 ? 'error' : status >= 300 ? 'warn' : 'info';
    if (err) n.error = safe(() => String(err && err.message || err), 'error');
    e.text = (n.method + ' ' + n.url + ' ' + status + ' ' + (n.error || '')).toLowerCase();
    updateRow(e);
    updateStats();
  }

  function watchFrame(tabId, iframe) {
    const old = frames.get(tabId);
    if (old) clearInterval(old.timer);
    const f = { tabId, iframe, timer: 0 };
    f.timer = setInterval(() => {
      if (!iframe.isConnected) { clearInterval(f.timer); if (frames.get(tabId) === f) frames.delete(tabId); return; }
      let win = null;
      try { win = iframe.contentWindow; void win.document; } catch (e) { return; }
      if (win && !win.__tcDt && hookWindow(win, f)) onFrameChanged(f);
    }, 100);
    frames.set(tabId, f);
  }
  let frameTimer = 0;
  function onFrameChanged(f) {
    if (!S.open || f !== activeFrame()) return;
    clearTimeout(frameTimer);
    frameTimer = setTimeout(() => { if (S.tab === 'elements') inspectActive(); }, 250);
  }

  /* ═════════════ 4. パネル UI（DOM 構築） ═════════════ */
  let panel, logList, replInput, statsEl, statusDot, statusText, searchInput, elTree, elDetail, elDetailBody, crumb, qCount;
  const rowEls = new Map();
  const ui = {};

  function build() {
    panel = $('#dt-panel');
    if (!panel) { panel = h('div'); panel.id = 'dt-panel'; document.body.appendChild(panel); }
    panel.innerHTML = '';

    const rz = h('div', 'dt-resize'); panel.appendChild(rz);
    bindResize(rz);

    // ── ヘッダ(タブ) ──
    const top = h('div', 'dt-top');
    ui.tabC = h('button', 'dt-tab', 'Console'); ui.tabE = h('button', 'dt-tab', 'Elements');
    ui.tabC.type = ui.tabE.type = 'button';
    ui.tabC.onclick = () => showTab('console'); ui.tabE.onclick = () => showTab('elements');
    ui.badge = h('span', 'dt-tab-badge'); ui.tabC.appendChild(ui.badge);
    top.appendChild(ui.tabC); top.appendChild(ui.tabE);
    top.appendChild(h('span', 'dt-flex'));
    const close = btn('x', '閉じる (F12)'); close.onclick = () => DevTools.close(); top.appendChild(close);
    panel.appendChild(top);

    panel.appendChild(buildConsole());
    panel.appendChild(buildElements());
    panel.addEventListener('keydown', ev => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'z' && S.tab === 'elements' && !/INPUT|TEXTAREA/.test(ev.target.tagName) && !ev.target.isContentEditable) {
        ev.preventDefault(); undo();
      }
    });
    document.addEventListener('click', () => hideCtx());
  }

  function bindResize(rz) {
    let sy = 0, sh = 0;
    const move = ev => {
      const y = ev.touches ? ev.touches[0].clientY : ev.clientY;
      S.height = Math.max(160, Math.min(window.innerHeight - 120, sh + (sy - y)));
      applyHeight();
      if (ev.cancelable) ev.preventDefault();
    };
    const up = () => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
      document.removeEventListener('touchmove', move); document.removeEventListener('touchend', up);
      saveSettings(); refreshHighlight();
    };
    const down = ev => {
      sy = ev.touches ? ev.touches[0].clientY : ev.clientY; sh = panel.offsetHeight;
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      document.addEventListener('touchmove', move, { passive: false }); document.addEventListener('touchend', up);
      ev.preventDefault();
    };
    rz.addEventListener('mousedown', down); rz.addEventListener('touchstart', down, { passive: false });
  }
  function applyHeight() {
    panel.style.height = S.height + 'px';
    document.documentElement.style.setProperty('--dt-h', S.open ? S.height + 'px' : '0px');
  }

  /* ── Console ペイン ── */
  function buildConsole() {
    const pane = h('div', 'dt-pane'); pane.id = 'dt-console';
    const bar = h('div', 'dt-bar');
    const clr = btn('trash', 'クリア'); clr.onclick = () => clearLogs(false);
    ui.pause = btn('pause', '一時停止（表示のみ停止・記録は継続）'); ui.pause.onclick = () => setPaused(!paused);
    const sw = h('div', 'dt-search');
    sw.innerHTML = icon('search');
    searchInput = h('input'); searchInput.type = 'text'; searchInput.placeholder = 'フィルタ  (文字列 or /正規表現/)';
    searchInput.spellcheck = false; searchInput.autocomplete = 'off';
    searchInput.addEventListener('input', () => { ui.search = searchInput.value.trim(); rebuildRows(); });
    sw.appendChild(searchInput);
    const cp = btn('copy', 'ログをコピー'); cp.onclick = () => { copyText(visibleEntries().map(fmtLine).join('\n')); flashBtn(cp); };
    const ex = btn('dl', 'JSON でエクスポート'); ex.onclick = exportJson;
    bar.appendChild(clr); bar.appendChild(ui.pause); bar.appendChild(sw); bar.appendChild(cp); bar.appendChild(ex);
    pane.appendChild(bar);

    const chips = h('div', 'dt-chips');
    ui.lvChips = {};
    LEVELS.forEach(lv => {
      const c = h('button', 'dt-chip-btn lv-' + lv); c.type = 'button';
      c.onclick = () => { S.levels[lv] = !S.levels[lv]; saveSettings(); syncChips(); rebuildRows(); };
      ui.lvChips[lv] = c; chips.appendChild(c);
    });
    chips.appendChild(h('span', 'dt-sep'));
    ui.catChips = {};
    [['app', 'アプリ'], ['console', 'ページ'], ['error', 'JSエラー'], ['net', '通信'], ['dom', 'DOM変更'], ['repl', 'REPL']].forEach(([k, label]) => {
      const c = h('button', 'dt-chip-btn cat'); c.type = 'button'; c.dataset.label = label;
      c.onclick = () => { S.cats[k] = !S.cats[k]; saveSettings(); syncChips(); rebuildRows(); if (k === 'dom') syncObserver(); };
      ui.catChips[k] = c; chips.appendChild(c);
    });
    chips.appendChild(h('span', 'dt-sep'));
    ui.tabOnly = h('button', 'dt-chip-btn cat', '現在のタブのみ'); ui.tabOnly.type = 'button';
    ui.tabOnly.onclick = () => { S.onlyTab = !S.onlyTab; saveSettings(); syncChips(); rebuildRows(); };
    ui.timeBtn = h('button', 'dt-chip-btn cat'); ui.timeBtn.type = 'button';
    ui.timeBtn.onclick = () => { S.time = S.time === 'abs' ? 'rel' : S.time === 'rel' ? 'off' : 'abs'; saveSettings(); syncChips(); rebuildRows(); };
    ui.keep = h('button', 'dt-chip-btn cat', 'ログを保持'); ui.keep.type = 'button';
    ui.keep.title = 'ページ遷移・console.clear() でクリアしない';
    ui.keep.onclick = () => { S.preserve = !S.preserve; saveSettings(); syncChips(); };
    chips.appendChild(ui.tabOnly); chips.appendChild(ui.timeBtn); chips.appendChild(ui.keep);
    pane.appendChild(chips);

    logList = h('div', 'dt-list'); logList.id = 'dt-loglist';
    logList.addEventListener('scroll', () => {
      ui.stick = logList.scrollHeight - logList.scrollTop - logList.clientHeight < 24;
      ui.jump.style.display = ui.stick ? 'none' : '';
    });
    ui.empty = h('div', 'dt-empty', '一致するログがありません');
    pane.appendChild(logList);
    ui.jump = h('button', 'dt-jump'); ui.jump.type = 'button'; ui.jump.innerHTML = icon('scroll') + ' 最新へ';
    ui.jump.style.display = 'none';
    ui.jump.onclick = () => { logList.scrollTop = logList.scrollHeight; };
    pane.appendChild(ui.jump);
    ui.stick = true;

    const repl = h('div', 'dt-repl');
    repl.appendChild(h('span', 'dt-prompt', '›'));
    replInput = h('input'); replInput.type = 'text'; replInput.spellcheck = false; replInput.autocomplete = 'off';
    replInput.placeholder = 'ページ内で JS を実行   ($0 = Elements で選択中の要素)';
    const hist = []; let hi = 0;
    replInput.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && replInput.value.trim()) {
        const code = replInput.value; hist.push(code); hi = hist.length; replInput.value = ''; runRepl(code);
      } else if (ev.key === 'ArrowUp') { if (hi > 0) replInput.value = hist[--hi] || ''; ev.preventDefault(); }
      else if (ev.key === 'ArrowDown') { hi = Math.min(hist.length, hi + 1); replInput.value = hist[hi] || ''; ev.preventDefault(); }
    });
    repl.appendChild(replInput);
    pane.appendChild(repl);

    const foot = h('div', 'dt-foot');
    statusDot = h('span', 'dt-dot idle'); statusText = h('span', null, 'Ready'); statsEl = h('span', 'dt-stats');
    foot.appendChild(statusDot); foot.appendChild(statusText); foot.appendChild(h('span', 'dt-flex')); foot.appendChild(statsEl);
    pane.appendChild(foot);
    return pane;
  }

  function flashBtn(b) { b.classList.add('ok'); setTimeout(() => b.classList.remove('ok'), 700); }
  function syncChips() {
    const counts = { error: 0, warn: 0, info: 0, log: 0, debug: 0 }, cc = {};
    store.forEach(e => { counts[e.level]++; cc[e.cat] = (cc[e.cat] || 0) + 1; });
    const LV = { error: 'Error', warn: 'Warn', info: 'Info', log: 'Log', debug: 'Debug' };
    LEVELS.forEach(lv => {
      const c = ui.lvChips[lv];
      c.textContent = LV[lv] + (counts[lv] ? ' ' + counts[lv] : '');
      c.classList.toggle('off', !S.levels[lv]);
    });
    Object.keys(ui.catChips).forEach(k => {
      const c = ui.catChips[k];
      c.textContent = c.dataset.label + (cc[k] ? ' ' + cc[k] : '');
      c.classList.toggle('off', !S.cats[k]);
    });
    ui.tabOnly.classList.toggle('off', !S.onlyTab);
    ui.timeBtn.textContent = '時刻: ' + (S.time === 'abs' ? '絶対' : S.time === 'rel' ? '相対' : '非表示');
    ui.keep.classList.toggle('off', !S.preserve);
    if (counts.error) { ui.badge.textContent = counts.error; ui.badge.style.display = ''; } else ui.badge.style.display = 'none';
  }
  let statsT = 0;
  function updateStats() {
    if (!statsEl || statsT) return;
    statsT = setTimeout(() => { statsT = 0; drawStats(); }, 80);
  }
  function drawStats() {
    if (!statsEl) return;
    const vis = visibleEntries().length;
    statsEl.textContent = (vis < store.length ? vis + ' / ' : '') + store.length + ' 件' + (paused ? '  (一時停止中: +' + pendingWhilePaused + ')' : '');
    syncChips();
  }
  function setPaused(v) {
    paused = v; ui.pause.innerHTML = icon(v ? 'play' : 'pause'); ui.pause.classList.toggle('active', v);
    ui.pause.title = v ? '再開' : '一時停止（表示のみ停止・記録は継続）';
    if (!v) { pendingWhilePaused = 0; rebuildRows(); } else updateStats();
  }

  /* ── ログ行の描画 ── */
  function matchSearch(e) {
    const q = ui.search;
    if (!q) return true;
    if (q.length > 2 && q[0] === '/' && q.lastIndexOf('/') > 0) {
      const i = q.lastIndexOf('/');
      try { return new RegExp(q.slice(1, i), q.slice(i + 1) || 'i').test(e.text); } catch (err) { /* 不正な正規表現は部分一致へ */ }
    }
    return e.text.includes(q.toLowerCase());
  }
  function matches(e) {
    if (!S.levels[e.level] || !S.cats[e.cat]) return false;
    if (S.onlyTab && e.tabId !== curTabId() && e.tabId != null && e.cat !== 'app') return false;
    return matchSearch(e);
  }
  function visibleEntries() { return store.filter(matches); }
  function timeStr(e) {
    if (S.time === 'off') return '';
    if (S.time === 'rel') return '+' + ((e.ts - T0) / 1000).toFixed(3) + 's';
    const d = new Date(e.ts);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3);
  }
  function entryText(e) {
    if (e.net) return e.net.method + ' ' + e.net.url + (e.net.status != null ? ' → ' + (e.net.status || 'FAILED') + ' ' + e.net.ms + 'ms' : ' …');
    return e.args.map(a => (typeof a === 'string' ? a : previewOf(a, 0))).join(' ');
  }
  function fmtLine(e) { return '[' + timeStr(e) + '] [' + e.level.toUpperCase() + '/' + CAT_LABEL[e.cat] + '] ' + entryText(e) + (e.count > 1 ? '  ×' + e.count : ''); }

  function buildRow(e) {
    const r = h('div', 'dt-row lv-' + e.level + ' cat-' + e.cat + (e.ok ? ' is-ok' : ''));
    r.dataset.id = e.id;
    const ts = timeStr(e);
    if (ts) r.appendChild(h('span', 'dt-ts', ts));
    r.appendChild(h('span', 'dt-cat', CAT_LABEL[e.cat] || e.cat));
    const msg = h('div', 'dt-msg');
    if (e.net) {
      const n = e.net;
      msg.appendChild(h('span', 'dt-method', n.method));
      const st = h('span', 'dt-status ' + (n.state === 'pending' ? 'pend' : n.status >= 400 || !n.status ? 'bad' : n.status >= 300 ? 'mid' : 'good'),
        n.state === 'pending' ? '…' : n.status || 'FAILED');
      msg.appendChild(st);
      msg.appendChild(h('span', 'dt-url', n.url));
      if (n.ms != null) msg.appendChild(h('span', 'dt-ms', n.ms + 'ms'));
      if (n.error) msg.appendChild(h('span', 'dt-muted', ' ' + n.error));
    } else {
      e.args.forEach((a, i) => { if (i) msg.appendChild(document.createTextNode(' ')); msg.appendChild(renderValue(a, true)); });
    }
    r.appendChild(msg);
    if (e.count > 1) r.appendChild(h('span', 'dt-count', '×' + e.count));
    if (e.stack) {
      const st = h('pre', 'dt-stack', e.stack.trim());
      r.appendChild(st);
      r.classList.add('has-stack');
      r.addEventListener('click', ev => { if (!ev.target.closest('.dt-obj, .dt-chip')) r.classList.toggle('open'); });
    }
    return r;
  }
  function appendRow(e) {
    if (!logList) return;
    const stick = ui.stick;
    updateStats();
    if (!matches(e)) return;
    ui.empty.remove();
    const r = buildRow(e); rowEls.set(e.id, r); logList.appendChild(r);
    if (stick) logList.scrollTop = logList.scrollHeight;
    refreshNodeLogs(e);
  }
  function updateRow(e) {
    if (!logList || paused) { updateStats(); return; }
    const old = rowEls.get(e.id);
    const ok = matches(e);
    if (old && ok) { const nr = buildRow(e); old.replaceWith(nr); rowEls.set(e.id, nr); if (old.classList.contains('open')) nr.classList.add('open'); }
    else if (old && !ok) { old.remove(); rowEls.delete(e.id); }
    else if (!old && ok && store.includes(e)) rebuildRows();
    updateStats();
    refreshNodeLogs(e);
  }
  function rebuildRows() {
    if (!logList) return;
    logList.innerHTML = ''; rowEls.clear();
    const frag = document.createDocumentFragment();
    let n = 0;
    store.forEach(e => { if (matches(e)) { const r = buildRow(e); rowEls.set(e.id, r); frag.appendChild(r); n++; } });
    logList.appendChild(frag);
    if (!n) logList.appendChild(ui.empty);
    if (ui.stick) logList.scrollTop = logList.scrollHeight;
    updateStats();
    if (S.tab === 'elements') renderDetail();
  }
  function clearLogs(fromPage, tabId) {
    for (let i = store.length - 1; i >= 0; i--) {
      const e = store[i];
      if (fromPage && (e.tabId !== tabId || e.cat === 'app')) continue;
      store.splice(i, 1);
    }
    domCount = store.filter(x => x.cat === 'dom').length;
    pendingWhilePaused = 0;
    rebuildRows();
    if (!fromPage) emit({ level: 'info', cat: 'app', args: ['ログをクリアしました'] });
  }
  function exportJson() {
    const seen = new WeakSet();
    const ser = (v, d) => {
      const t = typeOf(v);
      if (t === 'element' || t === 'node') return '<' + nodeLabel(v) + '>';
      if (t === 'function') return 'ƒ ' + (safe(() => v.name, '') || 'anonymous');
      if (t === 'error') return errText(v);
      if (t === 'undefined') return '[undefined]';
      if (t === 'symbol' || t === 'bigint') return String(v);
      if (isPrim(v)) return v;
      if (d > 3 || seen.has(v)) return '[…]';
      seen.add(v);
      if (Array.isArray(v)) return v.slice(0, 100).map(x => ser(x, d + 1));
      const o = {}; safe(() => Object.keys(v).slice(0, 100).forEach(k => { o[k] = ser(safe(() => v[k], '(error)'), d + 1); }));
      return o;
    };
    const data = {
      exportedAt: new Date().toISOString(), page: safe(() => { const f = activeFrame(); return decodeUrl(f.iframe.contentWindow.location.href); }, ''),
      entries: store.filter(matches).map(e => ({
        id: e.id, time: new Date(e.ts).toISOString(), level: e.level, category: e.cat, tabId: e.tabId, count: e.count,
        message: entryText(e), args: e.args.map(a => ser(a, 0)), stack: e.stack || undefined, net: e.net || undefined,
        target: e.nodes && e.nodes[0] ? nodeLabel(e.nodes[0]) : undefined,
      })),
    };
    const a = h('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = 'thecollapse-devtools-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* ── REPL: 現在のページ内で式を評価 ── */
  let lastResult;
  function runRepl(code) {
    emit({ level: 'log', cat: 'repl', args: ['› ' + code] }).repl = true;
    const f = activeFrame();
    const win = f && safe(() => f.iframe.contentWindow, null);
    if (!win) { emit({ level: 'error', cat: 'repl', args: ['ページが読み込まれていません'] }); return; }
    try {
      const def = (k, v) => { try { Object.defineProperty(win, k, { value: v, configurable: true, writable: true, enumerable: false }); } catch (e) {} };
      def('$0', E.sel && E.sel.nodeType === 1 ? E.sel : null); def('$_', lastResult);
      def('$', function (s) { return win.document.querySelector(s); }); def('$$', function (s) { return Array.from(win.document.querySelectorAll(s)); });
      const r = win.eval(code);
      if (r && typeof r.then === 'function') {
        emit({ level: 'log', cat: 'repl', args: ['Promise {pending}'] });
        r.then(v => { lastResult = v; emit({ level: 'log', cat: 'repl', args: ['← ', v], nodes: typeOf(v) === 'element' ? [v] : [] }); },
          err => emit({ level: 'error', cat: 'repl', args: ['Uncaught (in promise) ', isErr(err) ? errText(err) : err] }));
      } else {
        lastResult = r;
        emit({ level: 'log', cat: 'repl', args: ['← ', r], nodes: typeOf(r) === 'element' ? [r] : [] });
      }
    } catch (err) {
      emit({ level: 'error', cat: 'repl', args: [isErr(err) ? errText(err) : err], stack: safe(() => err.stack, '') });
    }
  }

  /* ═════════════ 5. Elements ═════════════ */
  const E = {
    doc: null, win: null, frame: null, rows: new WeakMap(), expanded: new WeakSet(), sel: null, mo: null,
    undo: [], matches: [], mi: -1, sq: '', pick: false, pickOff: null, hover: null,
  };

  function buildElements() {
    const pane = h('div', 'dt-pane'); pane.id = 'dt-elements';
    const bar = h('div', 'dt-bar');
    ui.pickBtn = btn('pick', '画面から要素を選択 (Ctrl+Shift+C)'); ui.pickBtn.onclick = () => setPick(!E.pick);
    const sw = h('div', 'dt-search'); sw.innerHTML = icon('search');
    const si = h('input'); si.type = 'text'; si.placeholder = 'セレクタ / XPath / 文字列で検索'; si.spellcheck = false; si.autocomplete = 'off';
    let st = 0;
    si.addEventListener('input', () => { clearTimeout(st); st = setTimeout(() => searchNext(si.value.trim(), 1, true), 250); });
    si.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); searchNext(si.value.trim(), ev.shiftKey ? -1 : 1, false); } });
    sw.appendChild(si); qCount = h('span', 'dt-qcount'); sw.appendChild(qCount);
    const pv = btn('up', '前の一致'); pv.onclick = () => searchNext(si.value.trim(), -1, false);
    const nx = btn('down', '次の一致'); nx.onclick = () => searchNext(si.value.trim(), 1, false);
    ui.undoBtn = btn('undo', '元に戻す (Ctrl+Z)'); ui.undoBtn.onclick = undo; ui.undoBtn.disabled = true;
    const rf = btn('refresh', '再読み込み'); rf.onclick = () => inspectActive(true);
    ui.detailBtn = btn('panel', '詳細パネルの表示切替'); ui.detailBtn.classList.toggle('active', S.detail);
    ui.detailBtn.onclick = () => { S.detail = !S.detail; saveSettings(); ui.detailBtn.classList.toggle('active', S.detail); applyDetailVis(); };
    [ui.pickBtn, sw, pv, nx, ui.undoBtn, rf, ui.detailBtn].forEach(x => bar.appendChild(x));
    pane.appendChild(bar);

    crumb = h('div', 'dt-crumb'); pane.appendChild(crumb);
    const split = h('div', 'dt-split');
    elTree = h('ul', 'dt-tree'); elTree.tabIndex = 0;
    elTree.addEventListener('mouseleave', () => { hoverNode(null); });
    elTree.addEventListener('keydown', treeKey);
    split.appendChild(elTree);

    elDetail = h('div', 'dt-detail');
    const tb = h('div', 'dt-dtabs');
    ui.dtabs = {};
    [['styles', 'Styles'], ['computed', 'Computed'], ['attrs', 'Attrs'], ['box', 'Box'], ['logs', 'Logs']].forEach(([k, label]) => {
      const b = h('button', 'dt-dtab', label); b.type = 'button';
      b.onclick = () => { S.detailTab = k; saveSettings(); renderDetail(); };
      ui.dtabs[k] = b; tb.appendChild(b);
    });
    ui.logsBadge = h('span', 'dt-tab-badge'); ui.dtabs.logs.appendChild(ui.logsBadge);
    elDetail.appendChild(tb);
    elDetailBody = h('div', 'dt-dbody'); elDetail.appendChild(elDetailBody);
    split.appendChild(elDetail);
    pane.appendChild(split);

    ui.ctx = h('div', 'dt-ctx'); ui.ctx.id = 'dt-ctx'; document.body.appendChild(ui.ctx);
    ui.modal = h('div', 'dt-modal'); pane.appendChild(ui.modal);
    return pane;
  }
  function applyDetailVis() { if (elDetail) elDetail.style.display = S.detail ? '' : 'none'; }

  /* ── 検査対象の取得 / ツリー構築 ── */
  function msgTree(t, err) { elTree.innerHTML = ''; const li = h('li', 'dt-note' + (err ? ' err' : ''), t); elTree.appendChild(li); }
  function inspectActive(force) {
    if (!elTree) return;
    const f = activeFrame();
    if (!f) { teardownDoc(); msgTree('ページが読み込まれていません'); return; }
    const doc = docOf(f.iframe);
    if (!doc || !doc.documentElement) { teardownDoc(); msgTree('アクセスできません（クロスオリジン、または読み込み中）'); return; }
    if (!force && E.doc === doc && E.frame === f && elTree.firstChild && elTree.firstChild.classList.contains('dt-node')) return;
    teardownDoc();
    E.doc = doc; E.win = doc.defaultView; E.frame = f;
    E.rows = new WeakMap(); E.expanded = new WeakSet(); E.sel = null; E.matches = []; E.mi = -1; E.sq = '';
    elTree.innerHTML = '';
    const root = doc.documentElement;
    E.expanded.add(root); if (doc.body) E.expanded.add(doc.body);
    elTree.appendChild(makeRow(root));
    startObserver();
    safe(() => { E.win.addEventListener('scroll', refreshHighlight, true); E.win.addEventListener('resize', refreshHighlight); });
    if (doc.body) select(doc.body, { noScroll: true, noHl: true });
  }
  function teardownDoc() {
    stopObserver(); setPick(false); hideHighlight();
    if (E.win) safe(() => { E.win.removeEventListener('scroll', refreshHighlight, true); E.win.removeEventListener('resize', refreshHighlight); });
    E.doc = E.win = E.frame = null; E.sel = null;
    if (crumb) crumb.innerHTML = '';
    if (elDetailBody) elDetailBody.innerHTML = '';
  }

  function visibleKids(node) {
    const out = [];
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1 || c.nodeType === 8 || (c.nodeType === 3 && c.data.trim())) out.push(c);
    }
    return out;
  }
  function inlineText(node) {
    const k = visibleKids(node);
    return k.length === 1 && k[0].nodeType === 3 ? k[0] : null;
  }

  function labelHtml(node) {
    if (node.nodeType === 3) return '<span class="dt-text">"' + esc(clip(node.data.trim().replace(/\s+/g, ' '), 160)) + '"</span>';
    if (node.nodeType === 8) return '<span class="dt-comment">&lt;!--' + esc(clip(node.data.trim(), 100)) + '--&gt;</span>';
    const tag = node.tagName.toLowerCase();
    let a = '<span class="dt-tag">&lt;' + esc(tag) + '</span>';
    const at = node.attributes, MAXA = 8;
    for (let i = 0; i < Math.min(at.length, MAXA); i++) {
      const v = decodeUrl(at[i].value);
      a += ' <span class="dt-an">' + esc(at[i].name) + '</span><span class="dt-eq">=</span><span class="dt-av">"' + esc(clip(v, 70)) + '"</span>';
    }
    if (at.length > MAXA) a += ' <span class="dt-more">…+' + (at.length - MAXA) + '</span>';
    a += '<span class="dt-tag">&gt;</span>';
    const it = inlineText(node);
    if (it) a += '<span class="dt-text">' + esc(clip(it.data.trim().replace(/\s+/g, ' '), 120)) + '</span><span class="dt-tag">&lt;/' + esc(tag) + '&gt;</span>';
    else if (!visibleKids(node).length) { if (!VOID.has(tag)) a += '<span class="dt-tag">&lt;/' + esc(tag) + '&gt;</span>'; }
    else if (!E.expanded.has(node)) a += '<span class="dt-more">…</span><span class="dt-tag">&lt;/' + esc(tag) + '&gt;</span>';
    return a;
  }
  function refreshLabel(row) {
    const n = row.node;
    row.label.innerHTML = labelHtml(n);
    const has = n.nodeType === 1 && visibleKids(n).length > 0 && !inlineText(n);
    row.caret.className = 'dt-caret' + (has ? (E.expanded.has(n) ? ' open' : ' closed') : '');
    if (row.close) row.close.style.display = has && E.expanded.has(n) ? '' : 'none';
  }

  function makeRow(node) {
    const li = h('li', 'dt-node');
    const line = h('div', 'dt-line');
    const caret = h('span', 'dt-caret'); const label = h('span', 'dt-label');
    const more = h('button', 'dt-rowmore'); more.type = 'button'; more.innerHTML = icon('more'); more.title = 'メニュー';
    line.appendChild(caret); line.appendChild(label); line.appendChild(more); li.appendChild(line);
    const row = { node, li, line, caret, label, kids: null, close: null, built: false };
    if (node.nodeType === 1) {
      row.kids = h('ul', 'dt-kids'); li.appendChild(row.kids);
      row.close = h('div', 'dt-close'); row.close.innerHTML = '<span class="dt-tag">&lt;/' + esc(node.tagName.toLowerCase()) + '&gt;</span>';
      li.appendChild(row.close);
    }
    li.__row = row;
    E.rows.set(node, row);
    refreshLabel(row);
    if (node.nodeType === 1 && E.expanded.has(node) && !inlineText(node)) buildKids(row);

    caret.addEventListener('click', ev => { ev.stopPropagation(); toggle(row, ev.altKey); });
    line.addEventListener('click', () => select(node, { noReveal: true }));
    line.addEventListener('dblclick', ev => { ev.preventDefault(); if (!ev.target.closest('.dt-caret')) startEdit(row); });
    line.addEventListener('mouseenter', () => hoverNode(node));
    line.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); select(node, { noReveal: true }); showCtx(ev.clientX, ev.clientY); });
    more.addEventListener('click', ev => { ev.stopPropagation(); select(node, { noReveal: true }); const r = more.getBoundingClientRect(); showCtx(r.left, r.bottom); });
    return li;
  }
  function buildKids(row) {
    const n = row.node;
    row.kids.innerHTML = '';
    visibleKids(n).forEach(c => row.kids.appendChild(makeRow(c)));
    row.built = true; row.dirty = false;
    row.kids.style.display = E.expanded.has(n) ? '' : 'none';
  }
  function expand(row, on) {
    const n = row.node;
    if (n.nodeType !== 1 || inlineText(n)) return;
    if (on) { E.expanded.add(n); if (!row.built || row.dirty) buildKids(row); } else E.expanded.delete(n);
    row.kids.style.display = on ? '' : 'none';
    refreshLabel(row);
  }
  function toggle(row, deep) {
    const on = !E.expanded.has(row.node);
    expand(row, on);
    if (deep && on) { // Alt+クリック: 子孫もすべて展開(最大 400 ノード)
      let budget = 400;
      const walk = r => visibleKids(r.node).forEach(c => {
        if (c.nodeType !== 1 || budget-- <= 0) return;
        const cr = E.rows.get(c);
        if (cr) { expand(cr, true); walk(cr); }
      });
      walk(row);
    }
  }

  /* ── 選択 / 公開 ── */
  function select(node, opt) {
    opt = opt || {};
    if (!node || !E.doc) return;
    if (E.sel) { const o = E.rows.get(E.sel); if (o) o.line.classList.remove('selected'); }
    E.sel = node;
    let row = E.rows.get(node);
    if (!row && !opt.noReveal) row = revealRow(node);
    if (!row && node.nodeType === 3) row = E.rows.get(node.parentNode); // インライン表示のテキストは親の行で代用
    if (row) { row.line.classList.add('selected'); if (!opt.noScroll) safe(() => row.line.scrollIntoView({ block: 'nearest', inline: 'nearest' })); }
    renderCrumb(); renderDetail();
    if (!opt.noHl) highlight(node, true);
  }
  function revealRow(node) {
    const chain = [];
    for (let n = node; n && n !== E.doc; n = n.parentNode) chain.unshift(n);
    for (let i = 0; i < chain.length - 1; i++) {
      const r = E.rows.get(chain[i]);
      if (!r) break;
      expand(r, true);
    }
    return E.rows.get(node) || null;
  }
  function revealInElements(node) {
    if (!node) return;
    if (!safe(() => node.isConnected, false)) { emit({ level: 'warn', cat: 'app', args: ['この要素は既にDOMから削除されています: ', '<' + nodeLabel(node) + '>'] }); return; }
    DevTools.open('elements');
    // 対象ノードが現在検査中の文書に属さない(タブ切替など)場合は検査し直す
    if (!E.doc || node.ownerDocument !== E.doc) {
      for (const f of frames.values()) { if (docOf(f.iframe) === node.ownerDocument) { try { if (typeof switchTab === 'function') switchTab(f.tabId); } catch (e) {} } }
      inspectActive(true);
    }
    select(node);
  }
  function renderCrumb() {
    crumb.innerHTML = '';
    if (!E.sel) return;
    const chain = [];
    for (let n = E.sel; n && n.nodeType; n = n.parentNode) { if (n.nodeType === 9) break; chain.unshift(n); }
    chain.forEach((n, i) => {
      if (i) crumb.appendChild(h('span', 'dt-crumb-sep', '›'));
      const c = h('span', 'dt-crumb-i' + (n === E.sel ? ' cur' : ''), nodeLabel(n));
      c.onclick = () => select(n);
      crumb.appendChild(c);
    });
    crumb.scrollLeft = crumb.scrollWidth;
  }

  /* ── MutationObserver: リアルタイム更新 + 変更ログ ── */
  function startObserver() {
    stopObserver();
    if (!E.doc || !E.win || !E.win.MutationObserver) return;
    E.mo = new E.win.MutationObserver(onMutations);
    E.mo.observe(E.doc, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true, characterDataOldValue: true });
  }
  function syncObserver() {
    if (!S.open) { stopObserver(); return; }
    if (S.tab === 'elements' || S.cats.dom) { if (!E.doc) inspectActive(); else if (!E.mo) startObserver(); }
    else stopObserver();
  }
  function stopObserver() { if (E.mo) { safe(() => E.mo.disconnect()); E.mo = null; } }
  const flash = el => { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); };

  function onMutations(records) {
    const tabId = E.frame ? E.frame.tabId : null;
    const attrs = new Map(), kids = new Map(), texts = new Map();
    const rebuild = new Set(); let selChanged = false, needCrumb = false;

    records.forEach(r => {
      const t = r.target;
      if (r.type === 'attributes') {
        const k = t, m = attrs.get(k) || new Map();
        if (!m.has(r.attributeName)) m.set(r.attributeName, r.oldValue);
        attrs.set(k, m);
        const row = E.rows.get(t); if (row) { refreshLabel(row); flash(row.line); }
        if (t === E.sel) selChanged = true;
      } else if (r.type === 'childList') {
        const k = kids.get(t) || { add: 0, del: 0 };
        k.add += r.addedNodes.length; k.del += r.removedNodes.length; kids.set(t, k);
        rebuild.add(t);
      } else if (r.type === 'characterData') {
        if (!texts.has(t)) texts.set(t, r.oldValue);
        const row = E.rows.get(t) || E.rows.get(t.parentNode);
        if (row) { refreshLabel(row); flash(row.line); }
        const p = t.parentNode && E.rows.get(t.parentNode); if (p) refreshLabel(p);
        if (t === E.sel || t.parentNode === E.sel) selChanged = true;
      }
    });

    rebuild.forEach(t => {
      const row = E.rows.get(t);
      if (!row) return;
      if (E.expanded.has(t) && row.built && !inlineText(t)) { buildKids(row); }
      else row.dirty = true;
      refreshLabel(row);
      flash(row.line);
    });
    if (E.sel && !E.sel.isConnected) {
      let p = E.sel.parentNode; while (p && !p.isConnected) p = p.parentNode;
      E.sel = null;
      select(p && p.nodeType === 1 ? p : (E.doc.body || E.doc.documentElement), { noScroll: true });
      needCrumb = false; selChanged = false;
    } else if (E.sel) {
      const sr = E.rows.get(E.sel); if (sr) sr.line.classList.add('selected');
      if (rebuild.has(E.sel) || selChanged) { renderDetail(); }
      refreshHighlight();
    }
    if (needCrumb) renderCrumb();

    // ── 変更をログのストリームへ（変更前 → 変更後） ──
    let n = 0; const LIM = 20;
    const push = (lvl, node, parts) => { if (n++ < LIM) emit({ level: lvl, cat: 'dom', tabId, nodes: [node], args: parts }); };
    attrs.forEach((m, node) => m.forEach((oldV, name) => {
      const cur = node.getAttribute(name);
      if (cur === oldV) return;
      push('debug', node, [node, '  ' + name + ': ' + (oldV == null ? '(なし)' : '"' + clip(decodeUrl(oldV), 80) + '"') + ' → ' + (cur == null ? '(削除)' : '"' + clip(decodeUrl(cur), 80) + '"')]);
    }));
    kids.forEach((k, node) => push('debug', node, [node, '  子要素 ' + (k.add ? '+' + k.add : '') + (k.add && k.del ? ' ' : '') + (k.del ? '−' + k.del : '')]));
    texts.forEach((oldV, node) => {
      const cur = node.data; if (cur === oldV) return;
      push('debug', node.parentNode || node, [node.parentElement || node, '  text: "' + clip((oldV || '').trim(), 60) + '" → "' + clip(cur.trim(), 60) + '"']);
    });
    if (n > LIM) emit({ level: 'debug', cat: 'dom', tabId, args: ['… ほか ' + (n - LIM) + ' 件のDOM変更'] });
  }

  /* ── ハイライト(画面上のオーバーレイ) ── */
  let overlay = null;
  function ensureOverlay(f) {
    const host = f.iframe.parentElement;
    if (!host) return null;
    if (overlay && overlay.parentElement !== host) { overlay.remove(); overlay = null; }
    if (!overlay) {
      overlay = h('div', 'dt-hl'); overlay.appendChild(h('div', 'dt-hl-label'));
      host.appendChild(overlay);
    }
    return overlay;
  }
  function hideHighlight() { if (overlay) overlay.style.display = 'none'; }
  function highlight(node, persistent) {
    const f = E.frame || activeFrame();
    if (!f || !node) { hideHighlight(); return; }
    let el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || !el.isConnected) { hideHighlight(); return; }
    const ov = ensureOverlay(f); if (!ov) return;
    try {
      const r = el.getBoundingClientRect();
      const fr = f.iframe.getBoundingClientRect(), hr = f.iframe.parentElement.getBoundingClientRect();
      const sc = fr.width / (f.iframe.offsetWidth || fr.width || 1);
      ov.style.display = 'block';
      ov.style.top = (fr.top - hr.top + r.top * sc) + 'px';
      ov.style.left = (fr.left - hr.left + r.left * sc) + 'px';
      ov.style.width = (r.width * sc) + 'px';
      ov.style.height = (r.height * sc) + 'px';
      ov.firstChild.textContent = nodeLabel(el) + '  ' + Math.round(r.width) + ' × ' + Math.round(r.height);
      ov.classList.toggle('label-below', r.top * sc < 22);
    } catch (e) { ov.style.display = 'none'; }
  }
  let rafHl = 0;
  function refreshHighlight() {
    if (!S.open || S.tab !== 'elements') return;
    cancelAnimationFrame(rafHl);
    rafHl = requestAnimationFrame(() => highlight(E.hover || E.sel, true));
  }
  function hoverNode(node) { E.hover = node; if (node) highlight(node); else if (E.sel) highlight(E.sel); else hideHighlight(); }

  /* ── 要素ピッカー(画面をタップして選択) ── */
  function setPick(on) {
    if (E.pickOff) { E.pickOff(); E.pickOff = null; }
    E.pick = !!on && !!E.doc;
    if (ui.pickBtn) ui.pickBtn.classList.toggle('active', E.pick);
    if (!E.pick) return;
    const doc = E.doc, ok = [];
    const on_ = (t, fn, o) => { doc.addEventListener(t, fn, o || true); ok.push(() => doc.removeEventListener(t, fn, o || true)); };
    const block = ev => { ev.preventDefault(); ev.stopPropagation(); };
    const over = ev => { if (ev.target && ev.target.nodeType === 1) highlight(ev.target); };
    const choose = ev => {
      block(ev);
      const t = ev.target && ev.target.nodeType === 1 ? ev.target : null;
      setPick(false);
      if (t) { DevTools.open('elements'); select(t); }
    };
    on_('mouseover', over); on_('mousedown', block); on_('mouseup', block); on_('pointerdown', block); on_('click', choose);
    on_('touchstart', ev => { const t = ev.touches[0] && doc.elementFromPoint(ev.touches[0].clientX, ev.touches[0].clientY); if (t) highlight(t); }, { capture: true, passive: true });
    on_('touchend', ev => { const c = ev.changedTouches[0]; const t = c && doc.elementFromPoint(c.clientX, c.clientY); block(ev); setPick(false); if (t) { DevTools.open('elements'); select(t); } }, { capture: true, passive: false });
    E.pickOff = () => ok.forEach(f => f());
  }

  /* ── 検索 (セレクタ / XPath / テキスト・属性) ── */
  function findMatches(q) {
    const doc = E.doc, out = [];
    if (!doc || !q) return out;
    if (q.startsWith('/')) {
      try {
        const snap = doc.evaluate(q, doc, null, 7, null);
        for (let i = 0; i < Math.min(snap.snapshotLength, 500); i++) out.push(snap.snapshotItem(i));
        if (out.length) return out;
      } catch (e) {}
    }
    try { const l = doc.querySelectorAll(q); if (l.length) return Array.from(l).slice(0, 500); } catch (e) {}
    const ql = q.toLowerCase();
    const w = doc.createTreeWalker(doc.documentElement, 1 | 4 | 128);
    let n = w.currentNode;
    if (n.nodeType === 1 && n.tagName.toLowerCase() === ql) out.push(n);
    while ((n = w.nextNode()) && out.length < 500) {
      if (n.nodeType === 1) {
        if (n.tagName.toLowerCase().includes(ql)) { out.push(n); continue; }
        for (let i = 0; i < n.attributes.length; i++) {
          const a = n.attributes[i];
          if (a.name.toLowerCase().includes(ql) || decodeUrl(a.value).toLowerCase().includes(ql)) { out.push(n); break; }
        }
      } else if (n.data.toLowerCase().includes(ql)) {
        const p = n.parentNode;
        if (!(p && (p.tagName === 'SCRIPT' || p.tagName === 'STYLE') && false)) out.push(n);
      }
    }
    return out;
  }
  function searchNext(q, dir, fresh) {
    if (!E.doc) return;
    if (!q) { E.matches = []; E.mi = -1; E.sq = ''; qCount.textContent = ''; return; }
    if (q !== E.sq) { E.sq = q; E.matches = findMatches(q); E.mi = -1; }
    const n = E.matches.length;
    if (!n) { qCount.textContent = '0'; return; }
    E.mi = fresh && E.mi < 0 ? 0 : (E.mi + dir + n) % n;
    qCount.textContent = (E.mi + 1) + '/' + n;
    select(E.matches[E.mi]);
  }

  /* ── 編集 (属性 / テキスト / HTML / 削除) と Undo ── */
  function pushUndo(label, fn) {
    E.undo.push({ label, fn }); if (E.undo.length > 60) E.undo.shift();
    if (ui.undoBtn) { ui.undoBtn.disabled = false; ui.undoBtn.title = '元に戻す: ' + label; }
  }
  function undo() {
    const u = E.undo.pop();
    if (!u) return;
    safe(u.fn);
    ui.undoBtn.disabled = !E.undo.length;
    ui.undoBtn.title = E.undo.length ? '元に戻す: ' + E.undo[E.undo.length - 1].label : '元に戻す (Ctrl+Z)';
    emit({ level: 'info', cat: 'app', args: ['元に戻しました: ' + u.label] });
  }
  function setAttr(node, name, val) {
    const old = node.getAttribute(name);
    try { if (val == null) node.removeAttribute(name); else node.setAttribute(name, val); } catch (e) { emit({ level: 'error', cat: 'app', args: ['属性を変更できません: ' + e.message] }); return; }
    pushUndo('属性 ' + name, () => { if (old == null) node.removeAttribute(name); else node.setAttribute(name, old); });
  }
  function startEdit(row) {
    const n = row.node;
    let tn = n.nodeType === 3 ? n : inlineText(n);
    if (!tn) { S.detailTab = 'attrs'; S.detail = true; ui.detailBtn.classList.add('active'); applyDetailVis(); select(n, { noReveal: true }); return; }
    const old = tn.data;
    const span = row.label.querySelector('.dt-text'); if (!span) return;
    span.contentEditable = 'true'; span.textContent = old; span.focus();
    const sel = window.getSelection(); safe(() => { const r = document.createRange(); r.selectNodeContents(span); sel.removeAllRanges(); sel.addRange(r); });
    const done = commit => {
      span.removeEventListener('blur', onBlur); span.removeEventListener('keydown', onKey2);
      span.contentEditable = 'false';
      const v = span.textContent;
      if (commit && v !== old) { tn.data = v; pushUndo('テキスト', () => { tn.data = old; }); }
      refreshLabel(row);
    };
    const onBlur = () => done(true);
    const onKey2 = ev => { if (ev.key === 'Enter') { ev.preventDefault(); done(true); } else if (ev.key === 'Escape') { ev.preventDefault(); done(false); } };
    span.addEventListener('blur', onBlur); span.addEventListener('keydown', onKey2);
  }
  function deleteNode(node) {
    const p = node.parentNode; if (!p || node === E.doc.documentElement) return;
    const next = node.nextSibling;
    p.removeChild(node);
    pushUndo('削除 <' + nodeLabel(node) + '>', () => p.insertBefore(node, next));
  }
  function toggleHide(node) {
    if (node.nodeType !== 1) return;
    const old = node.style.visibility;
    node.style.visibility = old === 'hidden' ? '' : 'hidden';
    pushUndo('表示/非表示', () => { node.style.visibility = old; });
  }
  function editHtml(node) {
    if (node.nodeType !== 1 || node === E.doc.documentElement) { emit({ level: 'warn', cat: 'app', args: ['この要素はHTMLとして編集できません'] }); return; }
    const m = ui.modal; m.innerHTML = ''; m.style.display = 'flex';
    const box = h('div', 'dt-modal-box');
    box.appendChild(h('div', 'dt-modal-title', 'HTMLとして編集  <' + nodeLabel(node) + '>'));
    const ta = h('textarea'); ta.value = clip(node.outerHTML, 200000); ta.spellcheck = false; box.appendChild(ta);
    const acts = h('div', 'dt-modal-acts');
    const cancel = h('button', 'dt-txtbtn', 'キャンセル'); cancel.onclick = () => { m.style.display = 'none'; };
    const ok = h('button', 'dt-txtbtn primary', '適用');
    ok.onclick = () => {
      const p = node.parentNode; if (!p) return;
      const prev = node.previousSibling, next = node.nextSibling;
      try { node.outerHTML = ta.value; } catch (e) { emit({ level: 'error', cat: 'app', args: ['HTMLを適用できません: ' + e.message] }); return; }
      const added = []; for (let c = prev ? prev.nextSibling : p.firstChild; c && c !== next; c = c.nextSibling) added.push(c);
      pushUndo('HTML編集', () => { added.forEach(a => a.parentNode && a.parentNode.removeChild(a)); p.insertBefore(node, next); });
      m.style.display = 'none';
      if (added[0] && added[0].nodeType === 1) select(added[0]);
    };
    acts.appendChild(cancel); acts.appendChild(ok); box.appendChild(acts); m.appendChild(box); ta.focus();
  }
  function treeKey(ev) {
    if (!E.sel || /INPUT|TEXTAREA/.test(ev.target.tagName) || ev.target.isContentEditable) return;
    const row = E.rows.get(E.sel); if (!row) return;
    const lines = $$('.dt-line', elTree).filter(l => l.offsetParent !== null);
    const idx = lines.indexOf(row.line);
    const goto_ = l => { const r = l && l.parentElement && l.parentElement.__row; if (r) select(r.node, { noReveal: true }); };
    switch (ev.key) {
      case 'ArrowDown': goto_(lines[idx + 1]); break;
      case 'ArrowUp': goto_(lines[idx - 1]); break;
      case 'ArrowRight': if (row.caret.classList.contains('closed')) expand(row, true); else goto_(lines[idx + 1]); break;
      case 'ArrowLeft': if (row.caret.classList.contains('open')) expand(row, false); else if (E.sel.parentNode && E.sel.parentNode.nodeType === 1) select(E.sel.parentNode, { noReveal: true }); break;
      case 'Delete': case 'Backspace': deleteNode(E.sel); break;
      case 'h': case 'H': toggleHide(E.sel); break;
      case 'F2': case 'Enter': startEdit(row); break;
      default: return;
    }
    ev.preventDefault();
  }
  /* ── コンテキストメニュー ── */
  function xpathOf(n) {
    const parts = [];
    for (; n && n.nodeType === 1; n = n.parentNode) {
      let i = 1; for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
      parts.unshift(n.tagName.toLowerCase() + '[' + i + ']');
    }
    return '/' + parts.join('/');
  }
  function selectorOf(el) {
    const path = [];
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      if (cur.id && !/\s/.test(cur.id)) { path.unshift(cur.tagName.toLowerCase() + '#' + (E.win && E.win.CSS ? E.win.CSS.escape(cur.id) : cur.id)); break; }
      const par = cur.parentElement;
      const sibs = par ? Array.from(par.children).filter(c => c.tagName === cur.tagName) : [];
      path.unshift(cur.tagName.toLowerCase() + (sibs.length > 1 ? ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')' : ''));
    }
    return path.join(' > ');
  }
  function showCtx(x, y) {
    const n = E.sel; if (!n) return;
    const items = [
      ['セレクタをコピー', () => copyText(selectorOf(n.nodeType === 1 ? n : n.parentElement))],
      ['XPathをコピー', () => copyText(xpathOf(n.nodeType === 1 ? n : n.parentElement))],
      n.nodeType === 1 && ['outerHTMLをコピー', () => copyText(n.outerHTML)],
      ['テキストをコピー', () => copyText((n.textContent || '').trim())],
      null,
      n.nodeType === 1 && ['HTMLとして編集…', () => editHtml(n)],
      n.nodeType === 1 && ['表示 / 非表示 (H)', () => toggleHide(n)],
      ['ノードを削除 (Del)', () => deleteNode(n)],
      null,
      ['画面内にスクロール', () => safe(() => (n.nodeType === 1 ? n : n.parentElement).scrollIntoView({ block: 'center', behavior: 'smooth' }))],
      ['コンソールに出力', () => { emit({ level: 'log', cat: 'app', args: [n], nodes: n.nodeType === 1 ? [n] : [] }); DevTools.open('console'); }],
      ['この要素のログを見る', () => { S.detail = true; S.detailTab = 'logs'; saveSettings(); ui.detailBtn.classList.add('active'); applyDetailVis(); renderDetail(); }],
    ].filter(x => x !== false);
    ui.ctx.innerHTML = '';
    items.forEach(it => {
      if (!it) { ui.ctx.appendChild(h('div', 'dt-ctx-sep')); return; }
      const b = h('button', 'dt-ctx-item', it[0]); b.type = 'button';
      b.onclick = ev => { ev.stopPropagation(); hideCtx(); it[1](); };
      ui.ctx.appendChild(b);
    });
    ui.ctx.style.display = 'block';
    const w = ui.ctx.offsetWidth, hh = ui.ctx.offsetHeight;
    ui.ctx.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + 'px';
    ui.ctx.style.top = Math.max(4, Math.min(y, window.innerHeight - hh - 4)) + 'px';
  }
  function hideCtx() { if (ui.ctx) ui.ctx.style.display = 'none'; }

  /* ── 詳細パネル (Styles / Computed / Attrs / Box / Logs) ── */
  function renderDetail() {
    if (!elDetailBody) return;
    const tab = S.detailTab;
    Object.keys(ui.dtabs).forEach(k => ui.dtabs[k].classList.toggle('active', k === tab));
    applyDetailVis();
    const body = elDetailBody; const keepScroll = body.scrollTop;
    body.innerHTML = '';
    const n = E.sel;
    if (!n) { body.appendChild(h('div', 'dt-empty', '要素を選択してください')); updateLogsBadge(); return; }
    if (n.nodeType !== 1) {
      if (tab === 'logs') { renderLogsTab(body, n); }
      else {
        body.appendChild(h('div', 'dt-sub', n.nodeType === 3 ? 'テキストノード' : 'コメント'));
        const ta = h('textarea', 'dt-textedit'); ta.value = n.data; ta.spellcheck = false;
        ta.addEventListener('change', () => { const old = n.data; n.data = ta.value; pushUndo('テキスト', () => { n.data = old; }); });
        body.appendChild(ta);
      }
      updateLogsBadge(); return;
    }
    const f = { styles: renderStyles, computed: renderComputed, attrs: renderAttrs, box: renderBox, logs: renderLogsTab }[tab] || renderStyles;
    try { f(body, n); } catch (e) { body.appendChild(h('div', 'dt-empty', '取得できません: ' + e.message)); }
    body.scrollTop = keepScroll;
    updateLogsBadge();
  }

  function editableRow(name, value, opt) {
    const row = h('div', 'dt-kv');
    const ni = h('input', 'dt-in k'); ni.value = name; ni.spellcheck = false;
    const vi = h('input', 'dt-in v'); vi.value = value; vi.spellcheck = false;
    row.appendChild(ni); row.appendChild(h('span', 'dt-kvc', opt.sep || ':')); row.appendChild(vi);
    if (opt.onToggle) {
      const cb = h('input'); cb.type = 'checkbox'; cb.checked = true; cb.className = 'dt-cb';
      cb.onchange = () => { row.classList.toggle('disabled', !cb.checked); opt.onToggle(cb.checked, ni.value, vi.value); };
      row.insertBefore(cb, ni);
    }
    const commit = () => { if (opt.onChange) opt.onChange(ni.value.trim(), vi.value, name, value); name = ni.value.trim(); value = vi.value; };
    ni.addEventListener('change', commit); vi.addEventListener('change', commit);
    [ni, vi].forEach(i => i.addEventListener('keydown', ev => { if (ev.key === 'Enter') i.blur(); }));
    if (opt.onDelete) { const d = h('button', 'dt-kvx', '×'); d.type = 'button'; d.title = '削除'; d.onclick = () => { opt.onDelete(name); row.remove(); }; row.appendChild(d); }
    return row;
  }

  function renderAttrs(body, el) {
    body.appendChild(h('div', 'dt-sub', '属性  — 値を編集 / Enter で確定'));
    Array.from(el.attributes).forEach(a => {
      body.appendChild(editableRow(a.name, a.value, {
        sep: '=',
        onChange: (nn, nv, on, ov) => {
          if (!nn) return;
          if (nn !== on) {
            try { el.removeAttribute(on); el.setAttribute(nn, nv); } catch (e) { emit({ level: 'error', cat: 'app', args: ['属性名が不正です: ' + nn] }); return; }
            pushUndo('属性名 ' + on + ' → ' + nn, () => { el.removeAttribute(nn); el.setAttribute(on, ov); });
          } else setAttr(el, nn, nv);
          const r = E.rows.get(el); if (r) refreshLabel(r);
        },
        onDelete: nm => { const old = el.getAttribute(nm); el.removeAttribute(nm); pushUndo('属性削除 ' + nm, () => el.setAttribute(nm, old)); },
      }));
    });
    const add = h('button', 'dt-txtbtn', '＋ 属性を追加'); add.type = 'button';
    add.onclick = () => {
      const row = editableRow('', '', { sep: '=', onChange: (nn, nv) => { if (nn) { setAttr(el, nn, nv); renderDetail(); } } });
      body.insertBefore(row, add); row.querySelector('.k').focus();
    };
    body.appendChild(add);
    const meta = h('div', 'dt-sub', 'プロパティ');
    body.appendChild(meta);
    [['tagName', el.tagName], ['id', el.id], ['classList', Array.from(el.classList).join(' ')], ['children', el.children.length],
     ['scroll', el.scrollWidth + ' × ' + el.scrollHeight], ['offset', el.offsetWidth + ' × ' + el.offsetHeight]].forEach(([k, v]) => {
      const r = h('div', 'dt-kv ro'); r.appendChild(h('span', 'dt-pk', k)); r.appendChild(h('span', 'dt-kvc', ': ')); r.appendChild(h('span', 'dt-v dt-string', String(v))); body.appendChild(r);
    });
  }

  function declsOf(style) {
    const out = [];
    for (let i = 0; i < style.length; i++) { const p = style[i]; out.push([p, style.getPropertyValue(p), style.getPropertyPriority(p)]); }
    return out;
  }
  function ruleBlock(title, source, style, extra) {
    const blk = h('div', 'dt-rule');
    const hd = h('div', 'dt-rule-h'); hd.appendChild(h('span', 'dt-rule-sel', title));
    if (source) hd.appendChild(h('span', 'dt-rule-src', source));
    blk.appendChild(hd);
    declsOf(style).forEach(([p, v, pr]) => {
      blk.appendChild(editableRow(p, v + (pr ? ' !' + pr : ''), {
        onToggle: (on, np, nv) => { if (on) style.setProperty(np, nv.replace(/\s*!important$/, ''), /!important$/.test(nv) ? 'important' : ''); else style.removeProperty(np); },
        onChange: (np, nv, op) => { if (op && op !== np) style.removeProperty(op); if (np) style.setProperty(np, nv.replace(/\s*!important$/, ''), /!important$/.test(nv) ? 'important' : ''); refreshHighlight(); },
      }));
    });
    if (extra) extra(blk);
    return blk;
  }
  function matchedRules(el) {
    const out = [], win = el.ownerDocument.defaultView;
    // CSSRule.type は非推奨なので、プロパティの有無で判定する
    const walk = (rules, sheet) => {
      Array.from(rules).forEach(r => {
        if (typeof r.selectorText === 'string' && r.style) { if (safe(() => el.matches(r.selectorText), false)) out.push({ r, sheet }); }
        else if (r.cssRules) {
          const cond = r.media ? safe(() => win.matchMedia(r.conditionText || r.media.mediaText).matches, true) : true;
          if (cond) walk(r.cssRules, sheet);
        }
      });
    };
    Array.from(el.ownerDocument.styleSheets).forEach(s => { const rules = safe(() => s.cssRules, null); if (rules) walk(rules, s); });
    return out.reverse();
  }
  function renderStyles(body, el) {
    const inline = ruleBlock('element.style', 'インライン', el.style, blk => {
      const add = h('button', 'dt-txtbtn', '＋ プロパティを追加'); add.type = 'button';
      add.onclick = () => {
        const row = editableRow('', '', { onChange: (np, nv) => { if (np) { const old = el.style.getPropertyValue(np); el.style.setProperty(np, nv); pushUndo('style ' + np, () => { if (old) el.style.setProperty(np, old); else el.style.removeProperty(np); }); renderDetail(); refreshHighlight(); } } });
        blk.insertBefore(row, add); row.querySelector('.k').focus();
      };
      blk.appendChild(add);
    });
    body.appendChild(inline);
    const rules = matchedRules(el);
    if (!rules.length) body.appendChild(h('div', 'dt-sub', '一致するCSSルールはありません（外部CSSがクロスオリジンの場合は取得できません）'));
    rules.slice(0, 60).forEach(({ r, sheet }) => {
      const src = sheet.href ? clip(decodeUrl(sheet.href).split('/').slice(-1)[0].split('?')[0] || decodeUrl(sheet.href), 28) : '<style>';
      body.appendChild(ruleBlock(r.selectorText, src, r.style));
    });
    if (rules.length > 60) body.appendChild(h('div', 'dt-sub', '… 他 ' + (rules.length - 60) + ' ルール'));
  }

  let compFilter = '';
  function renderComputed(body, el) {
    const fi = h('input', 'dt-in dt-cfilter'); fi.placeholder = 'プロパティを絞り込み'; fi.value = compFilter; fi.spellcheck = false;
    body.appendChild(fi);
    const list = h('div'); body.appendChild(list);
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    const props = []; for (let i = 0; i < cs.length; i++) props.push(cs[i]);
    props.sort();
    const draw = () => {
      list.innerHTML = '';
      const q = compFilter.toLowerCase(); let n = 0;
      props.forEach(p => {
        if (q && !p.includes(q)) return;
        const v = cs.getPropertyValue(p);
        if (!q && (v === '' || v === 'none' || v === 'normal' || v === 'auto' || v === '0px' || v === 'initial')) return;
        n++; const r = h('div', 'dt-kv ro'); r.appendChild(h('span', 'dt-pk g', p)); r.appendChild(h('span', 'dt-kvc', ': ')); r.appendChild(h('span', 'dt-v dt-number', v)); list.appendChild(r);
      });
      if (!n) list.appendChild(h('div', 'dt-empty', '一致なし'));
    };
    fi.addEventListener('input', () => { compFilter = fi.value.trim().toLowerCase(); draw(); });
    draw();
  }

  function renderBox(body, el) {
    const cs = el.ownerDocument.defaultView.getComputedStyle(el), r = el.getBoundingClientRect();
    const g = p => Math.round((parseFloat(cs.getPropertyValue(p)) || 0) * 10) / 10;
    const wrap = h('div', 'dt-box');
    const mk = (cls, label, p) => {
      const d = h('div', 'dt-bx ' + cls);
      d.appendChild(h('span', 'dt-bx-l', label));
      const row = h('div', 'dt-bx-row');
      row.appendChild(h('span', null, g(p + '-left'))); const mid = h('div', 'dt-bx-mid'); row.appendChild(mid); row.appendChild(h('span', null, g(p + '-right')));
      d.appendChild(h('div', 'dt-bx-v', g(p + '-top'))); d.appendChild(row); d.appendChild(h('div', 'dt-bx-v', g(p + '-bottom')));
      return [d, mid];
    };
    const [m, mm] = mk('m', 'margin', 'margin'); const [b, bm] = (() => { const d = h('div', 'dt-bx b'); d.appendChild(h('span', 'dt-bx-l', 'border')); const row = h('div', 'dt-bx-row'); row.appendChild(h('span', null, g('border-left-width'))); const mid = h('div', 'dt-bx-mid'); row.appendChild(mid); row.appendChild(h('span', null, g('border-right-width'))); d.appendChild(h('div', 'dt-bx-v', g('border-top-width'))); d.appendChild(row); d.appendChild(h('div', 'dt-bx-v', g('border-bottom-width'))); return [d, mid]; })();
    const [p, pm] = mk('p', 'padding', 'padding');
    const c = h('div', 'dt-bx c', Math.round(r.width * 10) / 10 + ' × ' + Math.round(r.height * 10) / 10);
    pm.appendChild(c); bm.appendChild(p); mm.appendChild(b); wrap.appendChild(m);
    body.appendChild(wrap);
    const pos = h('div', 'dt-posgrid');
    [['top', r.top], ['left', r.left], ['bottom', r.bottom], ['right', r.right]].forEach(([k, v]) => pos.appendChild(h('div', null, k + ': ' + Math.round(v * 10) / 10 + 'px')));
    body.appendChild(pos);
  }

  /* ── Logs タブ: この要素に関する全イベント(ログ・変更履歴・通信) ── */
  function logsFor(node) { return store.filter(e => e.nodes && e.nodes.indexOf(node) >= 0); }
  function renderLogsTab(body, node) {
    const list = logsFor(node);
    body.appendChild(h('div', 'dt-sub', '<' + nodeLabel(node) + '> に関するイベント  (' + list.length + ' 件)  — console出力 / DOM変更の履歴(変更前→変更後) / リソースエラー'));
    if (!list.length) { body.appendChild(h('div', 'dt-empty', 'この要素に関するログはまだありません。DOM変更は Elements を開いている間に記録されます。')); return; }
    const box = h('div', 'dt-mini'); list.slice(-200).forEach(e => box.appendChild(buildRow(e))); body.appendChild(box);
  }
  function refreshNodeLogs(e) {
    if (S.tab !== 'elements' || !E.sel) return;
    if (e.nodes && e.nodes.indexOf(E.sel) >= 0) { updateLogsBadge(); if (S.detailTab === 'logs') { clearTimeout(refreshNodeLogs.t); refreshNodeLogs.t = setTimeout(renderDetail, 120); } }
  }
  function updateLogsBadge() {
    if (!ui.logsBadge) return;
    const n = E.sel ? logsFor(E.sel).length : 0;
    ui.logsBadge.textContent = n; ui.logsBadge.style.display = n ? '' : 'none';
  }

  /* ═════════════ 6. 開閉 / タブ / ショートカット ═════════════ */
  function showTab(tab) {
    S.tab = tab; saveSettings();
    ui.tabC.classList.toggle('active', tab === 'console'); ui.tabE.classList.toggle('active', tab === 'elements');
    $('#dt-console').style.display = tab === 'console' ? 'flex' : 'none';
    $('#dt-elements').style.display = tab === 'elements' ? 'flex' : 'none';
    if (tab === 'console') { hideHighlight(); setPick(false); syncObserver(); rebuildRows(); setTimeout(() => { logList.scrollTop = logList.scrollHeight; }, 0); }
    else { inspectActive(); if (E.doc && !E.mo) startObserver(); refreshHighlight(); renderDetail(); }
  }
  function onKey(ev) {
    const k = ev.key, cs = ev.ctrlKey || ev.metaKey;
    if (k === 'F12' || (cs && ev.shiftKey && (k === 'I' || k === 'i'))) { ev.preventDefault(); DevTools.toggle('elements'); }
    else if (cs && ev.shiftKey && (k === 'J' || k === 'j')) { ev.preventDefault(); DevTools.toggle('console'); }
    else if (cs && ev.shiftKey && (k === 'C' || k === 'c')) { ev.preventDefault(); DevTools.open('elements'); setPick(!E.pick); }
    else if (k === 'Escape' && E.pick) { setPick(false); }
  }

  const DevTools = {
    open(tab) {
      if (!panel) return;
      S.open = true; panel.classList.add('open'); document.body.classList.add('dt-open'); applyHeight();
      showTab(tab || S.tab); refreshHighlight();
    },
    close() {
      S.open = false; if (!panel) return;
      panel.classList.remove('open'); document.body.classList.remove('dt-open'); applyHeight();
      hideHighlight(); setPick(false); stopObserver(); hideCtx();
    },
    toggle(tab) { (S.open && (!tab || S.tab === tab)) ? this.close() : this.open(tab); },
    isOpen(tab) { return S.open && (!tab || S.tab === tab); },
    /** タブ切替/ページ遷移後に呼ぶ */
    refresh() { if (S.open && S.tab === 'elements') inspectActive(true); else if (S.open) rebuildRows(); },
    onTabChange() { if (!S.open) return; if (S.tab === 'elements') inspectActive(true); else rebuildRows(); },
    watchFrame, hookWindow, reveal: revealInElements, select: n => { DevTools.open('elements'); select(n); },
    emit, clear: () => clearLogs(false), log: (m, t) => addLog(m, t),
    get entries() { return store.slice(); },
    get selected() { return E.sel; },
  };
  window.DevTools = DevTools;

  /* ═════════════ 7. 互換 API（既存コードからの呼び出し用） ═════════════ */
  window.addLog = function (msg, type) {
    const t = type || '';
    const level = t === 'err' || t === 'error' ? 'error' : t === 'warn' ? 'warn' : t === 'stream' ? 'debug' : 'info';
    const e = emit({ level, cat: 'app', args: [String(msg)] });
    if (t === 'ok') e.ok = true;
  };
  window.setLogStatus = function (state, text) {
    if (statusDot) statusDot.className = 'dt-dot ' + state;
    if (statusText) statusText.textContent = text;
  };
  window.toggleLogPanel = () => DevTools.toggle('console');
  window.toggleElementsPanel = () => DevTools.toggle('elements');
  window._elemInspectActive = () => { if (S.open && S.tab === 'elements') inspectActive(true); };

  /* ═════════════ 8. 起動 ═════════════ */
  function init() {
    build();
    syncChips(); applyHeight(); applyDetailVis(); setPaused(false);
    ui.tabC.classList.toggle('active', S.tab === 'console'); ui.tabE.classList.toggle('active', S.tab === 'elements');
    $('#dt-console').style.display = S.tab === 'console' ? 'flex' : 'none';
    $('#dt-elements').style.display = S.tab === 'elements' ? 'flex' : 'none';
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', refreshHighlight);
    // タブ内の iframe(#frame-<tabId>) を自動検出。go.js が iframe を作り直す経路(新規タブからの遷移など)でも追従する
    const scan = () => {
      document.querySelectorAll('iframe[id^="frame-"]').forEach(ifr => {
        const id = parseInt(ifr.id.slice(6), 10);
        if (!isNaN(id) && (!frames.has(id) || frames.get(id).iframe !== ifr)) watchFrame(id, ifr);
      });
    };
    scan(); setInterval(scan, 300);
    // ホスト側の未処理エラーも記録（アプリ自体のデバッグ用）
    window.addEventListener('error', ev => { if (!ev.target || ev.target === window) emit({ level: 'error', cat: 'error', tabId: null, args: ['[host] ' + (ev.message || 'error') + (ev.filename ? '  (' + ev.filename.split('/').pop() + ':' + ev.lineno + ')' : '')] }); });
    window.addEventListener('unhandledrejection', ev => emit({ level: 'error', cat: 'error', tabId: null, args: ['[host] Uncaught (in promise) ', isErr(ev.reason) ? errText(ev.reason) : ev.reason] }));
    emit({ level: 'info', cat: 'app', args: ['DevTools 起動  (F12: Elements / Ctrl+Shift+J: Console / Ctrl+Shift+C: 要素選択)'] });
  }
  // build() は DOM 構築のみ(重い処理なし)。go.js のログ呼び出しより前に使えるよう、body が出来次第すぐ起動
  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
