#!/bin/bash

set -e

BUILD_DIR="build"
BUILD_TYPE="${1:-Release}"
BUILD_SURELOG="${2:-ON}"

echo "=== Building HW Design Analyzer ==="
echo "Build Type: $BUILD_TYPE"
echo "Build Surelog: $BUILD_SURELOG"

mkdir -p $BUILD_DIR

cd $BUILD_DIR

cmake .. \
    -DCMAKE_BUILD_TYPE=$BUILD_TYPE \
    -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
    -DBUILD_SURELOG=$BUILD_SURELOG

make -j$(nproc)

echo "=== Build Complete ==="
echo "Binaries:"
echo "  - build/server/hwda_server"
echo "  - build/interpreter/hwda_interpreter"
