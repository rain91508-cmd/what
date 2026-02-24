cmake_minimum_required(VERSION 3.16)

project(hwda_server VERSION 1.0.0 LANGUAGES CXX)

set(SERVER_SOURCES
    src/main.cpp
    src/server.cpp
    src/api_handler.cpp
    src/kdb_loader.cpp
    src/wave_reader.cpp
    src/wave_fst.cpp
    src/wave_evcd.cpp
)

set(SERVER_HEADERS
    include/server.h
    include/api_handler.h
    include/kdb_loader.h
    include/wave_reader.h
    include/wave_fst.h
    include/wave_evcd.h
    include/types.h
    include/config.h
)

add_library(hwda_server_lib STATIC
    ${SERVER_SOURCES}
    ${SERVER_HEADERS}
)

target_include_directories(hwda_server_lib
    PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}/include
        ${CMAKE_CURRENT_SOURCE_DIR}/../interpreter/include
)

target_link_libraries(hwda_server_lib
    PUBLIC
        Threads::Threads
        ZLIB::ZLIB
)

find_package(OpenSSL)
if(OpenSSL_FOUND)
    target_link_libraries(hwda_server_lib PUBLIC OpenSSL::SSL OpenSSL::Crypto)
    target_compile_definitions(hwda_server_lib PUBLIC USE_OPENSSL)
endif()

add_executable(hwda_server src/main.cpp)
target_link_libraries(hwda_server PRIVATE hwda_server_lib)

install(TARGETS hwda_server
    RUNTIME DESTINATION bin
)

install(FILES ${SERVER_HEADERS}
    DESTINATION include/hwda/server
)
