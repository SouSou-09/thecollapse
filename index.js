import { createBareServer } from "@nebula-services/bare-server-node";
import wisp from "wisp-server-node";
import express from "express";
import { createServer, Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { uvPath } from "@titaniumnetwork-dev/ultraviolet";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { attachChatServer, CHAT_WS_PATH } from "./static/worksheets/chatserver.js";
import { attachAuthRoutes, getSessionUser } from "./auth.js";
import { attachSnsRoutes } from "./sns.js";
import { mintYoutubePoToken } from "./yt-pot.js";

const publicPath = fileURLToPath(new URL("./static/", import.meta.url));
// v1（現行エンジン）のdist退避先と、XR V1用カスタムconfigの場所
const uv1Path = fileURLToPath(new URL("./static/uv1/", import.meta.url));
const xr1CustomPath = fileURLToPath(new URL("./static/xr1/", import.meta.url));
const baremuxPath = fileURLToPath(new URL("./node_modules/@mercuryworkshop/bare-mux/dist/", import.meta.url));
const dataPath = fileURLToPath(new URL("./static/worksheets/data/", import.meta.url));
const readmePath = fileURLToPath(new URL("./readme.md", import.meta.url));
// bare v2 は上流へ送るヘッダーから `connection` を除外する（forbiddenSendHeaders）ため、
// WebSocket のアップグレード要求が Node 既定の `Connection: keep-alive` で送られ、
// 上流が101を返さず「Remote did not upgrade the WebSocket」になる。
// → `Upgrade` ヘッダー付きの要求だけ `Connection: Upgrade` を付与するエージェントを使う。
// （XR V1 経由で Call of War 等のWebSocketゲームを動かすために必要）
// さらに、YouTube / Google 等は Set-Cookie や Link ヘッダーで Node 既定の 16KB を超える応答ヘッダーを返し、
// 「Parse Error: Header overflow」(bare server error 500) になる。→ 上流応答のヘッダー上限を引き上げる。
//   ClientRequest#maxHeaderSize はソケット割り当て前（addRequest 時点）に設定すれば有効。
const MAX_UPSTREAM_HEADER_SIZE = 1024 * 1024; // 1MB
function prepareUpstreamRequest(req) {
  try { if (req.getHeader("upgrade")) req.setHeader("connection", "Upgrade"); } catch {}
  try { req.maxHeaderSize = MAX_UPSTREAM_HEADER_SIZE; } catch {}
}
class UpgradeHttpAgent extends HttpAgent {
  addRequest(req, opts) {
    prepareUpstreamRequest(req);
    return super.addRequest(req, opts);
  }
}
class UpgradeHttpsAgent extends HttpsAgent {
  addRequest(req, opts) {
    prepareUpstreamRequest(req);
    return super.addRequest(req, opts);
  }
}
const bare = createBareServer("/bare/", {
  httpAgent: new UpgradeHttpAgent({ keepAlive: true }),
  httpsAgent: new UpgradeHttpsAgent({ keepAlive: true }),
});
const app = express();
dotenv.config();

/* ── セキュリティヘッダー ────────────────────────────────── */
// Helmet を入れずとも最低限のヘッダーを付与し、MIME スニッフィング/クリックジャッキング/
// リファラ漏洩などの一般的な攻撃面を縮小する。
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer-when-downgrade");
  res.setHeader("X-XSS-Protection", "0"); // 古い XSS Auditor は無効化が推奨
  res.setHeader("Permissions-Policy", "geolocation=(self), microphone=(self), camera=(self), fullscreen=*");
  // プロキシ機能の都合上、HSTS / CSP は強制しない（UV/Bare の動作を壊さないため）
  next();
});

// JSON ペイロードを 1MB に制限し、リクエスト爆撃による DoS を抑止
app.use(express.json({ limit: "1mb" }));
// 認証 API（登録 / ログイン / ログアウト / me / update / delete）
attachAuthRoutes(app);
// SNS API（投稿 / いいね / 返信 / 削除）と Web Push（購読 / 通知送信）
attachSnsRoutes(app);

/* ── ユーザーデータファイルへの読み取り保護 ──────────────────
   static 配信より前に置き、/worksheets/data/ 配下の個人データファイルが
   無認証で誰でも GET できる問題（パスワードハッシュ等の漏洩）を塞ぐ。
   - account.json（旧・脆弱な平文ハッシュ一覧）は一切配信しない
   - <username>.json はログイン中の本人のみ GET 可能           */
