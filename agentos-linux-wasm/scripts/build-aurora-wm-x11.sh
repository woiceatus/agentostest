#!/usr/bin/env bash
# Build real ecooxai/aurora-wm as a WASM X11 WM client for the in-tab JS XServer.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
site_root="$(cd "${script_dir}/.." && pwd)"
crate_dir="${site_root}/wasm/vendor/aurora-wm"
out_dir="${site_root}/public/wasm/aurora-wm-x11"
transport="${site_root}/wasm/x11-apps/x11_transport.js"
shell_lib="${site_root}/wasm/x11-apps/aurora_shell.js"

if [[ -f /tmp/emsdk/emsdk_env.sh ]]; then
  # shellcheck disable=SC1091
  source /tmp/emsdk/emsdk_env.sh
fi

command -v emcc >/dev/null 2>&1 || {
  echo "emcc required to build aurora-wm WASM" >&2
  exit 66
}
command -v cargo >/dev/null 2>&1 || {
  echo "cargo required" >&2
  exit 66
}

export EMSCRIPTEN="${EMSCRIPTEN:-/tmp/emsdk/upstream/emscripten}"
mkdir -p "${out_dir}"

echo "Building real Aurora WM staticlib (wasm32-unknown-emscripten, feature=web)…"
cd "${crate_dir}"
# Keep RUSTFLAGS clean so dependency crates are not force-linked as JS modules.
unset RUSTFLAGS || true
cargo +nightly build \
  --lib \
  --release \
  --target wasm32-unknown-emscripten \
  --features web

archive="${crate_dir}/target/wasm32-unknown-emscripten/release/libaurora_wm.a"
[[ -f "${archive}" ]] || {
  echo "missing ${archive}" >&2
  exit 1
}

echo "Wrapping with emcc JS glue + x11 transport…"
emcc "${archive}" \
  --js-library "${transport}" \
  --js-library "${shell_lib}" \
  -O2 \
  -fwasm-exceptions \
  -sENVIRONMENT=web \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createAuroraWm \
  -sALLOW_MEMORY_GROWTH=1 \
  -sERROR_ON_UNDEFINED_SYMBOLS=0 \
  -sEXPORTED_RUNTIME_METHODS=['UTF8ToString','HEAPU8'] \
  -sEXPORTED_FUNCTIONS=['_aurora_wm_start','_aurora_wm_pump','_aurora_wm_is_running','_aurora_wm_stop'] \
  -o "${out_dir}/aurora_wm.js"

ls -la "${out_dir}/aurora_wm.js" "${out_dir}/aurora_wm.wasm"
echo "Real Aurora WM WASM ready → ${out_dir}"
