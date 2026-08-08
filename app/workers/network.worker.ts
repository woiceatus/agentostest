type CurlRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  includeHeaders: boolean;
  headOnly: boolean;
};

type StartMessage = {
  type: "start";
  request: CurlRequest;
};

type CancelMessage = {
  type: "cancel";
};

type NetworkWorkerMessage = StartMessage | CancelMessage;

type ProxyResponseMessage = {
  type: "response";
  id: string;
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
};

type ProxyChunkMessage = {
  type: "chunk";
  id: string;
  data: string;
};

type ProxyEndMessage = {
  type: "end";
  id: string;
};

type ProxyErrorMessage = {
  type: "error";
  id: string;
  message: string;
};

type ProxyMessage =
  | ProxyResponseMessage
  | ProxyChunkMessage
  | ProxyEndMessage
  | ProxyErrorMessage;

let socket: WebSocket | null = null;
let socketPromise: Promise<WebSocket> | null = null;
let activeRequestId: string | null = null;
let httpController: AbortController | null = null;

function proxyUrl(): string {
  const url = new URL("/__agentos/ws", self.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function fail(message: string): void {
  self.postMessage({ type: "error", message });
}

function connect(): Promise<WebSocket> {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket);
  if (socketPromise) return socketPromise;

  socketPromise = new Promise<WebSocket>((resolve, reject) => {
    const next = new WebSocket(proxyUrl());
    socket = next;
    let settled = false;
    let opened = false;
    next.onopen = () => {
      opened = true;
      settled = true;
      socketPromise = null;
      resolve(next);
    };
    next.onerror = () => {
      if (!opened) {
        if (settled) return;
        settled = true;
        socketPromise = null;
        if (socket === next) socket = null;
        reject(new Error("could not connect to the AgentOS network worker"));
      } else if (activeRequestId) {
        activeRequestId = null;
        fail("network proxy connection failed");
      }
    };
    next.onclose = () => {
      if (socket === next) socket = null;
      if (!opened) {
        if (settled) return;
        settled = true;
        socketPromise = null;
        reject(new Error("could not connect to the AgentOS network worker"));
      } else if (activeRequestId) {
        activeRequestId = null;
        fail("network proxy connection closed");
      }
    };
    next.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let message: ProxyMessage;
      try {
        message = JSON.parse(event.data) as ProxyMessage;
      } catch {
        fail("network proxy returned invalid data");
        return;
      }
      if (message.id !== activeRequestId && message.id !== "") return;
      if (message.type === "response") {
        self.postMessage({
          type: "response",
          status: message.status,
          statusText: message.statusText,
          url: message.url,
          headers: message.headers,
        });
        return;
      }
      if (message.type === "chunk") {
        const data = decodeBase64(message.data);
        self.postMessage({ type: "chunk", data });
        return;
      }
      if (message.type === "end") {
        activeRequestId = null;
        self.postMessage({ type: "end" });
        return;
      }
      if (message.type === "error") {
        activeRequestId = null;
        fail(message.message);
      }
    };
  });
  return socketPromise;
}

function proxyResponseHeaders(response: Response): Record<string, string> {
  try {
    return JSON.parse(response.headers.get("x-agentos-response-headers") ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

async function startHttpFallback(request: CurlRequest, id: string): Promise<void> {
  const controller = new AbortController();
  httpController = controller;
  try {
    const response = await fetch(new URL("/__agentos/proxy", self.location.href), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "request",
        id,
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body,
      }),
      signal: controller.signal,
    });
    if (activeRequestId !== id) return;
    if (!response.ok) {
      let message = `HTTP proxy returned ${response.status}`;
      try {
        const payload = JSON.parse(await response.text()) as { error?: string };
        if (payload.error) message = payload.error;
      } catch {
        // Keep the transport status when the proxy did not return JSON.
      }
      throw new Error(message);
    }
    self.postMessage({
      type: "response",
      status: Number(response.headers.get("x-agentos-status") ?? "0"),
      statusText: response.headers.get("x-agentos-status-text") ?? "",
      url: response.headers.get("x-agentos-url") ?? request.url,
      headers: proxyResponseHeaders(response),
    });
    if (request.headOnly || !response.body) {
      activeRequestId = null;
      self.postMessage({ type: "end" });
      return;
    }
    const reader = response.body.getReader();
    while (activeRequestId === id) {
      const result = await reader.read();
      if (result.done) break;
      const data = result.value.buffer.slice(
        result.value.byteOffset,
        result.value.byteOffset + result.value.byteLength,
      );
      self.postMessage({ type: "chunk", data });
    }
    if (activeRequestId === id) {
      activeRequestId = null;
      self.postMessage({ type: "end" });
    }
  } catch (error) {
    if (activeRequestId === id) {
      activeRequestId = null;
      if (!controller.signal.aborted) fail(error instanceof Error ? error.message : String(error));
    }
  } finally {
    if (httpController === controller) httpController = null;
  }
}

async function start(request: CurlRequest): Promise<void> {
  if (activeRequestId) {
    fail("curl is already running");
    return;
  }
  const id = `curl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  activeRequestId = id;
  try {
    const next = await connect();
    if (activeRequestId !== id) return;
    next.send(JSON.stringify({
      type: "request",
      id,
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body,
    }));
  } catch {
    if (activeRequestId === id) await startHttpFallback(request, id);
  }
}

self.onmessage = (event: MessageEvent<NetworkWorkerMessage>) => {
  if (event.data.type === "cancel") {
    if (activeRequestId && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "cancel", id: activeRequestId }));
    }
    httpController?.abort();
    activeRequestId = null;
    socket?.close(1000, "terminal interrupted");
    socket = null;
    return;
  }
  void start(event.data.request);
};

export {};
