# In-tab JS XServer extensions

The web XServer (`vendor/x11/server.js`, aliased over `x11/lib/xserver/server.js`)
now registers a compositor-capable extension set so Aurora WM and richer X11
clients (including a future Gecko X11 bridge) can probe real capabilities.

| Extension | Wire name | Role |
|-----------|-----------|------|
| SHAPE | `SHAPE` | Bounding/clip/input shapes; compose clips bounding rects |
| XFIXES | `XFIXES` | Regions, selection/cursor listeners (v5.0) |
| DAMAGE | `DAMAGE` | Damage objects + `DamageNotify` on window damage |
| Composite | `Composite` | Redirect / NameWindowPixmap / overlay (v0.4) |
| RANDR | `RANDR` | Single HTML5 output/CRTC/mode (v1.6) |
| GLX | `GLX` | Indirect GLX 1.4 via SoftGL or OffscreenCanvas WebGL2 |

Stock `BIG-REQUESTS`, `XC-MISC`, and `RENDER` remain.

## GLX backend

`vendor/x11/soft-gl-backend.js` prefers `OffscreenCanvas` + WebGL2 when available,
otherwise a CPU soft clear/rect framebuffer. `SwapBuffers` copies pixels into the
X drawable raster through `getDrawableSurface`.

## Install / Vite

- Vite aliases `x11/lib/xserver/server.js` and `input.js` to `vendor/x11/`.
- `scripts/install-ci.sh` copies the same files into `node_modules/x11/lib/xserver/`
  after `npm ci`.

## Aurora WM

`web_api.rs` starts Aurora with the light compositor enabled
(`Composite` `RedirectSubwindows` Automatic on the root).
