/*global Ultraviolet*/
self.__uv$config = {
    prefix: '/service3/',
    bare: '/bare/',
    encodeUrl: Ultraviolet.codec.base64.encode,
    decodeUrl: Ultraviolet.codec.base64.decode,
    handler: '/uv3/uv.handler.js',
    client: '/uv3/uv.client.js',
    bundle: '/uv3/uv.bundle.js',
    config: '/uv3/uv.config.js',
    sw: '/uv3/uv.sw.js',
};
