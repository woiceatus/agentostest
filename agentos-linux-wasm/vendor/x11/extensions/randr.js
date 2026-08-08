'use strict';

// RANDR 1.6 — single virtual output/crtc matching the JS XServer screen.

const { XError, codes } = require('x11/lib/xserver/errors.js');

const CRTC_ID = 0x61;
const OUTPUT_ID = 0x62;
const MODE_ID = 0x63;

function ensureRandr(server) {
    if (!server._randr) {
        server._randr = {
            listeners: new Map(), // window -> mask
            rotation: 1, // Rotate_0
            rate: 60,
            configTimestamp: server.now()
        };
    }
    return server._randr;
}

function modeName(server) {
    return `${server.width}x${server.height}`;
}

function packModeInfo(server) {
    const name = modeName(server);
    return {
        id: MODE_ID,
        width: server.width,
        height: server.height,
        dot_clock: server.width * server.height * 60,
        h_sync_start: server.width + 16,
        h_sync_end: server.width + 32,
        h_total: server.width + 48,
        h_skew: 0,
        v_sync_start: server.height + 4,
        v_sync_end: server.height + 8,
        v_total: server.height + 12,
        name,
        modeflags: 0
    };
}

function screenResourcesReply(server, client) {
    const mode = packModeInfo(server);
    const nameLen = mode.name.length;
    const namePad = (nameLen + 3) & ~3;
    // crtcs(1)+outputs(1)+modes(1)*32 + name
    const extraBytes = 4 + 4 + 32 + namePad;
    const extraWords = extraBytes / 4;
    const b = client.startReply(extraWords, 0);
    const ts = server.now();
    b.writeUInt32LE(ts, 8);
    b.writeUInt32LE(ensureRandr(server).configTimestamp, 12);
    b.writeUInt16LE(1, 16); // ncrtcs
    b.writeUInt16LE(1, 18); // noutputs
    b.writeUInt16LE(1, 20); // nmodes
    b.writeUInt16LE(nameLen, 22); // nbytes of mode names
    let o = 32;
    b.writeUInt32LE(CRTC_ID, o); o += 4;
    b.writeUInt32LE(OUTPUT_ID, o); o += 4;
    b.writeUInt32LE(mode.id, o); o += 4;
    b.writeUInt16LE(mode.width, o); o += 2;
    b.writeUInt16LE(mode.height, o); o += 2;
    b.writeUInt32LE(mode.dot_clock >>> 0, o); o += 4;
    b.writeUInt16LE(mode.h_sync_start, o); o += 2;
    b.writeUInt16LE(mode.h_sync_end, o); o += 2;
    b.writeUInt16LE(mode.h_total, o); o += 2;
    b.writeUInt16LE(mode.h_skew, o); o += 2;
    b.writeUInt16LE(mode.v_sync_start, o); o += 2;
    b.writeUInt16LE(mode.v_sync_end, o); o += 2;
    b.writeUInt16LE(mode.v_total, o); o += 2;
    b.writeUInt16LE(nameLen, o); o += 2;
    b.writeUInt32LE(mode.modeflags, o); o += 4;
    b.write(mode.name, o, 'latin1');
    client.send(b);
}

