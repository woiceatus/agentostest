/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const NETWORK_SOCKET_PATH = "/__agentos/ws";
const MAX_PROXY_REQUEST_BYTES = 1024 * 1024;
const MAX_PROXY_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PROXY_REDIRECTS = 5;
const PROXY_TIMEOUT_MS = 30_000;

type NetworkRequestMessage = {
  type: "request";
  id: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

type NetworkCancelMessage = {
  type: "cancel";
  id: string;
};

type NetworkSocketMessage = NetworkRequestMessage | NetworkCancelMessage;

type WebSocketPairLike = {
  0: WebSocket;
  1: WebSocket & { accept(): void };
};

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function sendSocketMessage(socket: WebSocket, message: Record<string, unknown>): void {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // A closed terminal can race with the final response chunk.
  }
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal" ||
    host === "metadata" ||
    host === "instance-data.ec2.internal"
  ) return true;

  const octets = host.split(".");
  if (octets.length === 4 && octets.every((octet) => /^\d+$/.test(octet))) {
    const [first, second] = octets.map(Number);
    if (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127)
    ) return true;
  }

  return (
    host === "::" ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80:")
  );
}

function validateTarget(rawUrl: string): URL {
  const target = new URL(rawUrl);
  if (!(["http:", "https:"].includes(target.protocol))) {
    throw new Error("only http:// and https:// URLs are allowed");
  }
  if (target.username || target.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }
  if (target.port && !["80", "443"].includes(target.port)) {
    throw new Error("only ports 80 and 443 are allowed");
  }
  if (isBlockedHostname(target.hostname)) {
    throw new Error("private and local network targets are blocked");
  }
  return target;
}

function requestHeaders(input: Record<string, string> | undefined): Headers {
  const headers = new Headers();
  const blocked = new Set([
    "authorization",
    "connection",
    "cookie",
    "host",
    "proxy-authorization",
    "transfer-encoding",
    "upgrade",
  ]);
  for (const [key, value] of Object.entries(input ?? {})) {
    if (blocked.has(key.toLowerCase())) continue;
    if (typeof value !== "string" || value.length > 4096) continue;
    headers.set(key, value);
  }
  headers.set("user-agent", "AgentOS-browser-vm/1.0");
  return headers;
}

function parseNetworkSocketMessage(data: unknown): NetworkSocketMessage | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as Partial<NetworkSocketMessage>;
    if (parsed.type === "cancel" && typeof parsed.id === "string") {
      return { type: "cancel", id: parsed.id };
    }
    if (
      parsed.type === "request" &&
      typeof parsed.id === "string" &&
      typeof parsed.url === "string" &&
      parsed.id.length <= 96 &&
      parsed.url.length <= 4096
    ) {
      return {
        type: "request",
        id: parsed.id,
        url: parsed.url,
        method: typeof parsed.method === "string" ? parsed.method : "GET",
        headers: parsed.headers,
        body: parsed.body,
      };
    }
  } catch {
    return null;
  }
  return null;
}

type NetworkFetchResult = {
  target: URL;
  method: string;
  response: Response;
};

async function fetchNetworkResponse(
  request: NetworkRequestMessage,
  controller: AbortController,
): Promise<NetworkFetchResult> {
  let target = validateTarget(request.url);
  const method = (request.method ?? "GET").toUpperCase();
  if (!["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"].includes(method)) {
    throw new Error(`unsupported HTTP method: ${method}`);
  }
  if ((request.body?.length ?? 0) > MAX_PROXY_REQUEST_BYTES) {
    throw new Error("request body is too large");
  }

  let response: Response | null = null;
  for (let redirect = 0; redirect <= MAX_PROXY_REDIRECTS; redirect += 1) {
    response = await fetch(target, {
      method,
      headers: requestHeaders(request.headers),
      body: method === "GET" || method === "HEAD" ? undefined : request.body,
      redirect: "manual",
      signal: controller.signal,
    });
    const location = response.headers.get("location");
    if (!location || ![301, 302, 303, 307, 308].includes(response.status)) break;
    if (redirect === MAX_PROXY_REDIRECTS) throw new Error("too many redirects");
    target = validateTarget(new URL(location, target).href);
  }
  if (!response) throw new Error("network request did not return a response");
  return { target, method, response };
}