app.get("/worksheets/data/:filename", async (req, res, next) => {
  const filename = req.params.filename;
  // NUL バイト・トラバーサル・先頭ドットを拒否し、許可文字と拡張子を厳格化
  if (
    typeof filename !== "string" ||
    filename.length > 128 ||
    filename.includes("\0") ||
    filename.startsWith(".") ||
    filename.includes("..") ||
    !/^[a-zA-Z0-9._-]+\.json$/.test(filename)
  ) {
    return res.status(400).json({ error: "Invalid filename" });
  }
  // 旧アカウント一覧は機微情報を含むため完全非公開
  if (filename === "account.json") {
    return res.status(404).json({ error: "Not Found" });
  }
  const username = getSessionUser(req);
  if (!username) {
    return res.status(401).json({ error: "ログインが必要です" });
  }
  // 自分のデータファイルのみ許可
  if (filename !== `${username}.json`) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const filePath = resolve(join(dataPath, filename));
    const baseResolved = resolve(dataPath);
    if (
      filePath !== baseResolved &&
      !filePath.startsWith(baseResolved + (process.platform === "win32" ? "\\" : "/"))
    ) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (!existsSync(filePath)) return res.status(404).json({ error: "Not Found" });
    const raw = await readFile(filePath, "utf8");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(raw);
  } catch (e) {
    console.error("data read error:", e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// data ディレクトリ全体の静的配信を無効化（一覧/直リンクでの漏洩防止）。
// 個別ファイルの GET は上の認可付きハンドラ経由でのみ。
// PUT（書き込み）は後段の認可付きハンドラに委ねるため、ここでは素通しする。
app.use("/worksheets/data", (req, res, next) => {
  if (req.method === "PUT") return next();
  res.status(404).json({ error: "Not Found" });
});

/* ── News API（readme.md の更新履歴を配信）─────────────────
   readme.md の内容をそのまま返す軽量エンドポイント。
   フロント側（news.html）で Markdown をパースして表示する。
   小さなキャッシュを持たせ、ファイル更新時刻が変わったら読み直す。 */
let _readmeCache = { mtimeMs: 0, content: "" };
app.get("/api/news", async (req, res) => {
  try {
    const { statSync } = await import("node:fs");
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(readmePath).mtimeMs;
    } catch {
      return res.status(404).json({ error: "readme.md not found" });
    }
    if (_readmeCache.mtimeMs !== mtimeMs || !_readmeCache.content) {
      const raw = await readFile(readmePath, "utf8");
      _readmeCache = { mtimeMs, content: raw };
    }
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=60");
    res.send(_readmeCache.content);
  } catch (e) {
    console.error("news read error:", e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/* ── Version API（readme.md の更新履歴の先頭バージョンを配信）──
   「## 更新履歴」セクション内で最初に現れる `### vX.Y.Z` 見出しを
   現在のバージョンとして返す。readme.md を更新するだけでフロントの
   バージョンバッジが追従する。 */
let _versionCache = { mtimeMs: 0, version: null };
function _parseLatestVersion(markdown) {
  if (typeof markdown !== "string") return null;
  // 「# 更新履歴」(h1) または「## 更新履歴」(h2) 以降に絞り込む（無ければ全文を対象）
  const histIdx = markdown.search(/^#{1,2}\s+更新履歴\s*$/m);
  const scope = histIdx >= 0 ? markdown.slice(histIdx) : markdown;
  // 最初の `## v1.2` / `## v1.3.5` または `### v1.2` などの見出しを拾う
  const m = scope.match(/^#{2,3}\s+(v[0-9][0-9A-Za-z.\-]*)\s*$/m);
  return m ? m[1] : null;
}
app.get("/api/version", async (req, res) => {
  try {
    const { statSync } = await import("node:fs");
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(readmePath).mtimeMs;
    } catch {
      return res.status(404).json({ error: "readme.md not found" });
    }
    if (_versionCache.mtimeMs !== mtimeMs || !_versionCache.version) {
      const raw = await readFile(readmePath, "utf8");
      _versionCache = { mtimeMs, version: _parseLatestVersion(raw) };
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({ version: _versionCache.version || null });
  } catch (e) {
    console.error("version read error:", e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// WebKit(iPad/iPhone)は SW 本体のバイト列が同じだと、importScripts() 先だけが
// 変わっても SW を入れ替えない（修正を配信しても端末に届かない）。
// 取り込み先を含めたハッシュを本体末尾に付け、どれかが変われば本体も変わるようにする。
// imports: ファイルパス、または内容を返す関数。
async function sendServiceWorker(res, mainFile, imports) {
  res.setHeader("Cache-Control", "no-cache");
  try {
    const main = await readFile(mainFile, "utf8");
    const hash = createHash("sha1").update(main);
    for (const src of imports) {
      hash.update(typeof src === "function" ? await src() : await readFile(src));
    }
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.send(`${main}\nself.__tcSwBuild = "${hash.digest("hex").slice(0, 16)}";\n`);
  } catch (e) {
    console.error("service worker stamp error:", e);
    res.sendFile(mainFile);
  }
}

// ⚠ express.static より前に置くこと。後ろだと static が先に /xr1/sw.js を返し、
// Service-Worker-Allowed が付かず /xr1-service/ スコープで登録できない。
app.get("/xr1/sw.js", (req, res) => {
  res.setHeader("Service-Worker-Allowed", "/xr1-service/");
  // 広告ブロック対応のカスタムSW（標準の dist/sw.js に広告ブロックを追加したもの）
  sendServiceWorker(res, xr1CustomPath + "sw.js", [
    getPatchedBundle,
    xr1CustomPath + "xr.config.js",
    join(uvPath, "uv.sw.js"),
    join(publicPath, "worksheets/adblock-rules.js"),
    join(publicPath, "worksheets/adblock-sw.js"),
    xr1CustomPath + "yt-diag.js",
    xr1CustomPath + "yt-pot.js",
  ]);
});
// YouTube の再生トークンをサーバー側で発行する（理由は yt-pot.js 参照）。XR V1 の SW が呼ぶ。
app.get("/xr1/yt-pot", rateLimit, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const videoId = String(req.query.v || "");
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return res.status(400).json({ error: "bad video id" });
  try {
    res.json({ token: await mintYoutubePoToken(videoId) });
  } catch (e) {
    console.error("yt-pot error:", e?.message || e);
    res.status(503).json({ error: "token unavailable" });
  }
});
app.get("/sw.js", (req, res) => {
  sendServiceWorker(res, join(publicPath, "sw.js"), [
    join(uv1Path, "uv.bundle.js"),
    join(publicPath, "worksheets/uv/uv.config.js"),
    join(uv1Path, "uv.sw.js"),
    join(publicPath, "worksheets/adblock-rules.js"),
    join(publicPath, "worksheets/adblock-sw.js"),
  ]);
});
app.use(express.static(publicPath));
app.use("/worksheets/uv/", express.static(uv1Path));
app.use("/uv/", express.static(uv1Path));

// XR V1（UV V3ベースエンジン）を /xr1-service/ で配信。
// 既存の /service/（v1.0.11・static/uv1 に退避済み）はそのまま維持。
// 【UV rewriter 不具合パッチ】
// UV の Identifier ハンドラは MethodDefinition のキーは除外するが、クラスフィールド宣言
// (PropertyDefinition) のキーを除外しないため、`class A { location; }` が
// `class A { __uv.$get(location); }` に書き換えられ SyntaxError になる
// (Call of War のログイン後ゲーム本体 model.*.js が読み込めず真っ白になる原因)。
// node_modules は直接編集できないため、配信時にバンドルへパッチを当てる。
let patchedBundleCache = null;
async function getPatchedBundle() {
  if (patchedBundleCache) return patchedBundleCache;
  const src = await readFile(join(uvPath, "uv.bundle.js"), "utf8");
  const needle = 'a.type==="MethodDefinition"||a.type==="ClassDeclaration"';
  const repl = 'a.type==="MethodDefinition"||a.type==="PropertyDefinition"&&a.key===r&&!a.computed||a.type==="ClassDeclaration"';
  if (!src.includes(needle)) {
    console.warn("[xr1] UV bundle patch target not found (UV updated?). Serving unpatched bundle.");
    patchedBundleCache = src;
  } else {
    patchedBundleCache = src.split(needle).join(repl);
  }
  return patchedBundleCache;
}
app.get(["/xr1/xr.bundle.js", "/xr1/uv.bundle.js"], async (req, res) => {
  try {
    const body = await getPatchedBundle();
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.send(body);
  } catch (e) {
    console.error("bundle patch error:", e);
    res.sendFile(join(uvPath, "uv.bundle.js"));
  }
});
for (const kind of ["client", "handler", "sw"]) {
  app.get(`/xr1/xr.${kind}.js`, (req, res) => {
    res.sendFile(join(uvPath, `uv.${kind}.js`));
  });
  app.get(`/xr1/uv.${kind}.js.map`, (req, res) => {
    res.sendFile(join(uvPath, `uv.${kind}.js.map`));
  });
}
app.use("/xr1/", express.static(xr1CustomPath));
app.use("/xr1/", express.static(uvPath));
app.use("/baremux/", express.static(baremuxPath));

// bare v2 / v3 のHTTPリクエストで x-bare-headers（分割された x-bare-headers-0, -1 ... 含む）に
// host が無い場合はサーバー側で補完し、また accept-encoding を gzip, deflate に正規化する。
// bare-serverは上流へ setHost:false で送信するため、hostが無いとHostヘッダー無しの
// リクエストになり、Cloudflare配下のサイトが 400 Bad Request を返す。
// またブラウザが br / zstd を要求すると一部サイトで圧縮解凍不整合になるため、
// Node / ブラウザ双方で確実に扱える gzip, deflate に統一する。
function prepareBareRequest(req) {
  req.headers["accept-encoding"] = "gzip, deflate";
  try {
    let rawXh = req.headers["x-bare-headers"];
    const splitKeys = [];
    if (typeof rawXh !== "string") {
      const parts = [];
      for (const k of Object.keys(req.headers)) {
        const m = /^x-bare-headers-(\d+)$/i.exec(k);
        if (m) {
          splitKeys.push(k);
          const v = String(req.headers[k] || "");
          parts[+m[1]] = v.startsWith(";") ? v.slice(1) : v;
        }
      }
      if (parts.length) rawXh = parts.join("");
    }
    if (typeof rawXh !== "string" || !rawXh) return;
    const json = JSON.parse(rawXh);
    if (!json || typeof json !== "object" || Array.isArray(json)) return;

    for (const k of Object.keys(json)) {
      if (k.toLowerCase() === "accept-encoding") delete json[k];
    }
    json["accept-encoding"] = "gzip, deflate";

    if (!Object.keys(json).some((k) => k.toLowerCase() === "host")) {
      const xUrl = req.headers["x-bare-url"];
      const host = req.headers["x-bare-host"];
      if (typeof xUrl === "string" && xUrl) {
        try { json.host = new URL(xUrl).host; } catch {}
      } else if (typeof host === "string" && host) {
        const proto = String(req.headers["x-bare-protocol"] || "");
        const port = String(req.headers["x-bare-port"] || "");
        const def = (proto === "https:" || proto === "wss:") ? "443" : "80";
        json.host = port && port !== def ? `${host}:${port}` : host;
      }
    }

    const updated = JSON.stringify(json);
    for (const k of splitKeys) delete req.headers[k];
    delete req.headers["x-bare-headers"];
    if (updated.length <= 3072) {
      req.headers["x-bare-headers"] = updated;
    } else {
      for (let i = 0, n = 0; i < updated.length; i += 3072) {
        req.headers[`x-bare-headers-${n++}`] = ";" + updated.slice(i, i + 3072);
      }
    }
  } catch {
    // 不正なJSONは bare-server 側のバリデーションに任せる
  }
}

/* ── 簡易レートリミッタ (PUT /worksheets/data/:filename) ── */
// 外部依存を増やさず、IP ごとのスライディングウィンドウで毎分の書き込み回数を制限する。
const _rlBucket = new Map(); // ip -> { count, resetAt }
const RL_WINDOW_MS = 60_000;
const RL_MAX = 60; // 1 分あたり 60 回まで
function rateLimit(req, res, next) {
  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown";
  const now = Date.now();
  const cur = _rlBucket.get(ip);
  if (!cur || cur.resetAt < now) {
    _rlBucket.set(ip, { count: 1, resetAt: now + RL_WINDOW_MS });
    return next();
  }
  cur.count += 1;
  if (cur.count > RL_MAX) {
    res.setHeader("Retry-After", Math.ceil((cur.resetAt - now) / 1000));
    return res.status(429).json({ error: "Too Many Requests" });
  }
  next();
}
// バケットの肥大化防止
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rlBucket) if (v.resetAt < now) _rlBucket.delete(k);
}, 5 * 60_000).unref?.();

// ユーザーデータファイルの書き込みエンドポイント
app.put("/worksheets/data/:filename", rateLimit, async (req, res) => {
  try {
    const filename = req.params.filename;
    // ディレクトリトラバーサル対策
    // `%` を許可していると `%2e%2e` 等が二段デコードで悪用されうるため許可文字を厳格化。
    // 半角英数字 / アンダースコア / ハイフン / ドット のみ、拡張子は .json 固定。
    // NUL バイト・先頭ドット (隠しファイル)・`..`・過長名も明示的に拒否。
    if (
      typeof filename !== "string" ||
      filename.length > 128 ||
      filename.includes("\0") ||
      filename.startsWith(".") ||
      filename.includes("..") ||
      !/^[a-zA-Z0-9._-]+\.json$/.test(filename)
    ) {
      return res.status(400).json({ error: "Invalid filename" });
    }

    // ── 認可: ログイン中の本人のデータファイルのみ書き込み可 ──
    // 旧実装では誰でも任意ユーザーのファイルを上書きでき、なりすまし・改ざんが可能だった。
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: "ログインが必要です" });
    }
    if (filename !== `${sessionUser}.json`) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const filePath = resolve(join(dataPath, filename));
    // dataPath の外へのアクセスを禁止（path.resolve 後に再確認）
    const baseResolved = resolve(dataPath);
    if (
      filePath !== baseResolved &&
      !filePath.startsWith(baseResolved + (process.platform === "win32" ? "\\" : "/"))
    ) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // 受信ボディが JSON オブジェクト/配列でない場合は拒否
    if (req.body === null || (typeof req.body !== "object")) {
      return res.status(400).json({ error: "Body must be a JSON object or array" });
    }

    // 認証関連の機微フィールドはデータファイルに保存させない
    // （認証情報は auth-data/auth.json でサーバーが一元管理する）
    const body = req.body;
    if (body && !Array.isArray(body)) {
      for (const k of ["passwordHash", "salt", "hash", "password", "admin"]) {
        if (k in body) delete body[k];
      }
    }

    // シリアライズ後サイズで再チェック（1MB）
    const serialized = JSON.stringify(body, null, 2);
    if (serialized.length > 1024 * 1024) {
      return res.status(413).json({ error: "Payload too large" });
    }

    await mkdir(dataPath, { recursive: true });
    await writeFile(filePath, serialized, "utf8");
    res.json({ ok: true });
  } catch (e) {
    // エラーメッセージをそのままクライアントへ返さない（情報漏洩防止）
    console.error("data write error:", e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/* ── 最終エラーハンドラ（必ず全ルートの後に登録する）──────────
   不正な JSON / 巨大ペイロード / 予期せぬ例外で Express 既定の
   スタックトレース付き HTML エラーページが返るのを防ぐ（情報漏洩防止）。
   4 引数シグネチャにすることで Express がエラーミドルウェアと認識する。 */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && (err.type === "entity.parse.failed" || err.type === "entity.too.large")) {
    return res.status(err.status || 400).json({ error: "Invalid request body" });
  }
  console.error("unhandled error:", err && err.stack ? err.stack : err);
  res.status(500).json({ error: "Internal Server Error" });
});

// ブラウザ → 本サーバー方向も、Cookie が多いサイトで x-bare-headers が巨大になるため上限を拡大
const server = createServer({ maxHeaderSize: MAX_UPSTREAM_HEADER_SIZE });

server.on("request", (req, res) => {
  if (bare.shouldRoute(req)) {
    prepareBareRequest(req);
    // 【重要】bare は全リクエストが同一URL(/bare/v2/)で、宛先は x-bare-* ヘッダーだけで区別される。
    // 応答に Cache-Control / Vary が無いとブラウザのHTTPキャッシュがURLだけで照合し、
    // 別サイトの応答（最初に取得したHTMLなど）を全リクエストに使い回してしまう
    // （YouTube のJSが全部同じHTMLになる / Call of War が読み込めない 原因）。
    // → 必ずキャッシュ禁止にする。
    const _origWriteHead = res.writeHead;
    res.writeHead = function (...args) {
      try {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Vary", "*");
      } catch {}
      return _origWriteHead.apply(this, args);
    };
    bare.routeRequest(req, res);
  } else {
    app(req, res);
  }
});

server.on("upgrade", (req, socket, head) => {
  // チャットWebSocketは chatserver.js が自身で upgrade を処理するため除外
  let pathname = "";
  try {
    pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
  } catch {
    // URL 解析に失敗した upgrade はどのハンドラも処理できないため即座に破棄
    try { socket.destroy(); } catch {}
    return;
  }
    if (pathname === CHAT_WS_PATH) return; // chatserver.js が処理

  if (bare.shouldRoute(req)) {
    prepareBareRequest(req);
    bare.routeUpgrade(req, socket, head);
  } else {
    wisp.routeRequest(req, socket, head);
  }
});

// チャット WebSocket サーバーを同じ HTTP サーバーに組み込む
attachChatServer(server);

const port = process.env.PORT || 3300;
server.on("listening", () => {
  console.log(`UP http://localhost:${port}`);
});

server.listen({
  port,
  host: "0.0.0.0",
});
