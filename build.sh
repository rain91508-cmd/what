#!/bin/bash

# Build script for HWDA interpreter
# Usage: ./build.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${SCRIPT_DIR}/build_new"
LOG_FILE="${BUILD_DIR}/build.log"

echo "========================================"
echo "HWDA Interpreter Build Script"
echo "========================================"
echo ""

# Remove old executables
echo "Step 1: Removing old executables..."
if [ -f "${BUILD_DIR}/interpreter/hwda_interpreter" ]; then
    rm -v "${BUILD_DIR}/interpreter/hwda_interpreter"
    echo "  - Removed hwda_interpreter"
else
    echo "  - hwda_interpreter not found (skipping)"
fi

if [ -f "${BUILD_DIR}/interpreter/kdb_viewer" ]; then
    rm -v "${BUILD_DIR}/interpreter/kdb_viewer"
    echo "  - Removed kdb_viewer"
else
    echo "  - kdb_viewer not found (skipping)"
fi
echo ""

# Run cmake and make
echo "Step 2: Building project..."
echo "  - Build directory: ${BUILD_DIR}"
echo "  - Log file: ${LOG_FILE}"
echo ""

cd "${BUILD_DIR}"

# Run make and capture all output
make -j4 2>&1 | tee "${LOG_FILE}"

BUILD_EXIT_CODE=${PIPESTATUS[0]}

echo ""
echo "========================================"
if [ $BUILD_EXIT_CODE -eq 0 ]; then
    echo "Build completed successfully!"
    echo ""
    echo "Executables:"
    ls -lh "${BUILD_DIR}/interpreter/hwda_interpreter" "${BUILD_DIR}/interpreter/kdb_viewer" 2>/dev/null || echo "  (executables not found)"
else
    echo "Build FAILED with exit code: ${BUILD_EXIT_CODE}"
    echo ""
    echo "Error summary:"
    grep -E "(Error|error:|ERROR)" "${LOG_FILE}" | head -20 || echo "  (no errors found in log)"
fi
echo "========================================"
echo ""
echo "Full log available at: ${LOG_FILE}"
echo ""

exit $BUILD_EXIT_CODE
