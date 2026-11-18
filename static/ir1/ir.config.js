/*global Ultraviolet*/
// IR V1 (UV V3ベース) 設定・互換パッチファイル
// ページ(window) / Dedicated Worker / SharedWorker / Service Worker のすべてで共通して読み込まれる。
(function () {
    const PREFIX = '/ir1-service/';
    const LEGACY_PREFIXES = ['/ir1-service/', '/service3/'];
    const PASS_THROUGH_SCHEMES = /^(#|about:|data:|mailto:|tel:|blob:|ws:|wss:)/i;

    function base64Encode(url) {
        if (!url) return url;
        return Ultraviolet.codec.base64.encode(String(url));
    }

    function base64DecodeRaw(token) {
        if (!token) return '';
        let t = String(token);
        const hashIdx = t.indexOf('#');
        const hash = hashIdx >= 0 ? t.slice(hashIdx) : '';
        if (hashIdx >= 0) t = t.slice(0, hashIdx);
        const qIdx = t.indexOf('?');
        const extraQuery = qIdx >= 0 ? t.slice(qIdx) : '';
        if (qIdx >= 0) t = t.slice(0, qIdx);
        t = t.replace(/^\/+/, '');
        // サブパスが付随した場合（例: <base64>/foo）に備えて先頭セグメントを取り出す
        const slashIdx = t.indexOf('/');
        const extraPath = slashIdx >= 0 ? t.slice(slashIdx) : '';
        if (slashIdx >= 0) t = t.slice(0, slashIdx);
        t = t.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/=]/g, '').replace(/=+$/, '');
        if (!t) return '';
        while (t.length % 4 !== 0) t += '=';
        const decoded = Ultraviolet.codec.base64.decode(t);
        if (!decoded) return '';
        if (extraPath || extraQuery || hash) {
            try {
                const u = new URL(decoded);
                if (extraPath && (u.pathname === '/' || !u.pathname)) {
                    u.pathname = extraPath;
                }
                if (extraQuery && !u.search) {
                    u.search = extraQuery;
                } else if (extraQuery && u.search) {
                    u.search += '&' + extraQuery.slice(1);
                }
                if (hash && !u.hash) u.hash = hash;
                return u.href;
            } catch (e) {
                return decoded + extraPath + extraQuery + hash;
            }
        }
        return decoded;
    }

    function safeDecodeUrl(input) {
        if (input == null) return '';
        let s = String(input).trim();
        if (!s) return '';
        for (const p of LEGACY_PREFIXES) {
            const idx = s.lastIndexOf(p);
            if (idx >= 0) {
                s = s.slice(idx + p.length);
                break;
            }
        }
        // 既に復号済みの URL が渡された場合はそのまま返す（空文字やゴミを返すと base に化けるため厳禁）
        if (/^(https?:|wss?:|about:|data:|blob:|mailto:|javascript:)/i.test(s)) {
            return s;
        }
        try {
            const dec = base64DecodeRaw(s);
            if (dec && /^(https?:|wss?:|about:|data:|blob:|mailto:|javascript:)/i.test(dec)) {
                return dec;
            }
        } catch (e) {}
        return 'about:blank';
    }

    function extractEncodedPart(str, prefix, origin) {
        const s = String(str);
        if (origin && s.startsWith(origin + prefix)) {
            return s.slice(origin.length + prefix.length);
        }
        if (s.startsWith(prefix)) {
            return s.slice(prefix.length);
        }
        for (const p of LEGACY_PREFIXES) {
            const idx = s.indexOf(p);
            if (idx >= 0) {
                // 同一オリジンまたは相対パスのプロキシURLのみ剥がす
                const head = s.slice(0, idx);
                if (!head || head === origin || /^https?:\/\/[^/]+$/i.test(head)) {
                    return s.slice(idx + p.length);
                }
            }
        }
        return null;
    }

    // ── BareClient パッチ（UV v3 内蔵 bare-mux v2.1.6 のバグ修正） ──
    function patchBareClientClass(BareClient) {
        if (!BareClient || BareClient.__ir1Patched) return;
        BareClient.__ir1Patched = true;

        // UV v3 内蔵の createWebSocket(url, protocols=[], ...) は `new WebSocket(url, undefined)` が渡った際
        // デフォルト引数が効くが、`null` や空文字列 `""` が第2引数に渡された際 `protocols = [""]` にしてしまい、
        // サブプロトコル検証 `Z0("")` は true で通過し、そのまま空文字サブプロトコルでサーバーへ送って
        // RFC 6455 違反エラーを起こすバグがある。また ArrayBufferView 以外の Blob 送信にも対応させる。
        const origCreateWS = BareClient.prototype.createWebSocket;
        if (typeof origCreateWS === 'function') {
            BareClient.prototype.createWebSocket = function (url, protocols, webSocketImpl, requestHeaders) {
                let normProtos = [];
                if (protocols != null && protocols !== '') {
                    normProtos = Array.isArray(protocols)
                        ? protocols.filter((p) => p != null && String(p) !== '').map(String)
                        : [String(protocols)];
                }
                const bws = origCreateWS.call(this, url, normProtos, webSocketImpl, requestHeaders);
                if (bws && !bws.__ir1PatchedSend) {
                    bws.__ir1PatchedSend = true;
                    // barews の open イベント時に確定したサブプロトコルを保持できるよう補正
                    bws.addEventListener('open', () => {
                        if (typeof bws.protocols === 'string') {
                            bws.protocol = bws.protocols;
                        } else if (Array.isArray(bws.protocols)) {
                            bws.protocol = bws.protocols[0] || '';
                        }
                    });
                    const origSend = bws.send;
                    bws.send = function (data) {
                        if (typeof Blob !== 'undefined' && data instanceof Blob) {
                            data.arrayBuffer().then((ab) => {
                                try { origSend.call(bws, ab); } catch (_) {}
                            }).catch(() => {});
                            return;
                        }
                        return origSend.call(bws, data);
                    };
                }
                return bws;
            };
        }
    }

    // ── Ultraviolet プロトタイプ互換パッチ（UV v3.2.10 既知バグの網羅修正） ──
    function patchUltravioletClass(UV) {
        if (!UV || UV.__ir1Patched) return;
        UV.__ir1Patched = true;

        if (UV.BareClient) {
            patchBareClientClass(UV.BareClient);
        }

        // 1) rewriteImport の引数順序バグ修正
        //    UV v3 の dynamicImport は `__uv.rewriteImport(JSON.stringify(ctx.meta.url), expr)` を生成するが、
        //    標準の rewriteImport(str, src) は第1引数を import 先、第2引数を base と解釈するため、
        //    常に自分自身のスクリプト URL を import してしまい全動的 import() が壊れる（G123 / Vite / Next.js 等）。
        UV.prototype.rewriteImport = function (first, second, meta = this.meta) {
            let base = first;
            let spec = second;
            if (second === undefined) {
                spec = first;
                base = meta && (meta.url || meta.base);
            }
            return this.rewriteUrl(spec, {
                ...(meta || this.meta || {}),
                base: base || (meta && (meta.url || meta.base)),
            });
        };

        // 2) rewriteUrl の二重エンコード防止 & 安全化
        UV.prototype.rewriteUrl = function (str, meta = this.meta) {
            if (str == null) return str;
            str = String(str).trim();
            if (!str || PASS_THROUGH_SCHEMES.test(str)) return str;

            if (/^javascript:/i.test(str)) {
                return 'javascript:' + this.js.rewrite(str.slice('javascript:'.length));
            }

            const origin = (meta && meta.origin) || (this.meta && this.meta.origin) || (typeof location !== 'undefined' ? location.origin : '');
            const prefix = this.prefix || PREFIX;

            // 既にプロキシ化済みの URL（/ir1-service/... または origin + /ir1-service/...）なら二重エンコードしない
            const already = extractEncodedPart(str, prefix, origin);
            if (already !== null) {
                const dec = safeDecodeUrl(already);
                if (dec && dec !== 'about:blank') {
                    return (origin || '') + prefix + base64Encode(dec);
                }
            }

            const base = (meta && (meta.base || meta.url)) || (this.meta && (this.meta.base || this.meta.url)) || undefined;
            try {
                const resolved = base ? new URL(str, String(base)).href : new URL(str).href;
                if (PASS_THROUGH_SCHEMES.test(resolved)) return resolved;
                return (origin || '') + prefix + this.encodeUrl(resolved);
            } catch (e) {
                return str;
            }
        };

        // 3) sourceUrl の重大バグ修正（bare-mux が new Request(remoteUrl) -> req.url を読んだ際に
        //    プロキシプレフィックスを持たない生の https://... URL を slice して空文字にし、
        //    ページの meta.base へ化けさせて全サブリソースが壊れる問題の根本修正）
        UV.prototype.sourceUrl = function (str, meta = this.meta) {
            if (str == null) return str;
            str = String(str).trim();
            if (!str || PASS_THROUGH_SCHEMES.test(str) || /^javascript:/i.test(str)) return str;

            const origin = (meta && meta.origin) || (this.meta && this.meta.origin) || (typeof location !== 'undefined' ? location.origin : '');
            const prefix = this.prefix || PREFIX;

            const encodedPart = extractEncodedPart(str, prefix, origin);
            if (encodedPart === null) {
                if (origin && str.startsWith(origin + '/')) {
                    return 'about:blank';
                }
                if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(str)) {
                    return str;
                }
                const base = (meta && (meta.base || meta.url)) || (this.meta && (this.meta.base || this.meta.url));
                if (base) {
                    try { return new URL(str, String(base)).href; } catch (e) {}
                }
                return str;
            }

            const decoded = this.decodeUrl(encodedPart);
            if (!decoded || decoded === 'about:blank') return 'about:blank';
            const base = (meta && (meta.base || meta.url)) || (this.meta && (this.meta.base || this.meta.url));
            try {
                return base ? new URL(decoded, String(base)).href : new URL(decoded).href;
            } catch (e) {
                return decoded;
            }
        };

        // 4) Cookie ドメイン検証バグ修正
        const fixedValidateCookie = function (cookie, meta, js = false) {
            if (!cookie || !meta || !meta.url) return false;
            if (cookie.httpOnly && !!js) return false;
            const host = String(meta.url.hostname || '').toLowerCase();
            const rawDom = String(cookie.domain || '').toLowerCase();
            const dom = rawDom.startsWith('.') ? rawDom.slice(1) : rawDom;
            if (!host || !dom) return false;
            if (rawDom.startsWith('.')) {
                if (host !== dom && !host.endsWith('.' + dom)) return false;
            } else {
                if (host !== dom) return false;
            }
            if (cookie.secure && meta.url.protocol === 'http:') return false;
            const cPath = cookie.path || '/';
            const reqPath = meta.url.pathname || '/';
            if (cPath !== '/' && reqPath !== cPath && !reqPath.startsWith(cPath.endsWith('/') ? cPath : cPath + '/')) {
                return false;
            }
            return true;
        };

        // 5) Ultraviolet インスタンス生成時のミドルウェア拡張:
        //    - <script type="application/ld+json"> / importmap / speculationrules / template 等の非JSスクリプトを壊さない
        //    - <meta http-equiv="refresh" content="0;url=..."> の自動リダイレクト先もプロキシ化する
        //    - JS AST で `import.meta.url` を元のリモート URL に書き換える（Vite / Rollup / G123 必須）
        const origImplement = UV.prototype.implementUVMiddleware;
        UV.prototype.implementUVMiddleware = function () {
            const res = origImplement.apply(this, arguments);
            try {
                if (this.cookie) {
                    this.cookie.validateCookie = fixedValidateCookie;
                }

                // HTML <script> の type チェックを差し替え（JSON-LD 等を JS として再構築しない）
                const htmlTextListeners = this.html.listeners('text');
                this.html.removeAllListeners('text');
                const jsTypes = new Set([
                    '',
                    'text/javascript',
                    'application/javascript',
                    'application/ecmascript',
                    'text/ecmascript',
                    'module',
                    'text/jscript',
                    'application/x-javascript',
                ]);
                this.html.on('text', (textEvt, type) => {
                    const tag = textEvt.element && textEvt.element.tagName;
                    if (tag === 'script') {
                        const rawType = String(textEvt.element.getAttribute('type') || '').trim().toLowerCase().split(';')[0].trim();
                        if (!jsTypes.has(rawType)) {
                            if (type === 'rewrite' && rawType === 'importmap') {
                                try {
                                    const map = JSON.parse(textEvt.value);
                                    if (map && typeof map === 'object') {
                                        if (map.imports && typeof map.imports === 'object') {
                                            for (const k of Object.keys(map.imports)) {
                                                if (typeof map.imports[k] === 'string') {
                                                    map.imports[k] = this.rewriteUrl(map.imports[k]);
                                                }
                                            }
                                        }
                                        textEvt.value = JSON.stringify(map);
                                    }
                                } catch (e) {}
                            }
                            return;
                        }
                    }
                    for (const fn of htmlTextListeners) {
                        fn.call(this.html, textEvt, type);
                    }
                });

                this.html.on('element', (el, type) => {
                    if (type !== 'rewrite') return;
                    if (el.tagName === 'meta') {
                        const eq = String(el.getAttribute('http-equiv') || '').toLowerCase();
                        if (eq === 'refresh') {
                            const content = el.getAttribute('content');
                            if (content && /url\s*=/i.test(content)) {
                                el.setAttribute('content', content.replace(/url\s*=\s*(['"]?)([^'";\s]+)\1/i, (_m, q, u) => {
                                    return 'url=' + q + this.rewriteUrl(u) + q;
                                }));
                            }
                        }
                    }
                });

                // JS: import.meta.url → 元のスクリプト URL に書き換え（Vite / G123 アセット解決必須）
                this.js.on('MemberExpression', (node, data, type) => {
                    if (type !== 'rewrite') return;
                    if (
                        node.object &&
                        node.object.type === 'MetaProperty' &&
                        node.object.meta &&
                        node.object.meta.name === 'import' &&
                        node.object.property &&
                        node.object.property.name === 'meta' &&
                        !node.computed &&
                        node.property &&
                        node.property.name === 'url'
                    ) {
                        const metaUrl = String((this.meta && (this.meta.url || this.meta.base)) || '');
                        if (metaUrl) {
                            data.changes.push({
                                start: node.start,
                                end: node.end,
                                node: JSON.stringify(metaUrl),
                            });
                        }
                    }
                });
            } catch (e) {}
            return res;
        };
    }

    // ── クライアント側（window および Web Worker 共通）追加パッチ ──
    function patchRuntimeEnvironment(globalScope) {
        if (!globalScope || globalScope.__ir1EnvPatched) return;
        // Service Worker 自身（UVServiceWorker スコープ）には適用しない
        if (typeof ServiceWorkerGlobalScope !== 'undefined' && globalScope instanceof ServiceWorkerGlobalScope) return;
        globalScope.__ir1EnvPatched = true;

        const isWindow = typeof globalScope.window !== 'undefined' && !!globalScope.document;

        const applyPostUvPatches = () => {
            const __uv = globalScope.__uv;
            if (!__uv || globalScope.__ir1PostUvApplied) return false;
            globalScope.__ir1PostUvApplied = true;

            // 1) navigator.onLine を常に true に補正（サンドボックス / プロキシ環境で G123 や各種ゲームが
            //    navigator.onLine === false と誤判定してオフライン画面や通信停止になるのを防止）
            try {
                const navProto = globalScope.Navigator && globalScope.Navigator.prototype;
                if (navProto) {
                    Object.defineProperty(navProto, 'onLine', {
                        get: () => true,
                        configurable: true,
                        enumerable: true,
                    });
                } else if (globalScope.navigator) {
                    Object.defineProperty(globalScope.navigator, 'onLine', {
                        get: () => true,
                        configurable: true,
                        enumerable: true,
                    });
                }
            } catch (e) {}

            // 2) window 専用パッチ（navigator.serviceWorker スタブ、window.open、document.cookie 同期）
            if (isWindow) {
                try {
                    const realSW = globalScope.navigator && globalScope.navigator.serviceWorker;
                    // SW からの updateCookies メッセージを受け取って document.cookie を即時同期する
                    // （偽装前に実物の serviceWorker コンテナへリスナーを登録しておく）
                    if (realSW && EventTarget.prototype.addEventListener) {
                        EventTarget.prototype.addEventListener.call(realSW, 'message', (ev) => {
                            const d = ev && ev.data;
                            if (d && d.msg === 'updateCookies' && __uv.cookie) {
                                __uv.cookie.db().then((db) => __uv.cookie.getCookies(db)).then((cookies) => {
                                    __uv.__latestCookieStr = __uv.cookie.serialize(cookies, __uv.meta, true);
                                }).catch(() => {});
                            }
                        });
                    }

                    // G123 や各種 SPA が自サイト用の SW を登録しようとして SecurityError で落ちるのを防ぐ安全なスタブ
                    if (globalScope.navigator) {
                        const fakeReady = new Promise(() => {});
                        const fakeSWContainer = Object.create(EventTarget.prototype, {
                            controller: { get: () => null, enumerable: true },
                            ready: { get: () => fakeReady, enumerable: true },
                            register: {
                                value: () => Promise.resolve({
                                    scope: __uv.location ? __uv.location.origin + '/' : '/',
                                    active: null,
                                    installing: null,
                                    waiting: null,
                                    update: () => Promise.resolve(),
                                    unregister: () => Promise.resolve(true),
                                    addEventListener: () => {},
                                    removeEventListener: () => {},
                                }),
                                enumerable: true,
                            },
                            getRegistration: { value: () => Promise.resolve(undefined), enumerable: true },
                            getRegistrations: { value: () => Promise.resolve([]), enumerable: true },
                            startMessages: { value: () => {}, enumerable: true },
                            oncontrollerchange: { get: () => null, set: () => {}, enumerable: true },
                            onmessage: { get: () => null, set: () => {}, enumerable: true },
                            onmessageerror: { get: () => null, set: () => {}, enumerable: true },
                        });
                        Object.defineProperty(globalScope.navigator, 'serviceWorker', {
                            get: () => fakeSWContainer,
                            configurable: true,
                        });
                    }
                } catch (e) {}

                // document.cookie の getter を補強し、SW の Set-Cookie 反映分（__latestCookieStr）も即座に読めるようにする
                try {
                    const docProto = globalScope.Document && globalScope.Document.prototype;
                    const htmlDocProto = globalScope.HTMLDocument && globalScope.HTMLDocument.prototype;
                    for (const proto of [docProto, htmlDocProto]) {
                        if (!proto) continue;
                        const desc = Object.getOwnPropertyDescriptor(proto, 'cookie');
                        if (desc && typeof desc.get === 'function' && typeof desc.set === 'function' && !desc.get.__ir1CookieWrapped) {
                            const origGet = desc.get;
                            const origSet = desc.set;
                            const wrappedGet = function () {
                                const base = origGet.call(this) || '';
                                const latest = __uv.__latestCookieStr;
                                if (!latest) return base;
                                if (!base) return latest;
                                // 両者をマージ（latest 優先 + JS で直前に set された base も保持）
                                const map = new Map();
                                for (const part of base.split(';')) {
                                    const s = part.trim();
                                    if (!s) continue;
                                    const eq = s.indexOf('=');
                                    if (eq > 0) map.set(s.slice(0, eq), s.slice(eq + 1));
                                }
                                for (const part of latest.split(';')) {
                                    const s = part.trim();
                                    if (!s) continue;
                                    const eq = s.indexOf('=');
                                    if (eq > 0) map.set(s.slice(0, eq), s.slice(eq + 1));
                                }
                                return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
                            };
                            wrappedGet.__ir1CookieWrapped = true;
                            const wrappedSet = function (v) {
                                const r = origSet.call(this, v);
                                // JS 側で document.cookie に書き込まれたら __latestCookieStr も再計算予約
                                if (__uv.cookie) {
                                    __uv.cookie.db().then((db) => __uv.cookie.getCookies(db)).then((cookies) => {
                                        __uv.__latestCookieStr = __uv.cookie.serialize(cookies, __uv.meta, true);
                                    }).catch(() => {});
                                }
                                return r;
                            };
                            Object.defineProperty(proto, 'cookie', {
                                get: wrappedGet,
                                set: wrappedSet,
                                configurable: true,
                                enumerable: true,
                            });
                        }
                    }
                } catch (e) {}

                // window.open: 相対URLや生URLで呼ばれた場合も確実にプロキシURLに変換する
                try {
                    const origOpen = globalScope.open;
                    if (typeof origOpen === 'function') {
                        globalScope.open = function (url, target, features) {
                            if (url != null && String(url) !== '' && String(url) !== 'about:blank') {
                                url = __uv.rewriteUrl(String(url));
                            }
                            return origOpen.call(this, url, target, features);
                        };
                    }
                } catch (e) {}
            }

            // 3) WebSocket（window と Web Worker 双方で有効）:
            //    - 相対パスや http(s):// が渡された場合の ws(s):// 正規化
            //    - UV v3 が第2引数未指定時に protocols=[undefined] -> ["undefined"] を送ってしまうバグの根絶
            try {
                const OrigWS = globalScope.WebSocket;
                if (typeof OrigWS === 'function' && !OrigWS.__ir1WsWrapped) {
                    const WrappedWS = function (url, protocols) {
                        let u = String(url);
                        try {
                            const baseHref = (__uv.location && __uv.location.href) || (__uv.meta && __uv.meta.url && __uv.meta.url.href) || '';
                            const resolved = baseHref ? new URL(u, String(baseHref)) : new URL(u);
                            if (resolved.protocol === 'http:') resolved.protocol = 'ws:';
                            else if (resolved.protocol === 'https:') resolved.protocol = 'wss:';
                            u = resolved.href;
                        } catch (e) {}

                        if (arguments.length < 2 || protocols === undefined || protocols === null || protocols === '') {
                            return new OrigWS(u, []);
                        }
                        return new OrigWS(u, protocols);
                    };
                    WrappedWS.prototype = OrigWS.prototype;
                    WrappedWS.__ir1WsWrapped = true;
                    Object.defineProperties(WrappedWS, {
                        CONNECTING: { value: 0, enumerable: true },
                        OPEN: { value: 1, enumerable: true },
                        CLOSING: { value: 2, enumerable: true },
                        CLOSED: { value: 3, enumerable: true },
                    });
                    globalScope.WebSocket = WrappedWS;
                }
            } catch (e) {}

            // 4) new Worker(url, { type: 'module' }) へのフォールバック（UV の worker 注入は importScripts を
            //    使うため module worker のままだと SyntaxError / TypeError で起動できないゲームがある）
            if (isWindow && typeof globalScope.Worker === 'function' && !globalScope.Worker.__ir1WorkerWrapped) {
                try {
                    const OrigWorker = globalScope.Worker;
                    const WrappedWorker = function (scriptURL, options) {
                        if (options && typeof options === 'object' && options.type === 'module') {
                            const cloned = { ...options };
                            delete cloned.type;
                            return new OrigWorker(scriptURL, cloned);
                        }
                        return arguments.length > 1 ? new OrigWorker(scriptURL, options) : new OrigWorker(scriptURL);
                    };
                    WrappedWorker.prototype = OrigWorker.prototype;
                    WrappedWorker.__ir1WorkerWrapped = true;
                    globalScope.Worker = WrappedWorker;
                } catch (e) {}
            }

            return true;
        };

        if (!applyPostUvPatches()) {
            if (typeof queueMicrotask === 'function') queueMicrotask(applyPostUvPatches);
            setTimeout(applyPostUvPatches, 0);
        }
    }

    if (typeof self !== 'undefined' && self.Ultraviolet) {
        patchUltravioletClass(self.Ultraviolet);
    }

    self.__uv$config = {
        prefix: PREFIX,
        bare: '/bare/',
        encodeUrl: base64Encode,
        decodeUrl: safeDecodeUrl,
        handler: '/ir1/ir.handler.js',
        client: '/ir1/ir.client.js',
        bundle: '/ir1/ir.bundle.js',
        config: '/ir1/ir.config.js',
        sw: '/ir1/ir.sw.js',
        construct(uv, _context) {
            try {
                if (uv && uv.constructor) patchUltravioletClass(uv.constructor);
            } catch (e) {}
        },
    };

    if (typeof self !== 'undefined') {
        patchRuntimeEnvironment(self);
    }
})();
