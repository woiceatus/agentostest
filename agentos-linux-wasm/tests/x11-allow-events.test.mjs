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

async function connectClient(server) {
  const [clientSide, serverSide] = createSyncStreamPair();
  server.addClientStream(serverSide);
  const display = await new Promise((resolve, reject) => {
    x11.createClient({ display: ":0", stream: clientSide }, (error, d) => {
      if (error) reject(error);
      else resolve(d);
    });
  });
  return display;
}

test("Sync GrabButton + AllowEvents ReplayPointer delivers ButtonPress to child", async () => {
  const server = new XServer({ width: 320, height: 200 });
  const wmDisplay = await connectClient(server);
  const appDisplay = await connectClient(server);
  const WM = wmDisplay.client;
  const App = appDisplay.client;
  const root = wmDisplay.screen[0].root;

  // WM: Sync GrabButton on root Button1 (Aurora pattern)
  WM.GrabButton(root, false, x11.eventMask.ButtonPress, 0 /* Sync */, 1 /* Async */, 0, 0, 1, 0x8000);
  await new Promise((r) => setTimeout(r, 10));

  // App window covering the click point
  const wid = App.AllocID();
  await new Promise((resolve, reject) => {
    App.CreateWindow(
      wid,
      root,
      20,
      20,
      120,
      80,
      0,
      0,
      0,
      0,
      { backgroundPixel: 0x334455, eventMask: x11.eventMask.ButtonPress },
      (error) => (error ? reject(error) : resolve()),
    );
  });
  App.MapWindow(wid);
  await new Promise((r) => setTimeout(r, 20));

  let wmPress = 0;
  let appPress = 0;
  WM.on("event", (ev) => {
    if (ev.name === "ButtonPress") wmPress += 1;
  });
  App.on("event", (ev) => {
    if (ev.name === "ButtonPress") appPress += 1;
  });

  server.injectPointerMove(50, 50);
  server.injectButton(1, true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(wmPress, 1, "WM should see activating ButtonPress on root grab");
  assert.equal(appPress, 0, "app must not see press while Sync-frozen");

  // Aurora: AllowEvents(ReplayPointer=2)
  WM.AllowEvents(2, 0);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(appPress, 1, "ReplayPointer must deliver ButtonPress to child window");

  server.injectButton(1, false);
  WM.terminate();
  App.terminate();
});
