"use client";

import { Buffer as BrowserBuffer } from "buffer";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import x11 from "x11";
import { XServer, createStreamPair } from "x11/lib/xserver/index.js";

const DISPLAY_WIDTH = 960;
const DISPLAY_HEIGHT = 540;

type GlobalBrowser = typeof globalThis & {
  Buffer?: typeof BrowserBuffer;
  setImmediate?: (callback: (...args: unknown[]) => void, ...args: unknown[]) => number;
};

const browserGlobal = globalThis as GlobalBrowser;
if (!browserGlobal.Buffer) browserGlobal.Buffer = BrowserBuffer;
if (!browserGlobal.setImmediate) {
  browserGlobal.setImmediate = ((callback: (...args: unknown[]) => void, ...args: unknown[]) =>
    window.setTimeout(callback, 0, ...args)) as GlobalBrowser["setImmediate"];
}

type X11Event = {
  name?: string;
  wid?: number;
  parent?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  borderWidth?: number;
};

type X11Client = {
  [method: string]: unknown;
  on: (event: string, listener: (value: unknown) => void) => void;
  terminate: () => void;
};

type X11Display = {
  client: X11Client;
  screen: Array<{ root: number }>;
};

type X11Api = {
  eventMask: Record<string, number>;
  createClient: (
    options: { display: string; stream: unknown },
    callback: (error: Error | null, display: X11Display) => void,
  ) => void;
};

type X11Server = {
  width: number;
  height: number;
  root: { raster?: { data?: Uint32Array } };
  keymap: { keycodeForKeysym: (keysym: number) => number };
  on: (event: string, listener: (value: unknown) => void) => void;
  addClientStream: (stream: unknown) => void;
  compose: () => unknown;
  injectPointerMove: (x: number, y: number) => void;
  injectButton: (button: number, isPress: boolean) => void;
  injectKey: (keycode: number, isPress: boolean) => void;
};

type AuroraCall = (...args: number[]) => number;

type AuroraModule = {
  aurora_tick: AuroraCall;
  aurora_pointer_down: AuroraCall;
  aurora_handle_key: AuroraCall;
};

type WindowSpec = {
  key: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  background: number;
  accent: number;
  lines: string[];
};

type Presenter = {
  kind: "webgpu" | "wasm-canvas2d" | "canvas2d";
  present: (pixels: Uint8Array) => void;
  dispose?: () => void;
};

type X11Runtime = {
  server: X11Server;
  wm: X11Client;
  app: X11Client;
  aurora: AuroraModule;
  presenter: Presenter;
  animationFrame: number;
  stop: () => void;
};

type WebDesktopProps = {
  startSignal: number;
  onRunning: (running: boolean) => void;
};

const x11Api = x11 as unknown as X11Api;

function callX(client: X11Client, method: string, ...args: unknown[]): unknown {
  const candidate = client[method];
  if (typeof candidate !== "function") throw new Error(`X11 client method ${method} is unavailable`);
  return (candidate as (...values: unknown[]) => unknown).apply(client, args);
}

function connectX11(server: X11Server): Promise<{ client: X11Client; display: X11Display }> {
  const [clientSide, serverSide] = createStreamPair();
  server.addClientStream(serverSide);
  return new Promise((resolve, reject) => {
    x11Api.createClient(
      { display: ":0", stream: clientSide },
      (error, display) => {
        if (error) reject(error);
        else resolve({ client: display.client, display });
      },
    );
  });
}

function waitForRequest(client: X11Client, method: string, ...args: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    callX(client, method, ...args, (error: unknown) => {
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve();
    });
  });
}

