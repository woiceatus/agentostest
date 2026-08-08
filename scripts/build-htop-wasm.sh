#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_root="${HTOP_WASM_BUILD_ROOT:-${project_root}/.htop-wasm-build}"
build_tmp="${build_root}/tmp"
htop_version="3.5.2"
htop_sha256="225128e697c4a8c8a878fd0078c965ff8bd5fb24913bfc8473b8edbd50f843f8"
ncurses_commit="87c2c84cbd2332d6d94b12a1dcaf12ad1a51a938"
jobs="${HTOP_WASM_JOBS:-4}"

if ! command -v emcc >/dev/null 2>&1; then
  echo "build-htop-wasm: activate Emscripten SDK 3.1.74 first" >&2
  exit 1
fi

if ! emcc --version | head -1 | grep -q "3.1.74"; then
  echo "build-htop-wasm: Emscripten 3.1.74 is required for the pinned artifact" >&2
  exit 1
fi

mkdir -p "${build_root}" "${build_tmp}"
export TMPDIR="${build_tmp}"

htop_archive="${build_root}/htop-${htop_version}.tar.xz"
if [[ ! -f "${htop_archive}" ]]; then
  curl -fsSL -o "${htop_archive}" "https://github.com/htop-dev/htop/releases/download/${htop_version}/htop-${htop_version}.tar.xz"
fi
printf '%s  %s\n' "${htop_sha256}" "${htop_archive}" | sha256sum -c -

ncurses_source="${build_root}/ncurses-source"
if [[ ! -d "${ncurses_source}/.git" ]]; then
  git clone https://github.com/mirror/ncurses.git "${ncurses_source}"
fi
git -C "${ncurses_source}" checkout --detach "${ncurses_commit}"

htop_source="${build_root}/htop-source"
if [[ ! -x "${htop_source}/configure" ]]; then
  mkdir -p "${htop_source}"
  tar --no-same-owner --strip-components=1 -xf "${htop_archive}" -C "${htop_source}"
fi
if ! grep -q "agentos_set_terminal_size" "${htop_source}/htop.c"; then
  patch -d "${htop_source}" -p1 < "${project_root}/wasm/htop/htop-3.5.2-emscripten.patch"
fi

ncurses_prefix="${build_root}/ncurses-prefix"
ncurses_build="${build_root}/ncurses-build"
mkdir -p "${ncurses_prefix}" "${ncurses_build}"
if [[ ! -f "${ncurses_build}/Makefile" ]]; then
  (
    cd "${ncurses_build}"
    emconfigure "${ncurses_source}/configure" \
      --host=wasm32-unknown-emscripten \
      --build=x86_64-pc-linux-gnu \
      --prefix="${ncurses_prefix}" \
      --with-build-cc=gcc \
      --without-progs \
      --without-tests \
      --without-manpages \
      --without-ada \
      --without-cxx \
      --without-cxx-binding \
      --without-debug \
      --disable-db-install \
      --disable-home-terminfo \
      --disable-termcap \
      --enable-widec \
      --with-fallbacks=xterm-256color,xterm \
      --with-tic-path="$(command -v tic)" \
      --with-default-terminfo-dir=/usr/share/terminfo \
      --with-terminfo-dirs=/usr/share/terminfo
  )
fi
emmake make -C "${ncurses_build}" -j"${jobs}"
emmake make -C "${ncurses_build}" install

htop_build="${build_root}/htop-build"
mkdir -p "${htop_build}"
if [[ ! -f "${htop_build}/Makefile" ]]; then
  (
    cd "${htop_build}"
    CPPFLAGS="-I${ncurses_prefix}/include -I${ncurses_prefix}/include/ncursesw" \
    CURSES_CFLAGS="-I${ncurses_prefix}/include -I${ncurses_prefix}/include/ncursesw" \
    CURSES_LIBS="${ncurses_prefix}/lib/libncursesw.a" \
    CFLAGS="-O2" \
      emconfigure "${htop_source}/configure" \
        --host=wasm32-unknown-emscripten \
        --build=x86_64-pc-linux-gnu \
        --disable-unicode \
        --disable-hwloc \
        --disable-delayacct \
        --disable-capabilities \
        --disable-sensors
  )
fi

emmake make -C "${htop_build}" -j"${jobs}" \
  LDFLAGS="-sASYNCIFY -sASYNCIFY_STACK_SIZE=24576 -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createHtopModule -sENVIRONMENT=web,worker,node -sEXIT_RUNTIME=1 -sALLOW_MEMORY_GROWTH=1 -sFORCE_FILESYSTEM=1 -sINVOKE_RUN=0 -sEXPORTED_FUNCTIONS=_main,_agentos_set_terminal_size -sEXPORTED_RUNTIME_METHODS=FS,callMain,TTY -sINITIAL_MEMORY=67108864"

output_dir="${project_root}/public/wasm/htop"
mkdir -p "${output_dir}"
install -m 0644 "${htop_build}/htop" "${output_dir}/htop.mjs"
install -m 0644 "${htop_build}/htop.wasm" "${output_dir}/htop.wasm"
install -m 0644 "${htop_source}/COPYING" "${output_dir}/HTOP-LICENSE.txt"
sha256sum "${output_dir}/htop.mjs" "${output_dir}/htop.wasm"
