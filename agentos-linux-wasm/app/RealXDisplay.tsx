"use client";

import "./buffer-polyfill";
import { useEffect, useRef, useState } from "react";
import { XServer } from "x11/lib/xserver/index.js";
import { createAuroraShellSession, type AuroraShellSession } from "./auroraShell";
import { createX11ByteTransport, type X11ByteTransport } from "./x11Transport";

const DISPLAY_WIDTH = 960;
const DISPLAY_HEIGHT = 540;

type X11Server = {
  width: number;
  height: number;
  root: { raster?: { data?: Uint32Array }; backgroundPixel?: number };
  extensions?: Map<string, unknown>;
  keymap: { keycodeForKeysym: (keysym: number) => number };
  on: (event: string, listener: (value: unknown) => void) => void;
  addClientStream: (stream: unknown) => void;
  compose: () => unknown;
  injectPointerMove: (x: number, y: number) => void;
  injectButton: (button: number, isPress: boolean) => void;
  injectKey: (keycode: number, isPress: boolean) => void;
};

type AuroraShellHost = {
  spawn: (cwd: string, cols: number, rows: number) => number;
  write: (id: number, bytes: Uint8Array) => number;
  read: (id: number, dest: Uint8Array) => number;
  poll: (id: number) => number;
  resize: (id: number, cols: number, rows: number) => void;
  close: (id: number) => void;
};

type EmscriptenModule = {
  x11Transport?: X11ByteTransport;
  auroraShell?: AuroraShellHost;
  HEAPU8?: Uint8Array;
  callMain?: (args?: string[]) => number | Promise<number>;
  _aurora_wm_start?: () => number;
  _aurora_wm_pump?: () => number;
  _aurora_wm_is_running?: () => number;
  _aurora_wm_stop?: () => void;
  _xdemo_start?: () => number;
  _xdemo_pump?: () => number;
  _xdemo_is_running?: () => number;
  _xclock_start?: () => number;
  _xclock_pump?: (now: number) => number;
  _xclock_is_running?: () => number;
  _firefox_x11_start?: () => number;
  _firefox_x11_pump?: () => number;
  _firefox_x11_is_running?: () => number;
};

function createAuroraShellHost(): AuroraShellHost {
  const sessions = new Map<number, AuroraShellSession>();
  let nextId = 1;
  return {
    spawn(cwd, cols, rows) {
      const id = nextId;
      nextId += 1;
      sessions.set(id, createAuroraShellSession({ cwd, cols, rows }));
      return id;
    },
    write(id, bytes) {
      const s = sessions.get(id);
      if (!s) return -1;
      s.write(bytes);
      return bytes.byteLength;
    },
    read(id, dest) {
      return sessions.get(id)?.read(dest) ?? 0;
    },
    poll(id) {
      return sessions.get(id)?.poll() ?? 0;
    },
    resize(id, cols, rows) {
      sessions.get(id)?.resize(cols, rows);
    },
    close(id) {
      sessions.get(id)?.close();
      sessions.delete(id);
    },
  };
}

type ModuleFactory = (options: Record<string, unknown>) => Promise<EmscriptenModule>;

type RealXDisplayProps = {
  startSignal: number;
  onRunning: (running: boolean) => void;
};

