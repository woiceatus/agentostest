#!/usr/bin/env bash
# Build ORIGINAL NetSurf (full package) for the in-tab JS XServer.
# Thin adapter only — see scripts/build-netsurf-original-wasm.sh.
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "${script_dir}/build-netsurf-original-wasm.sh"
