"use client";

import "./buffer-polyfill";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import x11 from "x11";
import { XServer, createStreamPair } from "x11/lib/xserver/index.js";

const DISPLAY_WIDTH = 960;
const DISPLAY_HEIGHT = 540;

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

type WasmCall = (...args: number[]) => number;

type AuroraModule = {
  memory: WebAssembly.Memory;
  aurora_tick: WasmCall;
  aurora_render: WasmCall;
  aurora_pointer_down: WasmCall;
  aurora_handle_key: WasmCall;
  aurora_map_request: WasmCall;
  aurora_window_x: WasmCall;
  aurora_window_y: WasmCall;
  aurora_window_width: WasmCall;
  aurora_window_height: WasmCall;
  aurora_content_x: WasmCall;
  aurora_content_y: WasmCall;
  aurora_content_width: WasmCall;
  aurora_content_height: WasmCall;
  aurora_window_active: WasmCall;
  aurora_active_window: WasmCall;
  aurora_is_running: WasmCall;
  aurora_frame_ptr: WasmCall;
  aurora_frame_len: WasmCall;
  aurora_wallpaper_ptr: WasmCall;
  aurora_wallpaper_len: WasmCall;
  aurora_topbar_height: WasmCall;
  aurora_titlebar_height: WasmCall;
  aurora_files_show: WasmCall;
  aurora_files_clear: WasmCall;
  aurora_files_path_buf: WasmCall;
  aurora_files_path_cap: WasmCall;
  aurora_files_set_path: WasmCall;
  aurora_files_name_buf: WasmCall;
  aurora_files_name_cap: WasmCall;
  aurora_files_add: WasmCall;
  aurora_files_count: WasmCall;
  aurora_files_visible: WasmCall;
};

type XserverModule = {
  memory: WebAssembly.Memory;
  xserver_init: WasmCall;
  xserver_frame_ptr: WasmCall;
  xserver_frame_len: WasmCall;
  xserver_render: WasmCall;
  xserver_set_window: WasmCall;
  xserver_clear_windows: WasmCall;
  xserver_wallpaper_ptr: WasmCall;
  xserver_wallpaper_len: WasmCall;
  xserver_input_pointer: WasmCall;
  xserver_is_running: WasmCall;
};

type WindowSpec = {
  key: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  contentX: number;
  contentY: number;
  contentWidth: number;
  contentHeight: number;
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
  xserver: XserverModule | null;
  presenter: Presenter;
  animationFrame: number;
  stop: () => void;
};

type WebDesktopProps = {
  startSignal: number;
  onRunning: (running: boolean) => void;
  workspaceFiles?: Record<string, string>;
};

function listWorkspaceEntries(files: Record<string, string>, dir = "/workspace"): Array<{ name: string; kind: number }> {
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  const names = new Set<string>();
  for (const path of Object.keys(files)) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (!rest || rest.includes("/")) continue;
    names.add(rest);
  }
  // Always expose common workspace dirs as places-style folders.
  for (const dirName of ["src", "public", "scripts"]) {
    if (Object.keys(files).some((path) => path.startsWith(`${prefix}${dirName}/`))) {
      names.add(dirName);
    }
  }
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const lower = name.toLowerCase();
      const isDir = !files[`${prefix}${name}`] && Object.keys(files).some((path) => path.startsWith(`${prefix}${name}/`));
      let kind = 1;
      if (isDir) kind = 0;
      else if (lower.endsWith(".json") || lower.endsWith(".toml") || lower.endsWith(".yml")) kind = 3;
      else if (lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".rs") || lower.endsWith(".ts") || lower.endsWith(".tsx")) kind = 2;
      return { name, kind };
    });
}

function writeWasmString(memory: WebAssembly.Memory, ptr: number, cap: number, value: string): number {
  const bytes = new TextEncoder().encode(value);
  const length = Math.min(bytes.length, Math.max(0, cap - 1));
  new Uint8Array(memory.buffer, ptr, length).set(bytes.subarray(0, length));
  return length;
}

