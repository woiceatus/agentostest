# Browser desktop WASM

This directory builds the in-tab display stack used by `app/WebDesktop.tsx`.

## Sources

- `vendor/aurora-wm` — vendored from [ecooxai/aurora-wm](https://github.com/ecooxai/aurora-wm)
- `vendor/netsurf` — vendored from [netsurf-browser/netsurf](https://github.com/netsurf-browser/netsurf)
- `aurora-wm-web` — Aurora WM + Files + Terminal browser port
- `netsurf-web` — NetSurf framebuffer frontend compiled with Emscripten
- `xserver-web` — browser WASM display-server compositor

Session boot auto-starts **Aurora Terminal**, **NetSurf**, and **Aurora Files** as
managed X11 clients on the in-tab Xserver.

## Build

```bash
rustup target add wasm32-unknown-unknown
# optional: source /path/to/emsdk/emsdk_env.sh
./scripts/build-desktop-wasm.sh
./scripts/build-netsurf-wasm.sh
```

Artifacts:

- `public/wasm/aurora-wm-web.wasm`
- `public/wasm/xserver-web.wasm`
- `public/wasm/netsurf-web.wasm`
