# Original NetSurf on the in-tab JS XServer

## Does XServer / WM / NetSurf run “in AgentOS” with syscalls & libs?

**Yes — inside the AgentOS browser tab** — but **not** as native Linux processes.

| Component | Runs as | “Syscalls / libs” meaning |
|-----------|---------|---------------------------|
| AgentOS shell / FS / `curl` | Browser tab + Workers | In-tab FS image; network via `/__agentos/ws` or `/__agentos/proxy` |
| JS XServer (`node-x11`) | Main-thread JS | Real X11 wire protocol in JS (no Linux `Xorg`) |
| Aurora WM | Emscripten WASM | Real WM logic; X I/O via `x11_js_*` JS bridge (not Unix sockets) |
| Original NetSurf (`nsfb`) | Emscripten WASM | Real NetSurf + libcss/libdom/…; display via thin `webx11` → `PutImage`; **HTTP(S) via AgentOS proxy** (browser TLS) |

There is **no Linux VM** and **no real kernel syscalls** for these clients. Emscripten provides wasm libc (`malloc`, MEMFS, `emscripten_sleep`/ASYNCIFY). X11 and network are **JS-bridged AgentOS services**.

## What runs today

`public/wasm/x11-apps/netsurf_x11.{js,wasm,data}` is the **original NetSurf**
framebuffer browser (`nsfb`), compiled with Emscripten:

1. **Original NetSurf full package** — upstream workspace under  
   `wasm/vendor/netsurf-workspace/` (gitignored; clone locally)
2. **Thin `webx11` surface** — `wasm/netsurf-webx11/` (RAM fb + input)
3. **Thin PutImage host** — `wasm/x11-apps/webx11_host_adapter.c`
4. **Thin AgentOS HTTP(S) fetch** — `wasm/x11-apps/netsurf_agentos_fetch.{c,js}`  
   wraps `fetch_curl_register` so http/https go through `/__agentos/proxy`  
   (**no NetSurf core source edits**)

## Open on start → DuckDuckGo

`RealXDisplay` starts NetSurf with:

```text
nsfb -f webx11 -w 720 -h 480 https://html.duckduckgo.com/html/
```

HTTPS is fetched by the browser through the AgentOS proxy, then fed into
original NetSurf’s fetcher pipeline.

## Typing latency (webx11)

The surface adapter batches PutImage to **once per input tick** (not once per
plotter dirty rect), copies only the dirty rectangle, caps `emscripten_sleep`
to ≤4 ms, and drops excess motion when the key queue is busy. Rebuild with
`scripts/build-netsurf-original-wasm.sh` after changing
`wasm/netsurf-webx11/` or `webx11_host_adapter.c`.

## Build

```bash
bash scripts/build-netsurf-original-wasm.sh
# or
bash scripts/build-netsurf-x11.sh
```
