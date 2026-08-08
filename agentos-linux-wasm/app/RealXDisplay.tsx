"use client";

import "./buffer-polyfill";
import { useEffect, useRef, useState } from "react";
import { XServer } from "x11/lib/xserver/index.js";
import { createX11ByteTransport, type X11ByteTransport } from "./x11Transport";

const DISPLAY_WIDTH = 960;
const DISPLAY_HEIGHT = 540;

type X11Server = {
  width: number;
  height: number;
  root: { raster?: { data?: Uint32Array }; backgroundPixel?: number };
  keymap: { keycodeForKeysym: (keysym: number) => number };
  on: (event: string, listener: (value: unknown) => void) => void;
  addClientStream: (stream: unknown) => void;
  compose: () => unknown;
  injectPointerMove: (x: number, y: number) => void;
  injectButton: (button: number, isPress: boolean) => void;
  injectKey: (keycode: number, isPress: boolean) => void;
};

type EmscriptenModule = {
  x11Transport?: X11ByteTransport;
  _xdemo_start?: () => number;
  _xdemo_pump?: () => number;
  _xdemo_is_running?: () => number;
  _xclock_start?: () => number;
  _xclock_pump?: (now: number) => number;
  _xclock_is_running?: () => number;
};

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

async function loadXApp(jsUrl: string, wasmUrl: string, transport: X11ByteTransport): Promise<EmscriptenModule> {
  const imported = (await import(/* @vite-ignore */ jsUrl)) as { default: ModuleFactory };
  const mod = await imported.default({
    locateFile: (path: string) => (path.endsWith(".wasm") ? wasmUrl : path),
    print: (text: string) => console.log(`[x11-app] ${text}`),
    printErr: (text: string) => console.error(`[x11-app] ${text}`),
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
    };
    const onMove = (event: PointerEvent) => {
      if (!server) return;
      const p = map(event);
      setPointer(p);
      server.injectPointerMove(p.x, p.y);
    };
    const onUp = (event: PointerEvent) => {
      if (!server) return;
      const p = map(event);
      setPointer(p);
      server.injectPointerMove(p.x, p.y);
      server.injectButton(event.button + 1, false);
    };
    const onKey = (event: KeyboardEvent, press: boolean) => {
      if (!server) return;
      if (event.key.length !== 1 && event.key !== "Enter" && event.key !== "Backspace") return;
      event.preventDefault();
      const keysym = event.key.length === 1 ? event.key.charCodeAt(0) : event.key === "Enter" ? 0xff0d : 0xff08;
      const keycode = server.keymap.keycodeForKeysym(keysym <= 0xff ? keysym : keysym);
      if (keycode) server.injectKey(keycode, press);
    };
    const onKeyDown = (e: KeyboardEvent) => onKey(e, true);
    const onKeyUp = (e: KeyboardEvent) => onKey(e, false);
    const onContext = (e: Event) => e.preventDefault();

    shell.addEventListener("pointerdown", onDown);
    shell.addEventListener("pointermove", onMove);
    shell.addEventListener("pointerup", onUp);
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
      if (server.root) server.root.backgroundPixel = 0x0b1a22;
      pushLog("XServer in-tab · real X11 wire protocol (node-x11)");
      setStatus("launching compiled X11 clients (xdemo + xclock)…");

      const demoTransport = createX11ByteTransport();
      transports.push(demoTransport);
      server.addClientStream(demoTransport.serverSide);
      const xdemo = await loadXApp(new URL("/wasm/x11-apps/xdemo.js", window.location.origin).href, new URL("/wasm/x11-apps/xdemo.wasm", window.location.origin).href, demoTransport);
      if (cancelled) return;
      if (!xdemo._xdemo_start?.()) throw new Error("xdemo failed X11 connect/map");
      pushLog("xdemo WASM: CreateWindow + MapWindow + drawing requests");

      const clockTransport = createX11ByteTransport();
      transports.push(clockTransport);
      server.addClientStream(clockTransport.serverSide);
      const xclock = await loadXApp(new URL("/wasm/x11-apps/xclock.js", window.location.origin).href, new URL("/wasm/x11-apps/xclock.wasm", window.location.origin).href, clockTransport);
      if (cancelled) return;
      if (!xclock._xclock_start?.()) throw new Error("xclock failed X11 connect/map");
      pushLog("xclock-demo WASM: second real X11 client mapped");

      setStatus("running · XServer.compose() pixels · xdemo + xclock");
      onRunning(true);
      shell.focus({ preventScroll: true });

      const pump = () => {
        if (cancelled || !server) return;
        xdemo._xdemo_pump?.();
        xclock._xclock_pump?.(Math.round(performance.now()));
        presentRoot(server, image, ctx);
        raf = requestAnimationFrame(pump);
      };
      raf = requestAnimationFrame(pump);
    };

    void start().catch((error: unknown) => {
      if (cancelled) return;
      setStatus(`failed · ${error instanceof Error ? error.message : "X server error"}`);
      onRunning(false);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      shell.removeEventListener("pointerdown", onDown);
      shell.removeEventListener("pointermove", onMove);
      shell.removeEventListener("pointerup", onUp);
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
          <p className="eyebrow">REAL X11 · JS XServer · WASM CLIENTS</p>
          <h2>Full in-tab X server (protocol + compose)</h2>
        </div>
        <span className={"desktop-status " + (status.startsWith("running") ? "running" : "")}>{status}</span>
      </div>
      <p className="web-desktop-intro">
        Not a painted fake desktop. Canvas = <code>XServer.compose()</code> → <code>root.raster</code>.
        Clients <strong>xdemo</strong> and <strong>xclock-demo</strong> are C programs (Emscripten) speaking
        real X11: CreateWindow, MapWindow, PolyFillRectangle, ImageText8, ButtonPress.
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
        <span>click xdemo Toggle — ButtonPress from X server</span>
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