async function loadAuroraLayout(): Promise<{ layout: WindowSpec[]; aurora: AuroraModule }> {
  const response = await fetch("/wasm/aurora-wm-web.wasm");
  if (!response.ok) throw new Error(`Aurora WASM returned HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const instance = (await WebAssembly.instantiate(bytes, {})).instance;
  const exports = instance.exports as unknown as Record<string, unknown>;
  const required = (name: string) => {
    const fn = exports[name] as AuroraCall | undefined;
    if (typeof fn !== "function") throw new Error(`Aurora WASM export ${name} is missing`);
    return fn;
  };
  const aurora = {
    aurora_tick: required("aurora_tick"),
    aurora_pointer_down: required("aurora_pointer_down"),
    aurora_handle_key: required("aurora_handle_key"),
  };
  required("aurora_init")(DISPLAY_WIDTH, DISPLAY_HEIGHT);
  const count = required("aurora_window_count")();
  const names = ["terminal", "agent log", "files"];
  const palettes = [
    { background: 0x172f35, accent: 0x73ded2, lines: ["agentOS shell", "xterm PTY connected", "ready for input", "processes: 3"] },
    { background: 0x18262f, accent: 0x8ebac4, lines: ["Aurora WM", "X11 MapRequest", "SubstructureRedirect", "focus: terminal"] },
    { background: 0x1d292b, accent: 0xb6f36b, lines: ["/workspace", "README.md", "config.json", "hello.txt"] },
  ];
  return {
    aurora,
    layout: Array.from({ length: count }, (_, index) => ({
      key: names[index] ?? `window-${index}`,
      title: names[index] ?? `window-${index}`,
      x: required("aurora_window_x")(index),
      y: required("aurora_window_y")(index),
      width: required("aurora_window_width")(index),
      height: required("aurora_window_height")(index),
      ...palettes[index % palettes.length],
    })),
  };
}

type WebGpuDevice = {
  queue: {
    writeTexture: (...args: unknown[]) => void;
    submit: (commands: unknown[]) => void;
  };
  createTexture: (descriptor: unknown) => { createView: () => unknown };
  createShaderModule: (descriptor: unknown) => unknown;
  createRenderPipeline: (descriptor: unknown) => { getBindGroupLayout: (index: number) => unknown };
  createBindGroup: (descriptor: unknown) => unknown;
  createSampler: (descriptor: unknown) => unknown;
  createCommandEncoder: () => {
    beginRenderPass: (descriptor: unknown) => {
      setPipeline: (pipeline: unknown) => void;
      setBindGroup: (index: number, group: unknown) => void;
      draw: (vertices: number) => void;
      end: () => void;
    };
    finish: () => unknown;
  };
  pushErrorScope?: (filter: "validation" | "out-of-memory" | "internal") => void;
  popErrorScope?: () => Promise<{ message?: string } | null>;
  addEventListener?: (type: "uncapturederror", listener: (event: { error?: { message?: string } }) => void) => void;
  lost?: Promise<{ message?: string }>;
  destroy: () => void;
};

type WebGpuAdapter = { requestDevice: () => Promise<WebGpuDevice> };

type BrowserGpu = {
  requestAdapter: () => Promise<WebGpuAdapter | null>;
  getPreferredCanvasFormat: () => string;
};

type WebGpuContext = {
  configure: (descriptor: unknown) => void;
  getCurrentTexture: () => { createView: () => unknown };
};

type WasmFramebuffer = {
  memory: WebAssembly.Memory;
  xserver_init: (width: number, height: number) => number;
  xserver_frame_ptr: () => number;
  xserver_frame_len: () => number;
  xserver_render: (tick: number) => number;
};

function createCanvasPresenter(canvas: HTMLCanvasElement, kind: "wasm-canvas2d" | "canvas2d"): Presenter {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("browser exposes no Canvas 2D fallback");
  const image = context.createImageData(DISPLAY_WIDTH, DISPLAY_HEIGHT);
  return {
    kind,
    present: (pixels) => {
      image.data.set(pixels);
      context.putImageData(image, 0, 0);
    },
  };
}

async function createWasmCanvasPresenter(canvas: HTMLCanvasElement): Promise<Presenter> {
  try {
    const response = await fetch("/wasm/xserver-web.wasm");
    if (!response.ok) throw new Error(`Xserver WASM returned HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const instance = (await WebAssembly.instantiate(bytes, {})).instance;
    const wasm = instance.exports as unknown as WasmFramebuffer;
    if (!wasm.memory || typeof wasm.xserver_init !== "function" || typeof wasm.xserver_frame_ptr !== "function" || typeof wasm.xserver_frame_len !== "function" || typeof wasm.xserver_render !== "function") {
      throw new Error("Xserver WASM framebuffer exports are incomplete");
    }
    wasm.xserver_init(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    const framePointer = wasm.xserver_frame_ptr();
    const frameLength = wasm.xserver_frame_len();
    const byteLength = DISPLAY_WIDTH * DISPLAY_HEIGHT * 4;
    if (frameLength < byteLength) throw new Error("Xserver WASM framebuffer is too small");
    wasm.xserver_render(0);
    const contextPresenter = createCanvasPresenter(canvas, "wasm-canvas2d");
    return {
      ...contextPresenter,
      present: (pixels) => {
        const frame = new Uint8Array(wasm.memory.buffer, framePointer, byteLength);
        frame.set(pixels);
        contextPresenter.present(frame);
      },
    };
  } catch {
    return createCanvasPresenter(canvas, "canvas2d");
  }
}

async function createPresenter(
  webGpuCanvas: HTMLCanvasElement,
  fallbackCanvas: HTMLCanvasElement,
): Promise<Presenter> {
  webGpuCanvas.width = DISPLAY_WIDTH;
  webGpuCanvas.height = DISPLAY_HEIGHT;
  fallbackCanvas.width = DISPLAY_WIDTH;
  fallbackCanvas.height = DISPLAY_HEIGHT;
  webGpuCanvas.style.opacity = "0";
  fallbackCanvas.style.opacity = "1";

  const fallback = await createWasmCanvasPresenter(fallbackCanvas);
  const browserNavigator = navigator as Navigator & { gpu?: BrowserGpu };
  const activateFallback = () => {
    webGpuCanvas.style.opacity = "0";
    fallbackCanvas.style.opacity = "1";
  };

  if (browserNavigator.gpu) {
    try {
      const adapter = await browserNavigator.gpu.requestAdapter();
      if (adapter) {
        const device = await adapter.requestDevice();
        const context = webGpuCanvas.getContext("webgpu") as unknown as WebGpuContext | null;
        if (!context) throw new Error("WebGPU canvas context unavailable");
        const format = browserNavigator.gpu.getPreferredCanvasFormat();
        context.configure({ device, format, alphaMode: "opaque" });
        const texture = device.createTexture({
          size: { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT, depthOrArrayLayers: 1 },
          format: "rgba8unorm",
          // COPY_DST is required by queue.writeTexture; TEXTURE_BINDING is
          // required by the fragment shader. STORAGE_BINDING is not needed.
          usage: 2 | 4,
        });
        const shader = device.createShaderModule({
          code: [
            "struct VertexOut { @builtin(position) position: vec4f, @location(0) uv: vec2f, };",
            "@vertex fn vertexMain(@builtin(vertex_index) i: u32) -> VertexOut {",
            "var p = array<vec2f, 6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));",
            "var u = array<vec2f, 6>(vec2f(0,1),vec2f(1,1),vec2f(0,0),vec2f(0,0),vec2f(1,1),vec2f(1,0));",
            "var o: VertexOut; o.position = vec4f(p[i],0,1); o.uv = u[i]; return o;",
            "}",
            "@group(0) @binding(0) var frameTexture: texture_2d<f32>;",
            "@group(0) @binding(1) var frameSampler: sampler;",
            "@fragment fn fragmentMain(i: VertexOut) -> @location(0) vec4f { return textureSample(frameTexture, frameSampler, i.uv); }",
          ].join("\n"),
        });
        const pipeline = device.createRenderPipeline({
          layout: "auto",
          vertex: { module: shader, entryPoint: "vertexMain" },
          fragment: { module: shader, entryPoint: "fragmentMain", targets: [{ format }] },
          primitive: { topology: "triangle-list" },
        });
        const bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: texture.createView() },
            { binding: 1, resource: device.createSampler({ magFilter: "nearest", minFilter: "nearest" }) },
          ],
        });
        const smokePixels = new Uint8Array(DISPLAY_WIDTH * DISPLAY_HEIGHT * 4);
        device.pushErrorScope?.("validation");
        device.queue.writeTexture(
          { texture },
          smokePixels,
          { bytesPerRow: DISPLAY_WIDTH * 4, rowsPerImage: DISPLAY_HEIGHT },
          { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT, depthOrArrayLayers: 1 },
        );
        const validationError = await device.popErrorScope?.();
        if (validationError) throw new Error(validationError.message ?? "WebGPU texture validation failed");

        let usingFallback = false;
        const switchToFallback = () => {
          if (usingFallback) return;
          usingFallback = true;
          activateFallback();
          device.destroy();
        };
        device.addEventListener?.("uncapturederror", () => switchToFallback());
        void device.lost?.then(() => switchToFallback());
        activateFallback();
        webGpuCanvas.style.opacity = "1";
        fallbackCanvas.style.opacity = "0";
        return {
          kind: "webgpu",
          present: (pixels) => {
            if (usingFallback) {
              fallback.present(pixels);
              return;
            }
            try {
              device.queue.writeTexture(
                { texture },
                pixels,
                { bytesPerRow: DISPLAY_WIDTH * 4, rowsPerImage: DISPLAY_HEIGHT },
                { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT, depthOrArrayLayers: 1 },
              );
              const encoder = device.createCommandEncoder();
              const pass = encoder.beginRenderPass({
                colorAttachments: [{
                  view: context.getCurrentTexture().createView(),
                  clearValue: { r: 0.02, g: 0.04, b: 0.05, a: 1 },
                  loadOp: "clear",
                  storeOp: "store",
                }],
              });
              pass.setPipeline(pipeline);
              pass.setBindGroup(0, bindGroup);
              pass.draw(6);
              pass.end();
              device.queue.submit([encoder.finish()]);
            } catch {
              switchToFallback();
              fallback.present(pixels);
            }
          },
          dispose: () => {
            usingFallback = true;
            device.destroy();
          },
        };
      }
    } catch {
      activateFallback();
    }
  }

  activateFallback();
  return fallback;
}

