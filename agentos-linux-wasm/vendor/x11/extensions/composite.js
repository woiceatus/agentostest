'use strict';

// COMPOSITE 0.4 — enough for Aurora light compositor + NameWindowPixmap.

const { XError, codes } = require('x11/lib/xserver/errors.js');

function ensureCompositeState(server) {
    if (!server._composite)
        server._composite = {
            // window id -> 'Automatic' | 'Manual'
            windowRedirect: new Map(),
            // parent id -> 'Automatic' | 'Manual' (RedirectSubwindows)
            subRedirect: new Map(),
            overlayByRoot: new Map(),
            namedPixmaps: new Map() // pixmap id -> window id
        };
    return server._composite;
}

function redirectMode(update) {
    return update === 1 ? 'Manual' : 'Automatic';
}

module.exports = {
    name: 'Composite',
    eventsCount: 0,
    errorsCount: 0,

    init(server) {
        ensureCompositeState(server);
    },

    handleRequest(server, client, minor, body) {
        const state = ensureCompositeState(server);
        switch (minor) {
            case 0: { // QueryVersion
                const b = client.startReply(0, 0);
                b.writeUInt32LE(0, 8);
                b.writeUInt32LE(4, 12);
                client.send(b);
                break;
            }
            case 1: { // RedirectWindow
                const win = server.getWindow(body.readUInt32LE(0));
                state.windowRedirect.set(win.id, redirectMode(body.readUInt8(4)));
                win.compositeRedirect = state.windowRedirect.get(win.id);
                break;
            }
            case 2: { // RedirectSubwindows
                const win = server.getWindow(body.readUInt32LE(0));
                const mode = redirectMode(body.readUInt8(4));
                state.subRedirect.set(win.id, mode);
                win.compositeRedirectSubwindows = mode;
                break;
            }
            case 3: { // UnredirectWindow
                const win = server.getWindow(body.readUInt32LE(0));
                state.windowRedirect.delete(win.id);
                delete win.compositeRedirect;
                break;
            }
            case 4: { // UnredirectSubwindows
                const win = server.getWindow(body.readUInt32LE(0));
                state.subRedirect.delete(win.id);
                delete win.compositeRedirectSubwindows;
                break;
            }
            case 5: { // CreateRegionFromBorderClip — needs XFIXES region
                const regionId = body.readUInt32LE(0);
                const win = server.getWindow(body.readUInt32LE(4));
                server.checkIdFree(client, regionId);
                server.resources.set(regionId, {
                    type: 'region',
                    id: regionId,
                    owner: client,
                    rects: [{ x: 0, y: 0, width: win.width, height: win.height }]
                });
                break;
            }
            case 6: { // NameWindowPixmap
                const win = server.getWindow(body.readUInt32LE(0));
                const pid = body.readUInt32LE(4);
                server.checkIdFree(client, pid);
                const pixmap = {
                    type: 'pixmap',
                    id: pid,
                    depth: win.depth || 24,
                    raster: win.raster,
                    owner: client,
                    namedFromWindow: win.id
                };
                server.resources.set(pid, pixmap);
                state.namedPixmaps.set(pid, win.id);
                break;
            }
            case 7: { // GetOverlayWindow
                const win = server.getWindow(body.readUInt32LE(0));
                let overlay = state.overlayByRoot.get(win.id);
                if (!overlay) {
                    const windows = require('x11/lib/xserver/windows.js');
                    if (!server._compositeOverlaySeq)
                        server._compositeOverlaySeq = 1;
                    const id = (0x70000000 + server._compositeOverlaySeq++) >>> 0;
                    overlay = new windows.Window(
                        server, id, win, 0, 0, win.width, win.height, 0, 1, null
                    );
                    overlay.overrideRedirect = true;
                    overlay.mapped = false;
                    win.children.push(overlay);
                    server.resources.set(id, overlay);
                    state.overlayByRoot.set(win.id, overlay);
                }
                const b = client.startReply(0, 0);
                b.writeUInt32LE(overlay.id >>> 0, 8);
                client.send(b);
                break;
            }
            case 8: // ReleaseOverlayWindow
                server.getWindow(body.readUInt32LE(0));
                break;
            default:
                throw new XError(codes.Implementation, minor);
        }
    }
};
