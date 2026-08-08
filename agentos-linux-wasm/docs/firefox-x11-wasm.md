# Firefox as an X11 WASM client (AgentOS)

## Goal

Run a **rebuilt** Firefox/Gecko as a real client of the in-tab JS `XServer`
(managed by Aurora WM), then open `about:addons` and install uBlock Origin.

## Why Puter’s prebuilt demo is the wrong shape

[HeyPuter/firefox-wasm](https://github.com/HeyPuter/firefox-wasm) compiles Gecko
to `wasm32-unknown-emscripten`, but its display path is:

- **cairo-headless** widget toolkit (`MOZ_HEADLESS`)
- software blit **or** WebRender → **host WebGL2** into a page `<canvas>`
- networking via **Wisp** (WebSocket), not raw sockets

It does **not** speak the X11 wire protocol. Dropping their `gecko.wasm` into
our XServer therefore cannot create a managed window via `MapRequest`.

We do **not** ship or embed their chrome-demo tarball for this reason.

## Approach that can actually sit on our XServer

Rebuild Gecko from Puter’s **source fork** (`HeyPuter/firefox` @ pinned SHA in
their Makefile), then wrap the headless compositor output in a thin **X11
bridge client**:

```
┌─────────────────────────────────────────────────────────┐
│ Browser tab                                             │
│  JS XServer  ←── X11 PutImage / events ──►  bridge.wasm │
│       ▲                                      ▲          │
│       │ Aurora WM                            │ embeds   │
│                                          gecko/libxul   │
│                                       (headless paint)  │
└─────────────────────────────────────────────────────────┘
```

1. **Rebuild** `libxul` with their `mozconfig.full.emscripten` (emsdk 6.0.1,
   `-pthread`, Wisp-patched WasmFS).
2. **Bridge** (`firefox_x11` WASM app): connect with our `x11_transport.js`,
   `CreateWindow` + `MapWindow`, pump Gecko, `PutImage` frames into the X11
   window, forward Button/Key events into Gecko’s embed input API.
3. Aurora manages that window like xdemo/xclock.
4. **Add-ons / uBlock** only become possible after the chrome GRE is staged
   (`GECKO_CHROME=1`) and Wisp networking reaches AMO — still a large follow-on.

This is still a multi-hour (often multi-day) engineering effort: Gecko link
peaks well over 15–30 GiB without LTO tricks, needs emsdk 6.0.1 + modern Rust,
and our JS XServer only implements BIG-REQUESTS / XC-MISC / RENDER (no
COMPOSITE/XFIXES/RANDR/GLX). The bridge avoids needing full GTK/X11 inside
Gecko by keeping Puter’s headless toolkit and only using X11 for presentation.

## Build entrypoints

```bash
# vendor tree
cd wasm/vendor/firefox-wasm
make emsdk          # pin emscripten 6.0.1 + Wisp WasmFS patches
make firefox        # shallow clone HeyPuter/firefox @ FIREFOX_REF
make vendor
make build          # produces obj-full-emscripten/dist/bin/libxul.so
# then: scripts/build-firefox-x11-bridge.sh  (AgentOS wrapper)
```

## Status (2026-08-08)

- **Rejected:** shipping Puter prebuilt `chrome-demo` / WebGL iframe.
- **In progress:** `make build` of HeyPuter/firefox @ `2e1e835a` with emsdk
  6.0.1 inside `wasm/vendor/firefox-wasm/` (local only; gitignored).
- **Done:** `firefox_x11` WASM client maps a window on the JS XServer (Aurora
  manages it). Until `libxul.so` links, it paints a rebuild-status placeholder.
- **Not done:** binding headless Gecko paint → `PutImage`, chrome GRE, Wisp to
  AMO, about:addons, uBlock install. Do not claim those until verified.
