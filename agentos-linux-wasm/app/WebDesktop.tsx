"use client";

import "./buffer-polyfill";
import { useEffect, useRef, useState } from "react";
import x11 from "x11";
import { XServer, createStreamPair } from "x11/lib/xserver/index.js";
import { startAuroraHtop, type AuroraHtopSession } from "./auroraHtop";
import { openDuckDuckGoHome, searchDuckDuckGo } from "./netsurfBrowse";

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
  aurora_pointer_move: WasmCall;
  aurora_pointer_up: WasmCall;
  aurora_is_dragging: WasmCall;
  aurora_drag_index: WasmCall;
  aurora_handle_key: WasmCall;
  aurora_map_request: WasmCall;
  aurora_layout_version: WasmCall;
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
  aurora_term_show: WasmCall;
  aurora_term_visible: WasmCall;
  aurora_term_clear: WasmCall;
  aurora_term_line_buf: WasmCall;
  aurora_term_line_cap: WasmCall;
  aurora_term_add_line: WasmCall;
  aurora_netsurf_show: WasmCall;
  aurora_netsurf_visible: WasmCall;
  aurora_netsurf_index: WasmCall;
  aurora_term_index: WasmCall;
};

type NetsurfModule = {
  memory: WebAssembly.Memory;
  netsurf_init: WasmCall;
  netsurf_frame_ptr: WasmCall;
  netsurf_frame_len: WasmCall;
  netsurf_width: WasmCall;
  netsurf_height: WasmCall;
  netsurf_is_running: WasmCall;
  netsurf_render: WasmCall;
  netsurf_address_buf: WasmCall;
  netsurf_address_cap: WasmCall;
  netsurf_commit_address: WasmCall;
  netsurf_commit_title: WasmCall;
  netsurf_clear_lines: WasmCall;
  netsurf_line_buf: WasmCall;
  netsurf_line_cap: WasmCall;
  netsurf_add_line: WasmCall;
  netsurf_set_mode: WasmCall;
  netsurf_mode: WasmCall;
  netsurf_query_buf: WasmCall;
  netsurf_query_cap: WasmCall;
  netsurf_set_query: WasmCall;
  netsurf_query_len: WasmCall;
  netsurf_clear_results: WasmCall;
  netsurf_add_result: WasmCall;
  netsurf_result_count: WasmCall;
  netsurf_search_x: WasmCall;
  netsurf_search_y: WasmCall;
  netsurf_search_w: WasmCall;
  netsurf_search_h: WasmCall;
  netsurf_pointer_down: WasmCall;
  netsurf_key: WasmCall;
  netsurf_set_status: WasmCall;
  netsurf_focus_search: WasmCall;
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
  netsurf: NetsurfModule | null;
  presenter: Presenter;
  animationFrame: number;
  htop: AuroraHtopSession | null;
  syncManagedGeometry: () => void;
  markDirty: () => void;
  submitNetsurfSearch: () => Promise<void>;
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
  aurora.aurora_files_show(1);
}

function syncAuroraTerminal(aurora: AuroraModule, lines: string[]): void {
  aurora.aurora_term_clear();
  for (const line of lines) {
    const len = writeWasmString(
      aurora.memory,
      aurora.aurora_term_line_buf(),
      aurora.aurora_term_line_cap(),
      line.slice(0, 90),
    );
    aurora.aurora_term_add_line(len);
  }
  aurora.aurora_term_show(1);
}