function toRgba(source: Uint32Array, target: Uint8Array): void {
  for (let index = 0; index < source.length; index += 1) {
    const color = source[index] ?? 0;
    const offset = index * 4;
    target[offset] = (color >> 16) & 0xff;
    target[offset + 1] = (color >> 8) & 0xff;
    target[offset + 2] = color & 0xff;
    target[offset + 3] = 0xff;
  }
}

function drawClientWindow(client: X11Client, windowId: number, gc: number, spec: WindowSpec): void {
  callX(client, "PolyFillRectangle", windowId, gc, [0, 0, spec.width, spec.height]);
  callX(client, "ImageText8", windowId, gc, 22, 24, spec.title);
  spec.lines.forEach((line, index) => {
    callX(client, "ImageText8", windowId, gc, 22, 70 + index * 28, line);
  });
  callX(client, "PolyFillRectangle", windowId, gc, [22, spec.height - 30, Math.max(40, spec.width - 44), 2]);
}

function drawScreen(client: X11Client, windowId: number, gc: number): void {
  callX(client, "PolyFillRectangle", windowId, gc, [0, 0, DISPLAY_WIDTH, DISPLAY_HEIGHT]);
  callX(client, "ImageText8", windowId, gc, 24, 27, "AgentOS X11 display :0");
  callX(client, "ImageText8", windowId, gc, DISPLAY_WIDTH - 200, 27, "AURORA WM  ·  RUNNING");
}

