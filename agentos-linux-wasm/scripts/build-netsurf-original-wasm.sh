#!/usr/bin/env bash
# Build ORIGINAL NetSurf (full package) for the in-tab JS XServer.
# Only adapters: libnsfb webx11 surface + X11 PutImage host hook.
# Does not rewrite NetSurf browser core.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
site_root="$(cd "${script_dir}/.." && pwd)"
WS="${site_root}/wasm/vendor/netsurf-workspace"
TOOLS="${WS}/emsdk-tools"
OUT="${site_root}/public/wasm/x11-apps"
X11APP="${site_root}/wasm/x11-apps"
HOST_TRIPLE=wasm32-unknown-emscripten
PREFIX="${WS}/inst-${HOST_TRIPLE}"
RES_SRC="${WS}/netsurf/frontends/framebuffer/res"
RES_STAGING="${WS}/netsurf-res-wasm"

if [[ -f /tmp/emsdk/emsdk_env.sh ]]; then
  # shellcheck disable=SC1091
  source /tmp/emsdk/emsdk_env.sh
fi

command -v emcc >/dev/null || { echo "emcc required" >&2; exit 66; }
[[ -d "${WS}/netsurf" && -d "${WS}/libnsfb" ]] || {
  echo "Missing NetSurf workspace at ${WS} — run ns-clone first" >&2
  exit 66
}
[[ -x "${TOOLS}/${HOST_TRIPLE}-cc" ]] || {
  echo "Missing emscripten wrappers in ${TOOLS}" >&2
  exit 66
}

# Ensure wrappers look like clang to netsurf-buildsystem and use emar.
cat > "${TOOLS}/${HOST_TRIPLE}-cc" <<'EOF'
#!/bin/bash
if [[ "$*" == "--version" ]]; then
  echo "clang version 20.0.0 (emscripten)"
  exit 0
fi
if [[ "$*" == "-dumpspecs" ]]; then
  exit 1
fi
if [[ "$*" == "-dumpmachine" ]]; then
  echo "wasm32-unknown-emscripten"
  exit 0
fi
# Keep NetSurf compile/link talking to Emscripten image ports.
exec "/tmp/emsdk/upstream/emscripten/emcc" \
  -sUSE_LIBPNG=1 -sUSE_LIBJPEG=1 -sUSE_ZLIB=1 "$@"
EOF
cp "${TOOLS}/${HOST_TRIPLE}-cc" "${TOOLS}/${HOST_TRIPLE}-gcc"
cat > "${TOOLS}/${HOST_TRIPLE}-ar" <<'EOF'
#!/bin/bash
exec "/tmp/emsdk/upstream/emscripten/emar" "$@"
EOF
cat > "${TOOLS}/${HOST_TRIPLE}-ranlib" <<'EOF'
#!/bin/bash
exec "/tmp/emsdk/upstream/emscripten/emranlib" "$@"
EOF
chmod +x "${TOOLS}/${HOST_TRIPLE}-"*

export PATH="${TOOLS}:${PATH}"
export HOST="${HOST_TRIPLE}"
export TARGET_WORKSPACE="${WS}"
export TARGET_TOOLKIT=framebuffer
export PREFIX
export GCCSDK_INSTALL_ENV="${PREFIX}"
export CC="${HOST_TRIPLE}-gcc"
export AR="${HOST_TRIPLE}-ar"
# Isolate pkg-config from host SDL/Wayland so libnsfb only builds ram+webx11.
export PKG_CONFIG_LIBDIR="${PREFIX}/lib/pkgconfig"
export PKG_CONFIG_PATH="${PREFIX}/lib/pkgconfig"
# env.sh probes unbound vars and uses `command -v` failures; relax set -e/-u.
set +eu
# shellcheck disable=SC1091
source "${WS}/env.sh"
set -eu
export PKG_CONFIG_LIBDIR="${PREFIX}/lib/pkgconfig"
export PKG_CONFIG_PATH="${PREFIX}/lib/pkgconfig"

mkdir -p "${PREFIX}/share/netsurf-buildsystem"
make -C "${WS}/buildsystem" install PREFIX="${PREFIX}" >/dev/null

# pkg-config stubs so NetSurf finds Emscripten port libpng/libjpeg/zlib
SYSROOT="${EMSDK:-/tmp/emsdk}/upstream/emscripten/cache/sysroot"
if [[ ! -f "${SYSROOT}/include/png.h" ]]; then
  echo 'int main(void){return 0;}' >/tmp/ns-port-probe.c
  emcc /tmp/ns-port-probe.c -sUSE_LIBPNG=1 -sUSE_LIBJPEG=1 -sUSE_ZLIB=1 -c -o /tmp/ns-port-probe.o
