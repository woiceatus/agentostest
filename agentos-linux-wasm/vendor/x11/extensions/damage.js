'use strict';

// DAMAGE 1.1 — Create/Destroy/Subtract/Add + DamageNotify.

const { XError, codes } = require('x11/lib/xserver/errors.js');

function ensureDamage(server) {
    if (!server._damage)
        server._damage = {
            byId: new Map(),       // damage xid -> record
            byDrawable: new Map()  // drawable xid -> Set(damage xid)
        };
    return server._damage;
}

function sendDamageNotify(server, rec, area, geometry) {
    const ext = server.extensions.get('DAMAGE') || server.extensions.get('Damage');
    if (!ext || !rec.client || !rec.client.alive)
        return;
    const b = Buffer.alloc(32);
    b[0] = ext.firstEvent & 0x7f; // DamageNotify
    b[1] = rec.level & 0xff;
    b.writeUInt32LE(rec.drawable >>> 0, 4);
    b.writeUInt32LE(rec.id >>> 0, 8);
    b.writeUInt32LE(server.now() >>> 0, 12);
    b.writeInt16LE(area.x, 16);
    b.writeInt16LE(area.y, 18);
    b.writeUInt16LE(area.width, 20);
    b.writeUInt16LE(area.height, 22);
    b.writeInt16LE(geometry.x, 24);
    b.writeInt16LE(geometry.y, 26);
    b.writeUInt16LE(geometry.width, 28);
    b.writeUInt16LE(geometry.height, 30);
    rec.client.sendEvent(b);
}

module.exports = {
    name: 'DAMAGE',
    eventsCount: 1,
    errorsCount: 1, // BadDamage

    init(server) {
        const state = ensureDamage(server);
        if (server._damageHooked)
            return;
        server._damageHooked = true;
        const orig = server.damageWindow.bind(server);
        server.damageWindow = win => {
            orig(win);
            const set = state.byDrawable.get(win.id);
            if (!set)
                return;
            const area = { x: 0, y: 0, width: win.width, height: win.height };
            const geometry = {
                x: win.absX(),
                y: win.absY(),
                width: win.width,
                height: win.height
            };
            for (const id of set) {
                const rec = state.byId.get(id);
                if (rec)
                    sendDamageNotify(server, rec, area, geometry);
            }
        };
    },

    handleRequest(server, client, minor, body) {
        const state = ensureDamage(server);
        switch (minor) {
            case 0: { // QueryVersion
                const b = client.startReply(0, 0);
                b.writeUInt32LE(1, 8);
                b.writeUInt32LE(1, 12);
                client.send(b);
                break;
            }
            case 1: { // Create
                const id = body.readUInt32LE(0);
                const drawable = body.readUInt32LE(4);
                const level = body.readUInt8(8);
                server.getDrawable(drawable);
                server.checkIdFree(client, id);
                const rec = { id, drawable, level, client, pending: [] };
                state.byId.set(id, rec);
                server.resources.set(id, { type: 'damage', id, owner: client });
                let set = state.byDrawable.get(drawable);
                if (!set) {
                    set = new Set();
                    state.byDrawable.set(drawable, set);
                }
                set.add(id);
                break;
            }
            case 2: { // Destroy
                const id = body.readUInt32LE(0);
                const rec = state.byId.get(id);
                if (!rec)
                    throw new XError(codes.Value, id);
                state.byId.delete(id);
                server.resources.delete(id);
                const set = state.byDrawable.get(rec.drawable);
                if (set) {
                    set.delete(id);
                    if (set.size === 0)
                        state.byDrawable.delete(rec.drawable);
                }
                break;
            }
            case 3: // Subtract
            case 4: // Add
                // Regions accepted as no-op bookkeeping; events already streamed.
                server.resources.get(body.readUInt32LE(0));
                break;
            default:
                throw new XError(codes.Implementation, minor);
        }
    }
};