async function startX11Runtime(
  canvas: HTMLCanvasElement,
  webGpuCanvas: HTMLCanvasElement,
  onStatus: (status: string) => void,
  onWindows: (windows: WindowSpec[]) => void,
): Promise<X11Runtime> {
  const server = new XServer({ width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT }) as unknown as X11Server;
  const presenter = await createPresenter(webGpuCanvas, canvas);
  const { layout, aurora } = await loadAuroraLayout();
  onWindows(layout);
  onStatus("X11 server booting · DISPLAY=:0");

  const wmConnection = await connectX11(server);
  const wm = wmConnection.client;
  const root = wmConnection.display.screen[0]?.root ?? 0x123;
  const eventMask = x11Api.eventMask;
  const redirectMask =
    (eventMask.SubstructureRedirect ?? 0) |
    (eventMask.SubstructureNotify ?? 0) |
    (eventMask.PropertyChange ?? 0) |
    (eventMask.ButtonPress ?? 0);
  await waitForRequest(wm, "ChangeWindowAttributes", root, { eventMask: redirectMask });

  const appConnection = await connectX11(server);
  const app = appConnection.client;
  const managed = new Map<number, { spec: WindowSpec; gc: number }>();
  let activeKey = layout[0]?.key ?? "terminal";
  let stopped = false;

  const redraw = (windowId: number) => {
    const window = managed.get(windowId);
    if (window) drawClientWindow(app, windowId, window.gc, window.spec);
  };

  wm.on("event", (value) => {
    const event = value as X11Event;
    if (event.name === "MapRequest" && event.wid) {
      const window = managed.get(event.wid);
      const spec = window?.spec ?? layout[managed.size % Math.max(1, layout.length)];
      if (spec) {
        callX(wm, "ConfigureWindow", event.wid, {
          x: spec.x,
          y: spec.y,
          width: spec.width,
          height: spec.height,
          borderWidth: 2,
        });
      }
      callX(wm, "MapWindow", event.wid);
      if (spec) onWindows(layout.map((item) => item.key === spec.key ? { ...item } : item));
    }
    if (event.name === "ConfigureRequest" && event.wid) {
      const window = managed.get(event.wid);
      if (window) {
        callX(wm, "ConfigureWindow", event.wid, {
          x: window.spec.x,
          y: window.spec.y,
          width: window.spec.width,
          height: window.spec.height,
          borderWidth: 2,
        });
      }
    }
    if (event.name === "DestroyNotify" && event.wid) {
      managed.delete(event.wid);
      onWindows(layout.filter((item) => Array.from(managed.values()).some((value) => value.spec.key === item.key)));
    }
  });

  const screenId = callX(app, "AllocID") as number;
  const screenGc = callX(app, "AllocID") as number;
  callX(app, "CreateWindow", screenId, root, 0, 0, DISPLAY_WIDTH, DISPLAY_HEIGHT, 0, 0, 0, 0, {
    backgroundPixel: 0x0b151b,
    overrideRedirect: 1,
    eventMask: eventMask.Exposure ?? 0,
  });
  callX(app, "CreateGC", screenGc, screenId, { foreground: 0xb6f36b, background: 0x0b151b });
  callX(app, "MapWindow", screenId);
  drawScreen(app, screenId, screenGc);

  layout.forEach((spec) => {
    const windowId = callX(app, "AllocID") as number;
    const gc = callX(app, "AllocID") as number;
    managed.set(windowId, { spec, gc });
    callX(app, "CreateWindow", windowId, root, 0, 0, spec.width, spec.height, 2, 0, 0, 0, {
      backgroundPixel: spec.background,
      borderPixel: spec.accent,
      eventMask: (eventMask.Exposure ?? 0) | (eventMask.ButtonPress ?? 0),
    });
    callX(app, "CreateGC", gc, windowId, { foreground: spec.accent, background: spec.background });
    callX(app, "MapWindow", windowId);
  });

  app.on("event", (value) => {
    const event = value as X11Event;
    if (event.name === "Expose" && event.wid) redraw(event.wid);
    if (event.name === "ButtonPress" && event.wid) {
      const window = managed.get(event.wid);
      if (window) {
        activeKey = window.spec.key;
        callX(app, "SetInputFocus", event.wid, 0);
        onWindows(layout.map((item) => ({ ...item, accent: item.key === activeKey ? 0xb6f36b : item.accent })));
      }
    }
  });

  onStatus("running · X11 protocol server + Aurora WM client · DISPLAY=:0");
  const rgba = new Uint8Array(DISPLAY_WIDTH * DISPLAY_HEIGHT * 4);
  const render = () => {
    if (stopped) return;
    aurora.aurora_tick(Math.round(performance.now()) >>> 0);
    server.compose();
    const pixels = server.root.raster?.data;
    if (pixels) {
      toRgba(pixels, rgba);
      presenter.present(rgba);
    }
    requestAnimationFrame(render);
  };
  const animationFrame = requestAnimationFrame(render);

  return {
    server,
    wm,
    app,
    aurora,
    presenter,
    animationFrame,
    stop: () => {
      stopped = true;
      cancelAnimationFrame(animationFrame);
      presenter.dispose?.();
      wm.terminate();
      app.terminate();
    },
  };
}

