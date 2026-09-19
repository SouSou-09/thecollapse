// =====================================================
//  TheCollapse — SNS モジュール（v2.2.0 本格実装）
//  - 投稿: アップデート=デベロッパー限定 / 改善案=誰でも /
//    おすすめサイト=Browserの共有ボタンからのみ
//  - いいね / 返信 / 削除（本人 or デベロッパー）
//  - Web Push: 新着投稿を通知
//      ・一般ユーザー: アップデート + おすすめサイト
//      ・デベロッパー: 全カテゴリ
//      ・設定ページから受信カテゴリを変更可
//      ・「ホーム画面に追加」した端末(PWA standalone)でのみ受信
//  データは static/worksheets/data/sns/ に保存（コミット禁止）。
//  認証は auth.js のセッション Cookie を使用。
// =====================================================

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { getSessionUser } from "./auth.js";

// ---- デベロッパー（アップデート投稿・全通知の対象）----
// ⚠️ account.js の TC_DEV_USERS と必ず同じ値を保つこと
const DEV_USERS = new Set(["sousou09"]);

const SNS_DIR = resolve(join(process.cwd(), "static", "worksheets", "data", "sns"));
const POSTS_FILE = join(SNS_DIR, "posts.json");
const PUSH_FILE = join(SNS_DIR, "push.json");
const VAPID_FILE = join(SNS_DIR, "vapid.json");

const CATEGORIES = new Set(["update", "site", "improve"]);
const MAX_POSTS = 500; // 古い投稿から自動削除（無限肥大化防止）

function isDevName(name) {
  return DEV_USERS.has(name);
}

// 役割ごとの既定の通知設定（ユーザーが保存するまでの初期値）
// 一般 = アップデート + おすすめサイト / デベロッパー = 全て
function defaultPrefs(name) {
  return isDevName(name)
    ? { update: true, site: true, improve: true }
    : { update: true, site: true, improve: false };
}

// ---- テキスト整形（制御文字除去・長さ制限） ----
function _cleanText(s, max) {
  if (typeof s !== "string") return "";
  // タブ・改行は残し、その他の制御文字と削除文字を落とす
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max);
}

// ---- 簡易ストア（メモリ + ファイル永続化・書き込み直列化） ----
let _posts = null;
let _postsQueue = Promise.resolve();
let _pushStore = null;
let _pushQueue = Promise.resolve();

async function _loadPosts() {
  if (_posts) return _posts;
  await mkdir(SNS_DIR, { recursive: true });
  if (existsSync(POSTS_FILE)) {
    try {
      const parsed = JSON.parse(await readFile(POSTS_FILE, "utf8"));
      _posts = parsed && Array.isArray(parsed.posts) ? parsed : { posts: [] };
    } catch {
      _posts = { posts: [] };
    }
  } else {
    _posts = { posts: [] };
  }
  return _posts;
}

function _persistPosts() {
  _postsQueue = _postsQueue.then(async () => {
    await mkdir(SNS_DIR, { recursive: true });
    await writeFile(POSTS_FILE, JSON.stringify(_posts, null, 2), "utf8");
  }).catch((e) => console.error("sns posts persist error:", e));
  return _postsQueue;
}

async function _loadPushStore() {
  if (_pushStore) return _pushStore;
  await mkdir(SNS_DIR, { recursive: true });
  if (existsSync(PUSH_FILE)) {
    try {
      const parsed = JSON.parse(await readFile(PUSH_FILE, "utf8"));
      _pushStore = parsed && parsed.users && typeof parsed.users === "object" ? parsed : { users: {} };
    } catch {
      _pushStore = { users: {} };
    }
  } else {
    _pushStore = { users: {} };
  }
  if (!_pushStore.users) _pushStore.users = {};
  return _pushStore;
}

function _persistPushStore() {
  _pushQueue = _pushQueue.then(async () => {
    await mkdir(SNS_DIR, { recursive: true });
    await writeFile(PUSH_FILE, JSON.stringify(_pushStore, null, 2), "utf8");
  }).catch((e) => console.error("sns push persist error:", e));
  return _pushQueue;
}

