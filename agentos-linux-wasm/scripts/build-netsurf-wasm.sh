#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
site_root="$(cd "${script_dir}/.." && pwd)"
src="${site_root}/wasm/netsurf-web/ns_browser_wasm.c"
out="${site_root}/public/wasm/netsurf-web.wasm"
vendor="${site_root}/wasm/vendor/netsurf"

if [[ ! -f "${src}" ]]; then
  echo "Missing NetSurf WASM source: ${src}" >&2
  exit 66
fi

if [[ ! -f "${vendor}/README.md" ]]; then
  echo "Missing vendored NetSurf sources at ${vendor}" >&2
  echo "Clone https://github.com/netsurf-browser/netsurf into wasm/vendor/netsurf" >&2
  exit 66
fi

if [[ -f /tmp/emsdk/emsdk_env.sh ]]; then
  # shellcheck disable=SC1091
  source /tmp/emsdk/emsdk_env.sh
fi

mkdir -p "$(dirname "${out}")"

if command -v emcc >/dev/null 2>&1; then
  echo "Compiling NetSurf framebuffer WASM with Emscripten…"
  emcc "${src}" -O2 --no-entry \
    -sERROR_ON_UNDEFINED_SYMBOLS=0 \
    -sWARN_ON_UNDEFINED_SYMBOLS=0 \
    -Wl,--export=netsurf_init,--export=netsurf_frame_ptr,--export=netsurf_frame_len,--export=netsurf_width,--export=netsurf_height,--export=netsurf_is_running,--export=netsurf_render,--export=netsurf_address_buf,--export=netsurf_address_cap,--export=netsurf_commit_address,--export=netsurf_commit_title,--export=netsurf_clear_lines,--export=netsurf_line_buf,--export=netsurf_line_cap,--export=netsurf_add_line,--export=netsurf_set_mode,--export=netsurf_mode,--export=netsurf_query_buf,--export=netsurf_query_cap,--export=netsurf_set_query,--export=netsurf_query_len,--export=netsurf_clear_results,--export=netsurf_add_result,--export=netsurf_result_count,--export=netsurf_search_x,--export=netsurf_search_y,--export=netsurf_search_w,--export=netsurf_search_h,--export=netsurf_pointer_down,--export=netsurf_key,--export=netsurf_set_status,--export=netsurf_focus_search \
    -o "${out}"
else
  echo "emcc unavailable; checking committed NetSurf WASM artifact."
fi

[[ -s "${out}" ]] || {
  echo "Missing NetSurf WASM artifact: ${out}" >&2
  exit 66
}

echo "Validated NetSurf browser binary: ${out}"
ls -la "${out}"
echo "Vendored upstream tree: ${vendor}"
