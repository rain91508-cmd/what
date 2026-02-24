cmake_minimum_required(VERSION 3.20)

project(hwda_interpreter VERSION 1.0.0 LANGUAGES CXX C)

# Protocol Buffers support
find_package(Protobuf QUIET)
if(NOT Protobuf_FOUND)
    message(STATUS "Protobuf not found, will use system protoc or skip protobuf generation")
endif()

# Proto files
set(PROTO_FILES
    proto/kdb.proto
)

# Generate C++ code from proto files
if(Protobuf_FOUND)
    protobuf_generate_cpp(PROTO_SRCS PROTO_HDRS ${PROTO_FILES})
    message(STATUS "Proto sources: ${PROTO_SRCS}")
    message(STATUS "Proto headers: ${PROTO_HDRS}")
else()
    # If protobuf not found, use pre-generated files or skip
    set(PROTO_SRCS "")
    set(PROTO_HDRS "")
    message(WARNING "Protobuf not found. Please install protobuf-compiler and libprotobuf-dev")
endif()

set(INTERPRETER_SOURCES
    src/main.cpp
    src/parser.cpp
    src/kdb_builder.cpp
    src/kdb_serializer.cpp
    src/ast_visitor.cpp
    ${PROTO_SRCS}
)

if(TARGET surelog)
    list(APPEND INTERPRETER_SOURCES src/surelog_parser.cpp)
endif()

set(INTERPRETER_HEADERS
    include/parser.h
    include/kdb_builder.h
    include/kdb_serializer.h
    include/ast_visitor.h
    include/types.h
    include/surelog_parser.h
    # include/surelog_interpreter.h  # TODO: Enable when API is updated
    ${PROTO_HDRS}
)

add_library(hwda_interpreter_lib STATIC
    ${INTERPRETER_SOURCES}
    ${INTERPRETER_HEADERS}
)

target_include_directories(hwda_interpreter_lib
    PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}/include
        ${CMAKE_CURRENT_BINARY_DIR}  # For generated proto headers
        ${CMAKE_SOURCE_DIR}/third_party/Surelog/include
        ${CMAKE_SOURCE_DIR}/third_party/Surelog/third_party/UHDM/include
        ${CMAKE_SOURCE_DIR}/third_party/Surelog/third_party/UHDM
        ${CMAKE_BINARY_DIR}/third_party/Surelog/third_party/UHDM/generated  # For UHDM generated headers
)

find_package(Zstd QUIET)
if(Zstd_FOUND)
    target_link_libraries(hwda_interpreter_lib PUBLIC zstd::zstd)
    target_compile_definitions(hwda_interpreter_lib PUBLIC USE_ZSTD)
    message(STATUS "zstd found and enabled for compression")
else()
    # Try to find zstd using pkg-config or direct library search
    find_library(ZSTD_LIBRARY NAMES zstd libzstd)
    find_path(ZSTD_INCLUDE_DIR NAMES zstd.h)
    if(ZSTD_LIBRARY AND ZSTD_INCLUDE_DIR)
        target_link_libraries(hwda_interpreter_lib PUBLIC ${ZSTD_LIBRARY})
        target_include_directories(hwda_interpreter_lib PUBLIC ${ZSTD_INCLUDE_DIR})
        target_compile_definitions(hwda_interpreter_lib PUBLIC USE_ZSTD)
        message(STATUS "zstd found via direct search: ${ZSTD_LIBRARY}")
    else()
        message(STATUS "zstd not found, compression disabled")
    endif()
endif()

if(Protobuf_FOUND)
    target_link_libraries(hwda_interpreter_lib PUBLIC protobuf::libprotobuf)
    target_compile_definitions(hwda_interpreter_lib PUBLIC USE_PROTOBUF)
endif()

if(TARGET surelog)
    target_link_libraries(hwda_interpreter_lib PUBLIC surelog)
    target_compile_definitions(hwda_interpreter_lib PUBLIC USE_SURELOG)
    message(STATUS "Surelog linked to interpreter")
endif()

add_executable(hwda_interpreter src/main.cpp)
target_link_libraries(hwda_interpreter PRIVATE hwda_interpreter_lib)

# KDB Viewer tool
add_executable(kdb_viewer src/kdb_viewer.cpp)
target_link_libraries(kdb_viewer PRIVATE hwda_interpreter_lib)

# Test serialize tool (temporarily disabled - file not found)
# add_executable(test_serialize ../test_serialize.cpp)
# target_link_libraries(test_serialize PRIVATE hwda_interpreter_lib)

# Check parent IDs tool (temporarily disabled - file not found)
# add_executable(check_parent_ids ../check_parent_ids.cpp)
# target_link_libraries(check_parent_ids PRIVATE hwda_interpreter_lib)

install(TARGETS hwda_interpreter kdb_viewer
    RUNTIME DESTINATION bin
)

install(FILES ${INTERPRETER_HEADERS}
    DESTINATION include/hwda/interpreter
)

message(STATUS "Interpreter configured with Surelog and Protobuf integration")