async function streamNetworkRequest(
  socket: WebSocket,
  request: NetworkRequestMessage,
  controllers: Map<string, AbortController>,
): Promise<void> {
  const controller = new AbortController();
  controllers.set(request.id, controller);
  const timeout = setTimeout(() => controller.abort("request timed out"), PROXY_TIMEOUT_MS);
  try {
    const { target, method, response } = await fetchNetworkResponse(request, controller);

    sendSocketMessage(socket, {
      type: "response",
      id: request.id,
      url: target.href,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
    });

    if (method === "HEAD" || !response.body) {
      sendSocketMessage(socket, { type: "end", id: request.id });
      return;
    }

    const reader = response.body.getReader();
    let totalBytes = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const value = result.value;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_PROXY_RESPONSE_BYTES) {
        await reader.cancel("response too large");
        throw new Error("response exceeded the 8 MiB proxy limit");
      }
      sendSocketMessage(socket, {
        type: "chunk",
        id: request.id,
        data: encodeBase64(value),
      });
    }
    sendSocketMessage(socket, { type: "end", id: request.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendSocketMessage(socket, {
      type: "error",
      id: request.id,
      message: controller.signal.aborted ? "request cancelled or timed out" : message,
    });
  } finally {
    clearTimeout(timeout);
    controllers.delete(request.id);
  }
}

async function handleNetworkHttpProxy(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("AgentOS HTTP network proxy expects POST.\n", { status: 405 });
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_PROXY_REQUEST_BYTES + 8192) {
    return new Response(JSON.stringify({ error: "proxy request is too large" }), {
      status: 413,
      headers: { "content-type": "application/json" },
    });
  }

  let message: NetworkSocketMessage | null = null;
  try {
    const body = await request.text();
    if (body.length > MAX_PROXY_REQUEST_BYTES + 8192) throw new Error("proxy request is too large");
    message = parseNetworkSocketMessage(body);
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  if (!message || message.type !== "request") {
    return new Response(JSON.stringify({ error: "invalid proxy request" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("request timed out"), PROXY_TIMEOUT_MS);
  try {
    const { target, method, response } = await fetchNetworkResponse(message, controller);
    const responseHeaders = new Headers({
      "cache-control": "no-store",
      "content-type": "application/octet-stream",
      "x-agentos-response-headers": JSON.stringify(Object.fromEntries(response.headers.entries())),
      "x-agentos-status": String(response.status),
      "x-agentos-status-text": response.statusText,
      "x-agentos-url": target.href,
    });
    if (method === "HEAD" || !response.body) {
      clearTimeout(timeout);
      return new Response(null, { status: 200, headers: responseHeaders });
    }

    const reader = response.body.getReader();
    let totalBytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        try {
          const result = await reader.read();
          if (result.done) {
            clearTimeout(timeout);
            streamController.close();
            return;
          }
          totalBytes += result.value.byteLength;
          if (totalBytes > MAX_PROXY_RESPONSE_BYTES) {
            await reader.cancel("response too large");
            controller.abort("response too large");
            clearTimeout(timeout);
            streamController.error(new Error("response exceeded the 8 MiB proxy limit"));
            return;
          }
          streamController.enqueue(result.value);
        } catch (error) {
          clearTimeout(timeout);
          streamController.error(error);
        }
      },
      async cancel(reason) {
        clearTimeout(timeout);
        controller.abort("client cancelled");
        await reader.cancel(reason);
      },
    });
    return new Response(body, { status: 200, headers: responseHeaders });
  } catch (error) {
    clearTimeout(timeout);
    const messageText = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({
      error: controller.signal.aborted ? "request cancelled or timed out" : messageText,
    }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}

function handleNetworkWebSocket(request: Request, ctx: ExecutionContext): Response {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("AgentOS network proxy requires a WebSocket upgrade.\n", {
      status: 426,
      headers: { Upgrade: "websocket" },
    });
  }

  const WebSocketPairConstructor = (globalThis as typeof globalThis & {
    WebSocketPair?: new () => WebSocketPairLike;
  }).WebSocketPair;
  if (!WebSocketPairConstructor) {
    return new Response("WebSocket proxy is unavailable in this runtime.\n", { status: 501 });
  }

  const pair = new WebSocketPairConstructor();
  const client = pair[0];
  const server = pair[1];
  const controllers = new Map<string, AbortController>();
  server.accept();
  server.addEventListener("message", (event) => {
    const message = parseNetworkSocketMessage(event.data);
    if (!message) {
      sendSocketMessage(server, { type: "error", id: "", message: "invalid proxy message" });
      return;
    }
    if (message.type === "cancel") {
      controllers.get(message.id)?.abort("cancelled by terminal");
      return;
    }
    if (controllers.has(message.id)) {
      sendSocketMessage(server, { type: "error", id: message.id, message: "request id is already active" });
      return;
    }
    ctx.waitUntil(streamNetworkRequest(server, message, controllers));
  });
  const close = () => {
    for (const controller of controllers.values()) controller.abort("socket closed");
    controllers.clear();
  };
  server.addEventListener("close", close);
  server.addEventListener("error", close);

  return new Response(null, {
    status: 101,
    webSocket: client,
  } as ResponseInit & { webSocket: WebSocket });
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === NETWORK_SOCKET_PATH) {
      return handleNetworkWebSocket(request, ctx);
    }

    if (url.pathname === "/__agentos/proxy") {
      return handleNetworkHttpProxy(request);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
