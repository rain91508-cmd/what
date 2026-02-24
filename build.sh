#!/bin/bash

set -e

BUILD_DIR="build"
BUILD_TYPE="${1:-Release}"

echo "=== Building HW Design Analyzer ==="
echo "Build Type: $BUILD_TYPE"

# Create build directory
mkdir -p $BUILD_DIR

# Configure with CMake
cd $BUILD_DIR
cmake .. \
    -DCMAKE_BUILD_TYPE=$BUILD_TYPE \
    -DCMAKE_EXPORT_COMPILE_COMMANDS=ON

# Build
make -j$(nproc)

echo "=== Build Complete ==="
echo "Binaries:"
echo "  - server/hwda_server"
echo "  - interpreter/hwda_interpreter"
