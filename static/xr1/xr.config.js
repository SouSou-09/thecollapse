/*global Ultraviolet*/
// XR V1 (UV V3ベース) 設定・互換パッチファイル
// ページ(window) / Dedicated Worker / SharedWorker / Service Worker のすべてで共通して読み込まれる。
(function () {
    const PREFIX = '/xr1-service/';
    const LEGACY_PREFIXES = ['/xr1-service/', '/service3/'];
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
        if (!BareClient || BareClient.__xr1Patched) return;
        BareClient.__xr1Patched = true;

        // UV v3 内蔵の createWebSocket(url, protocols=[], ...) は `new WebSocket(url, undefined)` が渡った際
        // デフォルト引数が効くが、`null` や空文字列 `""` が第2引数に渡された際 `protocols = [""]` にしてしまい、
        // サブプロトコル検証 `Z0("")` は true で通過し、そのまま空文字サブプロトコルでサーバーへ送って
        // RFC 6455 違反エラーを起こすバグがある。また ArrayBufferView 以外の Blob 送信にも対応させる。
        // 【POST が全て 500 になる問題の修正】
        // UV 内蔵の BareClient#fetch は `new Request(url, init).body`（ReadableStream）を
        // postMessage の transfer list に入れて bare-mux へ渡す。iPad / iPhone など
        // ReadableStream を transfer できない WebKit 環境では DataCloneError で例外になり、
        // Service Worker が 500 を返す（GET / HEAD はボディが無いので成功する）。
        // → ボディを ArrayBuffer に実体化してから送る。リダイレクト追従で再送しても
        //   detach されないよう、毎回コピーを渡す。
        const origFetch = BareClient.prototype.fetch;
        const REDIRECT_STATUS = [301, 302, 303, 307, 308];
        const NULL_BODY_STATUS = [101, 204, 205, 304];
        if (typeof origFetch === 'function') {
            BareClient.prototype.fetch = async function (url, init) {
                let req;
                try { req = new Request(url, init); } catch (e) { return origFetch.call(this, url, init); }
                let target;
                try { target = new URL(req.url); } catch (e) { return origFetch.call(this, url, init); }
                const method = String(req.method || 'GET').toUpperCase();
                const worker = this && this.worker;
                // blob: URL は元実装に任せる。ボディが無い場合も元実装で問題ない。
                if (target.protocol.startsWith('blob:') || !worker || typeof worker.sendMessage !== 'function' ||
                    method === 'GET' || method === 'HEAD') {
                    return origFetch.call(this, url, init);
                }
                const rawHeaders = (init && init.headers) || req.headers;
                const headers = rawHeaders instanceof Headers ? Object.fromEntries(rawHeaders) : rawHeaders;
                let buf = null;
                try {
                    if (req.body) buf = await req.arrayBuffer();
                } catch (e) { buf = null; }

                let current = target;
                for (let i = 0; ; i++) {
                    const payload = buf && buf.byteLength ? buf.slice(0) : undefined;
                    const msg = { type: 'fetch', fetch: { remote: current.toString(), method, headers, body: payload } };
                    const res = (await worker.sendMessage(msg, payload ? [payload] : [])).fetch;
                    const response = new Response(NULL_BODY_STATUS.includes(res.status) ? undefined : res.body, {
                        headers: new Headers(res.headers),
                        status: res.status,
                        statusText: res.statusText,
                    });
                    response.rawHeaders = res.headers;
                    response.finalURL = current.toString();
                    const redirect = (init && init.redirect) || req.redirect;
                    if (!REDIRECT_STATUS.includes(response.status)) return response;
                    if (redirect === 'follow') {
                        const loc = response.headers.get('location');
                        if (i < 20 && loc !== null) { current = new URL(loc, current); continue; }
                        throw new TypeError('Failed to fetch');
                    }
                    if (redirect === 'error') throw new TypeError('Failed to fetch');
                    return response;
                }
            };
        }

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
                if (bws && !bws.__xr1PatchedSend) {
                    bws.__xr1PatchedSend = true;
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
        if (!UV || UV.__xr1Patched) return;
        UV.__xr1Patched = true;

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
            // 別 realm（iframe 等）で作られた Request は UV の `instanceof Request` 判定をすり抜けてここへ来る。
            // 文字列化すると "[object Request]" という URL になってしまうため、Request のまま返す
            // （fetch / new Request はどちらも別 realm の Request をそのまま受け取れる）。
            if (typeof str === 'object' && Object.prototype.toString.call(str) === '[object Request]') return str;
            str = String(str).trim();
            if (!str || PASS_THROUGH_SCHEMES.test(str)) return str;

            if (/^javascript:/i.test(str)) {
                return 'javascript:' + this.js.rewrite(str.slice('javascript:'.length));
            }

            const origin = (meta && meta.origin) || (this.meta && this.meta.origin) || (typeof location !== 'undefined' ? location.origin : '');
            const prefix = this.prefix || PREFIX;

            // 既にプロキシ化済みの URL（/xr1-service/... または origin + /xr1-service/...）なら二重エンコードしない
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

        // 5) Ultraviolet インスタンス生成時のミドルウェア拡張:
        //    - <script type="application/ld+json"> / importmap / speculationrules / template 等の非JSスクリプトを壊さない
        //    - <meta http-equiv="refresh" content="0;url=..."> の自動リダイレクト先もプロキシ化する
        //    - JS AST で `import.meta.url` を元のリモート URL に書き換える（Vite / Rollup / G123 必須）
        const origImplement = UV.prototype.implementUVMiddleware;
        UV.prototype.implementUVMiddleware = function () {
            const res = origImplement.apply(this, arguments);
            try {
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

    // ── Cookie ジャーの不具合修正 ──
    // UV 標準の Cookie 処理には次の不具合があり、インスタンスごとに差し替える
    // （`this.cookie` はコンストラクタの最後で代入されるので、prototype 側からは差し替えられない）。
    // - 送信可否の判定が `hostname.endsWith("x.com")` で、ドット境界を見ない（x.com の Cookie が
    //   netflix.com 等にも送られる）うえ、Path を見ない。
    // - `Max-Age=0`（Expires 無し）の削除指示が無視され、値が空の Cookie が残り続ける。
    function cookieMatches(cookie, meta, js = false) {
        if (!cookie || !meta || !meta.url) return false;
        if (cookie.httpOnly && !!js) return false;
        const host = String(meta.url.hostname || '').toLowerCase();
        const dom = String(cookie.domain || '').toLowerCase().replace(/^\./, '');
        if (!host || !dom) return false;
        if (host !== dom && !host.endsWith('.' + dom)) return false;
        if (cookie.secure && meta.url.protocol === 'http:') return false;
        const cPath = cookie.path || '/';
        const reqPath = meta.url.pathname || '/';
        if (cPath !== '/' && reqPath !== cPath && !reqPath.startsWith(cPath.endsWith('/') ? cPath : cPath + '/')) {
            return false;
        }
        return true;
    }

    function cookieExpired(cookie, now) {
        if (typeof cookie.maxAge === 'number' && !isNaN(cookie.maxAge)) {
            if (cookie.maxAge <= 0) return true;
            const setAt = cookie.set ? new Date(cookie.set).getTime() : NaN;
            return !isNaN(setAt) && setAt + cookie.maxAge * 1000 <= now;
        }
        if (cookie.expires) {
            const at = new Date(cookie.expires).getTime();
            return !isNaN(at) && at <= now;
        }
        return false;
    }

    function patchCookieJar(uv) {
        const jar = uv && uv.cookie;
        if (!jar || jar.__xr1Patched) return;
        jar.__xr1Patched = true;
        jar.validateCookie = cookieMatches;
        jar.serialize = (cookies = [], meta, js) => {
            let out = '';
            for (const cookie of cookies) {
                if (!cookieMatches(cookie, meta, js)) continue;
                out += (out ? '; ' : '') + cookie.name + '=' + cookie.value;
            }
            return out;
        };
        jar.getCookies = async (db) => {
            const now = Date.now();
            return (await db.getAll('cookies')).filter((cookie) => {
                if (!cookieExpired(cookie, now)) return true;
                db.delete('cookies', cookie.id);
                return false;
            });
        };
        // Set-Cookie ヘッダーを、DB へ書く時と同じ規則で Cookie 一覧へ反映した新しい一覧を返す
        jar.withSetCookies = (cookies, setCookieHeader, meta) => {
            const byId = new Map((cookies || []).map((c) => [c.id, c]));
            const now = Date.now();
            for (const c of jar.setCookie(setCookieHeader, { decodeValues: false })) {
                if (!c.domain) c.domain = '.' + meta.url.hostname;
                if (!c.path) c.path = '/';
                if (!c.domain.startsWith('.')) c.domain = '.' + c.domain;
                c.id = `${c.domain}@${c.path}@${c.name}`;
                c.set = new Date(now);
                if (cookieExpired(c, now)) byId.delete(c.id);
                else byId.set(c.id, c);
            }
            return Array.from(byId.values());
        };
    }

    // ── クライアント側（window および Web Worker 共通）追加パッチ ──
    function patchRuntimeEnvironment(globalScope) {
        if (!globalScope || globalScope.__xr1EnvPatched) return;
        // Service Worker 自身（UVServiceWorker スコープ）には適用しない
        if (typeof ServiceWorkerGlobalScope !== 'undefined' && globalScope instanceof ServiceWorkerGlobalScope) return;
        globalScope.__xr1EnvPatched = true;

        const isWindow = typeof globalScope.window !== 'undefined' && !!globalScope.document;

        // UV の handler は起動時に Navigator.prototype.serviceWorker を削除する。この config は handler より
        // 先に読み込まれるので、Service Worker からの通知を受けるために実物をここで確保しておく。
        let realSWContainer = null;
        try {
            if (isWindow && globalScope.navigator) realSWContainer = globalScope.navigator.serviceWorker || null;
        } catch (e) {}

        // 0) Proxy の ownKeys トラップが返すキー配列の重複を除去する。
        //    G123 の qiankun サンドボックスは `Es(keys)` で `this[k] = true` を使って重複排除するが、
        //    UV が動的プロパティアクセスを `this[__uv.$wrap(k)]` に書き換える際 'location' が
        //    '__uv$location' に化けて重複排除が効かず、'ownKeys' on proxy: trap returned duplicate entries
        //    (TypeError) でゲームのロードが止まる。→ ownKeys の結果を必ず一意にして返す。
        //    ※ __uv の準備を待たず、ゲームのスクリプトが走る前に即時適用する。
        try {
            const NativeProxy = globalScope.Proxy;
            if (typeof NativeProxy === 'function' && !NativeProxy.__xr1ProxyWrapped) {
                const dedupeKeys = (keys) => {
                    if (!keys || typeof keys.length !== 'number') return keys;
                    const seen = new Set();
                    const out = [];
                    for (let i = 0; i < keys.length; i++) {
                        const k = keys[i];
                        if (seen.has(k)) continue;
                        seen.add(k);
                        out.push(k);
                    }
                    return out.length === keys.length ? keys : out;
                };
                const wrappedHandlers = new WeakSet();
                const SafeProxy = new NativeProxy(NativeProxy, {
                    construct(target, args) {
                        let handler = args[1];
                        if (handler && typeof handler === 'object' && typeof handler.ownKeys === 'function' && !wrappedHandlers.has(handler)) {
                            const origOwnKeys = handler.ownKeys;
                            try {
                                // ハンドラが凍結されていても動くよう、プロトタイプ継承のコピーを渡す
                                const copy = Object.create(handler);
                                copy.ownKeys = function () {
                                    return dedupeKeys(origOwnKeys.apply(this === copy ? handler : this, arguments));
                                };
                                wrappedHandlers.add(copy);
                                handler = copy;
                            } catch (e) {}
                        }
                        return new NativeProxy(args[0], handler);
                    },
                    get(target, prop, receiver) {
                        if (prop === '__xr1ProxyWrapped') return true;
                        return Reflect.get(target, prop, receiver);
                    },
                });
                globalScope.Proxy = SafeProxy;
            }
        } catch (e) {}

        const applyPostUvPatches = () => {
            const __uv = globalScope.__uv;
            if (!__uv || globalScope.__xr1PostUvApplied) return false;
            globalScope.__xr1PostUvApplied = true;

            // 0') UV が Object.prototype に定義する location / parent / top / eval のゲッターは、
            //     this が window の Proxy（G123 の qiankun サンドボックス等）のとき `this.location` を
            //     そのまま呼んで「Illegal invocation」になる（Window の本物のゲッターをレシーバー違いで呼ぶため）。
            //     → 例外時は UV の値（proxy 化された location 等）にフォールバックするよう差し替える。
            try {
                const m = __uv.methods || {};
                const realWin = globalScope;
                const objProto = realWin.Object && realWin.Object.prototype;
                const fallbacks = {
                    location: () => __uv.location,
                    eval: () => __uv.eval,
                    parent: () => realWin.parent,
                    top: () => realWin.top,
                };
                if (objProto) {
                    for (const key of Object.keys(fallbacks)) {
                        const name = m[key];
                        if (!name) continue;
                        const desc = Object.getOwnPropertyDescriptor(objProto, name);
                        if (!desc || typeof desc.get !== 'function' || desc.get.__xr1Safe) continue;
                        const origGet = desc.get;
                        const safeGet = function () {
                            try {
                                return origGet.call(this);
                            } catch (err) {
                                return fallbacks[key]();
                            }
                        };
                        safeGet.__xr1Safe = true;
                        Object.defineProperty(objProto, name, {
                            configurable: true,
                            enumerable: desc.enumerable,
                            get: safeGet,
                            set: desc.set,
                        });
                    }
                }
            } catch (e) {}

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
                    // G123 や各種 SPA が自サイト用の SW を登録しようとして SecurityError で落ちるのを防ぐ安全なスタブ
                    if (globalScope.navigator) {
                        // ready は実物と同じく「登録されたら解決」する。未解決のままだと、
                        // register().then(() => navigator.serviceWorker.ready) を待ってから起動するサイト
                        // （雀魂のゲーム本体など）が永久に止まる。
                        let resolveReady;
                        const fakeReady = new Promise((resolve) => { resolveReady = resolve; });
                        const makeFakeWorker = (scriptURL) => {
                            const worker = new EventTarget();
                            Object.defineProperties(worker, {
                                scriptURL: { value: scriptURL, enumerable: true },
                                state: { value: 'activated', enumerable: true },
                                postMessage: { value: () => {}, enumerable: true },
                                onstatechange: { get: () => null, set: () => {}, enumerable: true },
                                onerror: { get: () => null, set: () => {}, enumerable: true },
                            });
                            return worker;
                        };
                        // ⚠ Object.create(EventTarget.prototype) は本物の EventTarget ではないため、
                        //    addEventListener を呼ぶと「Illegal invocation」になる（G123 の Workbox が
                        //    navigator.serviceWorker.addEventListener('message', ...) で即死していた）。
                        //    → 本物の EventTarget インスタンスにプロパティを定義する。
                        const fakeSWContainer = new EventTarget();
                        Object.defineProperties(fakeSWContainer, {
                            controller: { get: () => null, enumerable: true },
                            ready: { get: () => fakeReady, enumerable: true },
                            register: {
                                value: (scriptURL) => {
                                    let resolved = '';
                                    try { resolved = new URL(String(scriptURL), __uv.location.href).href; } catch (_) {}
                                    const registration = {
                                        scope: __uv.location ? __uv.location.origin + '/' : '/',
                                        active: makeFakeWorker(resolved),
                                        installing: null,
                                        waiting: null,
                                        update: () => Promise.resolve(),
                                        unregister: () => Promise.resolve(true),
                                        addEventListener: () => {},
                                        removeEventListener: () => {},
                                    };
                                    resolveReady(registration);
                                    return Promise.resolve(registration);
                                },
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

                // document.cookie を Cookie DB と同期する。
                // UV は document.cookie の値をページ読み込み時の文字列で持ち続け、その後に fetch / XHR などの
                // 応答の Set-Cookie で変わった分を反映しない。そのため「応答で更新された Cookie を読んで
                // ヘッダーに載せる」サイト（X の ct0 → x-csrf-token など）で、ヘッダーと実際に送られる Cookie が
                // 食い違う。Service Worker からの updateCookies 通知と JS からの書き込みのたびに DB から読み直す。
                try {
                    const docProto = globalScope.Document && globalScope.Document.prototype;
                    const desc = docProto && Object.getOwnPropertyDescriptor(docProto, 'cookie');
                    if (desc && typeof desc.get === 'function' && typeof desc.set === 'function' && !desc.get.__xr1CookieWrapped && __uv.cookie) {
                        patchCookieJar(__uv);
                        const origGet = desc.get;
                        const origSet = desc.set;
                        const doc = globalScope.document;
                        let cookieView = origGet.call(doc) || '';
                        let refreshSeq = 0;
                        const refreshCookieView = () => {
                            const seq = ++refreshSeq;
                            __uv.cookie.db().then((db) => __uv.cookie.getCookies(db)).then((cookies) => {
                                // 途中で新しい読み直しが始まっていたら、古い結果で上書きしない
                                if (seq === refreshSeq) cookieView = __uv.cookie.serialize(cookies, __uv.meta, true);
                            }).catch(() => {});
                        };
                        // DB の読み直し（非同期）を待たずに読めるよう、書き込まれた Cookie を手元の値にも即時反映する
                        const applyToCookieView = (setCookie, host) => {
                            for (const cookie of __uv.cookie.setCookie(setCookie, { decodeValues: false })) {
                                if (!cookie || !cookie.name) continue;
                                if (!cookie.path) cookie.path = '/';
                                if (!cookie.domain) cookie.domain = host;
                                if (!cookieMatches(cookie, __uv.meta, true)) continue;
                                const parts = cookieView ? cookieView.split('; ').filter((c) => !c.startsWith(cookie.name + '=')) : [];
                                if (!cookieExpired(cookie, Date.now())) parts.push(cookie.name + '=' + cookie.value);
                                cookieView = parts.join('; ');
                            }
                        };
                        const wrappedGet = function () {
                            return this === doc ? cookieView : origGet.call(this);
                        };
                        wrappedGet.__xr1CookieWrapped = true;
                        const wrappedSet = function (v) {
                            const r = origSet.call(this, v);
                            if (this === doc) {
                                try { applyToCookieView(String(v), __uv.meta.url.hostname); } catch (e) {}
                                refreshCookieView();
                            }
                            return r;
                        };
                        Object.defineProperty(docProto, 'cookie', {
                            get: wrappedGet,
                            set: wrappedSet,
                            configurable: true,
                            enumerable: true,
                        });
                        if (realSWContainer) {
                            EventTarget.prototype.addEventListener.call(realSWContainer, 'message', (ev) => {
                                const d = ev && ev.data;
                                if (!d || d.msg !== 'updateCookies') return;
                                try {
                                    if (d.setCookie) applyToCookieView(d.setCookie, new URL(d.url).hostname);
                                } catch (e) {}
                                refreshCookieView();
                            });
                            // 通知はページの読み込み完了まで保留されるので、すぐ受け取れるようにする
                            try { realSWContainer.startMessages(); } catch (e) {}
                        }
                        // 注入された初期値の後に変わった分（並行して届いた応答の Set-Cookie）を取り込む
                        refreshCookieView();
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
                if (typeof OrigWS === 'function' && !OrigWS.__xr1WsWrapped) {
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
                    WrappedWS.__xr1WsWrapped = true;
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
            if (isWindow && typeof globalScope.Worker === 'function' && !globalScope.Worker.__xr1WorkerWrapped) {
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
                    WrappedWorker.__xr1WorkerWrapped = true;
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
        handler: '/xr1/xr.handler.js',
        client: '/xr1/xr.client.js',
        bundle: '/xr1/xr.bundle.js',
        config: '/xr1/xr.config.js',
        sw: '/xr1/xr.sw.js',
        construct(uv, _context) {
            try {
                if (uv && uv.constructor) patchUltravioletClass(uv.constructor);
            } catch (e) {}
            try { patchCookieJar(uv); } catch (e) {}
        },
    };

    if (typeof self !== 'undefined') {
        patchRuntimeEnvironment(self);
    }
})();