module.exports = {
    name: 'RANDR',
    eventsCount: 2,
    errorsCount: 4,

    init(server) {
        ensureRandr(server);
    },

    handleRequest(server, client, minor, body) {
        const state = ensureRandr(server);
        switch (minor) {
            case 0: { // QueryVersion
                const b = client.startReply(0, 0);
                b.writeUInt32LE(1, 8);
                b.writeUInt32LE(6, 12);
                client.send(b);
                break;
            }
            case 2: { // SetScreenConfig
                const b = client.startReply(0, 0); // status Success in detail
                b[1] = 0;
                b.writeUInt32LE(server.now(), 8);
                b.writeUInt32LE(state.configTimestamp, 12);
                b.writeUInt16LE(state.rotation, 16);
                b.writeUInt16LE(0, 18);
                b.writeUInt16LE(state.rate, 20);
                client.send(b);
                break;
            }
            case 4: { // SelectInput
                const win = server.getWindow(body.readUInt32LE(0));
                const mask = body.readUInt16LE(4);
                state.listeners.set(win.id, { client, mask });
                break;
            }
            case 5: { // GetScreenInfo
                const root = server.root.id;
                // sizes (8 bytes) + rates (2) + pad -> 3 words
                const b = client.startReply(3, 1);
                b[1] = 1; // Rotate_0 supported (detail)
                b.writeUInt32LE(root >>> 0, 8);
                b.writeUInt32LE(server.now(), 12);
                b.writeUInt32LE(state.configTimestamp, 16);
                b.writeUInt16LE(1, 20); // nSizes
                b.writeUInt16LE(0, 22); // sizeID
                b.writeUInt16LE(state.rotation, 24);
                b.writeUInt16LE(state.rate, 26);
                b.writeUInt16LE(1, 28); // nRates
                b.writeUInt16LE(server.width, 32);
                b.writeUInt16LE(server.height, 34);
                b.writeUInt16LE(Math.round(server.width * 25.4 / 96), 36);
                b.writeUInt16LE(Math.round(server.height * 25.4 / 96), 38);
                b.writeUInt16LE(state.rate, 40);
                client.send(b);
                break;
            }
            case 6: { // GetScreenSizeRange
                const b = client.startReply(0, 0);
                b.writeUInt16LE(320, 8);
                b.writeUInt16LE(200, 10);
                b.writeUInt16LE(7680, 12);
                b.writeUInt16LE(4320, 14);
                client.send(b);
                break;
            }
            case 7: { // SetScreenSize
                const width = body.readUInt16LE(4);
                const height = body.readUInt16LE(6);
                if (width >= 320 && height >= 200) {
                    const { Raster } = require('x11/lib/xserver/raster.js');
                    server.width = width;
                    server.height = height;
                    server.root.width = width;
                    server.root.height = height;
                    server.root.raster = new Raster(width, height, server.root.depth || 24);
                    state.configTimestamp = server.now();
                    server.damageWindow(server.root);
                }
                break;
            }
            case 8: // GetScreenResources
            case 25: // GetScreenResourcesCurrent
                screenResourcesReply(server, client);
                break;
            case 9: { // GetOutputInfo
                const name = 'HTML5-1';
                const namePad = (name.length + 3) & ~3;
                const extra = (4 + 4 + namePad) / 4; // crtcs + modes + name
                const b = client.startReply(extra, 0);
                b[1] = 0; // status Success
                b.writeUInt32LE(server.now(), 8);
                b.writeUInt32LE(CRTC_ID, 12);
                b.writeUInt32LE(Math.round(server.width * 25.4 / 96), 16);
                b.writeUInt32LE(Math.round(server.height * 25.4 / 96), 20);
                b.writeUInt8(0, 24); // Connected
                b.writeUInt8(0, 25); // subpixel
                b.writeUInt16LE(1, 26); // ncrtcs
                b.writeUInt16LE(1, 28); // nmodes
                b.writeUInt16LE(1, 30); // npreferred
                b.writeUInt16LE(0, 32); // nclones
                b.writeUInt16LE(name.length, 34);
                b.writeUInt32LE(CRTC_ID, 36);
                b.writeUInt32LE(MODE_ID, 40);
                b.write(name, 44, 'latin1');
                client.send(b);
                break;
            }
            case 10: { // ListOutputProperties
                const b = client.startReply(0, 0);
                b.writeUInt16LE(0, 8);
                client.send(b);
                break;
            }
            case 11: { // QueryOutputProperty
                const b = client.startReply(0, 0);
                client.send(b);
                break;
            }
            case 15: { // GetCrtcGammaSize
                const b = client.startReply(0, 0);
                b.writeUInt16LE(256, 8);
                client.send(b);
                break;
            }
            case 16: { // GetCrtcGamma
                const n = 256;
                const extra = (n * 3 * 2 + 3) >> 2;
                const b = client.startReply(extra, 0);
                b.writeUInt16LE(n, 8);
                client.send(b);
                break;
            }
            case 20: { // GetCrtcInfo
                const b = client.startReply(2, 0); // 1 output + 1 possible = 2 words
                b[1] = 0; // status Success
                b.writeUInt32LE(server.now(), 8);
                b.writeInt16LE(0, 12);
                b.writeInt16LE(0, 14);
                b.writeUInt16LE(server.width, 16);
                b.writeUInt16LE(server.height, 18);
                b.writeUInt32LE(MODE_ID, 20);
                b.writeUInt16LE(state.rotation, 24);
                b.writeUInt16LE(1, 26); // rotations
                b.writeUInt16LE(1, 28); // noutput
                b.writeUInt16LE(1, 30); // npossible
                b.writeUInt32LE(OUTPUT_ID, 32);
                b.writeUInt32LE(OUTPUT_ID, 36);
                client.send(b);
                break;
            }
            case 21: { // SetCrtcConfig
                const b = client.startReply(0, 0);
                b[1] = 0;
                b.writeUInt32LE(server.now(), 8);
                client.send(b);
                break;
            }
            case 22: { // GetCrtcTransform
                const b = client.startReply(0, 0);
                // identity 3x3 FIXED at 8
                for (let i = 0; i < 9; i++)
                    b.writeInt32LE(i % 4 === 0 ? 65536 : 0, 8 + i * 4);
                client.send(b);
                break;
            }
            case 23: // SetCrtcTransform
                break;
            case 24: { // GetPanning
                const b = client.startReply(0, 0);
                client.send(b);
                break;
            }
            case 26: { // GetOutputPrimary
                const b = client.startReply(0, 0);
                b.writeUInt32LE(OUTPUT_ID, 8);
                client.send(b);
                break;
            }
            case 27: // SetOutputPrimary
                break;
            case 28: { // GetProviders
                const b = client.startReply(0, 0);
                b.writeUInt32LE(server.now(), 8);
                b.writeUInt16LE(0, 12);
                client.send(b);
                break;
            }
            case 31: { // GetMonitors
                const name = 'HTML5-1';
                const namePad = (name.length + 3) & ~3;
                // nmonitors=1, noutputs=1, monitor info + name + outputs
                const monitorBytes = 24 + namePad + 4;
                const extra = (4 + monitorBytes) / 4;
                const b = client.startReply(extra, 0);
                b.writeUInt32LE(server.now(), 8);
                b.writeUInt32LE(1, 12); // nmonitors
                b.writeUInt32LE(1, 16); // noutputs
                // monitor: name atom(4), primary+auto(1)+noutputs(1)+pad(2), x,y,w,h, mmw,mmh
                let o = 20;
                b.writeUInt32LE(0, o); o += 4; // name atom None — use string after?
                // Actually GetMonitors monitorinfo: name(atom), primary, automatic, noutput, x,y,width,height,width_in_mm,height_in_mm, outputs[]
                // Some clients use name as atom. Put None and also list.
                b.writeUInt8(1, o); // primary
                b.writeUInt8(1, o + 1); // automatic
                b.writeUInt16LE(1, o + 2); // noutput
                o += 4;
                b.writeInt16LE(0, o); o += 2;
                b.writeInt16LE(0, o); o += 2;
                b.writeUInt16LE(server.width, o); o += 2;
                b.writeUInt16LE(server.height, o); o += 2;
                b.writeUInt32LE(Math.round(server.width * 25.4 / 96), o); o += 4;
                b.writeUInt32LE(Math.round(server.height * 25.4 / 96), o); o += 4;
                b.writeUInt32LE(OUTPUT_ID, o);
                client.send(b);
                break;
            }
            default:
                // Ignore unknown RANDR minors (no-op / empty success where needed).
                break;
        }
    }
};
