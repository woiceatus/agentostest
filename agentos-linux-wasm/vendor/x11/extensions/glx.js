'use strict';

// GLX 1.4 — wraps node-x11 browser GLX emulator with Soft/WebGL backend.

const { createGlxExtension } = require('x11/browser/glx');
const { createGlBackend } = require('../soft-gl-backend');

function createServerGlxExtension() {
    const backend = createGlBackend();

    const ext = createGlxExtension({
        backend,
        indirectContexts: true,
        getDrawableSurface(xid) {
            const server = ext.server;
            if (!server)
                return null;
            const drawable = server.resources.get(xid);
            if (!drawable || !drawable.raster)
                return null;
            return {
                width: drawable.raster.width,
                height: drawable.raster.height,
                wantsPixels: true,
                notifySwap(pixels) {
                    if (!pixels || !drawable.raster || !drawable.raster.data)
                        return;
                    const dst = drawable.raster.data;
                    const n = Math.min(dst.length, pixels.length);
                    dst.set(pixels.subarray(0, n));
                    if (drawable.type === 'window')
                        server.damageWindow(drawable);
                    else
                        server.emit('damage', {
                            x: 0,
                            y: 0,
                            width: drawable.raster.width,
                            height: drawable.raster.height
                        });
                }
            };
        }
    });

    const origInit = ext.init.bind(ext);
    ext.init = function (server, extInfo) {
        this.server = server;
        return origInit(server, extInfo);
    };

    return ext;
}

module.exports = createServerGlxExtension();
