#!/usr/bin/env bash
# Build the Firefox→X11 bridge WASM client (placeholder until libxul links in).
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
site_root="$(cd "${script_dir}/.." && pwd)"
src_dir="${site_root}/wasm/x11-apps"
out_dir="${site_root}/public/wasm/x11-apps"
transport="${src_dir}/x11_transport.js"
gecko_dir="${site_root}/wasm/vendor/firefox-wasm"
libxul="${gecko_dir}/obj-full-emscripten/dist/bin/libxul.so"

if [[ -f /tmp/emsdk/emsdk_env.sh ]]; then
  # shellcheck disable=SC1091
  source /tmp/emsdk/emsdk_env.sh
fi
# Prefer Puter-pinned emsdk when present (matches Gecko toolchain).
if [[ -f "${gecko_dir}/emsdk/emsdk_env.sh" ]]; then
  # shellcheck disable=SC1091
  source "${gecko_dir}/emsdk/emsdk_env.sh"
fi

command -v emcc >/dev/null 2>&1 || {
  echo "emcc required" >&2
  exit 66
}

mkdir -p "${out_dir}"

extra_objs=()
if [[ -f "${libxul}" && -f "${src_dir}/gecko_x11_embed.cpp" ]]; then
  echo "Linking against rebuilt libxul + gecko_x11_embed…"
  # Full link is a follow-on step (pthread/COOP/COEP + huge wasm). For now we
  # only compile the bridge stub; wire libxul when embed glue is ready.
fi

echo "Building firefox_x11 bridge (X11 client)…"
emcc "${src_dir}/mini_x11.c" "${src_dir}/firefox_x11_bridge.c" \
  -O2 \
  -I"${src_dir}" \
  --js-library "${transport}" \
  -sENVIRONMENT=web \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createFirefoxX11 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sERROR_ON_UNDEFINED_SYMBOLS=0 \
  -sEXPORTED_RUNTIME_METHODS=['UTF8ToString','HEAPU8'] \
  -sEXPORTED_FUNCTIONS=['_malloc','_free','_firefox_x11_start','_firefox_x11_pump','_firefox_x11_is_running'] \
  -o "${out_dir}/firefox_x11.js"

ls -la "${out_dir}/firefox_x11.js" "${out_dir}/firefox_x11.wasm"
echo "firefox_x11 bridge ready → ${out_dir}"
if [[ ! -f "${libxul}" ]]; then
  echo "NOTE: ${libxul} not built yet — window is a placeholder until make build finishes in wasm/vendor/firefox-wasm"
fi
