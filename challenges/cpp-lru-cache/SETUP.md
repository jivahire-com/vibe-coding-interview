# Setup

## Requirements

| Tool | Minimum version | Check |
|---|---|---|
| CMake | 3.14 | `cmake --version` |
| C++ compiler | C++17 support | `c++ --version` |
| Git | any | `git --version` |

**No other installs needed.** Catch2 is fetched automatically by CMake on first build.

## Recommended compilers

- **macOS**: Apple Clang 14+ (comes with Xcode Command Line Tools)
- **Linux**: GCC 11+ or Clang 14+
- **Windows**: MSVC 2019+ (via Visual Studio) or MinGW-w64

## First build

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j
./build/tests
```

Expected output on the unmodified starter:
```
Randomness seeded to: ...
===============================================================================
All tests passed (N assertions in N test cases)
```

(The public tests are designed to pass on the starter — that is intentional.)

## Troubleshooting

**"cmake: command not found"**
- macOS: `brew install cmake`
- Ubuntu/Debian: `sudo apt install cmake`
- Arch: `sudo pacman -S cmake`

**"c++: no such file or directory" / "clang++: command not found"**
- macOS: `xcode-select --install`
- Ubuntu/Debian: `sudo apt install build-essential clang`

**FetchContent fails (no internet)**
- You need internet access for the first build to download Catch2.
- After the first build, `build/_deps/` is cached and offline builds work.

**ThreadSanitizer not available**
- TSan requires Clang or GCC on Linux/macOS. MSVC does not support it.
- The public tests do not use TSan. If you're on Windows, skip the `-fsanitize=thread` flag.
- The grader always builds with TSan on Linux.
