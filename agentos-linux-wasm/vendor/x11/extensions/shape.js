'use strict';

// SHAPE 1.1 — bounding/clip/input regions tracked per window.

const { XError, codes } = require('../errors');

function ensureShape(win) {
    if (!win.shape) {
        win.shape = {
            bounding: null, // null = unshaped default rectangle
            clip: null,
            input: null,
            selectInput: false,
            selectClient: null
        };
    }
    return win.shape;
}

function kindKey(kind) {
    return kind === 1 ? 'clip' : kind === 2 ? 'input' : 'bounding';
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

function applyOp(op, dest, src) {
    if (op === 0) // Set
        return src.slice();
    if (!dest)
        dest = [];
    if (op === 1) // Union
        return dest.concat(src);
    if (op === 3) // Subtract — keep dest (approx)
        return dest.slice();
    if (op === 2) // Intersect — keep dest if any
        return dest.length ? dest.slice() : src.slice();
    if (op === 4) // Invert
        return src.slice();
    return src.slice();
}

function notifyShape(server, win, kind) {
    const sh = win.shape;
    if (!sh || !sh.selectInput || !sh.selectClient || !sh.selectClient.alive)
        return;
    const ext = server.extensions.get('SHAPE');
    if (!ext)
        return;
    const b = Buffer.alloc(32);
    b[0] = ext.firstEvent & 0x7f;
    b[1] = kind & 0xff;
    b.writeUInt32LE(win.id >>> 0, 4);
    b.writeUInt32LE(server.now() >>> 0, 8);
    const rects = sh[kindKey(kind)] || [{ x: 0, y: 0, width: win.width, height: win.height }];
    const r = rects[0] || { x: 0, y: 0, width: win.width, height: win.height };
    b.writeInt16LE(r.x, 12);
    b.writeInt16LE(r.y, 14);
    b.writeUInt16LE(r.width, 16);
    b.writeUInt16LE(r.height, 18);
    b.writeUInt16LE(1, 20); // shaped
    b.writeUInt16LE(1, 22); // ordered
    sh.selectClient.sendEvent(b);
}

module.exports = {
    name: 'SHAPE',
    eventsCount: 1,
    errorsCount: 0,

    handleRequest(server, client, minor, body) {
        switch (minor) {
            case 0: { // QueryVersion
                const b = client.startReply(0, 0);
                b.writeUInt16LE(1, 8);
                b.writeUInt16LE(1, 10);
                client.send(b);
                break;
            }
            case 1: { // Rectangles
                const op = body.readUInt8(0);
                const kind = body.readUInt8(1);
                const win = server.getWindow(body.readUInt32LE(4));
                const xoff = body.readInt16LE(8);
                const yoff = body.readInt16LE(10);
                const rects = readRects(body, 12).map(r => ({
                    x: r.x + xoff,
                    y: r.y + yoff,
                    width: r.width,
                    height: r.height
                }));
                const sh = ensureShape(win);
                const key = kindKey(kind);
                sh[key] = applyOp(op, sh[key], rects);
                notifyShape(server, win, kind);
                server.damageWindow(win);
                break;
            }
            case 2: { // Mask
                const kind = body.readUInt8(1);
                const win = server.getWindow(body.readUInt32LE(4));
                const sh = ensureShape(win);
                const bitmap = body.readUInt32LE(12);
                if (bitmap === 0)
                    sh[kindKey(kind)] = null;
                else
                    sh[kindKey(kind)] = [{ x: 0, y: 0, width: win.width, height: win.height }];
                notifyShape(server, win, kind);
                break;
            }
            case 3: { // Combine
                const op = body.readUInt8(0);
                const destKind = body.readUInt8(1);
                const srcKind = body.readUInt8(2);
                const dest = server.getWindow(body.readUInt32LE(4));
                const src = server.getWindow(body.readUInt32LE(12));
                const dsh = ensureShape(dest);
                const ssh = ensureShape(src);
                const srcRects = ssh[kindKey(srcKind)] ||
                    [{ x: 0, y: 0, width: src.width, height: src.height }];
                const key = kindKey(destKind);
                dsh[key] = applyOp(op, dsh[key], srcRects);
                notifyShape(server, dest, destKind);
                break;
            }
            case 4: { // Offset
                const kind = body.readUInt8(0);
                const win = server.getWindow(body.readUInt32LE(4));
                const dx = body.readInt16LE(8);
                const dy = body.readInt16LE(10);
                const sh = ensureShape(win);
                const key = kindKey(kind);
                if (sh[key])
                    sh[key] = sh[key].map(r => ({ ...r, x: r.x + dx, y: r.y + dy }));
                notifyShape(server, win, kind);
                break;
            }
            case 5: { // QueryExtents
                const win = server.getWindow(body.readUInt32LE(0));
                const sh = ensureShape(win);
                const bounding = sh.bounding ||
                    [{ x: 0, y: 0, width: win.width, height: win.height }];
                const clip = sh.clip ||
                    [{ x: 0, y: 0, width: win.width, height: win.height }];
                const be = bounding[0];
                const ce = clip[0];
                const b = client.startReply(0, 0);
                b.writeUInt8(sh.bounding ? 1 : 0, 8);
                b.writeUInt8(sh.clip ? 1 : 0, 9);
                b.writeInt16LE(be.x, 12);
                b.writeInt16LE(be.y, 14);
                b.writeUInt16LE(be.width, 16);
                b.writeUInt16LE(be.height, 18);
                b.writeInt16LE(ce.x, 20);
                b.writeInt16LE(ce.y, 22);
                b.writeUInt16LE(ce.width, 24);
                b.writeUInt16LE(ce.height, 26);
                client.send(b);
                break;
            }
            case 6: { // SelectInput
                const win = server.getWindow(body.readUInt32LE(0));
                const enable = body.readUInt8(4);
                const sh = ensureShape(win);
                sh.selectInput = !!enable;
                sh.selectClient = enable ? client : null;
                break;
            }
            case 7: { // InputSelected
                const win = server.getWindow(body.readUInt32LE(0));
                const sh = ensureShape(win);
                const b = client.startReply(0, sh.selectInput ? 1 : 0);
                client.send(b);
                break;
            }
            case 8: { // GetRectangles
                const win = server.getWindow(body.readUInt32LE(0));
                const kind = body.readUInt8(4);
                const sh = ensureShape(win);
                const rects = sh[kindKey(kind)] ||
                    [{ x: 0, y: 0, width: win.width, height: win.height }];
                const extra = rects.length * 2;
                const b = client.startReply(extra, 0); // ordering Unsorted in detail? detail=ordering
                b[1] = 0; // Unsorted
                b.writeUInt32LE(rects.length, 8);
                let o = 32;
                for (const r of rects) {
                    b.writeInt16LE(r.x, o);
                    b.writeInt16LE(r.y, o + 2);
                    b.writeUInt16LE(r.width, o + 4);
                    b.writeUInt16LE(r.height, o + 6);
                    o += 8;
                }
                client.send(b);
                break;
            }
            default:
                throw new XError(codes.Implementation, minor);
        }
    }
};
