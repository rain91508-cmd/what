#!/usr/bin/env bash
#
# cross-build-win.sh
# Cross-compile HWDA's interpreter + Surelog/UHDM for Windows from a Linux host
# using the MinGW-w64 toolchain.
#
# The cross-compile "gotchas" and how we solve them:
#
# 1) Cap'n Proto:
#   UHDM/Surelog run the `capnp` compiler at BUILD time to generate C++ from
#   .capnp schemas, but they also link the capnp *runtime* into the final
#   Windows .exe. A single capnp copy cannot serve both roles when
#   cross-compiling (the Windows capnp can't run on Linux; the Linux capnp
#   runtime can't be linked into a PE executable). So we build capnp twice:
#     * a native (host) copy  -> used only as the code-generation compiler
#     * a MinGW (target) copy -> linked into the Windows executable
#   find_package(CapnProto) is pointed at the target copy (so CapnProto::capnp
#   resolves to Windows libs), while CAPNP_EXECUTABLE/CAPNPC_CXX_EXECUTABLE are
#   overridden to the host binaries (so schema codegen runs on Linux).
#
# 2) Protobuf (same idea, for the KDB serializer):
#   The interpreter's kdb.proto is compiled to C++ at BUILD time by `protoc`,
#   and libprotobuf is linked into the final Windows .exe. So we build protobuf
#   twice:
#     * a native (host) copy  -> only the `protoc` compiler (code generation)
#     * a MinGW (target) copy -> only libprotobuf (linked into the .exe)
#   find_package(Protobuf) is fed the target lib/include via explicit cache
#   vars, while Protobuf_PROTOC_EXECUTABLE is overridden to the host `protoc`.
#
#   The protobuf 3.21.12 source ships pre-generated descriptor .pb.cc files, so
#   building the target libprotobuf does NOT need a protoc at all.
#
# Both toolchain copies are staged OUTSIDE the project source/build tree
# (CMake rejects imported-target INTERFACE_INCLUDE_DIRECTORIES that point
# inside the source/build directory). $ROOT/../cross-tooling is a sibling of
# the repo, so it is outside both.
#
# Prerequisites (apt):
#   sudo apt-get install -y --no-install-recommends \
#     gcc-mingw-w64-x86-64 g++-mingw-w64-x86-64 binutils-mingw-w64-x86-64 \
#     mingw-w64-tools capnproto libcapnp-dev libz-mingw-w64-dev \
#     default-jre-headless build-essential cmake ninja-build pkg-config \
#     git python3 python3-pip curl
#   pip3 install --break-system-packages orderedmultidict
#
# Usage:
#   ./cross-build-win.sh            # everything (toolchain, configure, build)
#   ./cross-build-win.sh configure   # configure only (after toolchain built)
#   ./cross-build-win.sh build        # build only (needs prior configure)
#   ./cross-build-win.sh capnp        # (re)build only the host+target capnproto
#   ./cross-build-win.sh protobuf     # (re)build only the host+target protobuf
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

BUILD_DIR="${BUILD_DIR:-$ROOT/build-win}"
JOBS="${JOBS:-$(nproc)}"
MODE="${1:-all}"

# --- toolchain staging (outside the repo) ---------------------------------
HOST_CAPNP="${HOST_CAPNP:-$ROOT/../cross-tooling/capnp-host}"
WIN_CAPNP="${WIN_CAPNP:-$ROOT/../cross-tooling/capnp-win}"
HOST_PROTO="${HOST_PROTO:-$ROOT/../cross-tooling/proto-host}"
WIN_PROTO="${WIN_PROTO:-$ROOT/../cross-tooling/proto-win}"
PROTOBUF_SRC="${PROTOBUF_SRC:-$ROOT/../cross-tooling/src/protobuf-3.21.12}"

ANTLR_VERSION="4.13.2"
ANTLR_JAR="$ROOT/third_party/Surelog/third_party/antlr4_bin/antlr-${ANTLR_VERSION}-complete.jar"

MINGW_TRIPLE=x86_64-w64-mingw32
MINGW_CC="$MINGW_TRIPLE-gcc"
MINGW_CXX="$MINGW_TRIPLE-g++"
MINGW_RC="$MINGW_TRIPLE-windres"
MINGW_SYSROOT="/usr/$MINGW_TRIPLE"

# ---------------------------------------------------------------------------
# Non-apt prerequisites
# ---------------------------------------------------------------------------
if [ ! -f "$ANTLR_JAR" ]; then
  echo "==> Downloading ANTLR ${ANTLR_VERSION} jar -> $ANTLR_JAR"
  mkdir -p "$(dirname "$ANTLR_JAR")"
  curl -fsSL "https://www.antlr.org/download/antlr-${ANTLR_VERSION}-complete.jar" -o "$ANTLR_JAR"
fi

if ! python3 -c "import orderedmultidict" 2>/dev/null; then
  echo "==> Installing Python 'orderedmultidict' (needed by UHDM codegen)"
  pip3 install --break-system-packages orderedmultidict || pip3 install orderedmultidict
