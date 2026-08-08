/** DuckDuckGo browse/search helpers for the NetSurf WASM client. */

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type NetsurfBrowseModule = {
  memory: WebAssembly.Memory;
  netsurf_address_buf: (...args: number[]) => number;
  netsurf_address_cap: (...args: number[]) => number;
  netsurf_commit_address: (...args: number[]) => number;
  netsurf_commit_title: (...args: number[]) => number;
  netsurf_set_mode?: (...args: number[]) => number;
  netsurf_query_buf?: (...args: number[]) => number;
  netsurf_query_cap?: (...args: number[]) => number;
  netsurf_set_query?: (...args: number[]) => number;
  netsurf_clear_results?: (...args: number[]) => number;
  netsurf_add_result?: (...args: number[]) => number;
  netsurf_set_status?: (...args: number[]) => number;
  netsurf_render: (...args: number[]) => number;
  netsurf_focus_search?: (...args: number[]) => number;
};

const DDG_HOME = "https://html.duckduckgo.com/html/";

function writeWasmString(memory: WebAssembly.Memory, ptr: number, cap: number, value: string): number {
  const bytes = new TextEncoder().encode(value);
  const length = Math.min(bytes.length, Math.max(0, cap - 1));
  new Uint8Array(memory.buffer, ptr, length).set(bytes.subarray(0, length));
  return length;
}

function netsurfWrite(
  netsurf: NetsurfBrowseModule,
  kind: "address" | "title" | "query" | "status" | "result",
  value: string,
): void {
  if (kind === "query" && netsurf.netsurf_query_buf && netsurf.netsurf_query_cap && netsurf.netsurf_set_query) {
    const len = writeWasmString(netsurf.memory, netsurf.netsurf_query_buf(), netsurf.netsurf_query_cap(), value);
    netsurf.netsurf_set_query(len);
    return;
  }
  if (kind === "status" && netsurf.netsurf_set_status) {
    const len = writeWasmString(netsurf.memory, netsurf.netsurf_address_buf(), netsurf.netsurf_address_cap(), value);
    netsurf.netsurf_set_status(len);
    return;
  }
  if (kind === "result" && netsurf.netsurf_add_result) {
    const len = writeWasmString(netsurf.memory, netsurf.netsurf_address_buf(), netsurf.netsurf_address_cap(), value);
    // lengths unused by WASM packed parser; pass zeros
    void len;
    netsurf.netsurf_add_result(0, 0, 0);
    return;
  }
  const len = writeWasmString(netsurf.memory, netsurf.netsurf_address_buf(), netsurf.netsurf_address_cap(), value);
  if (kind === "address") netsurf.netsurf_commit_address(len);
  else netsurf.netsurf_commit_title(len);
}

async function proxyFetch(url: string): Promise<{ status: number; body: string; finalUrl: string }> {
  const response = await fetch("/__agentos/proxy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "request",
      id: `netsurf-${Date.now()}`,
      url,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      body: null,
    }),
  });
  if (!response.ok) {
    let message = `proxy HTTP ${response.status}`;
    try {
      const payload = JSON.parse(await response.text()) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // keep status text
    }
    throw new Error(message);
  }
  const body = await response.text();
  return {
    status: Number(response.headers.get("x-agentos-status") ?? "0"),
    body,
    finalUrl: response.headers.get("x-agentos-url") ?? url,
  };
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function unwrapDdgUrl(href: string): string {
  try {
    const absolute = href.startsWith("//") ? `https:${href}` : href;
    const parsed = new URL(absolute, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : parsed.href;
  } catch {
    return href;
  }
}

export function parseDuckDuckGoResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blockRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(html)) && results.length < 8) {
    results.push({
      url: unwrapDdgUrl(match[1] ?? "").slice(0, 150),
      title: stripTags(match[2] ?? "").slice(0, 90),
      snippet: stripTags(match[3] ?? "").slice(0, 140),
    });
  }
  if (results.length > 0) return results;

  // Fallback: title links only
  const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = linkRe.exec(html)) && results.length < 8) {
    results.push({
      url: unwrapDdgUrl(match[1] ?? "").slice(0, 150),
      title: stripTags(match[2] ?? "").slice(0, 90),
      snippet: "DuckDuckGo result",
    });
  }
  return results;
}

export async function openDuckDuckGoHome(netsurf: NetsurfBrowseModule): Promise<void> {
  netsurfWrite(netsurf, "address", DDG_HOME);
  netsurfWrite(netsurf, "title", "DuckDuckGo");
  netsurf.netsurf_set_mode?.(0);
  netsurf.netsurf_focus_search?.(1);
  netsurfWrite(netsurf, "status", "Loaded DuckDuckGo · type a query and press Enter");
  try {
    const page = await proxyFetch(DDG_HOME);
    const titleMatch = page.body.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (titleMatch?.[1]) netsurfWrite(netsurf, "title", stripTags(titleMatch[1]).slice(0, 80) || "DuckDuckGo");
    netsurfWrite(netsurf, "status", `DuckDuckGo ready · proxy ${page.status} · click search box to type`);
  } catch (error) {
    netsurfWrite(
      netsurf,
      "status",
      `DuckDuckGo UI ready · proxy offline (${error instanceof Error ? error.message : "error"})`,
    );
  }
  netsurf.netsurf_render(0);
}

export async function searchDuckDuckGo(netsurf: NetsurfBrowseModule, query: string): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const url = `${DDG_HOME}?q=${encodeURIComponent(q)}`;
  netsurfWrite(netsurf, "query", q);
  netsurfWrite(netsurf, "address", url);
  netsurfWrite(netsurf, "title", `${q} at DuckDuckGo`);
  netsurf.netsurf_clear_results?.();
  netsurf.netsurf_set_mode?.(1);
  netsurfWrite(netsurf, "status", `Searching DuckDuckGo for “${q}”…`);
  netsurf.netsurf_render(0);

  const page = await proxyFetch(url);
  const results = parseDuckDuckGoResults(page.body);
  netsurf.netsurf_clear_results?.();
  if (results.length === 0) {
    netsurfWrite(netsurf, "status", `No parseable results for “${q}” (HTTP ${page.status})`);
    netsurf.netsurf_render(0);
    return [];
  }
  for (const result of results) {
    netsurfWrite(netsurf, "result", `${result.title}\n${result.url}\n${result.snippet}`);
  }
  netsurfWrite(netsurf, "status", `${results.length} DuckDuckGo results for “${q}”`);
  netsurf.netsurf_render(0);
  return results;
}

export { DDG_HOME };
