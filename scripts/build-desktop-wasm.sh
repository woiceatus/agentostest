#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
site_root="$(cd "${script_dir}/.." && pwd)"
target="wasm32-unknown-unknown"

if command -v cargo >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1 && rustc --target "${target}" --version >/dev/null 2>&1; then
  cargo build --manifest-path "${site_root}/wasm/xserver-web/Cargo.toml" --target "${target}" --release
  cargo build --manifest-path "${site_root}/wasm/aurora-wm-web/Cargo.toml" --target "${target}" --release
  cp "${site_root}/wasm/xserver-web/target/${target}/release/agentos_xserver_web.wasm" "${site_root}/public/wasm/xserver-web.wasm"
  cp "${site_root}/wasm/aurora-wm-web/target/${target}/release/aurora_wm_web.wasm" "${site_root}/public/wasm/aurora-wm-web.wasm"
else
  echo "Rust/WASM toolchain unavailable; checking committed desktop binaries."
fi

for artifact in "${site_root}/public/wasm/xserver-web.wasm" "${site_root}/public/wasm/aurora-wm-web.wasm"; do
  [[ -s "${artifact}" ]] || {
    echo "Missing desktop WASM artifact: ${artifact}" >&2
    exit 66
  }
done

echo "Validated browser display binaries: xserver-web.wasm + aurora-wm-web.wasm"
