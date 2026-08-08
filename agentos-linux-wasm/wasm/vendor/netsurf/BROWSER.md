# Vendored netsurf-browser/netsurf

Source: https://github.com/netsurf-browser/netsurf

Used by AgentOS as:

1. Upstream reference tree for the NetSurf project
2. Resource/docs companion to `wasm/netsurf-web/ns_browser_wasm.c`

The browser Xserver launches `public/wasm/netsurf-web.wasm`, which is compiled
with Emscripten:

```bash
./scripts/build-netsurf-wasm.sh
```

A full native NetSurf framebuffer build (`make TARGET=framebuffer`) still needs
the complete NetSurf library stack (libnsfb, libcss, hubbub, libdom, curl, …).
The WASM module provides the framebuffer frontend ABI that Aurora WM maps as an
X11 client on session start.
