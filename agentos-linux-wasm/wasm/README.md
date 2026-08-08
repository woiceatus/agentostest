# Browser desktop WASM

This directory builds the in-tab display stack used by `app/WebDesktop.tsx`.

## Sources

- `vendor/aurora-wm` — vendored from [ecooxai/aurora-wm](https://github.com/ecooxai/aurora-wm)
- `aurora-wm-web` — browser WASM port of Aurora WM (wallpaper, topbar, dock, framed clients, MapRequest placement)
- `xserver-web` — browser WASM display-server compositor (framebuffer, surfaces, hit testing)

The JS `x11` package still owns the X11 wire protocol inside the tab. Aurora WM WASM
makes the real window-manager decisions and paints Aurora chrome; Xserver WASM owns the
compositor framebuffer that stays in sync with those surfaces.

## Build

```bash
rustup target add wasm32-unknown-unknown
./scripts/build-desktop-wasm.sh
```

Artifacts are written to:

- `public/wasm/aurora-wm-web.wasm`
- `public/wasm/xserver-web.wasm`
