# Setup

## Prerequisites

| Tool | Version |
|---|---|
| C++ compiler | C++17 (GCC 9+, Clang 10+, or MSVC 19.20+) |
| CMake | 3.16+ |
| Git | any |

The Jivahire extension checks for these on session start.

## Build

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build build -j
```

## Run tests

```bash
./build/tests           # Linux/macOS
.\build\tests.exe       # Windows
```

Catch2 v3 is fetched automatically by CMake (`FetchContent`). First build will take ~60s; subsequent builds are incremental.

## Run with thread sanitizer (recommended)

```bash
cmake -S . -B build-tsan -DCMAKE_BUILD_TYPE=Debug -DCMAKE_CXX_FLAGS="-fsanitize=thread -g"
cmake --build build-tsan -j
./build-tsan/tests
```

TSan will catch the planted race conditions immediately. Use this — it's faster than reasoning about lock placement on paper.

## Demo run

```bash
./build/wafer_demo
```

Runs a synthetic 4-chamber, 8-wafer scenario and prints the per-wafer records.
