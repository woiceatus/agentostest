import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import test from "node:test";
import x11 from "x11";
import { XServer } from "x11/lib/xserver/index.js";

function createSyncStreamPair() {
  const make = () => {
    const stream = new EventEmitter();
    stream.destroyed = false;
    stream.peer = null;
    stream.write = (buf) => {
      const peer = stream.peer;
      if (stream.destroyed || !peer || peer.destroyed) return true;
      peer.emit("data", Buffer.from(buf));
      return true;
    };
    stream.end = () => {
      stream.destroyed = true;
      if (stream.peer && !stream.peer.destroyed) stream.peer.emit("end");
    };
    return stream;
  };
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

test("JS XServer completes LE setup over sync transport", () => {
  const server = new XServer({ width: 320, height: 200 });
  const [clientSide, serverSide] = createSyncStreamPair();
  const inbound = [];
  clientSide.on("data", (d) => inbound.push(Buffer.from(d)));
  server.addClientStream(serverSide);

  const setup = Buffer.alloc(12);
  setup[0] = 0x6c;
  setup.writeUInt16LE(11, 2);
  clientSide.write(setup);

  assert.ok(inbound.length >= 1);
  const reply = Buffer.concat(inbound);
  assert.equal(reply[0], 1, "setup success");
  assert.equal(reply.readUInt16LE(2), 11);
});

test("X client CreateWindow MapWindow PolyFillRectangle appears in compose()", async () => {
  const server = new XServer({ width: 320, height: 200 });
  const [clientSide, serverSide] = createSyncStreamPair();
  server.addClientStream(serverSide);

  const display = await new Promise((resolve, reject) => {
    x11.createClient({ display: ":0", stream: clientSide }, (error, d) => {
      if (error) reject(error);
      else resolve(d);
    });
  });

  const client = display.client;
  const root = display.screen[0].root;
  const wid = client.AllocID();
  const gc = client.AllocID();

  await new Promise((resolve, reject) => {
    client.CreateWindow(wid, root, 10, 10, 100, 60, 0, 0, 0, 0, {
      backgroundPixel: 0x224466,
      eventMask: x11.eventMask.Exposure,
    }, (error) => (error ? reject(error) : resolve()));
  });
  client.CreateGC(gc, wid, { foreground: 0xffcc00, background: 0x224466 });
  client.MapWindow(wid);
  await new Promise((r) => setTimeout(r, 20));

  client.PolyFillRectangle(wid, gc, [0, 0, 100, 60]);
  await new Promise((r) => setTimeout(r, 20));
  server.compose();

  const px = server.root.raster.data;
  // Sample a pixel inside the mapped window (abs 10+50, 10+30)
  const sample = px[(40) * 320 + (60)];
  assert.equal(sample & 0xffffff, 0xffcc00);
  client.terminate();
});
