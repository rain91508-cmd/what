cmake_minimum_required(VERSION 3.20)

project(hwdesignanalyzer 
    VERSION 1.0.0
    LANGUAGES CXX C
    DESCRIPTION "Hardware Design Analysis Tool - Server and Interpreter"
)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(BUILD_SERVER "Build data server" ON)
option(BUILD_INTERPRETER "Build design interpreter" ON)
option(BUILD_TESTS "Build tests" OFF)
option(BUILD_SURELOG "Build with Surelog parser" ON)

if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    add_compile_options(-g -O0 -Wall -Wextra)
else()
    add_compile_options(-O2 -Wall)
endif()

find_package(Threads REQUIRED)
find_package(ZLIB REQUIRED)

find_program(CLANG_FORMAT "clang-format")
if(CLANG_FORMAT)
    add_custom_target(format
        COMMAND ${CLANG_FORMAT}
        -i
        -style=file
        ${CMAKE_SOURCE_DIR}/server/src/*.cpp
        ${CMAKE_SOURCE_DIR}/server/include/*.h
        ${CMAKE_SOURCE_DIR}/interpreter/src/*.cpp
        ${CMAKE_SOURCE_DIR}/interpreter/include/*.h
        COMMENT "Formatting code with clang-format"
    )
endif()

if(BUILD_SURELOG)
    set(SURELOG_BUILD_TESTS OFF CACHE BOOL "Disable Surelog tests")
    add_subdirectory(third_party/Surelog)
endif()

if(BUILD_SERVER)
    add_subdirectory(server)
endif()

if(BUILD_INTERPRETER)
    add_subdirectory(interpreter)
endif()

if(BUILD_TESTS)
    enable_testing()
endif()

message(STATUS "=== Build Configuration ===")
message(STATUS "Build Type: ${CMAKE_BUILD_TYPE}")
message(STATUS "Build Server: ${BUILD_SERVER}")
message(STATUS "Build Interpreter: ${BUILD_INTERPRETER}")
message(STATUS "Build Surelog: ${BUILD_SURELOG}")
message(STATUS "Build Tests: ${BUILD_TESTS}")
message(STATUS "C++ Standard: ${CMAKE_CXX_STANDARD}")
message(STATUS "Install Prefix: ${CMAKE_INSTALL_PREFIX}")
