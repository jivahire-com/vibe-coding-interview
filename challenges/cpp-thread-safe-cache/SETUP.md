# Setup

Build and test instructions for the **Thread-Safe Cache (C++17)** challenge.

## Requirements

| Tool          | Version                          |
| ------------- | -------------------------------- |
| CMake         | ≥ 3.14                           |
| C++ compiler  | C++17 (GCC 11+ or Clang 14+)     |
| Git           | any recent version               |

Catch2 (the test framework) is fetched automatically on the first build via
CMake's `FetchContent` — nothing to install by hand.

## Install

The fastest path is the setup script, which checks for CMake and a C++17
compiler, installs them if missing, then configures and builds.

### macOS

```bash
bash setup.sh
```

If you prefer to install the toolchain yourself:

```bash
brew install cmake
xcode-select --install   # provides the C++ compiler
```

### Linux

```bash
bash setup.sh
```

If you prefer to install the toolchain yourself:

```bash
sudo apt install cmake build-essential   # Debian / Ubuntu
```

> **Windows:** do this challenge in **WSL** (Ubuntu). Run `wsl --install` once
> in PowerShell, reopen the folder in WSL, then use the Linux steps above.

## First build

The first build fetches and compiles Catch2 (~10s, cached afterwards):

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j
```

## Running tests

Run the whole suite:

```bash
./build/tests
```

Run a single tag group (Catch2 bracket tags):

```bash
./build/tests "[basic]"
./build/tests "[thread]"
./build/tests "[edge]"
```

After editing the header, rebuild and re-run in one step:

```bash
cmake --build build -j && ./build/tests
```

> On the **unmodified starter**, most tests pass but the "LRU eviction order"
> `[basic]` test fails on purpose — it points at the planted bug. If *every*
> test passes, you are on a modified tree.

## Troubleshooting

- **`cmake: command not found`** — macOS: `brew install cmake`; Ubuntu:
  `sudo apt install cmake`.
- **`c++` / `clang++` not found** — macOS: `xcode-select --install`; Ubuntu:
  `sudo apt install build-essential clang`.
- **FetchContent fails on the first build** — the first build needs internet to
  download Catch2. After that `build/_deps/` is cached and offline builds work.
- **Compiler too old / C++17 features missing** — use GCC 11+ or Clang 14+; an
  older compiler may not fully support C++17 and the build will fail.
- **ThreadSanitizer not available** — TSan needs Clang/GCC on Linux/macOS (MSVC
  doesn't support it). The visible tests don't use TSan; the grader runs it on
  Linux.