// ---- レートリミッタ（ユーザー単位・メモリ） ----
const _limits = new Map(); // key -> { count, resetAt }
function _allow(key, max, windowMs) {
  const now = Date.now();
  const cur = _limits.get(key);
  if (!cur || cur.resetAt < now) {
    _limits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  cur.count += 1;
  return cur.count <= max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _limits) if (v.resetAt < now) _limits.delete(k);
}, 5 * 60_000).unref?.();

// ---- Web Push（web-push が無ければ通知なしで動作） ----
let _webpush = undefined; // undefined=未確認 / null=利用不可
async function _getWebPush() {
  if (_webpush !== undefined) return _webpush;
  try {
    _webpush = (await import("web-push")).default || (await import("web-push"));
  } catch {
    _webpush = null;
    console.warn("[sns] web-push が未インストールのためプッシュ通知は送信されません（npm install で有効化）");
  }
  return _webpush;
}

// VAPID 鍵は初回送信時に自動生成して sns/vapid.json に保存（コミットされない）
async function _getVapid() {
  try {
    await mkdir(SNS_DIR, { recursive: true });
    if (existsSync(VAPID_FILE)) {
      const j = JSON.parse(await readFile(VAPID_FILE, "utf8"));
      if (j && j.publicKey && j.privateKey) return j;
    }
  } catch {}
  const wp = await _getWebPush();
  if (!wp) return null;
  const keys = wp.generateVAPIDKeys();
  const j = {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    subject: process.env.VAPID_SUBJECT || "mailto:admin@thecollapse.local",
  };
  try {
    await writeFile(VAPID_FILE, JSON.stringify(j, null, 2), "utf8");
  } catch (e) {
    console.error("[sns] vapid persist error:", e);
  }
  return j;
}

// 新着投稿の通知。対象: カテゴリ設定が有効なユーザー（投稿者本人を除く）
async function _notifyNewPost(post) {
  const wp = await _getWebPush();
  if (!wp) return;
  const vapid = await _getVapid();
  if (!vapid) return;
  try {
    wp.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  } catch (e) {
    console.error("[sns] setVapidDetails error:", e);
    return;
  }
  const store = await _loadPushStore();
  const labels = { update: "新しいアップデート", site: "おすすめサイトが共有されました", improve: "新しい改善案" };
  const payload = JSON.stringify({
    title: "TheCollapse SNS",
    body: `@${post.author} が${labels[post.category] || "投稿"}しました` + (post.text ? `：${post.text.slice(0, 60)}` : ""),
    url: "/worksheets/sns.html",
    tag: "sns-" + post.category,
  });
  const dead = [];
  for (const [username, u] of Object.entries(store.users)) {
    if (username === post.author) continue; // 自分の投稿は通知しない
    const prefs = u && u.prefs ? u.prefs : defaultPrefs(username);
    if (!prefs[post.category]) continue;
    for (const sub of u.subs || []) {
      try {
        await wp.sendNotification(sub, payload);
      } catch (e) {
        // 購読無効(404/410)なら掃除対象に。その他の失敗は無視して続行
        if (e && (e.statusCode === 404 || e.statusCode === 410)) {
          dead.push({ username, endpoint: sub.endpoint });
        }
      }
    }
  }
  if (dead.length) {
    for (const d of dead) {
      const u = store.users[d.username];
      if (u) u.subs = (u.subs || []).filter((s) => s.endpoint !== d.endpoint);
    }
    await _persistPushStore();
  }
}

