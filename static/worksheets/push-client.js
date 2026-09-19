// =====================================================
//  TheCollapse — Push 通知クライアント（v2.2.0 SNS）
//  「ホーム画面に追加」した端末（PWA standalone）でのみ
//  プッシュ購読を行う。account.js の後に読み込むこと。
// =====================================================
(function () {
  const TC_PUSH = {
    // この端末はホーム画面に追加済み（PWA standalone）か
    isStandalone() {
      return (
        (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
        window.navigator.standalone === true
      );
    },

    async ensurePermission() {
      if (typeof Notification === "undefined") return "unsupported";
      if (Notification.permission === "granted") return "granted";
      if (Notification.permission === "denied") return "denied";
      try {
        return await Notification.requestPermission();
      } catch {
        return "denied";
      }
    },

    // 購読してサーバーに登録する
    async subscribe() {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        return { ok: false, reason: "unsupported" };
      }
      if (!window.TC_ACCOUNT || !TC_ACCOUNT.currentUser()) {
        return { ok: false, reason: "nologin" };
      }
      const perm = await TC_PUSH.ensurePermission();
      if (perm !== "granted") return { ok: false, reason: perm === "unsupported" ? "unsupported" : "permission" };

      // PWA-SW（/pwa-sw.js, scope:/）を使う。未登録ならここで登録。
      let reg = await navigator.serviceWorker.getRegistration("/");
      if (!reg) {
        try {
          reg = await navigator.serviceWorker.register("/pwa-sw.js", { scope: "/" });
        } catch {
          return { ok: false, reason: "sw" };
        }
      }
      try {
        const keyRes = await fetch("/api/push/key", { cache: "no-store", credentials: "same-origin" });
        const keyData = await keyRes.json();
        if (!keyData || !keyData.publicKey) return { ok: false, reason: "server" };

        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
          sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: TC_PUSH._urlB64ToUint8(keyData.publicKey),
          });
        }
        const r = await fetch("/api/push/subscribe", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscription: sub.toJSON() }),
        });
        if (!r.ok) return { ok: false, reason: "server" };
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: "error" };
      }
    },

    // 通知設定（カテゴリごとのオン/オフ）をサーバーに保存
    async savePrefs(prefs) {
      try {
        const r = await fetch("/api/push/prefs", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(prefs),
        });
        return r.ok;
      } catch {
        return false;
      }
    },

    // 通知設定を取得（サーバー側の既定値: 一般=アップデート+おすすめサイト / デベロッパー=全て）
    async loadPrefs() {
      try {
        const r = await fetch("/api/push/prefs", { credentials: "same-origin", cache: "no-store" });
        if (!r.ok) return null;
        return await r.json();
      } catch {
        return null;
      }
    },

    _urlB64ToUint8(b64) {
      const pad = "=".repeat((4 - (b64.length % 4)) % 4);
      const base64 = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
      const raw = atob(base64);
      const out = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
      return out;
    },
  };
  window.TC_PUSH = TC_PUSH;

  // ── 自動購読: ホーム画面に追加済み & ログイン済みのとき ──
  window.addEventListener("DOMContentLoaded", async () => {
    try {
      if (!TC_PUSH.isStandalone()) return; // ホーム画面に追加していなければ何もしない
      if (typeof Notification === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
      if (Notification.permission === "denied") return;
      if (typeof TC_ACCOUNT === "undefined" || !TC_ACCOUNT.restoreSession) return;
      await TC_ACCOUNT.restoreSession();
      if (!TC_ACCOUNT.currentUser()) return;
      // 初回のみ許可ダイアログを出す（断った以後は自動で聞かない）
      if (Notification.permission === "default" && localStorage.getItem("tc_push_prompted") === "1") return;
      localStorage.setItem("tc_push_prompted", "1");
      await TC_PUSH.subscribe();
    } catch (e) {
      // 通知は本筋機能ではないので失敗しても何もしない
    }
  });

  // SW の通知クリック → 既存ウィンドウがあればその中で遷移
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (ev) => {
      try {
        if (ev.data && ev.data.type === "tc-open-url" && ev.data.url) {
          if (location.pathname !== ev.data.url) location.href = ev.data.url;
        }
      } catch {}
    });
  }
})();