function presentRoot(server: X11Server, image: ImageData, ctx: CanvasRenderingContext2D): void {
  server.compose();
  const src = server.root?.raster?.data;
  if (!src) return;
  const out = image.data;
  const n = Math.min(src.length, out.length / 4);
  for (let i = 0; i < n; i += 1) {
    const px = src[i]!;
    const o = i * 4;
    out[o] = (px >> 16) & 0xff;
    out[o + 1] = (px >> 8) & 0xff;
    out[o + 2] = px & 0xff;
    out[o + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

function keysymFromDomKey(event: KeyboardEvent): number | null {
  if (event.key.length === 1) {
    const code = event.key.charCodeAt(0);
    return code;
  }
  switch (event.key) {
    case "Enter":
      return 0xff0d;
    case "Backspace":
      return 0xff08;
    case "Tab":
      return 0xff09;
    case "Escape":
      return 0xff1b;
    case "ArrowLeft":
      return 0xff51;
    case "ArrowUp":
      return 0xff52;
    case "ArrowRight":
      return 0xff53;
    case "ArrowDown":
      return 0xff54;
    case "Delete":
      return 0xffff;
    case "Home":
      return 0xff50;
    case "End":
      return 0xff57;
    case "PageUp":
      return 0xff55;
    case "PageDown":
      return 0xff56;
    case " ":
      return 0x20;
    default:
      return null;
  }
}

async function loadXApp(
  jsUrl: string,
  wasmUrl: string,
  transport: X11ByteTransport,
  extras?: Record<string, unknown>,
): Promise<EmscriptenModule> {
  const imported = (await import(/* @vite-ignore */ jsUrl)) as { default: ModuleFactory };
  const base = jsUrl.replace(/[^/]+$/, "");
  const mod = await imported.default({
    locateFile: (path: string) => {
      if (path.endsWith(".wasm")) return wasmUrl;
      // Preloaded NetSurf resources (.data) live next to the JS module.
      if (path.endsWith(".data")) return new URL(path, base).href;
      return path;
    },
    print: (text: string) => console.log(`[x11-app] ${text}`),
    printErr: (text: string) => console.error(`[x11-app] ${text}`),
    ...(extras || {}),
  });
  mod.x11Transport = transport;
  return mod;
}

export function RealXDisplay({ startSignal, onRunning }: RealXDisplayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("idle · press startx");
  const [log, setLog] = useState<string[]>([]);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (startSignal === 0) return;
    let cancelled = false;
    let raf = 0;
    const transports: X11ByteTransport[] = [];
    let server: X11Server | null = null;
    let auroraPump: (() => void) | null = null;
    const pushLog = (line: string) => setLog((prev) => [...prev.slice(-8), line]);

    const shell = shellRef.current;
    const canvas = canvasRef.current;
    if (!shell || !canvas) return;

    const map = (event: PointerEvent) => {
      const bounds = shell.getBoundingClientRect();
      const x = Math.max(0, Math.min(DISPLAY_WIDTH - 1, Math.round(((event.clientX - bounds.left) * DISPLAY_WIDTH) / bounds.width)));
      const y = Math.max(0, Math.min(DISPLAY_HEIGHT - 1, Math.round(((event.clientY - bounds.top) * DISPLAY_HEIGHT) / bounds.height)));
      return { x, y };
    };

    /** Deliver DOM input to X, then immediately pump Aurora so Sync grab → AllowEvents → Replay runs before the next move. */
    const afterInject = () => {
      auroraPump?.();
    };

    const onDown = (event: PointerEvent) => {
      if (!server) return;
      const p = map(event);
      event.preventDefault();
      shell.focus({ preventScroll: true });
      try {
        shell.setPointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
      setPointer(p);
      server.injectPointerMove(p.x, p.y);
      server.injectButton(event.button + 1, true);
      afterInject();
    };
    const onMove = (event: PointerEvent) => {
      if (!server) return;
      const p = map(event);
      setPointer(p);
      server.injectPointerMove(p.x, p.y);
      afterInject();
    };
    const onUp = (event: PointerEvent) => {
      if (!server) return;
      const p = map(event);
      setPointer(p);
      server.injectPointerMove(p.x, p.y);
      server.injectButton(event.button + 1, false);
      afterInject();
      try {
        shell.releasePointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
    };
    const onCancel = (event: PointerEvent) => {
      if (!server) return;
      const p = map(event);
      setPointer(p);
      server.injectPointerMove(p.x, p.y);
      server.injectButton(event.button + 1, false);
      afterInject();
    };
    const onKey = (event: KeyboardEvent, press: boolean) => {
      if (!server) return;
      // Keep focus on the display shell so keydown keeps firing after clicks
      // inside the canvas (which uses pointer-events: none on the canvas itself).
      if (press && document.activeElement !== shell) {
        shell.focus({ preventScroll: true });
      }
      const keysym = keysymFromDomKey(event);
      if (keysym == null) return;
      event.preventDefault();
      const keycode = server.keymap.keycodeForKeysym(keysym);
      if (keycode) {
        server.injectKey(keycode, press);
        afterInject();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => onKey(e, true);
    const onKeyUp = (e: KeyboardEvent) => onKey(e, false);
    const onContext = (e: Event) => e.preventDefault();

    shell.addEventListener("pointerdown", onDown);
    shell.addEventListener("pointermove", onMove);
    shell.addEventListener("pointerup", onUp);
    shell.addEventListener("pointercancel", onCancel);
    shell.addEventListener("keydown", onKeyDown);
    shell.addEventListener("keyup", onKeyUp);
    shell.addEventListener("contextmenu", onContext);

    const start = async () => {
      canvas.width = DISPLAY_WIDTH;
      canvas.height = DISPLAY_HEIGHT;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("2d context missing");
      const image = ctx.createImageData(DISPLAY_WIDTH, DISPLAY_HEIGHT);

      setStatus("booting JS XServer (real X11 protocol)…");
      server = new XServer({ width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT }) as unknown as X11Server;
      if (server.root) {
        server.root.backgroundPixel = 0x0b1a22;
        const data = server.root.raster?.data;
        if (data) data.fill(0x0b1a22);
      }
      const extNames = server.extensions
        ? [...(server.extensions as Map<string, unknown>).keys()].join(", ")
        : "";
      pushLog("XServer in-tab · real X11 wire protocol (node-x11)");
      pushLog(`extensions: ${extNames || "(none)"}`);
      pushLog("input: Sync GrabButton + AllowEvents(ReplayPointer) enabled");

      // WM must claim SubstructureRedirect before other clients MapWindow.
      setStatus("launching real Aurora WM (x11rb WASM)…");
      const wmTransport = createX11ByteTransport();
      transports.push(wmTransport);
      server.addClientStream(wmTransport.serverSide);
      const auroraShell = createAuroraShellHost();
      const aurora = await loadXApp(
        new URL("/wasm/aurora-wm-x11/aurora_wm.js", window.location.origin).href,
        new URL("/wasm/aurora-wm-x11/aurora_wm.wasm", window.location.origin).href,
        wmTransport,
        { auroraShell },
      );
      if (cancelled) return;
      // Keep a live reference on the module instance for js-library FFI.
      aurora.auroraShell = auroraShell;
      if (!aurora._aurora_wm_start?.()) throw new Error("aurora-wm failed X11 connect / become_wm");
      auroraPump = () => {
        aurora._aurora_wm_pump?.();
      };
      pushLog("aurora-wm WASM: SubstructureRedirect + chrome (real ecooxai WM)");
      pushLog("aurora Files terminal → web shell (ls/cd/cat/…; no host fork)");

      // Paint immediately once the WM is up (avoid black canvas while clients load).
      let xdemo: EmscriptenModule | null = null;
      let xclock: EmscriptenModule | null = null;
      let netsurf: EmscriptenModule | null = null;
      let firefox: EmscriptenModule | null = null;
      const pump = () => {
        if (cancelled || !server) return;
        aurora._aurora_wm_pump?.();
        xdemo?._xdemo_pump?.();
        xclock?._xclock_pump?.(Math.round(performance.now()));
        // Original NetSurf runs under ASYNCIFY (callMain); no explicit pump.
        firefox?._firefox_x11_pump?.();
        presentRoot(server, image, ctx);
        raf = requestAnimationFrame(pump);
      };
      raf = requestAnimationFrame(pump);
      onRunning(true);
      shell.focus({ preventScroll: true });
      setStatus("running · Aurora WM up · loading X11 clients…");

      setStatus("launching compiled X11 clients (xdemo + xclock)…");
      const demoTransport = createX11ByteTransport();
      transports.push(demoTransport);
      server.addClientStream(demoTransport.serverSide);
      xdemo = await loadXApp(
        new URL("/wasm/x11-apps/xdemo.js", window.location.origin).href,
        new URL("/wasm/x11-apps/xdemo.wasm", window.location.origin).href,
        demoTransport,
      );
      if (cancelled) return;
      if (!xdemo._xdemo_start?.()) throw new Error("xdemo failed X11 connect/map");
      aurora._aurora_wm_pump?.();
      pushLog("xdemo WASM: CreateWindow + MapWindow → Aurora MapRequest");

      const clockTransport = createX11ByteTransport();
      transports.push(clockTransport);
      server.addClientStream(clockTransport.serverSide);
      xclock = await loadXApp(
        new URL("/wasm/x11-apps/xclock.js", window.location.origin).href,
        new URL("/wasm/x11-apps/xclock.wasm", window.location.origin).href,
        clockTransport,
      );
      if (cancelled) return;
      if (!xclock._xclock_start?.()) throw new Error("xclock failed X11 connect/map");
      aurora._aurora_wm_pump?.();
      pushLog("xclock-demo WASM: second real X11 client managed by Aurora");

      // ORIGINAL NetSurf (full package) → webx11 surface → PutImage on JS XServer.
      try {
        setStatus("running · launching original NetSurf on XServer…");
        const nsTransport = createX11ByteTransport();
        transports.push(nsTransport);
        server.addClientStream(nsTransport.serverSide);
        netsurf = await loadXApp(
          new URL("/wasm/x11-apps/netsurf_x11.js", window.location.origin).href,
          new URL("/wasm/x11-apps/netsurf_x11.wasm", window.location.origin).href,
          nsTransport,
        );
        if (cancelled) return;
        if (typeof netsurf.callMain !== "function") {
          throw new Error("original NetSurf module missing callMain");
        }
        // Fire-and-forget: main() blocks in framebuffer_run(); ASYNCIFY yields.
        // HTTP(S) goes through AgentOS /__agentos/proxy (browser TLS) — open DuckDuckGo.
        void Promise.resolve(
          netsurf.callMain([
            "nsfb",
            "-f",
            "webx11",
            "-w",
            "720",
            "-h",
            "480",
            "https://html.duckduckgo.com/html/",
          ]),
        ).catch((err) => {
          console.error("[netsurf_x11] callMain ended", err);
        });
        aurora._aurora_wm_pump?.();
        pushLog("netsurf_x11: ORIGINAL NetSurf → DuckDuckGo via AgentOS proxy + webx11 PutImage");
        setStatus("running · Aurora WM + NetSurf (DuckDuckGo) · xdemo + xclock · firefox in 10s");
      } catch (err) {
        pushLog(`netsurf_x11: skipped · ${err instanceof Error ? err.message : "load error"}`);
        netsurf = null;
        setStatus("running · Aurora WM + COMPOSITE/RANDR/GLX · xdemo + xclock · firefox in 10s");
      }

      // Firefox X11 bridge loads 10s after WM is up so chrome/tasks stay responsive.
      const firefoxDelayMs = 10_000;
      pushLog(`firefox_x11: scheduled in ${firefoxDelayMs / 1000}s after WM start`);
      window.setTimeout(() => {
        if (cancelled || !server) return;
        void (async () => {
          try {
            setStatus("running · loading firefox_x11 bridge…");
            const ffTransport = createX11ByteTransport();
            transports.push(ffTransport);
            server.addClientStream(ffTransport.serverSide);
            const mod = await loadXApp(
              new URL("/wasm/x11-apps/firefox_x11.js", window.location.origin).href,
              new URL("/wasm/x11-apps/firefox_x11.wasm", window.location.origin).href,
              ffTransport,
            );
            if (cancelled) return;
            if (mod._firefox_x11_start?.()) {
              firefox = mod;
              aurora._aurora_wm_pump?.();
              pushLog("firefox_x11: X11 bridge mapped (Gecko rebuild → PutImage)");
              setStatus(
                netsurf
                  ? "running · Aurora WM + NetSurf + firefox_x11 · xdemo + xclock"
                  : "running · Aurora WM + COMPOSITE/RANDR/GLX · xdemo + xclock + firefox_x11",
              );
            } else {
              pushLog("firefox_x11: start failed (bridge present, not running)");
              setStatus(
                netsurf
                  ? "running · Aurora WM + NetSurf X11 · xdemo + xclock"
                  : "running · Aurora WM + COMPOSITE/RANDR/GLX · xdemo + xclock",
              );
            }
          } catch (err) {
            pushLog(`firefox_x11: skipped · ${err instanceof Error ? err.message : "load error"}`);
            setStatus(
              netsurf
                ? "running · Aurora WM + NetSurf X11 · xdemo + xclock"
                : "running · Aurora WM + COMPOSITE/RANDR/GLX · xdemo + xclock",
            );
          }
        })();
      }, firefoxDelayMs);
    };

    void start().catch((error: unknown) => {
      if (cancelled) return;
      setStatus(`failed · ${error instanceof Error ? error.message : "X server error"}`);
      onRunning(false);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      auroraPump = null;
      shell.removeEventListener("pointerdown", onDown);
      shell.removeEventListener("pointermove", onMove);
      shell.removeEventListener("pointerup", onUp);
      shell.removeEventListener("pointercancel", onCancel);
      shell.removeEventListener("keydown", onKeyDown);
      shell.removeEventListener("keyup", onKeyUp);
      shell.removeEventListener("contextmenu", onContext);
      for (const t of transports) t.close();
      onRunning(false);
    };
  }, [startSignal, onRunning]);

  return (
    <section className="web-desktop-panel" aria-label="Real in-browser X11 server">
      <div className="web-desktop-heading">
        <div>
          <p className="eyebrow">REAL X11 · AURORA WM · WASM CLIENTS</p>
          <h2>Full in-tab X server + real Aurora WM</h2>
        </div>
        <span className={"desktop-status " + (status.startsWith("running") ? "running" : "")}>{status}</span>
      </div>
      <p className="web-desktop-intro">
        Canvas = <code>XServer.compose()</code> → <code>root.raster</code>.{" "}
        <strong>aurora-wm</strong> (ecooxai, x11rb) is compiled to WASM and becomes the real window
        manager via SubstructureRedirect / MapRequest / reparent frames. The JS XServer now
        advertises <strong>COMPOSITE</strong>, <strong>XFIXES</strong>, <strong>SHAPE</strong>,{" "}
        <strong>DAMAGE</strong>, <strong>RANDR</strong>, and <strong>GLX</strong> (soft/WebGL).
        Clients <strong>xdemo</strong> and <strong>xclock-demo</strong> speak real X11 into the same
        server. Pointer uses Sync GrabButton + ReplayPointer so titlebar drag / dock clicks work.
        Files → Terminal uses the in-tab web shell (<code>ls</code>/<code>help</code>/…).{" "}
        <strong>Original NetSurf</strong> (full package) is compiled to WASM; only a thin{" "}
        <code>webx11</code> surface adapter maps it via <code>PutImage</code> — see{" "}
        <code>docs/netsurf-x11-wasm.md</code>.
        Firefox is rebuilt from source on a delayed X11 bridge — see{" "}
        <code>docs/firefox-x11-wasm.md</code>.
      </p>
      <div ref={shellRef} className="web-display-shell" tabIndex={0} role="application" aria-label="Real X11 screen">
        <canvas ref={canvasRef} className="web-display-canvas" style={{ pointerEvents: "none" }} />
        <span
          className="web-pointer-readout"
          style={{ left: `${(pointer.x / DISPLAY_WIDTH) * 100}%`, top: `${(pointer.y / DISPLAY_HEIGHT) * 100}%` }}
        />
      </div>
      <div className="web-desktop-footer">
        <span>
          <i className="footer-dot" /> node-x11 XServer
        </span>
        <span>
          pointer {pointer.x},{pointer.y}
        </span>
        <span>click / drag / type — Sync grab + ReplayPointer</span>
      </div>
      <ul className="boot-list" style={{ marginTop: 12 }}>
        {log.map((line) => (
          <div key={line}>
            <span>x11</span>
            <b>{line}</b>
          </div>
        ))}
      </ul>
    </section>
  );
}
