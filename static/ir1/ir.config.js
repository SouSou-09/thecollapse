/*global Ultraviolet*/
// IR V1 (UV V3ベース) 設定ファイル
self.__uv$config = {
    prefix: '/ir1-service/',
    bare: '/bare/',
    // SW側(Ultraviolet#sourceUrl)は targetURL だけでなく referrer(アプリ自身のページURL)まで
    // 「prefix+originを剥がした文字列」として decodeUrl に渡してくる。
    // ページURLはbase64ではないため atob が例外を出し、これがSW内で握りつぶされず500になる。
    // そこで decodeUrl は「絶対に例外を出さない」設計にする:
    //   - /ir1-service/（または旧 /service3/）が含まれるならその後ろだけを取り出す(lastIndexOfで後ろ基準)
    //   - base64以外の文字は落としてパディングを正規化してからデコード
    //   - それでも復号できないなら about:blank を返す(SWは処理を続行できる)
    encodeUrl: (url) => Ultraviolet.codec.base64.encode(url),
    decodeUrl: (s) => {
        let t = String(s == null ? '' : s);
        for (const p of ['/ir1-service/', '/service3/']) {
            const i = t.lastIndexOf(p);
            if (i >= 0) { t = t.slice(i + p.length); break; }
        }
        const q = t.indexOf('?');
        if (q >= 0) t = t.slice(0, q);
        t = t.replace(/^\/+/, '').replace(/[^A-Za-z0-9+\/=]/g, '').replace(/=+$/, '');
        while (t.length % 4 !== 0) t += '=';
        try {
            return Ultraviolet.codec.base64.decode(t);
        } catch (e) {
            return 'about:blank';
        }
    },
    handler: '/ir1/ir.handler.js',
    client: '/ir1/ir.client.js',
    bundle: '/ir1/ir.bundle.js',
    config: '/ir1/ir.config.js',
    sw: '/ir1/ir.sw.js',
};