fi

# ---------------------------------------------------------------------------
# Build capnproto twice: native host (for codegen) + MinGW target (for linking)
# ---------------------------------------------------------------------------
build_capnp() {
  local out_prefix="$1"; local is_host="$2"
  local tag; [ "$is_host" = 1 ] && tag=host || tag=win
  local b="$BUILD_DIR/capnp-$tag"
  if [ "$is_host" = 1 ] && [ -x "$out_prefix/bin/capnp" ]; then
    echo "==> capnproto(host) already built at $out_prefix (skipping)"; return 0
  fi
  if [ "$is_host" != 1 ] && [ -x "$out_prefix/bin/capnp.exe" ]; then
    echo "==> capnproto(win) already built at $out_prefix (skipping)"; return 0
  fi
  echo "==> Building capnproto ($tag) -> $out_prefix"
  local cmake_args=(
    -S third_party/Surelog/third_party/UHDM/third_party/capnproto/c++
    -B "$b" -G Ninja
    -DCMAKE_BUILD_TYPE=Release
    -DBUILD_TESTING=OFF -DBUILD_SHARED_LIBS=OFF
    -DWITH_OPENSSL=OFF -DWITH_ZLIB=OFF
    -DCMAKE_INSTALL_PREFIX="$out_prefix"
  )
  if [ "$is_host" != "1" ]; then
    cmake_args+=(
      -DCMAKE_SYSTEM_NAME=Windows -DCMAKE_SYSTEM_PROCESSOR=x86_64
      -DCMAKE_C_COMPILER="$MINGW_CC" -DCMAKE_CXX_COMPILER="$MINGW_CXX"
      -DCMAKE_RC_COMPILER="$MINGW_RC"
      -DCMAKE_FIND_ROOT_PATH="$MINGW_SYSROOT"
      -DCMAKE_FIND_ROOT_PATH_MODE_PROGRAM=NEVER
      -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=BOTH
      -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=BOTH
      # Use the HOST capnp compiler to generate this target's own schema code.
      -DCAPNP_EXECUTABLE="$HOST_CAPNP/bin/capnp"
      -DCAPNPC_CXX_EXECUTABLE="$HOST_CAPNP/bin/capnpc-c++"
    )
  fi
  cmake "${cmake_args[@]}"
  cmake --build "$b" -j"$JOBS"
  cmake --install "$b"
}

# ---------------------------------------------------------------------------
# Build protobuf twice: native host (protoc only) + MinGW target (lib only)
# ---------------------------------------------------------------------------
build_protobuf() {
  local out_prefix="$1"; local is_host="$2"
  local tag; [ "$is_host" = 1 ] && tag=host || tag=win
  local b="$BUILD_DIR/proto-$tag"
  if [ "$is_host" = 1 ] && [ -x "$out_prefix/bin/protoc" ]; then
    echo "==> protobuf(host) already built at $out_prefix (skipping)"; return 0
  fi
  if [ "$is_host" != 1 ] && [ -f "$out_prefix/lib/libprotobuf.a" ]; then
    echo "==> protobuf(win) already built at $out_prefix (skipping)"; return 0
  fi
  if [ ! -d "$PROTOBUF_SRC" ]; then
    echo "==> ERROR: protobuf source not found at $PROTOBUF_SRC" >&2
    echo "   Download it with: curl -fsSL \\" >&2
    echo "     https://github.com/protocolbuffers/protobuf/archive/refs/tags/v3.21.12.tar.gz \\" >&2
    echo "     | tar xz -C '$(dirname "$PROTOBUF_SRC")'" >&2
    return 1
  fi
  echo "==> Building protobuf ($tag) -> $out_prefix"
  local cmake_args=(
    -S "$PROTOBUF_SRC" -B "$b" -G Ninja
    -DCMAKE_BUILD_TYPE=Release
    -Dprotobuf_BUILD_TESTS=OFF
    -Dprotobuf_BUILD_SHARED_LIBS=OFF
    -Dprotobuf_WITH_ZLIB=OFF
    -DCMAKE_INSTALL_PREFIX="$out_prefix"
  )
  if [ "$is_host" = 1 ]; then
    # Host: we need a working `protoc` compiler.
    cmake_args+=(-Dprotobuf_BUILD_PROTOC_BINARIES=ON)
  else
    # Target (MinGW): only libprotobuf, linked into the Windows .exe.
    # The 3.21.12 source ships pre-generated descriptor .pb.cc, so no protoc
    # is required to build the target lib.
    cmake_args+=(
      -DCMAKE_SYSTEM_NAME=Windows -DCMAKE_SYSTEM_PROCESSOR=x86_64
      -DCMAKE_C_COMPILER="$MINGW_CC" -DCMAKE_CXX_COMPILER="$MINGW_CXX"
      -DCMAKE_RC_COMPILER="$MINGW_RC"
      -DCMAKE_FIND_ROOT_PATH="$MINGW_SYSROOT"
      -DCMAKE_FIND_ROOT_PATH_MODE_PROGRAM=NEVER
      -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=BOTH
      -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=BOTH
      -Dprotobuf_BUILD_PROTOC_BINARIES=OFF
      -Dprotobuf_BUILD_LIBPROTOC=OFF
    )
  fi
  cmake "${cmake_args[@]}"
  cmake --build "$b" -j"$JOBS"
  cmake --install "$b"
}