fi
cat > "${PREFIX}/lib/pkgconfig/libpng.pc" <<EOF
prefix=${SYSROOT}
libdir=\${prefix}/lib/wasm32-emscripten
includedir=\${prefix}/include
Name: libpng
Description: Emscripten port libpng
Version: 1.6.58
Libs: -L\${libdir} -lpng -lz
Cflags: -I\${includedir}
EOF
cat > "${PREFIX}/lib/pkgconfig/libjpeg.pc" <<EOF
prefix=${SYSROOT}
libdir=\${prefix}/lib/wasm32-emscripten
includedir=\${prefix}/include
Name: libjpeg
Description: Emscripten port libjpeg
Version: 9.0.0
Libs: -L\${libdir} -ljpeg
Cflags: -I\${includedir}
EOF
cat > "${PREFIX}/lib/pkgconfig/zlib.pc" <<EOF
prefix=${SYSROOT}
libdir=\${prefix}/lib/wasm32-emscripten
includedir=\${prefix}/include
Name: zlib
Description: Emscripten zlib
Version: 1.3
Libs: -L\${libdir} -lz
Cflags: -I\${includedir}
EOF

ADAPTER="${site_root}/wasm/netsurf-webx11"
if [[ -f "${ADAPTER}/webx11.c" ]]; then
  echo "=== Applying tracked webx11 surface adapter into original libnsfb ==="
  cp -a "${ADAPTER}/webx11.c" "${WS}/libnsfb/src/surface/webx11.c"
  cp -a "${ADAPTER}/libnsfb_webx11.h" "${WS}/libnsfb/include/libnsfb_webx11.h"
  cp -a "${ADAPTER}/libnsfb_webx11.h" "${PREFIX}/include/libnsfb_webx11.h"
  if [[ -f "${ADAPTER}/surface.Makefile" ]]; then
    cp -a "${ADAPTER}/surface.Makefile" "${WS}/libnsfb/src/surface/Makefile"
  fi
  if [[ -f "${ADAPTER}/libnsfb.h.patched" ]]; then
    cp -a "${ADAPTER}/libnsfb.h.patched" "${WS}/libnsfb/include/libnsfb.h"
  fi
fi

echo "=== Installing original NetSurf libs for ${HOST} (incl. webx11 surface) ==="
make -C "${WS}/libnsfb" HOST="${HOST}" PREFIX="${PREFIX}" install ${USE_CPUS:- -j$(nproc)}
cp -a "${WS}/libnsfb/include/libnsfb_webx11.h" "${PREFIX}/include/"
ns-make-libs install
cp -a "${WS}/libnsfb/include/libnsfb_webx11.h" "${PREFIX}/include/"

echo "=== Configuring original NetSurf framebuffer ==="
cat > "${WS}/netsurf/Makefile.config" <<'EOF'
override NETSURF_FB_FONTLIB := internal
override NETSURF_USE_DUKTAPE := NO
override NETSURF_USE_HARU_PDF := NO
override NETSURF_USE_JPEG := YES
override NETSURF_USE_JPEGXL := NO
override NETSURF_USE_PNG := YES
override NETSURF_USE_BMP := YES
override NETSURF_USE_GIF := YES
override NETSURF_USE_WEBP := NO
override NETSURF_USE_NSSVG := YES
override NETSURF_USE_ROSPRITE := YES
override NETSURF_USE_CURL := YES
override NETSURF_USE_OPENSSL := NO
override NETSURF_USE_UTF8PROC := YES
override NETSURF_USE_LIBICONV_PLUG := YES
override NETSURF_FB_RESPATH := /share/netsurf
override NETSURF_HOMEPAGE := about:welcome
EOF

echo "=== Compiling original NetSurf objects (TARGET=framebuffer) ==="
cd "${WS}/netsurf"
OBJDIR="${WS}/netsurf/build/${HOST}-framebuffer"
# Do NOT pass CFLAGS=/LDFLAGS= on the make command line — that blocks the
# framebuffer frontend Makefile from appending -Dnsframebuffer etc.
# Port flags come from the HOST-cc wrapper; extra -I via the environment.
export CFLAGS="-I${PREFIX}/include"
export LDFLAGS="-L${PREFIX}/lib"
# Optionally wipe the wasm framebuffer tree (never reuse native Linux objects).
if [[ "${NETSURF_WASM_CLEAN:-0}" == "1" ]]; then
  rm -rf "${OBJDIR}"
fi
set +e
make TARGET=framebuffer HOST="${HOST}" PREFIX="${PREFIX}" \
  ${USE_CPUS:- -j$(nproc)} 2>&1 | tee /tmp/ns-wasm-build.log | tail -80
