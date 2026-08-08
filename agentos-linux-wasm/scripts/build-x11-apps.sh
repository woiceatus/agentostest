#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
site_root="$(cd "${script_dir}/.." && pwd)"
src_dir="${site_root}/wasm/x11-apps"
out_dir="${site_root}/public/wasm/x11-apps"
transport="${src_dir}/x11_transport.js"

if [[ -f /tmp/emsdk/emsdk_env.sh ]]; then
  # shellcheck disable=SC1091
  source /tmp/emsdk/emsdk_env.sh
fi

command -v emcc >/dev/null 2>&1 || {
  echo "emcc required to build real X11 WASM clients" >&2
  exit 66
}

mkdir -p "${out_dir}"

common=(
  -O2
  -I"${src_dir}"
  --js-library "${transport}"
  -sENVIRONMENT=web
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createX11App
  -sALLOW_MEMORY_GROWTH=1
  -sERROR_ON_UNDEFINED_SYMBOLS=0
  -sEXPORTED_RUNTIME_METHODS=['UTF8ToString','HEAPU8']
  -sEXPORTED_FUNCTIONS=['_malloc','_free']
)

echo "Building xdemo (real X11 client)…"
emcc "${src_dir}/mini_x11.c" "${src_dir}/xdemo.c" \
  "${common[@]}" \
  -sEXPORTED_FUNCTIONS=['_malloc','_free','_xdemo_start','_xdemo_pump','_xdemo_is_running'] \
  -o "${out_dir}/xdemo.js"

echo "Building xclock-demo (real X11 client)…"
emcc "${src_dir}/mini_x11.c" "${src_dir}/xclock_demo.c" \
  "${common[@]}" \
  -sEXPORTED_FUNCTIONS=['_malloc','_free','_xclock_start','_xclock_pump','_xclock_is_running'] \
  -o "${out_dir}/xclock.js"

ls -la "${out_dir}/xdemo.js" "${out_dir}/xdemo.wasm" "${out_dir}/xclock.js" "${out_dir}/xclock.wasm"
echo "Real X11 WASM clients ready."
