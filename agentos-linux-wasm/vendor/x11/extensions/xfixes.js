'use strict';

// XFIXES 5.0 — regions, selection/cursor listeners, common compositor ops.

const { XError, codes } = require('x11/lib/xserver/errors.js');

function ensureXfixes(server) {
    if (!server._xfixes) {
        server._xfixes = {
            selectionListeners: new Map(), // selection atom -> [{wid,client,mask}]
            cursorListeners: new Map()     // window -> [{client,mask}]
        };
    }
    return server._xfixes;
}

function getRegion(server, id) {
    if (id === 0)
        return null;
    const res = server.resources.get(id);
    if (!res || res.type !== 'region')
        throw new XError(codes.Value, id);
    return res;
}

function readRects(body, offset) {
    const rects = [];
    for (let off = offset; off + 8 <= body.length; off += 8) {
        rects.push({
            x: body.readInt16LE(off),
            y: body.readInt16LE(off + 2),
            width: body.readUInt16LE(off + 4),
            height: body.readUInt16LE(off + 6)
        });
    }
    return rects;
}

function extentsOf(rects) {
    if (!rects.length)
        return { x: 0, y: 0, width: 0, height: 0 };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of rects) {
        x0 = Math.min(x0, r.x);
        y0 = Math.min(y0, r.y);
        x1 = Math.max(x1, r.x + r.width);
        y1 = Math.max(y1, r.y + r.height);
    }
    return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

function cloneRects(rects) {
    return rects.map(r => ({ x: r.x, y: r.y, width: r.width, height: r.height }));
}

function sendSelectionNotify(server, selection, subtype, window, owner) {
    const state = ensureXfixes(server);
    const list = state.selectionListeners.get(selection) || [];
    const ext = server.extensions.get('XFIXES');
    if (!ext)
        return;
    for (const L of list) {
        if (!L.client.alive)
            continue;
        if (subtype === 0 && !(L.mask & 1))
            continue;
        if (subtype === 1 && !(L.mask & 2))
            continue;
        if (subtype === 2 && !(L.mask & 4))
            continue;
        const b = Buffer.alloc(32);
        b[0] = ext.firstEvent & 0x7f;
        b[1] = subtype & 0xff;
        b.writeUInt32LE(window >>> 0, 4);
        b.writeUInt32LE(server.now() >>> 0, 8);
        b.writeUInt32LE(selection >>> 0, 12);
        b.writeUInt32LE((owner || 0) >>> 0, 16);
        L.client.sendEvent(b);
    }
}

