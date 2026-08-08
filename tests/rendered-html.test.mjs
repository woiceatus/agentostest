import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import x11 from "x11";
import { XServer, createStreamPair } from "x11/lib/xserver/index.js";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;

test("renders development preview metadata", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  assert.match(await response.text(), developmentPreviewMeta);
});

test("uses a loaded terminal font with stable xterm cell metrics", async () => {
  const terminalSource = await readFile(
    new URL("../app/BrowserTerminal.tsx", import.meta.url),
    "utf8",
  );
  const layoutSource = await readFile(
    new URL("../app/layout.tsx", import.meta.url),
    "utf8",
  );

  assert.match(layoutSource, /@fontsource-variable\/jetbrains-mono\/wght\.css/);
  assert.match(terminalSource, /JetBrains Mono Variable/);
  assert.match(terminalSource, /document\.fonts\s*\.load/);
  assert.match(terminalSource, /rescaleOverlappingGlyphs:\s*true/);
  assert.match(terminalSource, /letterSpacing:\s*0/);
  assert.doesNotMatch(terminalSource, /fontFamily:\s*["']var\(--font-geist-mono\)/);
});

test("runs the compiled htop ncurses binary until the PTY sends q", async () => {
  const moduleUrl = new URL("../public/wasm/htop/htop.mjs", import.meta.url);
  moduleUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: createHtop } = await import(moduleUrl.href);
  const input = [];
  const output = [];
  let exitCode = null;

  const runtime = await createHtop({
    noInitialRun: true,
    preRun: [(instance) => instance.FS.init(
      () => input.shift() ?? null,
      (byte) => output.push(byte),
      (byte) => output.push(byte),
    )],
    onExit: (code) => {
      exitCode = code;
    },
  });

  runtime.TTY.default_tty_ops.ioctl_tiocgwinsz = () => [30, 100];
  runtime._agentos_set_terminal_size(100, 30);
  runtime.FS.mkdirTree("/home/root/.config/htop");
  runtime.callMain([]);
  await delay(200);
  assert.equal(exitCode, null, "htop should still own the foreground terminal");
  input.push("q".charCodeAt(0));

  for (let attempt = 0; attempt < 40 && exitCode === null; attempt += 1) await delay(25);

  const screen = new TextDecoder().decode(new Uint8Array(output));
  assert.equal(exitCode, 0);
  assert.match(screen, /\x1b\[\?1049h/);
  assert.match(screen, /Tasks:/);
  assert.match(screen, /htop/);
});

test("routes foreground curl through the Worker WebSocket network proxy", async () => {
  const workerSource = await readFile(
    new URL("../worker/index.ts", import.meta.url),
    "utf8",
  );
  const terminalSource = await readFile(
    new URL("../app/BrowserTerminal.tsx", import.meta.url),
    "utf8",
  );
  const networkWorkerSource = await readFile(
    new URL("../app/workers/network.worker.ts", import.meta.url),
    "utf8",
  );
  const pageSource = await readFile(
    new URL("../app/page.tsx", import.meta.url),
    "utf8",
  );

  assert.match(workerSource, /NETWORK_SOCKET_PATH = ["']\/__agentos\/ws["']/);
  assert.match(workerSource, /\/__agentos\/proxy/);
  assert.match(workerSource, /new URL\(location, target\)/);
  assert.match(workerSource, /MAX_PROXY_RESPONSE_BYTES/);
  assert.match(workerSource, /private and local network targets are blocked/);
  assert.match(networkWorkerSource, /wss:/);
  assert.match(networkWorkerSource, /startHttpFallback/);
  assert.match(networkWorkerSource, /__agentos\/proxy/);
  assert.match(networkWorkerSource, /type: "chunk"/);
  assert.match(terminalSource, /startCurl/);
  assert.match(terminalSource, /worker WebSocket proxy/);
  assert.match(pageSource, /terminal\.startCurl\(tokens\.slice\(1\)\)/);
  assert.doesNotMatch(pageSource, /network access denied by browser VM policy/);
});

test("runs a real X11 MapRequest through the browser WM client", async () => {
  const server = new XServer({ width: 320, height: 180 });
  const connect = () => {
    const [clientSide, serverSide] = createStreamPair();
    server.addClientStream(serverSide);
    return new Promise((resolve, reject) => {
      x11.createClient(
        { display: ":0", stream: clientSide },
        (error, display) => error ? reject(error) : resolve(display),
      );
    });
  };
  const request = (client, method, ...args) => new Promise((resolve, reject) => {
    client[method](...args, (error, value) => error ? reject(error) : resolve(value));
  });

  const wmDisplay = await connect();
  const wm = wmDisplay.client;
  const root = wmDisplay.screen[0].root;
  const mapRequests = [];
  wm.on("event", (event) => {
    if (event.name === "MapRequest") mapRequests.push(event);
  });
  await request(wm, "ChangeWindowAttributes", root, {
    eventMask: x11.eventMask.SubstructureRedirect | x11.eventMask.SubstructureNotify,
  });

  const appDisplay = await connect();
  const app = appDisplay.client;
  const windowId = app.AllocID();
  await request(app, "CreateWindow", windowId, root, 0, 0, 140, 80, 0, 0, 0, 0, {
    backgroundPixel: 0x172f35,
  });
  app.MapWindow(windowId);
  await delay(20);
  assert.equal(mapRequests.length, 1);
  assert.equal(mapRequests[0].wid, windowId);
  assert.equal(server.resources.get(windowId).mapped, false);

  wm.MapWindow(windowId);
  await delay(20);
  assert.equal(server.resources.get(windowId).mapped, true);
  wm.terminate();
  app.terminate();
});

test("loads the Aurora layout target used by the X11 WM", async () => {
  const auroraBytes = await readFile(new URL("../public/wasm/aurora-wm-web.wasm", import.meta.url));
  const aurora = (await WebAssembly.instantiate(auroraBytes, {})).instance;
  const auroraExports = aurora.exports;

  assert.equal(typeof auroraExports.aurora_init, "function");
  assert.equal(typeof auroraExports.aurora_pointer_down, "function");
  assert.equal(typeof auroraExports.aurora_window_count, "function");

  auroraExports.aurora_init(960, 540);
  assert.equal(auroraExports.aurora_window_count(), 3);

  const desktopSource = await readFile(new URL("../app/WebDesktop.tsx", import.meta.url), "utf8");
  assert.match(desktopSource, /x11\/lib\/xserver\/index\.js/);
  assert.match(desktopSource, /SubstructureRedirect/);
  assert.match(desktopSource, /MapRequest/);
  assert.match(desktopSource, /server\.compose\(\)/);
  assert.match(desktopSource, /aurora-wm-web\.wasm/);
  assert.match(desktopSource, /browserNavigator\.gpu/);
});

test("keeps the WM alive when WebGPU is unavailable", async () => {
  const desktopSource = await readFile(
    new URL("../app/WebDesktop.tsx", import.meta.url),
    "utf8",
  );
  const pageSource = await readFile(
    new URL("../app/page.tsx", import.meta.url),
    "utf8",
  );

  assert.match(desktopSource, /usage:\s*2\s*\|\s*4/);
  assert.doesNotMatch(desktopSource, /usage:\s*4\s*\|\s*8/);
  assert.match(desktopSource, /wasm\/xserver-web\.wasm/);
  assert.match(desktopSource, /wasm-canvas2d/);
  assert.match(desktopSource, /device\.pushErrorScope/);
  assert.match(desktopSource, /device\.lost/);
  assert.match(pageSource, /useState\(1\)/);
  assert.match(pageSource, /<WebDesktop startSignal=\{desktopStartSignal\}/);
});
