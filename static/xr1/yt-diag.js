/* TheCollapse: YouTube 再生診断（Service Worker 側）
   YouTube の動画データ(SABR)は、止まるときも通信は全部 200 のままで、コンソールにも何も出ない。
   原因は要求・応答の中身（再生トークンの有無、サーバーの配信可否の通知、届いた動画の範囲）にしか現れないので、
   それを 1 行に要約してアプリ内ログへ出す。動画データ本体は読み飛ばし、トークン等は長さだけを出す。 */
(function () {
  'use strict';

  var VP_RE = /^https:\/\/[^/]*\.googlevideo\.com\/videoplayback\?/i;
  var BG_RE = /\/(api\/jnn\/v1|\$rpc\/google\.internal\.waa\.v1\.Waa)\/GenerateIT(\?|$)/;
  var PLAYER_RE = /^https:\/\/[^/]*\.youtube(-nocookie)?\.com\/youtubei\/v1\/player(\?|$)/i;
  var MAX_PART = 8192; // これより大きいパートは中身を読まない

  function post(text) {
    var proxyBase = self.location.origin + __uv$config.prefix;
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
      clients.forEach(function (c) {
        // プロキシ先のページには送らない（アプリ本体の画面だけがログを持つ）
        if (c.url.indexOf(proxyBase) === 0) return;
        try { c.postMessage({ msg: 'tcYtDiag', build: String(self.__tcSwBuild || '').slice(0, 6), text: text }); } catch (e) {}
      });
    }).catch(function () {});
  }

  // protobuf を [フィールド番号, 値] の配列にする（値は数値か Uint8Array）
  function pb(buf) {
    var out = [], p = 0;
    function varint() {
      var v = 0, s = 1, c;
      do { c = buf[p++]; v += (c & 0x7f) * s; s *= 128; } while (c & 0x80 && p < buf.length);
      return v;
    }
    try {
      while (p < buf.length) {
        var key = varint(), field = Math.floor(key / 8), wire = key & 7;
        if (wire === 0) out.push([field, varint()]);
        else if (wire === 2) { var len = varint(); out.push([field, buf.subarray(p, p + len)]); p += len; }
        else if (wire === 1) p += 8;
        else if (wire === 5) p += 4;
        else break;
      }
    } catch (e) {}
    return out;
  }
  function first(fields, n) {
    for (var i = 0; i < fields.length; i++) if (fields[i][0] === n) return fields[i][1];
    return null;
  }
  function sub(fields, n) {
    var v = first(fields, n);
    return v instanceof Uint8Array ? pb(v) : [];
  }
  function sec(ms) { return typeof ms === 'number' ? (ms / 1000).toFixed(1) : '-'; }

  // 要求: 再生トークン(PO token)の長さ、プレーヤーの再生位置、読み込み済みの終端
  function summarizeRequest(buf) {
    var f = pb(buf);
    var po = first(sub(f, 19), 2);
    var bufEnd = null;
    f.forEach(function (x) {
      if (x[0] !== 3 || !(x[1] instanceof Uint8Array)) return;
      var r = pb(x[1]);
      var end = (first(r, 2) || 0) + (first(r, 3) || 0);
      if (bufEnd === null || end > bufEnd) bufEnd = end;
    });
    return 'req ' + buf.length + 'B po=' + (po instanceof Uint8Array ? po.length : 'none') +
      ' t=' + sec(first(sub(f, 1), 28)) + ' buf=' + sec(bufEnd);
  }

  // 応答(UMP): パートの種類、配信可否(STREAM_PROTECTION_STATUS)、待ち時間、エラー、届いた動画の終端
  function createUmpSummary() {
    var pending = new Uint8Array(0), skip = 0, total = 0, media = 0, mediaEnd = null;
    var types = {}, notes = [];

    function varintAt(p) {
      if (p >= pending.length) return null;
      var b = pending[p], n = b < 128 ? 1 : b < 192 ? 2 : b < 224 ? 3 : b < 240 ? 4 : 5;
      if (p + n > pending.length) return null;
      var v;
      if (n === 1) v = b;
      else if (n === 2) v = (b & 0x3f) + 64 * pending[p + 1];
      else if (n === 3) v = (b & 0x1f) + 32 * (pending[p + 1] + 256 * pending[p + 2]);
      else if (n === 4) v = (b & 0x0f) + 16 * (pending[p + 1] + 256 * (pending[p + 2] + 256 * pending[p + 3]));
      else v = pending[p + 1] + 256 * (pending[p + 2] + 256 * (pending[p + 3] + 256 * pending[p + 4]));
      return [v, n];
    }
    function part(type, payload) {
      var f = pb(payload);
      if (type === 58) notes.push('SPS=' + first(f, 1));
      else if (type === 35) { var b = first(f, 4); if (b) notes.push('backoff=' + b); }
      else if (type === 44) notes.push('SABR_ERROR=' + String.fromCharCode.apply(null, payload.subarray(0, 60)).replace(/[^\x20-\x7e]/g, '.'));
      else if (type === 43) notes.push('REDIRECT');
      else if (type === 46) notes.push('RELOAD');
      else if (type === 57) notes.push('CTX=' + first(f, 1));
      else if (type === 67) notes.push('SNACKBAR');
      else if (type === 20) {
        var end = (first(f, 11) || 0) + (first(f, 12) || 0);
        if (end && (mediaEnd === null || end > mediaEnd)) mediaEnd = end;
      }
    }
    return {
      push: function (chunk) {
        total += chunk.length;
        if (skip) {
          var n = Math.min(skip, chunk.length);
          skip -= n;
          chunk = chunk.subarray(n);
        }
        if (!chunk.length) return;
        var merged = new Uint8Array(pending.length + chunk.length);
        merged.set(pending); merged.set(chunk, pending.length);
        pending = merged;
        var p = 0;
        for (;;) {
          var t = varintAt(p); if (!t) break;
          var s = varintAt(p + t[1]); if (!s) break;
          var start = p + t[1] + s[1], type = t[0], size = s[0];
          var big = type === 21 || size > MAX_PART;
          if (!big && start + size > pending.length) break;
          types[type] = (types[type] || 0) + 1;
          if (type === 21) media += size;
          if (big) {
            var have = pending.length - start;
            if (size > have) { skip = size - have; p = pending.length; break; }
          } else {
            part(type, pending.subarray(start, start + size));
          }
          p = start + size;
        }
        pending = pending.slice(p);
      },
      text: function () {
        return 'res ' + total + 'B media=' + media + 'B' + (mediaEnd !== null ? '(→' + sec(mediaEnd) + 's)' : '') +
          (notes.length ? ' ' + notes.join(' ') : '') + ' parts=' + Object.keys(types).join(',');
      },
    };
  }

  async function watchVideoplayback(reqClone, res, remote) {
    var rn = (/[?&]rn=(\d+)/.exec(remote) || [])[1] || '?';
    var line = 'videoplayback #' + rn + ' ' + res.status + ' ';
    try { line += summarizeRequest(new Uint8Array(await reqClone.arrayBuffer())); } catch (e) { line += 'req ?'; }
    try {
      var ump = createUmpSummary();
      var reader = res.body ? res.body.getReader() : { read: function () { return { done: true }; } };
      for (;;) {
        var r = await reader.read();
        if (r.done) break;
        ump.push(r.value);
      }
      line += ' | ' + ump.text();
    } catch (e) { line += ' | res ? ' + String(e).slice(0, 60); }
    post(line);
  }

  self.TCYtDiag = {
    // 診断対象のリクエストなら、応答を渡すための関数を返す（対象外は null）。
    // リクエスト本体は送信時に消費されるので、送信前に呼ぶこと。
    begin: function (request, remote) {
      try {
        if (request.method !== 'POST') return null;
        if (VP_RE.test(remote)) {
          var reqClone = request.clone();
          return function (res) { watchVideoplayback(reqClone, res.clone(), remote); };
        }
        if (BG_RE.test(remote)) {
          return function (res) {
            res.clone().text().then(function (t) {
              post('BotGuard GenerateIT ' + res.status + ' ' + (/^\s*\["/.test(t) ? 'TOKEN' : 'FALLBACK'));
            }).catch(function () {});
          };
        }
        if (PLAYER_RE.test(remote)) {
          var login = request.headers.has('authorization');
          return function (res) {
            res.clone().text().then(function (t) {
              post('player ' + res.status +
                ' status=' + ((/"playabilityStatus":\s*\{\s*"status":\s*"([A-Z_]+)"/.exec(t) || [])[1] || '?') +
                ' sabr=' + /"serverAbrStreamingUrl"/.test(t) + ' ads=' + /"adPlacements"|"adSlots"/.test(t) +
                ' login=' + login);
            }).catch(function () {});
          };
        }
      } catch (e) {}
      return null;
    },
  };
})();