module.exports = {
    name: 'XFIXES',
    eventsCount: 2, // SelectionNotify, CursorNotify
    errorsCount: 1, // BadRegion

    init(server) {
        ensureXfixes(server);
        if (server._xfixesSelectionHooked)
            return;
        server._xfixesSelectionHooked = true;
        const prev = server.handlers[22];
        if (!prev)
            return;
        server.handlers[22] = (client, detail, body) => {
            const ownerWid = body.readUInt32LE(0);
            const selection = body.readUInt32LE(4);
            prev(client, detail, body);
            sendSelectionNotify(server, selection, 0, ownerWid, ownerWid);
        };
    },

    handleRequest(server, client, minor, body) {
        const state = ensureXfixes(server);
        switch (minor) {
            case 0: { // QueryVersion
                const b = client.startReply(0, 0);
                b.writeUInt32LE(5, 8);
                b.writeUInt32LE(0, 12);
                client.send(b);
                break;
            }
            case 1: // ChangeSaveSet
                server.getWindow(body.readUInt32LE(4));
                break;
            case 2: { // SelectSelectionInput
                const wid = body.readUInt32LE(0);
                const selection = body.readUInt32LE(4);
                const mask = body.readUInt32LE(8);
                server.getWindow(wid);
                server.checkAtom(selection);
                let list = state.selectionListeners.get(selection);
                if (!list) {
                    list = [];
                    state.selectionListeners.set(selection, list);
                }
                const filtered = list.filter(L => !(L.client === client && L.wid === wid));
                if (mask)
                    filtered.push({ wid, client, mask });
                state.selectionListeners.set(selection, filtered);
                break;
            }
            case 3: { // SelectCursorInput
                const wid = body.readUInt32LE(0);
                const mask = body.readUInt32LE(4);
                server.getWindow(wid);
                let list = state.cursorListeners.get(wid) || [];
                list = list.filter(L => L.client !== client);
                if (mask)
                    list.push({ client, mask });
                state.cursorListeners.set(wid, list);
                break;
            }
            case 4: { // GetCursorImage — 1x1 empty cursor
                const extra = 1; // one ARGB pixel = 1 word after the 24-byte fixed
                const b = client.startReply(extra, 0);
                b.writeInt16LE(server.pointer.x, 8);
                b.writeInt16LE(server.pointer.y, 10);
                b.writeUInt16LE(1, 12);
                b.writeUInt16LE(1, 14);
                b.writeUInt16LE(0, 16);
                b.writeUInt16LE(0, 18);
                b.writeUInt32LE(1, 20);
                b.writeUInt32LE(0, 32);
                client.send(b);
                break;
            }
            case 5: { // CreateRegion
                const id = body.readUInt32LE(0);
                server.checkIdFree(client, id);
                server.resources.set(id, {
                    type: 'region', id, owner: client, rects: readRects(body, 4)
                });
                break;
            }
            case 6: // CreateRegionFromBitmap
            case 8: // CreateRegionFromGC
            case 9: { // CreateRegionFromPicture
                const id = body.readUInt32LE(0);
                server.checkIdFree(client, id);
                server.resources.set(id, { type: 'region', id, owner: client, rects: [] });
                break;
            }
            case 7: { // CreateRegionFromWindow
                const id = body.readUInt32LE(0);
                const win = server.getWindow(body.readUInt32LE(4));
                server.checkIdFree(client, id);
                server.resources.set(id, {
                    type: 'region',
                    id,
                    owner: client,
                    rects: [{ x: 0, y: 0, width: win.width, height: win.height }]
                });
                break;
            }
            case 10: { // DestroyRegion
                const id = body.readUInt32LE(0);
                getRegion(server, id);
                server.resources.delete(id);
                break;
            }
            case 11: { // SetRegion
                const region = getRegion(server, body.readUInt32LE(0));
                region.rects = readRects(body, 4);
                break;
            }
            case 12: { // CopyRegion
                const src = getRegion(server, body.readUInt32LE(0));
                const dst = getRegion(server, body.readUInt32LE(4));
                dst.rects = cloneRects(src.rects);
                break;
            }
            case 13: // UnionRegion
            case 14: // IntersectRegion
            case 15: { // SubtractRegion
                const src1 = getRegion(server, body.readUInt32LE(0));
                const src2 = getRegion(server, body.readUInt32LE(4));
                const dst = getRegion(server, body.readUInt32LE(8));
                if (minor === 13)
                    dst.rects = cloneRects(src1.rects).concat(cloneRects(src2.rects));
                else if (minor === 14)
                    dst.rects = cloneRects(src1.rects.length ? src1.rects : src2.rects);
                else
                    dst.rects = cloneRects(src1.rects);
                break;
            }
            case 16: { // InvertRegion
                const src = getRegion(server, body.readUInt32LE(0));
                const bounds = {
                    x: body.readInt16LE(4),
                    y: body.readInt16LE(6),
                    width: body.readUInt16LE(8),
                    height: body.readUInt16LE(10)
                };
                const dst = getRegion(server, body.readUInt32LE(12));
                dst.rects = src.rects.length ? [] : [bounds];
                break;
            }
            case 17: { // TranslateRegion
                const region = getRegion(server, body.readUInt32LE(0));
                const dx = body.readInt16LE(4);
                const dy = body.readInt16LE(6);
                region.rects = region.rects.map(r => ({
                    x: r.x + dx, y: r.y + dy, width: r.width, height: r.height
                }));
                break;
            }
            case 18: { // RegionExtents
                const src = getRegion(server, body.readUInt32LE(0));
                const dst = getRegion(server, body.readUInt32LE(4));
                dst.rects = [extentsOf(src.rects)];
                break;
            }
            case 19: { // FetchRegion
                const region = getRegion(server, body.readUInt32LE(0));
                const ext = extentsOf(region.rects);
                const extra = region.rects.length * 2;
                const b = client.startReply(extra, 0);
                b.writeInt16LE(ext.x, 8);
                b.writeInt16LE(ext.y, 10);
                b.writeUInt16LE(ext.width, 12);
                b.writeUInt16LE(ext.height, 14);
                let o = 32;
                for (const r of region.rects) {
                    b.writeInt16LE(r.x, o);
                    b.writeInt16LE(r.y, o + 2);
                    b.writeUInt16LE(r.width, o + 4);
                    b.writeUInt16LE(r.height, o + 6);
                    o += 8;
                }
                client.send(b);
                break;
            }
            case 20: // SetGCClipRegion
            case 21: // SetWindowShapeRegion
            case 22: // SetPictureClipRegion
            case 23: // SetCursorName
            case 26: // HideCursor
            case 27: // ShowCursor
            case 28: // CreatePointerBarrier
            case 29: // DeletePointerBarrier
            case 31: // GetCursorImageAndName uses reply - skip
            case 32: // ExpandRegion
                break;
            case 24: { // GetCursorName
                const b = client.startReply(0, 0);
                b.writeUInt32LE(0, 8);
                b.writeUInt16LE(0, 12);
                client.send(b);
                break;
            }
            case 25: { // GetCursorImageAndName
                const b = client.startReply(1, 0);
                b.writeInt16LE(server.pointer.x, 8);
                b.writeInt16LE(server.pointer.y, 10);
                b.writeUInt16LE(1, 12);
                b.writeUInt16LE(1, 14);
                b.writeUInt16LE(0, 16);
                b.writeUInt16LE(0, 18);
                b.writeUInt32LE(1, 20);
                b.writeUInt32LE(0, 24); // atom
                b.writeUInt16LE(0, 28); // nbytes
                b.writeUInt32LE(0, 32);
                client.send(b);
                break;
            }
            case 30: { // Barrier query / no-op list
                break;
            }
            default:
                // Accept unknown XFIXES minors without desync.
                break;
        }
    }
};