# ---------------------------------------------------------------------------
# Mode dispatch
# ---------------------------------------------------------------------------
do_configure=0
do_build=0
case "$MODE" in
  all)
    build_capnp "$HOST_CAPNP" 1
    build_capnp "$WIN_CAPNP" 0
    build_protobuf "$HOST_PROTO" 1
    build_protobuf "$WIN_PROTO" 0
    do_configure=1; do_build=1
    ;;
  capnp)
    build_capnp "$HOST_CAPNP" 1
    build_capnp "$WIN_CAPNP" 0
    ;;
  protobuf)
    build_protobuf "$HOST_PROTO" 1
    build_protobuf "$WIN_PROTO" 0
    ;;
  configure)
    do_configure=1
    ;;
  build)
    do_build=1
    ;;
  *)
    echo "Unknown mode: $MODE" >&2
    echo "Usage: $0 [all|configure|build|capnp|protobuf]" >&2
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# Apply cross-compile source patches to the Surelog submodule.
# third_party/Surelog is an upstream git submodule we do NOT maintain, so its
# source edits cannot live in a fork. Instead they are shipped as a patch in
# this repo (patches/surelog-mingw-cross.patch) and applied onto the pristine
# submodule checkout. This keeps the build reproducible after a
# `git submodule update --force`. Applied idempotently.
# ---------------------------------------------------------------------------
SURELOG_PATCH="$ROOT/patches/surelog-mingw-cross.patch"
if [ -f "$SURELOG_PATCH" ] && [ -e "$ROOT/third_party/Surelog/.git" ]; then
  if git -C "$ROOT/third_party/Surelog" apply --check "$SURELOG_PATCH" 2>/dev/null; then
    echo "==> Applying Surelog cross-compile patch -> third_party/Surelog"
    git -C "$ROOT/third_party/Surelog" apply "$SURELOG_PATCH"
  else
    echo "==> Surelog patch already applied or not applicable (skipping)"
  fi
fi

# ---------------------------------------------------------------------------
# Configure (MinGW-w64 -> Windows)
# ---------------------------------------------------------------------------
if [ "$do_configure" = 1 ]; then
  echo "==> Configuring cross build in: $BUILD_DIR"
  cmake -S . -B "$BUILD_DIR" \
    -G "Ninja" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_SYSTEM_NAME=Windows \
    -DCMAKE_SYSTEM_PROCESSOR=x86_64 \
    -DCMAKE_C_COMPILER="$MINGW_CC" \
    -DCMAKE_CXX_COMPILER="$MINGW_CXX" \
    -DCMAKE_RC_COMPILER="$MINGW_RC" \
    -DCMAKE_FIND_ROOT_PATH="$MINGW_SYSROOT" \
    -DCMAKE_FIND_ROOT_PATH_MODE_PROGRAM=NEVER \
    -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=BOTH \
    -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=BOTH \
    -DCMAKE_EXE_LINKER_FLAGS="-static -static-libgcc -static-libstdc++" \
    -DZLIB_USE_STATIC_LIBS=ON \
    -DCMAKE_PREFIX_PATH="$WIN_CAPNP" \
    -DCAPNP_EXECUTABLE="$HOST_CAPNP/bin/capnp" \
    -DCAPNPC_CXX_EXECUTABLE="$HOST_CAPNP/bin/capnpc-c++" \
    -DProtobuf_INCLUDE_DIR="$WIN_PROTO/include" \
    -DProtobuf_LIBRARY="$WIN_PROTO/lib/libprotobuf.a" \
    -DProtobuf_LITE_LIBRARY="$WIN_PROTO/lib/libprotobuf.a" \
    -DProtobuf_PROTOC_EXECUTABLE="$HOST_PROTO/bin/protoc" \
    -DBUILD_INTERPRETER=ON \
    -DBUILD_TESTS=OFF \
    -DBUILD_SURELOG=ON \
    -DSURELOG_WITH_TCMALLOC=OFF \
    -DSURELOG_USE_HOST_CAPNP=ON \
    -DUHDM_USE_HOST_CAPNP=ON
fi

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
if [ "$do_build" = 1 ]; then
  echo "==> Building targets: what_interpreter kdb_viewer"
  cmake --build "$BUILD_DIR" --target what_interpreter kdb_viewer -j"$JOBS"
  echo "==> Done. Artifacts:"
  find "$BUILD_DIR" -name '*.exe' -print
fi
