'use strict';

// GLX 1.4 protocol stub + SoftGL SwapBuffers. Avoids importing x11/browser/glx
// so Vite/rolldown browser bundles never hit a runtime `require` hole.

const { createGlBackend } = require('../soft-gl-backend');

function pad4(n) {
    return (n + 3) & ~3;
}

function stringReply(client, s) {
    const len = s.length + 1;
    const extra = pad4(len) / 4;
    const b = client.startReply(extra, 0);
    b.writeUInt32LE(len, 12);
    b.write(s, 32, 'latin1');
    client.send(b);
}

function createGlxExtension() {
    const backend = createGlBackend();
    const contexts = new Map();
    const tags = new Map();
    let nextTag = 1;
    let serverRef = null;

    function drawableSurface(xid) {
        if (!serverRef)
            return null;
        const drawable = serverRef.resources.get(xid);
        if (!drawable || !drawable.raster)
            return null;
        return drawable;
    }

    return {
        name: 'GLX',
        eventsCount: 1,
        errorsCount: 13,

        init(server) {
            serverRef = server;
        },

        handleRequest(server, client, minor, body) {
            serverRef = server;
            switch (minor) {
                case 3: // CreateContext: context, visual, screen, shareList, isDirect
                case 20: // CreateNewContext
                case 24: { // CreateContextAttribsARB-ish void create
                    const ctx = body.readUInt32LE(0);
                    contexts.set(ctx, { xid: ctx, drawable: 0 });
                    break;
                }
                case 4: // DestroyContext
                    contexts.delete(body.readUInt32LE(0));
                    break;
                case 5: { // MakeCurrent: drawable, context, oldContext -> tag
                    const drawable = body.readUInt32LE(0);
                    const context = body.readUInt32LE(4);
                    if (context && !contexts.has(context))
                        contexts.set(context, { xid: context, drawable });
                    const surf = drawableSurface(drawable);
                    if (surf)
                        backend.resize(surf.raster.width, surf.raster.height);
                    const tag = nextTag++;
                    tags.set(tag, { context, drawable });
                    const b = client.startReply(0, 0);
                    b.writeUInt32LE(tag, 8);
                    client.send(b);
                    break;
                }
                case 6: { // IsDirect
                    const b = client.startReply(0, 0);
                    b.writeUInt32LE(0, 8);
                    client.send(b);
                    break;
                }
                case 7: { // QueryVersion
                    const b = client.startReply(0, 0);
                    b.writeUInt32LE(1, 8);
                    b.writeUInt32LE(4, 12);
                    client.send(b);
                    break;
                }
                case 11: { // SwapBuffers: contextTag, drawable
                    const drawable = body.readUInt32LE(4);
                    const surf = drawableSurface(drawable);
                    if (surf) {
                        backend.resize(surf.raster.width, surf.raster.height);
                        const pixels = backend.readPixelsUint32(
                            surf.raster.width, surf.raster.height
                        );
                        const dst = surf.raster.data;
                        dst.set(pixels.subarray(0, Math.min(dst.length, pixels.length)));
                        if (surf.type === 'window')
                            server.damageWindow(surf);
                    }
                    break;
                }
                case 14: // GetVisualConfigs
                case 21: { // GetFBConfigs
                    // num = 0 → clients fall back / skip GL visuals
                    const b = client.startReply(0, 0);
                    b.writeUInt32LE(0, 8);
                    b.writeUInt32LE(0, 12);
                    client.send(b);
                    break;
                }
                case 17: // QueryExtensionsString
                    stringReply(client, 'GLX_ARB_create_context');
                    break;
                case 18: { // QueryServerString
                    const name = body.readUInt32LE(4);
                    if (name === 1) stringReply(client, 'agentos-linux-wasm');
                    else if (name === 2) stringReply(client, '1.4');
                    else stringReply(client, 'GLX_ARB_create_context');
                    break;
                }
                case 19: { // ClientID / vendor private empty reply paths
                    const b = client.startReply(0, 0);
                    client.send(b);
                    break;
                }
                default:
                    // Render / large requests / unknowns: ignore (no reply).
                    break;
            }
        }
    };
}

module.exports = createGlxExtension();