// ===== Express ルーター登録 =====
export function attachSnsRoutes(app) {
  // ---- タイムライン取得（閲覧はログイン不要・公開情報のみ） ----
  app.get("/api/sns/posts", async (req, res) => {
    try {
      const store = await _loadPosts();
      let list = store.posts;
      const cat = req.query.category;
      if (cat && CATEGORIES.has(cat)) list = list.filter((p) => p.category === cat);
      const viewer = getSessionUser(req) || null;
      // dev フラグは保存時に持たせず、取得時に現在の DEV_USERS から付与
      const out = list.slice(0, 200).map((p) => ({ ...p, dev: isDevName(p.author) }));
      res.setHeader("Cache-Control", "no-store");
      res.json({ posts: out, viewer });
    } catch (e) {
      console.error("sns list error:", e);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // ---- 投稿 ----
  app.post("/api/sns/posts", async (req, res) => {
    try {
      const username = getSessionUser(req);
      if (!username) return res.status(401).json({ error: "ログインが必要です" });
      if (!_allow(username + ":post", 10, 5 * 60_000)) {
        return res.status(429).json({ error: "投稿が集中しています。しばらく待ってからお試しください" });
      }
      const body = req.body || {};
      const category = body.category;
      if (!CATEGORIES.has(category)) return res.status(400).json({ error: "カテゴリが不正です" });

      // 権限ルール:
      //  - アップデートはデベロッパーのみ（公式アカウントではなくタグ所持者が投稿）
      //  - おすすめサイトは Browser の共有ボタンからのみ（via=browser 必須）
      if (category === "update" && !isDevName(username)) {
        return res.status(403).json({ error: "アップデートの投稿はデベロッパーのみです" });
      }
      if (category === "site" && body.via !== "browser") {
        return res.status(403).json({ error: "サイト共有はBrowserの共有ボタンからのみです" });
      }

      const text = _cleanText(body.text, 2000);
      let url = "";
      let title = "";
      if (category === "site") {
        const raw = _cleanText(body.url, 2048);
        try {
          const u = new URL(raw);
          if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol");
          url = u.href;
        } catch {
          return res.status(400).json({ error: "共有できるURLが不正です" });
        }
        title = _cleanText(body.title, 200);
      } else if (!text) {
        return res.status(400).json({ error: "投稿内容を入力してください" });
      }

      const post = {
        id: "p_" + randomUUID().replace(/-/g, "").slice(0, 20),
        category,
        author: username,
        text,
        url,
        title,
        createdAt: Date.now(),
        likes: [],
        replies: [],
      };
      const store = await _loadPosts();
      store.posts.unshift(post);
      if (store.posts.length > MAX_POSTS) store.posts.length = MAX_POSTS;
      await _persistPosts();
      // 通知は非同期（失敗しても投稿自体は成功扱い）
      _notifyNewPost(post).catch((e) => console.error("[sns] notify error:", e && (e.stack || e)));
      res.json({ ok: true, post: { ...post, dev: isDevName(post.author) } });
    } catch (e) {
      console.error("sns post error:", e);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // ---- いいね（トグル） ----
  app.post("/api/sns/posts/:id/like", async (req, res) => {
    try {
      const username = getSessionUser(req);
      if (!username) return res.status(401).json({ error: "ログインが必要です" });
      if (!_allow(username + ":like", 60, 60_000)) {
        return res.status(429).json({ error: "操作が集中しています。しばらく待ってください" });
      }
      const store = await _loadPosts();
      const p = store.posts.find((x) => x.id === req.params.id);
      if (!p) return res.status(404).json({ error: "投稿が見つかりません" });
      const i = p.likes.indexOf(username);
      if (i >= 0) p.likes.splice(i, 1);
      else p.likes.push(username);
      await _persistPosts();
      res.json({ ok: true, likes: p.likes.length, liked: i < 0 });
    } catch (e) {
      console.error("sns like error:", e);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // ---- 返信 ----
  app.post("/api/sns/posts/:id/replies", async (req, res) => {
    try {
      const username = getSessionUser(req);
      if (!username) return res.status(401).json({ error: "ログインが必要です" });
      if (!_allow(username + ":reply", 30, 5 * 60_000)) {
        return res.status(429).json({ error: "操作が集中しています。しばらく待ってください" });
      }
      const text = _cleanText((req.body || {}).text, 500);
      if (!text) return res.status(400).json({ error: "返信内容を入力してください" });
      const store = await _loadPosts();
      const p = store.posts.find((x) => x.id === req.params.id);
      if (!p) return res.status(404).json({ error: "投稿が見つかりません" });
      p.replies.push({
        id: "r_" + randomUUID().replace(/-/g, "").slice(0, 20),
        author: username,
        text,
        createdAt: Date.now(),
      });
      if (p.replies.length > 100) p.replies = p.replies.slice(-100);
      await _persistPosts();
      res.json({ ok: true, replies: p.replies });
    } catch (e) {
      console.error("sns reply error:", e);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // ---- 削除（本人 or デベロッパー） ----
  app.delete("/api/sns/posts/:id", async (req, res) => {
    try {
      const username = getSessionUser(req);
      if (!username) return res.status(401).json({ error: "ログインが必要です" });
      const store = await _loadPosts();
      const p = store.posts.find((x) => x.id === req.params.id);
      if (!p) return res.status(404).json({ error: "投稿が見つかりません" });
      if (p.author !== username && !isDevName(username)) {
        return res.status(403).json({ error: "削除する権限がありません" });
      }
      store.posts = store.posts.filter((x) => x.id !== p.id);
      await _persistPosts();
      res.json({ ok: true });
    } catch (e) {
      console.error("sns delete error:", e);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // ================= Web Push =================

  // VAPID 公開鍵（フロントの購読に必要）
  app.get("/api/push/key", async (req, res) => {
    try {
      const vapid = await _getVapid();
      if (!vapid) return res.json({ publicKey: null, available: false });
      res.json({ publicKey: vapid.publicKey, available: true });
    } catch (e) {
      console.error("push key error:", e);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // 購読登録（要ログイン・ユーザーごとに端末の購読を保存）
  app.post("/api/push/subscribe", async (req, res) => {
    try {
      const username = getSessionUser(req);
      if (!username) return res.status(401).json({ error: "ログインが必要です" });
      const sub = (req.body || {}).subscription;
      if (!sub || typeof sub.endpoint !== "string" || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
        return res.status(400).json({ error: "購読情報が不正です" });
      }
      const store = await _loadPushStore();
      const u = store.users[username] || (store.users[username] = { subs: [], prefs: null });
      if (!Array.isArray(u.subs)) u.subs = [];
      const i = u.subs.findIndex((s) => s && s.endpoint === sub.endpoint);
      if (i >= 0) u.subs[i] = sub;
      else u.subs.push(sub);
      if (u.subs.length > 5) u.subs = u.subs.slice(-5); // 端末は最大5件
      await _persistPushStore();
      res.json({ ok: true });
    } catch (e) {
      console.error("push subscribe error:", e);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.post("/api/push/unsubscribe", async (req, res) => {
    try {
      const username = getSessionUser(req);
      if (!username) return res.status(401).json({ error: "ログインが必要です" });
      const endpoint = (req.body || {}).endpoint;
      const store = await _loadPushStore();
      const u = store.users[username];
      if (u && typeof endpoint === "string") {
        u.subs = (u.subs || []).filter((s) => s && s.endpoint !== endpoint);
        await _persistPushStore();
      }
      res.json({ ok: true });
    } catch (e) {
      console.error("push unsubscribe error:", e);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // 通知設定の取得（未設定なら役割ごとの既定値を返す）
  app.get("/api/push/prefs", async (req, res) => {
    try {
      const username = getSessionUser(req);
      if (!username) return res.status(401).json({ error: "ログインが必要です" });
      const store = await _loadPushStore();
      const u = store.users[username];
      res.setHeader("Cache-Control", "no-store");
      res.json({
        ok: true,
        dev: isDevName(username),
        prefs: (u && u.prefs) || defaultPrefs(username),
      });
    } catch (e) {
      console.error("push prefs get error:", e);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // 通知設定の保存（カテゴリごとのオン/オフ）
  app.post("/api/push/prefs", async (req, res) => {
    try {
      const username = getSessionUser(req);
      if (!username) return res.status(401).json({ error: "ログインが必要です" });
      const body = req.body || {};
      const store = await _loadPushStore();
      const u = store.users[username] || (store.users[username] = { subs: [], prefs: null });
      const cur = u.prefs || defaultPrefs(username);
      u.prefs = {
        update: body.update === undefined ? cur.update : !!body.update,
        site: body.site === undefined ? cur.site : !!body.site,
        improve: body.improve === undefined ? cur.improve : !!body.improve,
      };
      await _persistPushStore();
      res.json({ ok: true, prefs: u.prefs });
    } catch (e) {
      console.error("push prefs set error:", e);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });
}
