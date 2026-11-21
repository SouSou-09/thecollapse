// YouTube の再生トークン（PO トークン）をサーバー側で発行する。
//
// YouTube の動画サーバーは、BotGuard（ボット判定）で発行した PO トークンが要求に付いていないと
// 先頭 60 秒分しか配信しない。トークンはプロキシ配下のページでも発行できるが、判定がプロキシの
// オリジン上で走るため、動画サーバーに有効と認められない（証明待ちのまま 60 秒で配信が止まる）。
// ここでは判定を www.youtube.com として動く jsdom 上で実行し、発行したトークンを
// Service Worker（static/xr1/yt-pot.js）が動画データの要求へ載せ替える。
//
// jsdom / bgutils-js は初回の発行時に読み込む（読み込めなくても本体は起動する）。

const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo"; // YouTube Web 用の BotGuard リクエストキー
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const INIT_TIMEOUT_MS = 20_000;
const MAX_MINTER_AGE_MS = 6 * 60 * 60_000;
const MAX_CACHE = 500;

let minter = null; // { mint, expiresAt, close }
let pending = null;
const cache = new Map(); // videoId -> { token, minter }

// 判定を実行する jsdom と同じブラウザを名乗る
function fetchWithTimeout(url, init) {
  return fetch(url, {
    ...init,
    headers: { ...init?.headers, "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(INIT_TIMEOUT_MS),
  });
}

async function createMinter() {
  const [{ JSDOM, ResourceLoader }, { getChallenge, BotGuardClient }, { buildURL, getHeaders }] = await Promise.all([
    import("jsdom"),
    import("bgutils-js/botguard"),
    import("bgutils-js/utils"),
  ]);

  // navigator.userAgent は ResourceLoader 経由でしか変えられない。外部リソースは読み込ませない。
  class NoFetchLoader extends ResourceLoader {
    fetch() {
      return null;
    }
  }
  const dom = new JSDOM('<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>', {
    url: "https://www.youtube.com/",
    referrer: "https://www.youtube.com/",
    resources: new NoFetchLoader({ userAgent: USER_AGENT }),
    runScripts: "outside-only",
  });
  const win = dom.window;
  try {
    const challenge = await getChallenge({ requestKey: REQUEST_KEY, fetchFunction: fetchWithTimeout });
    let script = challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
    if (!script) {
      const url = challenge.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
      if (!url) throw new Error("BotGuard challenge has no interpreter");
      script = await (await fetchWithTimeout("https:" + url)).text();
    }
    win.eval(script);

    const botguard = await BotGuardClient.create({
      program: challenge.program,
      globalName: challenge.globalName,
      globalObject: win,
    });
    const webPoSignalOutput = [];
    const botguardResponse = await botguard.snapshot({ webPoSignalOutput });

    const res = await fetchWithTimeout(buildURL("GenerateIT"), {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify([REQUEST_KEY, botguardResponse]),
    });
    const [integrityToken, ttlSecs] = await res.json();
    if (typeof integrityToken !== "string") throw new Error("GenerateIT returned no integrity token");

    // 以降の配列は jsdom 側の Uint8Array で渡す（BotGuard は自分の realm の型かどうかを見る）
    const getMinter = webPoSignalOutput[0];
    if (typeof getMinter !== "function") throw new Error("BotGuard returned no minter");
    const mintCallback = await getMinter(win.Uint8Array.from(Buffer.from(integrityToken, "base64url")));
    if (typeof mintCallback !== "function") throw new Error("BotGuard minter is not callable");

    const ttlMs = (Number(ttlSecs) > 0 ? Number(ttlSecs) : 3600) * 1000;
    return {
      expiresAt: Date.now() + Math.min(ttlMs / 2, MAX_MINTER_AGE_MS),
      mint: async (binding) => {
        const token = await mintCallback(win.Uint8Array.from(Buffer.from(binding, "utf8")));
        if (!token || !token.length) throw new Error("BotGuard minted an empty token");
        return Buffer.from(token).toString("base64url");
      },
      close: () => {
        try { win.close(); } catch {}
      },
    };
  } catch (e) {
    try { win.close(); } catch {}
    throw e;
  }
}

async function getMinter() {
  if (minter && minter.expiresAt > Date.now()) return minter;
  if (!pending) {
    pending = createMinter()
      .then((created) => {
        if (minter) minter.close();
        cache.clear();
        minter = created;
        return created;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

/** 動画 ID に束縛した PO トークン（base64url）を返す。発行できなければ例外。 */
export async function mintYoutubePoToken(videoId) {
  const m = await getMinter();
  const hit = cache.get(videoId);
  if (hit && hit.minter === m) return hit.token;
  const token = await m.mint(videoId);
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(videoId, { token, minter: m });
  return token;
}
