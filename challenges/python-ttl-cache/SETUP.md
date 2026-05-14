# Setup

## Requirements

| Tool | Minimum version | Check |
|---|---|---|
| Python | 3.11 | `python3 --version` |
| pip | any modern | `pip --version` |
| Git | any | `git --version` |

**No other installs needed.** `pytest` is the only runtime dev dep and is pulled by `pip install -e ".[dev]"`.

## Recommended setup

- **macOS**: `brew install python@3.11`
- **Ubuntu/Debian**: `sudo apt install python3.11 python3.11-venv`
- **Windows**: official installer from python.org (check "Add to PATH")

## First build

```bash
python3 -m venv .venv
source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
pytest -m basic
```

Expected output on the unmodified starter: most `basic` tests pass; the LRU
eviction-order test fails — that failure is intentional and points at a
planted bug in the eviction loop.

## Troubleshooting

**"python3.11: command not found"**
- macOS: `brew install python@3.11`
- Ubuntu/Debian: `sudo apt install python3.11 python3.11-venv`
- Arch: `sudo pacman -S python`

**"No module named pytest"**
- You probably skipped `pip install -e ".[dev]"`. Activate the venv first, then re-run.

**ImportError: ttl_cache**
- The package is installed in editable mode from `src/`. If you renamed the file, also update `pyproject.toml`.

**Concurrency tests flaky locally**
- The grader runs tests on Linux with deterministic seeds. Local runs should still be stable; if not, you almost certainly have a race in your locking.
