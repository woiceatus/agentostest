# Original NetSurf on the in-tab JS XServer

## What runs today

`public/wasm/x11-apps/netsurf_x11.{js,wasm,data}` is the **original NetSurf**
framebuffer browser (`nsfb`), compiled with Emscripten, speaking real X11 into
the JS XServer:

1. **Original NetSurf full package** — upstream `netsurf` + libcss/libdom/
   libhubbub/libnsfb/… from the official NetSurf workspace  
   (`wasm/vendor/netsurf-workspace/`, cloned via `ns-clone`)
2. **Thin surface adapter only** — `libnsfb` surface `webx11`  
   (`wasm/netsurf-webx11/webx11.c`) — RAM framebuffer + input queue  
   **NetSurf browser core is not rewritten**
3. **Thin X11 host hook** — `wasm/x11-apps/webx11_host_adapter.c`  
   implements `webx11_host_present` / `webx11_host_poll` → `mini_x11`  
   **`PutImage` ZPixmap** onto the JS XServer

Runtime args:

```text
nsfb -f webx11 -w 720 -h 480 about:welcome
```

## Build

```bash
# Once: clone official NetSurf workspace into wasm/vendor/netsurf-workspace
# (ns-clone / env.sh from https://git.netsurf-browser.org/…)

bash scripts/build-netsurf-original-wasm.sh
# or
bash scripts/build-netsurf-x11.sh
```

Artifacts:

- `public/wasm/x11-apps/netsurf_x11.js`
- `public/wasm/x11-apps/netsurf_x11.wasm`
- `public/wasm/x11-apps/netsurf_x11.data` (framebuffer Messages/CSS/welcome)

## Runtime

`RealXDisplay` starts Aurora WM, then xdemo/xclock, then loads original
`netsurf_x11` and calls `callMain(["nsfb","-f","webx11",…,"about:welcome"])`.
The framebuffer event loop yields via `emscripten_sleep` (ASYNCIFY) so the
browser / XServer can keep painting.

## Notes

- HTTP fetch uses the wasm-built libcurl (HTTP-only in this tree). HTTPS sites
  need SSL / browser-fetch wiring later; `about:welcome` works offline from
  packed resources.
- The old `ns_browser_wasm.c` DuckDuckGo shell is **not** used as NetSurf.