make_rc=${PIPESTATUS[0]}
set -e

[[ -d "${OBJDIR}" ]] || { echo "No wasm object dir ${OBJDIR}" >&2; exit 1; }
mapfile -t OBJS < <(find "${OBJDIR}" -name '*.o' ! -path '*/tools/*' | sort)
[[ ${#OBJS[@]} -gt 50 ]] || {
  echo "Too few NetSurf objects (${#OBJS[@]}) — see /tmp/ns-wasm-build.log" >&2
  exit 1
}
echo "Collected ${#OBJS[@]} original NetSurf object files from ${OBJDIR} (make_rc=${make_rc})"

echo "=== Staging framebuffer resources for MEMFS ==="
rm -rf "${RES_STAGING}"
mkdir -p "${RES_STAGING}"
for F in adblock.css credits.html default.css internal.css licence.html \
         netsurf.png quirks.css welcome.html Messages; do
  # Follow symlinks (Messages -> en/Messages) so file_packager sees real files.
  if [[ -e "${RES_SRC}/${F}" ]]; then
    cp -L "${RES_SRC}/${F}" "${RES_STAGING}/${F}"
  elif [[ -f "${RES_SRC}/en/${F}" ]]; then
    cp -L "${RES_SRC}/en/${F}" "${RES_STAGING}/${F}"
  fi
done
# Prefer the filtered framebuffer Messages produced by the NetSurf build.
MSG_BUILT=$(find "${OBJDIR}" -type f -path '*/en/Messages' 2>/dev/null | head -1 || true)
if [[ -n "${MSG_BUILT}" ]]; then
  cp -L "${MSG_BUILT}" "${RES_STAGING}/Messages"
fi
# Icons used by the framebuffer UI
if [[ -d "${RES_SRC}/icons" ]]; then
  mkdir -p "${RES_STAGING}/icons"
  find "${RES_SRC}/icons" -maxdepth 1 -type f -exec cp -L {} "${RES_STAGING}/icons/" \;
fi
# Also force filesystem support for the preloaded package.
export EMCC_FORCE_FILESYSTEM=1

echo "=== Linking original NetSurf + thin webx11 PutImage adapter ==="
mkdir -p "${OUT}"
# Compile adapter objects
emcc -O2 -c "${X11APP}/mini_x11.c" -I"${X11APP}" -o /tmp/mini_x11.o
emcc -O2 -c "${X11APP}/webx11_host_adapter.c" \
  -I"${X11APP}" -I"${PREFIX}/include" \
  -o /tmp/webx11_host_adapter.o

# Whole-archive libnsfb so webx11 constructor registers the surface.
emcc -O2 \
  "${OBJS[@]}" \
  /tmp/mini_x11.o \
  /tmp/webx11_host_adapter.o \
  -L"${PREFIX}/lib" \
  -Wl,--whole-archive -lnsfb -Wl,--no-whole-archive \
  -lcss -ldom -lhubbub -lparserutils -lwapcaplet \
  -lnsgif -lnsbmp -lnsutils -lnspsl -lnslog \
  -lsvgtiny -lrosprite \
  -lcurl -lexpat -lutf8proc \
  -sUSE_LIBPNG=1 -sUSE_LIBJPEG=1 -sUSE_ZLIB=1 \
  -sASYNCIFY=1 \
  -sASYNCIFY_STACK_SIZE=1048576 \
  -sENVIRONMENT=web \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createNetsurfX11 \
  -sINVOKE_RUN=0 \
  -sEXIT_RUNTIME=0 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=67108864 \
  -sSTACK_SIZE=1048576 \
  -sEXPORTED_RUNTIME_METHODS=['ccall','cwrap','callMain','FS','HEAPU8','UTF8ToString'] \
  -sEXPORTED_FUNCTIONS=['_main','_malloc','_free'] \
  -sERROR_ON_UNDEFINED_SYMBOLS=0 \
  -sFORCE_FILESYSTEM=1 \
  --js-library "${X11APP}/x11_transport.js" \
  --preload-file "${RES_STAGING}@/share/netsurf" \
  -o "${OUT}/netsurf_x11.js"

# Emscripten may also emit netsurf_x11.data for preloaded files
ls -la "${OUT}/netsurf_x11.js" "${OUT}/netsurf_x11.wasm" "${OUT}/netsurf_x11.data" 2>/dev/null || \
  ls -la "${OUT}/netsurf_x11.js" "${OUT}/netsurf_x11.wasm"

echo "original NetSurf (full pkg) + webx11 adapter ready → ${OUT}"
echo "make_rc(stage compile/link netsurf makefile)=${make_rc}"
