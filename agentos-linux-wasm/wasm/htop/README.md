# htop WebAssembly build

The files served from `public/wasm/htop/` are a real build of upstream htop and ncurses, not a JavaScript recreation of htop's screen.

## Pinned inputs

- htop 3.5.2 release archive: `225128e697c4a8c8a878fd0078c965ff8bd5fb24913bfc8473b8edbd50f843f8`
- ncurses 6.4, patch 20230311: commit `87c2c84cbd2332d6d94b12a1dcaf12ad1a51a938`
- Emscripten SDK 3.1.74

The small port patch adds an Asyncify yield so a browser worker can service PTY input, exports the terminal dimensions, and replaces htop's unsupported-platform placeholder values with the running WASM process and its real linear-memory readings. The ncurses UI, key handling, sorting, setup screens, meters, and process-table rendering remain upstream htop code.

## Rebuild

Activate Emscripten 3.1.74, then run:

```sh
source /path/to/emsdk/emsdk_env.sh
./scripts/build-htop-wasm.sh
```

Generated runtime assets:

- `htop.mjs`: `77676fe73c48672197d2762aad936651069cc9618ca46f8f8d4cc2d373fca8a4`
- `htop.wasm`: `3932c5a2fcb0c7b210f7a7ff2b824f68d38bb22b8243346a1a9839dc0587967a`

htop is distributed under GPL-2.0-or-later. Its license is shipped beside the runtime as `HTOP-LICENSE.txt`.
