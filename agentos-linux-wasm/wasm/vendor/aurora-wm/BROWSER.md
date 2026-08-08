# Vendored ecooxai/aurora-wm

Source: https://github.com/ecooxai/aurora-wm

## Browser / WASM path (real X WM)

Build with:

```bash
./scripts/build-aurora-wm-x11.sh
```

This compiles the **real** Aurora WM (x11rb) for `wasm32-unknown-emscripten`
with feature `web`, then wraps `libaurora_wm.a` with emcc + the same
`x11_transport.js` used by xdemo/xclock.

Runtime (see `app/RealXDisplay.tsx`):

1. JS `XServer` boots in-tab
2. `aurora_wm_start` connects via sync byte transport and claims
   SubstructureRedirect (`become_wm`)
3. xdemo / xclock map; Aurora handles MapRequest and reparents frames
4. Host pumps `aurora_wm_pump` + client pumps each rAF; canvas shows
   `XServer.compose()` → `root.raster`

Minimal adaptations (feature `web` only):

- `web_stream.rs` — x11rb `Stream` over `x11_js_{write,read,poll}`
- `web_api.rs` — `aurora_wm_start` / `aurora_wm_pump` C ABI
- `WmConn` type alias + non-blocking `pump_once`
- `wait_for_x_event_or_timeout` is a no-op under `web` (rAF host)

COMPOSITE / SHAPE / XFIXES soft-fail on the JS XServer (no those extensions).

## Legacy painted port

`wasm/aurora-wm-web` is an older framebuffer chrome port (not a real X WM).
Assets (wallpaper / fonts) are still shared from this tree.