async function loadNetsurf(contentWidth: number, contentHeight: number): Promise<NetsurfModule | null> {
  try {
    const response = await fetch("/wasm/netsurf-web.wasm");
    if (!response.ok) throw new Error(`NetSurf WASM HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const instance = (await WebAssembly.instantiate(bytes, {})).instance;
    const exports = instance.exports as unknown as Record<string, unknown>;
    const memory = exports.memory as WebAssembly.Memory | undefined;
    if (!(memory instanceof WebAssembly.Memory)) throw new Error("NetSurf memory missing");
    const netsurf: NetsurfModule = {
      memory,
      netsurf_init: requiredExport(exports, "netsurf_init"),
      netsurf_frame_ptr: requiredExport(exports, "netsurf_frame_ptr"),
      netsurf_frame_len: requiredExport(exports, "netsurf_frame_len"),
      netsurf_width: requiredExport(exports, "netsurf_width"),
      netsurf_height: requiredExport(exports, "netsurf_height"),
      netsurf_is_running: requiredExport(exports, "netsurf_is_running"),
      netsurf_render: requiredExport(exports, "netsurf_render"),
      netsurf_address_buf: requiredExport(exports, "netsurf_address_buf"),
      netsurf_address_cap: requiredExport(exports, "netsurf_address_cap"),
      netsurf_commit_address: requiredExport(exports, "netsurf_commit_address"),
      netsurf_commit_title: requiredExport(exports, "netsurf_commit_title"),
      netsurf_clear_lines: requiredExport(exports, "netsurf_clear_lines"),
      netsurf_line_buf: requiredExport(exports, "netsurf_line_buf"),
      netsurf_line_cap: requiredExport(exports, "netsurf_line_cap"),
      netsurf_add_line: requiredExport(exports, "netsurf_add_line"),
      netsurf_set_mode: optionalExport(exports, "netsurf_set_mode"),
      netsurf_mode: optionalExport(exports, "netsurf_mode"),
      netsurf_query_buf: optionalExport(exports, "netsurf_query_buf", requiredExport(exports, "netsurf_address_buf")),
      netsurf_query_cap: optionalExport(exports, "netsurf_query_cap", () => 160),
      netsurf_set_query: optionalExport(exports, "netsurf_set_query"),
      netsurf_query_len: optionalExport(exports, "netsurf_query_len"),
      netsurf_clear_results: optionalExport(exports, "netsurf_clear_results"),
      netsurf_add_result: optionalExport(exports, "netsurf_add_result"),
      netsurf_result_count: optionalExport(exports, "netsurf_result_count"),
      netsurf_search_x: optionalExport(exports, "netsurf_search_x"),
      netsurf_search_y: optionalExport(exports, "netsurf_search_y"),
      netsurf_search_w: optionalExport(exports, "netsurf_search_w"),
      netsurf_search_h: optionalExport(exports, "netsurf_search_h"),
      netsurf_pointer_down: optionalExport(exports, "netsurf_pointer_down"),
      netsurf_key: optionalExport(exports, "netsurf_key"),
      netsurf_set_status: optionalExport(exports, "netsurf_set_status"),
      netsurf_focus_search: optionalExport(exports, "netsurf_focus_search"),
    };
    netsurf.netsurf_init(Math.max(320, contentWidth), Math.max(200, contentHeight));
    return netsurf;
  } catch {
    return null;
  }
}

function blitNetsurfIntoAurora(aurora: AuroraModule, netsurf: NetsurfModule): void {
  const index = aurora.aurora_netsurf_index();
  const dx = aurora.aurora_content_x(index);
  const dy = aurora.aurora_content_y(index);
  const dw = aurora.aurora_content_width(index);
  const dh = aurora.aurora_content_height(index);
  if (dw <= 0 || dh <= 0) return;
  netsurf.netsurf_render(Math.round(performance.now()) >>> 0);
  const sw = netsurf.netsurf_width();
  const sh = netsurf.netsurf_height();
  const src = new Uint8Array(netsurf.memory.buffer, netsurf.netsurf_frame_ptr(), netsurf.netsurf_frame_len());
  const dst = new Uint8Array(aurora.memory.buffer, aurora.aurora_frame_ptr(), aurora.aurora_frame_len());
  const copyW = Math.min(dw, sw);
  const copyH = Math.min(dh, sh);
  for (let y = 0; y < copyH; y += 1) {
    const srcOffset = y * sw * 4;
    const dstOffset = ((dy + y) * DISPLAY_WIDTH + dx) * 4;
    dst.set(src.subarray(srcOffset, srcOffset + copyW * 4), dstOffset);
  }
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

function optionalExport(exports: Record<string, unknown>, name: string, fallback: WasmCall = () => 0): WasmCall {
  const fn = exports[name] as WasmCall | undefined;
  return typeof fn === "function" ? fn : fallback;
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
    aurora_pointer_move: requiredExport(exports, "aurora_pointer_move"),
    aurora_pointer_up: requiredExport(exports, "aurora_pointer_up"),
    aurora_is_dragging: requiredExport(exports, "aurora_is_dragging"),
    aurora_drag_index: requiredExport(exports, "aurora_drag_index"),
    aurora_handle_key: requiredExport(exports, "aurora_handle_key"),
    aurora_map_request: requiredExport(exports, "aurora_map_request"),
    aurora_layout_version: requiredExport(exports, "aurora_layout_version"),
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
    aurora_term_show: requiredExport(exports, "aurora_term_show"),
    aurora_term_visible: requiredExport(exports, "aurora_term_visible"),
    aurora_term_clear: requiredExport(exports, "aurora_term_clear"),
    aurora_term_line_buf: requiredExport(exports, "aurora_term_line_buf"),
    aurora_term_line_cap: requiredExport(exports, "aurora_term_line_cap"),
    aurora_term_add_line: requiredExport(exports, "aurora_term_add_line"),
    aurora_netsurf_show: requiredExport(exports, "aurora_netsurf_show"),
    aurora_netsurf_visible: requiredExport(exports, "aurora_netsurf_visible"),
    aurora_netsurf_index: requiredExport(exports, "aurora_netsurf_index"),
    aurora_term_index: requiredExport(exports, "aurora_term_index"),
  };

  requiredExport(exports, "aurora_init")(DISPLAY_WIDTH, DISPLAY_HEIGHT);
  if (aurora.aurora_is_running() !== 1) throw new Error("Aurora WM failed to enter running state");

  const count = requiredExport(exports, "aurora_window_count")();
  const names = ["Aurora Terminal", "NetSurf", "Aurora Files"];
  const palettes = [
    { background: 0x18242a, accent: 0x73ded2, lines: ["Aurora Terminal", "ecooxai/aurora-wm", "PTY bridge ready", "$"] },
    { background: 0xf8fafc, accent: 0x1464a0, lines: ["NetSurf", "framebuffer WASM", "netsurf-browser/netsurf", "auto-start"] },
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
  // Boot the same session apps a real Aurora desktop would: Files + Terminal,
  // plus NetSurf compiled to WASM for the in-tab Xserver.
  syncAuroraFiles(aurora, workspaceFiles, "/workspace");
  syncAuroraTerminal(aurora, [
    "Aurora Terminal",
    "compiled from ecooxai/aurora-wm terminal UI",
    "booting real htop.wasm (upstream ncurses)…",
    "$ htop",
  ]);
  aurora.aurora_netsurf_show(1);
  aurora.aurora_term_show(1);
  aurora.aurora_files_show(1);
  if (aurora.aurora_files_visible() !== 1 || aurora.aurora_term_visible() !== 1) {
    throw new Error("Aurora Terminal/Files failed to start with the WM session");
  }
  aurora.aurora_render(0);
  onWindows(readLayout(aurora, layout));

  onStatus("loading NetSurf WASM · opening DuckDuckGo…");
  const netsurfIndex = aurora.aurora_netsurf_index();
  const netsurf = await loadNetsurf(
    aurora.aurora_content_width(netsurfIndex),
    aurora.aurora_content_height(netsurfIndex),
  );
  if (netsurf) {
    await openDuckDuckGoHome(netsurf);
    aurora.aurora_netsurf_show(1);
    // Focus NetSurf content so keyboard goes to DuckDuckGo search immediately.
    const focusX = aurora.aurora_content_x(netsurfIndex) + Math.floor(aurora.aurora_content_width(netsurfIndex) / 2);
    const focusY = aurora.aurora_content_y(netsurfIndex) + Math.floor(aurora.aurora_content_height(netsurfIndex) / 2);
    aurora.aurora_pointer_down(focusX, focusY);
    aurora.aurora_pointer_up();
    netsurf.netsurf_focus_search(1);
  }

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
  let htopSession: AuroraHtopSession | null = null;
  const paintState = {
    lastPaint: -1,
    lastActive: aurora.aurora_active_window(),
    lastLayout: aurora.aurora_layout_version(),
    dirty: true,
  };
  const markDirty = () => {
    paintState.dirty = true;
  };

  const syncManagedGeometry = () => {
    for (const [wid, entry] of managed) {
      const content = {
        x: aurora.aurora_content_x(entry.index),
        y: aurora.aurora_content_y(entry.index),
        width: aurora.aurora_content_width(entry.index),
        height: aurora.aurora_content_height(entry.index),
      };
      const frame = {
        x: aurora.aurora_window_x(entry.index),
        y: aurora.aurora_window_y(entry.index),
        width: aurora.aurora_window_width(entry.index),
        height: aurora.aurora_window_height(entry.index),
      };
      callX(wm, "ConfigureWindow", wid, {
        x: content.x,
        y: content.y,
        width: content.width,
        height: content.height,
        borderWidth: 0,
      });
      entry.spec = {
        ...entry.spec,
        ...frame,
        contentX: content.x,
        contentY: content.y,
        contentWidth: content.width,
        contentHeight: content.height,
      };
    }
  };

  const refreshWindows = () => {
    currentLayout = readLayout(aurora, layout);
    onWindows(currentLayout);
    syncManagedGeometry();
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
  const netsurfRunning = netsurf?.netsurf_is_running() === 1;

  // Real Linux htop compiled to WASM — runs inside Aurora Terminal on session boot.
  const termIndex = aurora.aurora_term_index();
  const termCols = Math.max(40, Math.floor(aurora.aurora_content_width(termIndex) / 7) - 2);
  const termRows = Math.max(8, Math.floor((aurora.aurora_content_height(termIndex) - 34) / 16));
  htopSession = startAuroraHtop(aurora, {
    cols: termCols,
    rows: termRows,
    onUpdate: () => {
      markDirty();
    },
    onStatus: (text) => {
      if (!stopped) onStatus(`${text} · drag titlebars · DISPLAY=:0`);
    },
  });
  // Focus the terminal content (not titlebar) so htop is visible without starting a drag.
  aurora.aurora_pointer_down(
    aurora.aurora_content_x(termIndex) + 8,
    aurora.aurora_content_y(termIndex) + 8,
  );
  aurora.aurora_pointer_up();

  const submitNetsurfSearch = async () => {
    if (!netsurf) return;
    const queryLen = netsurf.netsurf_query_len();
    const ptr = netsurf.netsurf_query_buf();
    const bytes = new Uint8Array(netsurf.memory.buffer, ptr, Math.max(0, queryLen));
    const query = new TextDecoder().decode(bytes);
    try {
      await searchDuckDuckGo(netsurf, query);
    } catch (error) {
      const message = error instanceof Error ? error.message : "search failed";
      const status = `DuckDuckGo search failed · ${message}`;
      const len = writeWasmString(
        netsurf.memory,
        netsurf.netsurf_address_buf(),
        netsurf.netsurf_address_cap(),
        status,
      );
      netsurf.netsurf_set_status(len);
    }
    markDirty();
  };

  onStatus(
    auroraRunning && netsurfRunning
      ? `running · click/drag/type enabled · DuckDuckGo + htop · ${xserverRunning ? "Xserver WASM" : "JS X11"} · DISPLAY=:0`
      : auroraRunning
        ? "running · click/drag/type enabled · htop · DISPLAY=:0"
        : "failed · desktop modules did not start",
  );

  // Font glyph rasterization is expensive; redraw Aurora chrome on state changes /
  // ~2.5 Hz for the topbar pulse, not every animation frame. Dragging always paints.
  const paintAurora = (now: number, force = false) => {
    const active = aurora.aurora_active_window();
    const layoutVersion = aurora.aurora_layout_version();
    const dragging = aurora.aurora_is_dragging() === 1;
    if (
      !force &&
      !paintState.dirty &&
      !dragging &&
      active === paintState.lastActive &&
      layoutVersion === paintState.lastLayout &&
      now - paintState.lastPaint < 400
    ) {
      return;
    }
    paintState.dirty = false;
    paintState.lastActive = active;
    paintState.lastLayout = layoutVersion;
    paintState.lastPaint = now;
    aurora.aurora_tick(now);
    aurora.aurora_render(now);
    if (netsurf) blitNetsurfIntoAurora(aurora, netsurf);
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
    // Keep NetSurf framebuffer live even between Aurora dirty paints.
    if (netsurf) blitNetsurfIntoAurora(aurora, netsurf);
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
    netsurf,
    presenter,
    animationFrame,
    htop: htopSession,
    syncManagedGeometry,
    markDirty,
    submitNetsurfSearch,
    stop: () => {
      stopped = true;
      htopSession?.stop();
      htopSession = null;
      cancelAnimationFrame(animationFrame);
      presenter.dispose?.();
      wm.terminate();
      app.terminate();
    },
  };
}

function keysymFromDomKey(event: KeyboardEvent): number | null {
  if (event.key.length === 1) return event.key.charCodeAt(0);
  switch (event.key) {
    case "Backspace":
      return 0xff08;
    case "Tab":
      return 0xff09;
    case "Enter":
      return 0xff0d;
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
    default:
      return null;
  }
}

export function WebDesktop({ startSignal, onRunning, workspaceFiles = {} }: WebDesktopProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const webGpuCanvasRef = useRef<HTMLCanvasElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<X11Runtime | null>(null);
  const onRunningRef = useRef(onRunning);
  const workspaceFilesRef = useRef(workspaceFiles);
  const [status, setStatus] = useState("idle · press start above");
  const [backend, setBackend] = useState("not started");
  const [windows, setWindows] = useState<WindowSpec[]>([]);
  const [pointer, setPointer] = useState({ x: DISPLAY_WIDTH / 2, y: DISPLAY_HEIGHT / 2 });
  const pointerRef = useRef({ x: DISPLAY_WIDTH / 2, y: DISPLAY_HEIGHT / 2 });
  const netsurfTypingRef = useRef(false);
  const [inputHint, setInputHint] = useState("click the display to focus keyboard + mouse");

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
      setStatus("starting Aurora Terminal + DuckDuckGo + Files…");
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
      const xserverLabel = runtime.xserver ? "Xserver WASM" : "JS X11";
      const netsurfLabel = runtime.netsurf ? "NetSurf · DuckDuckGo" : "NetSurf unavailable";
      setBackend(
        runtime.presenter.kind === "webgpu"
          ? `WebGPU · ${xserverLabel} · ${netsurfLabel}`
          : `Canvas2D · ${xserverLabel} · ${netsurfLabel}`,
      );
      onRunningRef.current(true);
      shellRef.current?.focus({ preventScroll: true });
      setInputHint("focused · drag titlebars · type in DuckDuckGo search");
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

  // Native listeners on the shell so WebGPU overlay never eats click/drag/type.
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;

    const mapCoords = (event: PointerEvent) => {
      const bounds = shell.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return null;
      const x = Math.max(
        0,
        Math.min(DISPLAY_WIDTH - 1, Math.round(((event.clientX - bounds.left) * DISPLAY_WIDTH) / bounds.width)),
      );
      const y = Math.max(
        0,
        Math.min(DISPLAY_HEIGHT - 1, Math.round(((event.clientY - bounds.top) * DISPLAY_HEIGHT) / bounds.height)),
      );
      return { x, y };
    };

    const netsurfContentAt = (runtime: X11Runtime, x: number, y: number) => {
      const index = runtime.aurora.aurora_netsurf_index();
      const cx = runtime.aurora.aurora_content_x(index);
      const cy = runtime.aurora.aurora_content_y(index);
      const cw = runtime.aurora.aurora_content_width(index);
      const ch = runtime.aurora.aurora_content_height(index);
      if (x < cx || y < cy || x >= cx + cw || y >= cy + ch) return null;
      return { index, cx, cy, cw, ch };
    };

    const routeNetsurfPointer = (runtime: X11Runtime, x: number, y: number) => {
      const netsurf = runtime.netsurf;
      const content = netsurfContentAt(runtime, x, y);
      if (!netsurf || !content) return 0;
      const localX = Math.floor(((x - content.cx) * netsurf.netsurf_width()) / Math.max(1, content.cw));
      const localY = Math.floor(((y - content.cy) * netsurf.netsurf_height()) / Math.max(1, content.ch));
      return netsurf.netsurf_pointer_down(localX, localY);
    };

    const onPointerDown = (event: PointerEvent) => {
      const runtime = runtimeRef.current;
      const coords = mapCoords(event);
      if (!runtime || !coords) return;
      event.preventDefault();
      shell.focus({ preventScroll: true });
      try {
        shell.setPointerCapture(event.pointerId);
      } catch {
        // ignore capture failures
      }
      pointerRef.current = coords;
      setPointer(coords);
      runtime.server.injectPointerMove(coords.x, coords.y);
      runtime.xserver?.xserver_input_pointer(coords.x, coords.y, event.buttons || 1);
      runtime.aurora.aurora_pointer_down(coords.x, coords.y);
      const inNetsurfContent = !!netsurfContentAt(runtime, coords.x, coords.y);
      const hit = routeNetsurfPointer(runtime, coords.x, coords.y);
      // Any click inside NetSurf page content arms keyboard → DuckDuckGo search box.
      netsurfTypingRef.current = inNetsurfContent || hit === 1 || hit === 2;
      if (netsurfTypingRef.current) {
        runtime.netsurf?.netsurf_focus_search(1);
        setInputHint("NetSurf typing armed · type query, Enter to search DuckDuckGo");
      } else {
        setInputHint("pointer down · drag titlebar to move");
      }
      if (hit === 2) void runtime.submitNetsurfSearch();
      runtime.server.injectButton(event.button + 1, true);
      runtime.markDirty();
      runtime.aurora.aurora_render(Math.round(performance.now()) >>> 0);
    };

    const onPointerMove = (event: PointerEvent) => {
      const runtime = runtimeRef.current;
      const coords = mapCoords(event);
      if (!runtime || !coords) return;
      pointerRef.current = coords;
      setPointer(coords);
      runtime.server.injectPointerMove(coords.x, coords.y);
      runtime.xserver?.xserver_input_pointer(coords.x, coords.y, event.buttons);
      if ((event.buttons & 1) === 0 && runtime.aurora.aurora_is_dragging() !== 1) return;
      event.preventDefault();
      const moved = runtime.aurora.aurora_pointer_move(coords.x, coords.y);
      if (moved === 1 || runtime.aurora.aurora_is_dragging() === 1) {
        runtime.syncManagedGeometry();
        runtime.markDirty();
        runtime.aurora.aurora_render(Math.round(performance.now()) >>> 0);
        setInputHint(`dragging window ${runtime.aurora.aurora_drag_index()} · ${coords.x},${coords.y}`);
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      const runtime = runtimeRef.current;
      const coords = mapCoords(event);
      if (!runtime) return;
      if (coords) {
        pointerRef.current = coords;
        setPointer(coords);
        runtime.server.injectPointerMove(coords.x, coords.y);
        runtime.xserver?.xserver_input_pointer(coords.x, coords.y, 0);
      }
      runtime.aurora.aurora_pointer_up();
      runtime.syncManagedGeometry();
      runtime.server.injectButton(event.button + 1, false);
      runtime.markDirty();
      try {
        shell.releasePointerCapture(event.pointerId);
      } catch {
        // ignore
      }
      setInputHint("focused · drag titlebars · type in DuckDuckGo");
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      const keysym = keysymFromDomKey(event);
      if (keysym === null) return;
      event.preventDefault();
      event.stopPropagation();

      runtime.aurora.aurora_handle_key(keysym <= 0xff ? keysym : keysym & 0xff);
      const netsurf = runtime.netsurf;
      const netsurfIndex = runtime.aurora.aurora_netsurf_index();
      const netsurfActive =
        netsurfTypingRef.current || runtime.aurora.aurora_active_window() === netsurfIndex;
      if (netsurf && netsurfActive) {
        netsurfTypingRef.current = true;
        netsurf.netsurf_focus_search(1);
        let code = 0;
        if (event.key === "Backspace") code = 8;
        else if (event.key === "Enter") code = 13;
        else if (event.key.length === 1) code = event.key.charCodeAt(0);
        if (code) {
          const result = netsurf.netsurf_key(code);
          const now = Math.round(performance.now()) >>> 0;
          netsurf.netsurf_render(now);
          runtime.markDirty();
          runtime.aurora.aurora_render(now);
          const qLen = netsurf.netsurf_query_len();
          setInputHint(`NetSurf query (${qLen} chars) · key ${event.key}`);
          if (result === 2) void runtime.submitNetsurfSearch();
        }
      } else {
        setInputHint(`key ${event.key} → X11 · click DuckDuckGo to type`);
      }

      const keycode = runtime.server.keymap.keycodeForKeysym(keysym)
        || (event.key.length === 1 ? runtime.server.keymap.keycodeForKeysym(event.key.charCodeAt(0)) : 0);
      if (keycode) runtime.server.injectKey(keycode, true);
      const pos = pointerRef.current;
      runtime.xserver?.xserver_input_pointer(pos.x, pos.y, 0);
      const xserver = runtime.xserver as (XserverModule & { xserver_input_key?: WasmCall }) | null;
      xserver?.xserver_input_key?.(keysym);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      const keysym = keysymFromDomKey(event);
      if (keysym === null) return;
      event.preventDefault();
      const keycode = runtime.server.keymap.keycodeForKeysym(keysym)
        || (event.key.length === 1 ? runtime.server.keymap.keycodeForKeysym(event.key.charCodeAt(0)) : 0);
      if (keycode) runtime.server.injectKey(keycode, false);
    };

    const onContextMenu = (event: Event) => event.preventDefault();

    shell.addEventListener("pointerdown", onPointerDown);
    shell.addEventListener("pointermove", onPointerMove);
    shell.addEventListener("pointerup", onPointerUp);
    shell.addEventListener("pointercancel", onPointerUp);
    shell.addEventListener("keydown", onKeyDown);
    shell.addEventListener("keyup", onKeyUp);
    shell.addEventListener("contextmenu", onContextMenu);

    return () => {
      shell.removeEventListener("pointerdown", onPointerDown);
      shell.removeEventListener("pointermove", onPointerMove);
      shell.removeEventListener("pointerup", onPointerUp);
      shell.removeEventListener("pointercancel", onPointerUp);
      shell.removeEventListener("keydown", onKeyDown);
      shell.removeEventListener("keyup", onKeyUp);
      shell.removeEventListener("contextmenu", onContextMenu);
    };
  }, []);

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
        Click the display to focus. <strong>Drag titlebars</strong> to move windows.{" "}
        <strong>Type</strong> into DuckDuckGo in NetSurf. Session also runs <strong>htop.wasm</strong> in
        Aurora Terminal.
      </p>
      <div
        ref={shellRef}
        className="web-display-shell"
        tabIndex={0}
        role="application"
        aria-label="X11 screen · keyboard and mouse input"
      >
        <canvas ref={canvasRef} className="web-display-canvas" aria-hidden="true" />
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
        <span>{windows.length} clients · DDG + htop + Files</span>
        <span>{inputHint}</span>
      </div>
    </section>
  );
}
