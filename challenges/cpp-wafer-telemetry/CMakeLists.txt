cmake_minimum_required(VERSION 3.16)
project(wafer_telemetry LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(MSVC)
    add_compile_options(/W4 /permissive-)
else()
    add_compile_options(-Wall -Wextra -Wpedantic)
endif()

# --- Library under test ---
add_library(wafer_core STATIC
    src/spc_limits.cpp
    src/chamber_aggregator.cpp
    src/excursion_reporter.cpp   # Task 5 — starter ships a no-op stub
)
target_include_directories(wafer_core PUBLIC src)
find_package(Threads REQUIRED)
target_link_libraries(wafer_core PUBLIC Threads::Threads)

# --- Demo binary ---
add_executable(wafer_demo src/main.cpp)
target_link_libraries(wafer_demo PRIVATE wafer_core)

# --- Tests (Catch2 v3) ---
include(FetchContent)
FetchContent_Declare(
    Catch2
    GIT_REPOSITORY https://github.com/catchorg/Catch2.git
    GIT_TAG        v3.5.2
)
FetchContent_MakeAvailable(Catch2)

# Glob so the grader's injected tests/hidden_tests.cpp is picked up alongside
# the visible tests/public_tests.cpp without editing this file.
file(GLOB TEST_SOURCES tests/*.cpp)
add_executable(tests ${TEST_SOURCES})
target_link_libraries(tests PRIVATE wafer_core Catch2::Catch2WithMain)

include(CTest)
include(Catch)
catch_discover_tests(tests)
