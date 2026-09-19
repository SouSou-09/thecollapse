/*global Ultraviolet*/
self.__uv$config = {
    prefix: '/service3/',
    bare: '/bare/',
    // SW側(Ultraviolet#sourceUrl)は「prefix+meta.originを剥がした文字列」をdecodeUrlに渡す。
    // SWは new Ultraviolet(config) で生成するため meta.origin が空文字になり、
    // origin分が剥がれずにdecodeUrlへ渡って atob が InvalidCharacterError で落ちていた。
    // そこで decodeUrl 側で /service3/ 以降だけを取り出してからデコードする
    // （フルURL・パス形式・純base64のどれが渡っても耐える）。
    encodeUrl: (url) => Ultraviolet.codec.base64.encode(url),
    decodeUrl: (s) => {
        let t = String(s == null ? '' : s);
        const i = t.indexOf('/service3/');
        if (i >= 0) t = t.slice(i + '/service3/'.length);
        const q = t.indexOf('?');
        if (q >= 0) t = t.slice(0, q);
        return Ultraviolet.codec.base64.decode(t.replace(/^\/+/, ''));
    },
    handler: '/uv3/uv.handler.js',
    client: '/uv3/uv.client.js',
    bundle: '/uv3/uv.bundle.js',
    config: '/uv3/uv.config.js',
    sw: '/uv3/uv.sw.js',
};
