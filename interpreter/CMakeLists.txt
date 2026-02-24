cmake_minimum_required(VERSION 3.16)

project(hwda_interpreter VERSION 1.0.0 LANGUAGES CXX C)

set(INTERPRETER_SOURCES
    src/main.cpp
    src/parser.cpp
    src/kdb_builder.cpp
    src/kdb_serializer.cpp
    src/ast_visitor.cpp
)

set(INTERPRETER_HEADERS
    include/parser.h
    include/kdb_builder.h
    include/kdb_serializer.h
    include/ast_visitor.h
    include/kdb.pb.h
    include/types.h
)

add_library(hwda_interpreter_lib STATIC
    ${INTERPRETER_SOURCES}
    ${INTERPRETER_HEADERS}
)

target_include_directories(hwda_interpreter_lib
    PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}/include
)

find_package(Protobuf QUIET)
if(Protobuf_FOUND)
    message(STATUS "Found Protobuf: ${Protobuf_VERSION}")
    target_link_libraries(hwda_interpreter_lib PUBLIC protobuf::libprotobuf)
else()
    message(STATUS "Protobuf not found, will use bundled version")
    add_subdirectory(third_party/protobuf)
    target_link_libraries(hwda_interpreter_lib PUBLIC libprotobuf)
endif()

find_package(Zstd QUIET)
if(Zstd_FOUND)
    target_link_libraries(hwda_interpreter_lib PUBLIC zstd::zstd)
else()
    message(STATUS "zstd not found, will use bundled version")
    add_subdirectory(third_party/zstd)
    target_link_libraries(hwda_interpreter_lib PUBLIC zstd_static)
endif()

add_executable(hwda_interpreter src/main.cpp)
target_link_libraries(hwda_interpreter PRIVATE hwda_interpreter_lib)

install(TARGETS hwda_interpreter
    RUNTIME DESTINATION bin
)

install(FILES ${INTERPRETER_HEADERS}
    DESTINATION include/hwda/interpreter
)

message(STATUS "Surelog will be integrated as a submodule in third_party/")