function syncAuroraFiles(aurora: AuroraModule, workspaceFiles: Record<string, string>, path = "/workspace"): void {
  aurora.aurora_files_clear();
  const pathLen = writeWasmString(
    aurora.memory,
    aurora.aurora_files_path_buf(),
    aurora.aurora_files_path_cap(),
    path,
  );
  aurora.aurora_files_set_path(pathLen);
  for (const entry of listWorkspaceEntries(workspaceFiles, path)) {
    const nameLen = writeWasmString(
      aurora.memory,
      aurora.aurora_files_name_buf(),
      aurora.aurora_files_name_cap(),
      entry.name,
    );
    aurora.aurora_files_add(nameLen, entry.kind);
  }
  // Ensure the Files app is mapped/focused like upstream show_folder(..., true).
  aurora.aurora_files_show(1);
}

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

function requiredExport(exports: Record<string, unknown>, name: string): WasmCall {
  const fn = exports[name] as WasmCall | undefined;
  if (typeof fn !== "function") throw new Error(`WASM export ${name} is missing`);
  return fn;
}

async function loadAuroraWm(): Promise<{ layout: WindowSpec[]; aurora: AuroraModule }> {
  const response = await fetch("/wasm/aurora-wm-web.wasm");
  if (!response.ok) throw new Error(`Aurora WM WASM returned HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const instance = (await WebAssembly.instantiate(bytes, {})).instance;
  const exports = instance.exports as unknown as Record<string, unknown>;
  const memory = exports.memory as WebAssembly.Memory | undefined;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("Aurora WM WASM memory export missing");

  const aurora: AuroraModule = {
    memory,
    aurora_tick: requiredExport(exports, "aurora_tick"),
    aurora_render: requiredExport(exports, "aurora_render"),
    aurora_pointer_down: requiredExport(exports, "aurora_pointer_down"),
    aurora_handle_key: requiredExport(exports, "aurora_handle_key"),
    aurora_map_request: requiredExport(exports, "aurora_map_request"),
    aurora_window_x: requiredExport(exports, "aurora_window_x"),
    aurora_window_y: requiredExport(exports, "aurora_window_y"),
    aurora_window_width: requiredExport(exports, "aurora_window_width"),
    aurora_window_height: requiredExport(exports, "aurora_window_height"),
    aurora_content_x: requiredExport(exports, "aurora_content_x"),
    aurora_content_y: requiredExport(exports, "aurora_content_y"),
    aurora_content_width: requiredExport(exports, "aurora_content_width"),
    aurora_content_height: requiredExport(exports, "aurora_content_height"),
    aurora_window_active: requiredExport(exports, "aurora_window_active"),
    aurora_active_window: requiredExport(exports, "aurora_active_window"),
    aurora_is_running: requiredExport(exports, "aurora_is_running"),
    aurora_frame_ptr: requiredExport(exports, "aurora_frame_ptr"),
    aurora_frame_len: requiredExport(exports, "aurora_frame_len"),
    aurora_wallpaper_ptr: requiredExport(exports, "aurora_wallpaper_ptr"),
    aurora_wallpaper_len: requiredExport(exports, "aurora_wallpaper_len"),
    aurora_topbar_height: requiredExport(exports, "aurora_topbar_height"),
    aurora_titlebar_height: requiredExport(exports, "aurora_titlebar_height"),
    aurora_files_show: requiredExport(exports, "aurora_files_show"),
    aurora_files_clear: requiredExport(exports, "aurora_files_clear"),
    aurora_files_path_buf: requiredExport(exports, "aurora_files_path_buf"),
    aurora_files_path_cap: requiredExport(exports, "aurora_files_path_cap"),
    aurora_files_set_path: requiredExport(exports, "aurora_files_set_path"),
    aurora_files_name_buf: requiredExport(exports, "aurora_files_name_buf"),
    aurora_files_name_cap: requiredExport(exports, "aurora_files_name_cap"),
    aurora_files_add: requiredExport(exports, "aurora_files_add"),
    aurora_files_count: requiredExport(exports, "aurora_files_count"),
    aurora_files_visible: requiredExport(exports, "aurora_files_visible"),
  };

  requiredExport(exports, "aurora_init")(DISPLAY_WIDTH, DISPLAY_HEIGHT);
  if (aurora.aurora_is_running() !== 1) throw new Error("Aurora WM failed to enter running state");

  const count = requiredExport(exports, "aurora_window_count")();
  const names = ["terminal", "agent log", "Aurora Files"];
  const palettes = [
    { background: 0x172f35, accent: 0x73ded2, lines: ["agentOS shell", "xterm PTY connected", "ready for input", "processes: 3"] },
    { background: 0x18262f, accent: 0x8ebac4, lines: ["Aurora WM", "MapRequest: Aurora Files", "files app running", "ecooxai/aurora-wm"] },
    { background: 0xf7fcff, accent: 0x4cc5b2, lines: ["/workspace", "Aurora Files", "Places · Workspace", "auto-started with WM"] },
  ];

  return {
    aurora,
    layout: Array.from({ length: count }, (_, index) => ({
      key: names[index] ?? `window-${index}`,
      title: names[index] ?? `window-${index}`,
      x: aurora.aurora_window_x(index),
      y: aurora.aurora_window_y(index),
      width: aurora.aurora_window_width(index),
      height: aurora.aurora_window_height(index),
      contentX: aurora.aurora_content_x(index),
      contentY: aurora.aurora_content_y(index),
      contentWidth: aurora.aurora_content_width(index),
      contentHeight: aurora.aurora_content_height(index),
      ...palettes[index % palettes.length],
    })),
  };
}

async function loadXserver(): Promise<XserverModule | null> {
  try {
    const response = await fetch("/wasm/xserver-web.wasm");
    if (!response.ok) throw new Error(`Xserver WASM returned HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const instance = (await WebAssembly.instantiate(bytes, {})).instance;
    const exports = instance.exports as unknown as Record<string, unknown>;
    const memory = exports.memory as WebAssembly.Memory | undefined;
    if (!(memory instanceof WebAssembly.Memory)) throw new Error("Xserver WASM memory export missing");
    const xserver: XserverModule = {
      memory,
      xserver_init: requiredExport(exports, "xserver_init"),
      xserver_frame_ptr: requiredExport(exports, "xserver_frame_ptr"),
      xserver_frame_len: requiredExport(exports, "xserver_frame_len"),
      xserver_render: requiredExport(exports, "xserver_render"),
      xserver_set_window: requiredExport(exports, "xserver_set_window"),
      xserver_clear_windows: requiredExport(exports, "xserver_clear_windows"),
      xserver_wallpaper_ptr: requiredExport(exports, "xserver_wallpaper_ptr"),
      xserver_wallpaper_len: requiredExport(exports, "xserver_wallpaper_len"),
      xserver_input_pointer: requiredExport(exports, "xserver_input_pointer"),
      xserver_is_running: requiredExport(exports, "xserver_is_running"),
    };
    xserver.xserver_init(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    return xserver;
  } catch {
    return null;
  }
}

function syncWallpaper(aurora: AuroraModule, xserver: XserverModule): void {
  const srcLen = aurora.aurora_wallpaper_len();
  const dstLen = xserver.xserver_wallpaper_len();
  const byteLength = Math.min(srcLen, dstLen, DISPLAY_WIDTH * DISPLAY_HEIGHT * 4);
  const src = new Uint8Array(aurora.memory.buffer, aurora.aurora_wallpaper_ptr(), byteLength);
  const dst = new Uint8Array(xserver.memory.buffer, xserver.xserver_wallpaper_ptr(), byteLength);
  dst.set(src);
}

function syncWindowsToXserver(aurora: AuroraModule, xserver: XserverModule, count: number): void {
  xserver.xserver_clear_windows();
  for (let index = 0; index < count; index += 1) {
    xserver.xserver_set_window(
      index,
      aurora.aurora_window_x(index),
      aurora.aurora_window_y(index),
      aurora.aurora_window_width(index),
      aurora.aurora_window_height(index),
      aurora.aurora_window_active(index),
    );
  }
}

function readLayout(aurora: AuroraModule, base: WindowSpec[]): WindowSpec[] {
  return base.map((item, index) => ({
    ...item,
    x: aurora.aurora_window_x(index),
    y: aurora.aurora_window_y(index),
    width: aurora.aurora_window_width(index),
    height: aurora.aurora_window_height(index),
    contentX: aurora.aurora_content_x(index),
    contentY: aurora.aurora_content_y(index),
    contentWidth: aurora.aurora_content_width(index),
    contentHeight: aurora.aurora_content_height(index),
    accent: aurora.aurora_window_active(index) === 1 ? 0xb6f36b : item.accent,
  }));
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

  const fallback = createCanvasPresenter(fallbackCanvas, "wasm-canvas2d");
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

function drawClientWindow(client: X11Client, windowId: number, gc: number, spec: WindowSpec): void {
  callX(client, "PolyFillRectangle", windowId, gc, [0, 0, spec.contentWidth, spec.contentHeight]);
  callX(client, "ImageText8", windowId, gc, 18, 24, spec.title);
  spec.lines.forEach((line, index) => {
    callX(client, "ImageText8", windowId, gc, 18, 56 + index * 24, line);
  });
}

async function startX11Runtime(
  canvas: HTMLCanvasElement,
  webGpuCanvas: HTMLCanvasElement,
  onStatus: (status: string) => void,
  onWindows: (windows: WindowSpec[]) => void,
  workspaceFiles: Record<string, string>,
): Promise<X11Runtime> {
  onStatus("loading Aurora WM WASM (ecooxai/aurora-wm)…");
  const { layout, aurora } = await loadAuroraWm();
  // Match upstream WM boot: show_folder / aurora-files is launched with the session.
  syncAuroraFiles(aurora, workspaceFiles, "/workspace");
  if (aurora.aurora_files_visible() !== 1 || aurora.aurora_files_count() < 1) {
    throw new Error("Aurora Files failed to start with the WM session");
  }
  aurora.aurora_render(0);
  onWindows(readLayout(aurora, layout));
  onStatus(`Aurora Files running · ${aurora.aurora_files_count()} items in /workspace`);

  onStatus("loading Xserver WASM compositor…");
  const xserver = await loadXserver();
  if (xserver) {
    syncWallpaper(aurora, xserver);
    syncWindowsToXserver(aurora, xserver, layout.length);
    xserver.xserver_render(0);
  }

  const presenter = await createPresenter(webGpuCanvas, canvas);
  const server = new XServer({ width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT }) as unknown as X11Server;
  onStatus("X11 protocol server booting · DISPLAY=:0");

  const wmConnection = await connectX11(server);
  const wm = wmConnection.client;
  const root = wmConnection.display.screen[0]?.root ?? 0x123;
  const eventMask = x11Api.eventMask;
  // Same become_wm mask shape as upstream aurora-wm.
  const redirectMask =
    (eventMask.SubstructureRedirect ?? 0) |
    (eventMask.SubstructureNotify ?? 0) |
    (eventMask.StructureNotify ?? 0) |
    (eventMask.Exposure ?? 0) |
    (eventMask.PropertyChange ?? 0) |
    (eventMask.ButtonPress ?? 0) |
    (eventMask.KeyRelease ?? 0);
  await waitForRequest(wm, "ChangeWindowAttributes", root, { eventMask: redirectMask });

  const appConnection = await connectX11(server);
  const app = appConnection.client;
  const managed = new Map<number, { index: number; spec: WindowSpec; gc: number }>();
  let stopped = false;
  let currentLayout = layout;
  const paintState = { lastPaint: -1, lastActive: aurora.aurora_active_window(), dirty: true };
  const markDirty = () => {
    paintState.dirty = true;
  };

  const refreshWindows = () => {
    currentLayout = readLayout(aurora, layout);
    onWindows(currentLayout);
    if (xserver) syncWindowsToXserver(aurora, xserver, currentLayout.length);
    markDirty();
  };

  wm.on("event", (value) => {
    const event = value as X11Event;
    if (event.name === "MapRequest" && event.wid) {
      const entry = managed.get(event.wid);
      const index = entry?.index ?? managed.size % Math.max(1, layout.length);
      aurora.aurora_map_request(index, event.width ?? 0, event.height ?? 0);
      markDirty();
      const frame = {
        x: aurora.aurora_window_x(index),
        y: aurora.aurora_window_y(index),
        width: aurora.aurora_window_width(index),
        height: aurora.aurora_window_height(index),
      };
      const content = {
        x: aurora.aurora_content_x(index),
        y: aurora.aurora_content_y(index),
        width: aurora.aurora_content_width(index),
        height: aurora.aurora_content_height(index),
      };
      // Place the client in the content rect under the Aurora titlebar frame.
      callX(wm, "ConfigureWindow", event.wid, {
        x: content.x,
        y: content.y,
        width: content.width,
        height: content.height,
        borderWidth: 0,
      });
      callX(wm, "MapWindow", event.wid);
      if (entry) {
        entry.spec = {
          ...entry.spec,
          ...frame,
          contentX: content.x,
          contentY: content.y,
          contentWidth: content.width,
          contentHeight: content.height,
        };
      }
      refreshWindows();
      void frame;
    }
    if (event.name === "ConfigureRequest" && event.wid) {
      const entry = managed.get(event.wid);
      if (entry) {
        callX(wm, "ConfigureWindow", event.wid, {
          x: aurora.aurora_content_x(entry.index),
          y: aurora.aurora_content_y(entry.index),
          width: aurora.aurora_content_width(entry.index),
          height: aurora.aurora_content_height(entry.index),
          borderWidth: 0,
        });
      }
    }
    if (event.name === "DestroyNotify" && event.wid) {
      managed.delete(event.wid);
      refreshWindows();
    }
  });

  layout.forEach((spec, index) => {
    const windowId = callX(app, "AllocID") as number;
    const gc = callX(app, "AllocID") as number;
    managed.set(windowId, { index, spec, gc });
    callX(app, "CreateWindow", windowId, root, 0, 0, spec.contentWidth, spec.contentHeight, 0, 0, 0, 0, {
      backgroundPixel: spec.background,
      eventMask: (eventMask.Exposure ?? 0) | (eventMask.ButtonPress ?? 0),
    });
    callX(app, "CreateGC", gc, windowId, { foreground: spec.accent, background: spec.background });
    callX(app, "MapWindow", windowId);
  });

  app.on("event", (value) => {
    const event = value as X11Event;
    if (event.name === "Expose" && event.wid) {
      const entry = managed.get(event.wid);
      if (entry) drawClientWindow(app, event.wid, entry.gc, entry.spec);
    }
    if (event.name === "ButtonPress" && event.wid) {
      const entry = managed.get(event.wid);
      if (entry) {
        aurora.aurora_pointer_down(entry.spec.contentX + 8, entry.spec.contentY + 8);
        callX(app, "SetInputFocus", event.wid, 0);
        markDirty();
        refreshWindows();
      }
    }
  });

  const xserverRunning = xserver?.xserver_is_running() === 1;
  const auroraRunning = aurora.aurora_is_running() === 1;
  onStatus(
    auroraRunning && xserverRunning
      ? "running · Xserver + Aurora WM + Aurora Files · DISPLAY=:0"
      : auroraRunning
        ? "running · Aurora WM + Aurora Files · DISPLAY=:0"
        : "failed · desktop modules did not start",
  );

  // Font glyph rasterization is expensive; redraw Aurora chrome on state changes /
  // ~2.5 Hz for the topbar pulse, not every animation frame.
  const paintAurora = (now: number, force = false) => {
    const active = aurora.aurora_active_window();
    if (!force && !paintState.dirty && active === paintState.lastActive && now - paintState.lastPaint < 400) {
      return;
    }
    paintState.dirty = false;
    paintState.lastActive = active;
    paintState.lastPaint = now;
    aurora.aurora_tick(now);
    aurora.aurora_render(now);
    if (xserver) {
      syncWindowsToXserver(aurora, xserver, layout.length);
      xserver.xserver_render(now);
    }
  };
  paintAurora(0, true);

  const render = () => {
    if (stopped) return;
    const now = Math.round(performance.now()) >>> 0;
    paintAurora(now);
    server.compose();
    const byteLength = DISPLAY_WIDTH * DISPLAY_HEIGHT * 4;
    const auroraPixels = new Uint8Array(
      aurora.memory.buffer,
      aurora.aurora_frame_ptr(),
      Math.min(byteLength, aurora.aurora_frame_len()),
    );
    presenter.present(auroraPixels);
    requestAnimationFrame(render);
  };
  const animationFrame = requestAnimationFrame(render);

  return {
    server,
    wm,
    app,
    aurora,
    xserver,
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

export function WebDesktop({ startSignal, onRunning, workspaceFiles = {} }: WebDesktopProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const webGpuCanvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<X11Runtime | null>(null);
  const onRunningRef = useRef(onRunning);
  const workspaceFilesRef = useRef(workspaceFiles);
  const [status, setStatus] = useState("idle · press start above");
  const [backend, setBackend] = useState("not started");
  const [windows, setWindows] = useState<WindowSpec[]>([]);
  const [pointer, setPointer] = useState({ x: DISPLAY_WIDTH / 2, y: DISPLAY_HEIGHT / 2 });

  useEffect(() => {
    onRunningRef.current = onRunning;
  }, [onRunning]);

  useEffect(() => {
    workspaceFilesRef.current = workspaceFiles;
  }, [workspaceFiles]);

  useEffect(() => {
    if (startSignal === 0) return;
    let cancelled = false;
    const start = async () => {
      runtimeRef.current?.stop();
      runtimeRef.current = null;
      onRunningRef.current(false);
      setStatus("starting Aurora WM + Aurora Files…");
      setBackend("initializing");
      const canvas = canvasRef.current;
      const webGpuCanvas = webGpuCanvasRef.current;
      if (!canvas || !webGpuCanvas) throw new Error("display canvases are not mounted");
      const runtime = await startX11Runtime(
        canvas,
        webGpuCanvas,
        setStatus,
        setWindows,
        workspaceFilesRef.current,
      );
      if (cancelled) {
        runtime.stop();
        return;
      }
      runtimeRef.current = runtime;
      const xserverLabel = runtime.xserver ? "Xserver WASM compositor" : "JS X11 protocol only";
      setBackend(
        runtime.presenter.kind === "webgpu"
          ? `WebGPU · ${xserverLabel} · Aurora WM`
          : runtime.presenter.kind === "wasm-canvas2d"
            ? `Canvas2D · ${xserverLabel} · Aurora WM`
            : `Canvas 2D fallback · ${xserverLabel}`,
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
    runtime.xserver?.xserver_input_pointer(x, y, event.buttons);
    return { runtime, x, y };
  };

  const handlePointer = (event: PointerEvent<HTMLCanvasElement>, pressed: boolean) => {
    const position = pointerPosition(event);
    if (!position) return;
    const { runtime } = position;
    if (pressed) {
      runtime.aurora.aurora_pointer_down(position.x, position.y);
      runtime.aurora.aurora_render(Math.round(performance.now()) >>> 0);
      runtime.server.injectButton(event.button + 1, true);
    } else {
      runtime.server.injectButton(event.button + 1, false);
    }
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
          <p className="eyebrow">LIVE DISPLAY · DISPLAY=:0 · ecooxai/aurora-wm</p>
          <h2>Real X11 server + Aurora WM</h2>
        </div>
        <span className={"desktop-status " + (status.startsWith("running") ? "running" : "")}>{status}</span>
      </div>
      <p className="web-desktop-intro">
        Aurora WM auto-starts <strong>Aurora Files</strong> on session boot (same idea as upstream
        <code> show_folder </code>/<code> aurora-files </code>
        ). The Files window lists the live <code>/workspace</code> browser filesystem with Places,
        toolbar, and selectable rows. Built from{" "}
        <a href="https://github.com/ecooxai/aurora-wm" target="_blank" rel="noreferrer">
          ecooxai/aurora-wm
        </a>
        .
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
        <span>{windows.length} managed X11 clients · Aurora Files auto-start</span>
        <span>MapRequest · show_folder on boot</span>
      </div>
    </section>
  );
}
