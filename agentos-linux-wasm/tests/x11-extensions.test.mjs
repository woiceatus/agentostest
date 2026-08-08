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

async function connect(server) {
  const [clientSide, serverSide] = createSyncStreamPair();
  server.addClientStream(serverSide);
  return new Promise((resolve, reject) => {
    x11.createClient({ display: ":0", stream: clientSide }, (error, d) => {
      if (error) reject(error);
      else resolve(d);
    });
  });
}

function queryExtension(client, name) {
  return new Promise((resolve, reject) => {
    client.QueryExtension(name, (err, ext) => (err ? reject(err) : resolve(ext)));
  });
}

test("XServer advertises Composite XFIXES SHAPE DAMAGE RANDR GLX", async () => {
  const server = new XServer({ width: 640, height: 480 });
  const display = await connect(server);
  const names = ["Composite", "XFIXES", "SHAPE", "DAMAGE", "RANDR", "GLX", "RENDER"];
  for (const name of names) {
    const ext = await queryExtension(display.client, name);
    assert.ok(ext.present, `${name} present`);
    assert.ok(ext.majorOpcode >= 128, `${name} opcode`);
  }
});

test("COMPOSITE QueryVersion + RedirectSubwindows succeeds", async () => {
  const server = new XServer({ width: 640, height: 480 });
  const display = await connect(server);
  const Composite = await new Promise((resolve, reject) => {
    display.client.require("composite", (err, ext) => (err ? reject(err) : resolve(ext)));
  });
  assert.equal(Composite.major, 0);
  assert.equal(Composite.minor, 4);
  Composite.RedirectSubwindows(display.screen[0].root, Composite.Redirect.Automatic);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(server.root.compositeRedirectSubwindows, "Automatic");
});

test("RANDR GetScreenResources returns HTML5 mode", async () => {
  const server = new XServer({ width: 960, height: 540 });
  const display = await connect(server);
  const Randr = await new Promise((resolve, reject) => {
    display.client.require("randr", (err, ext) => (err ? reject(err) : resolve(ext)));
  });
  const resources = await new Promise((resolve, reject) => {
    Randr.GetScreenResources(display.screen[0].root, (err, res) =>
      err ? reject(err) : resolve(res),
    );
  });
  assert.equal(resources.crtcs.length, 1);
  assert.equal(resources.outputs.length, 1);
  assert.equal(resources.modeinfos.length, 1);
  assert.equal(resources.modeinfos[0].width, 960);
  assert.equal(resources.modeinfos[0].height, 540);
});

test("GLX QueryVersion is 1.4 and CreateContext works", async () => {
  const server = new XServer({ width: 320, height: 200 });
  const display = await connect(server);
  const GLX = await new Promise((resolve, reject) => {
    display.client.require("glx", (err, ext) => (err ? reject(err) : resolve(ext)));
  });
  const version = await new Promise((resolve, reject) => {
    GLX.QueryVersion(1, 4, (err, v) => (err ? reject(err) : resolve(v)));
  });
  assert.deepEqual(version, [1, 4]);
  const ctx = display.client.AllocID();
  GLX.CreateContext(ctx, display.screen[0].root_visual, 0, 0, 0);
  await new Promise((r) => setTimeout(r, 10));
  const isDirect = await new Promise((resolve, reject) => {
    GLX.IsDirect(ctx, (err, d) => (err ? reject(err) : resolve(d)));
  });
  assert.equal(isDirect, false);
});