export function WebDesktop({ startSignal, onRunning }: WebDesktopProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const webGpuCanvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<X11Runtime | null>(null);
  const onRunningRef = useRef(onRunning);
  const [status, setStatus] = useState("idle · press start above");
  const [backend, setBackend] = useState("not started");
  const [windows, setWindows] = useState<WindowSpec[]>([]);
  const [pointer, setPointer] = useState({ x: DISPLAY_WIDTH / 2, y: DISPLAY_HEIGHT / 2 });

  useEffect(() => {
    onRunningRef.current = onRunning;
  }, [onRunning]);

  useEffect(() => {
    if (startSignal === 0) return;
    let cancelled = false;
    const start = async () => {
      runtimeRef.current?.stop();
      runtimeRef.current = null;
      onRunningRef.current(false);
      setStatus("loading real X11 protocol server…");
      setBackend("initializing");
      const canvas = canvasRef.current;
      const webGpuCanvas = webGpuCanvasRef.current;
      if (!canvas || !webGpuCanvas) throw new Error("display canvases are not mounted");
      const runtime = await startX11Runtime(canvas, webGpuCanvas, setStatus, setWindows);
      if (cancelled) {
        runtime.stop();
        return;
      }
      runtimeRef.current = runtime;
      setBackend(
        runtime.presenter.kind === "webgpu"
          ? "WebGPU canvas presenter"
          : runtime.presenter.kind === "wasm-canvas2d"
            ? "WebAssembly framebuffer + Canvas 2D fallback"
            : "Canvas 2D fallback",
      );
      onRunningRef.current(true);
    };
    void start().catch((error: unknown) => {
      if (cancelled) return;
      setStatus(`failed · ${error instanceof Error ? error.message : "browser X11 error"}`);
      setBackend("unavailable");
      onRunningRef.current(false);
    });
    return () => {
      cancelled = true;
      runtimeRef.current?.stop();
      runtimeRef.current = null;
      onRunningRef.current(false);
    };
  }, [startSignal]);

  const pointerPosition = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const runtime = runtimeRef.current;
    if (!canvas || !runtime) return null;
    const bounds = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(DISPLAY_WIDTH - 1, Math.round((event.clientX - bounds.left) * DISPLAY_WIDTH / bounds.width)));
    const y = Math.max(0, Math.min(DISPLAY_HEIGHT - 1, Math.round((event.clientY - bounds.top) * DISPLAY_HEIGHT / bounds.height)));
    setPointer({ x, y });
    runtime.server.injectPointerMove(x, y);
    return { runtime, x, y };
  };

  const handlePointer = (event: PointerEvent<HTMLCanvasElement>, pressed: boolean) => {
    const position = pointerPosition(event);
    if (!position) return;
    const { runtime } = position;
    if (pressed) {
      runtime.aurora.aurora_pointer_down(position.x, position.y);
      runtime.server.injectButton(event.button + 1, true);
    }
    else runtime.server.injectButton(event.button + 1, false);
  };

  const handleKey = (event: KeyboardEvent<HTMLCanvasElement>, isPress: boolean) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const key = event.key.length === 1 ? event.key : event.key === "Tab" ? "\t" : "";
    if (!key) return;
    const keysym = key === "\t" ? 0x09 : key.charCodeAt(0);
    if (isPress) runtime.aurora.aurora_handle_key(keysym);
    const keycode = runtime.server.keymap.keycodeForKeysym(keysym);
    if (!keycode) return;
    event.preventDefault();
    runtime.server.injectKey(keycode, isPress);
  };

  return (
    <section className="web-desktop-panel" aria-label="Real in-browser X11 server and Aurora WM">
      <div className="web-desktop-heading">
        <div>
          <p className="eyebrow">LIVE DISPLAY · DISPLAY=:0</p>
          <h2>Real X11 server + Aurora WM</h2>
        </div>
        <span className={"desktop-status " + (status.startsWith("running") ? "running" : "")}>{status}</span>
      </div>
      <p className="web-desktop-intro">
        This surface runs an in-browser X11 protocol server. Aurora attaches as a real X11 window-manager client, claims SubstructureRedirect, and receives MapRequest events before arranging the client windows.
      </p>
      <div className="web-display-shell">
        <canvas
          ref={canvasRef}
          className="web-display-canvas"
          tabIndex={0}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            handlePointer(event, true);
          }}
          onPointerMove={(event) => pointerPosition(event)}
          onPointerUp={(event) => handlePointer(event, false)}
          onKeyDown={(event) => handleKey(event, true)}
          onKeyUp={(event) => handleKey(event, false)}
          aria-label="X11 screen canvas"
        />
        <canvas
          ref={webGpuCanvasRef}
          className="web-display-canvas web-gpu-display-canvas"
          aria-hidden="true"
        />
        <span className="web-pointer-readout" style={{ left: `${(pointer.x / DISPLAY_WIDTH) * 100}%`, top: `${(pointer.y / DISPLAY_HEIGHT) * 100}%` }} />
        <div className="web-x11-window-list" aria-live="polite">
          {windows.map((window) => <span key={window.key}>{window.title}</span>)}
        </div>
      </div>
      <div className="web-desktop-footer">
        <span><i className="footer-dot" /> {backend}</span>
        <span>{windows.length} X11 client windows · click to focus</span>
        <span>events + drawing · in-tab server</span>
      </div>
    </section>
  );
}
