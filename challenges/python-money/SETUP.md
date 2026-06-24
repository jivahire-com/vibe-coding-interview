# Setup

How to get the **Money Value Type** challenge installed and running its tests.
Every command here mirrors the project's `README.md`, `setup.sh`, `setup.ps1`,
and `pyproject.toml`.

## Requirements

| Tool   | Version          | Notes                                         |
| ------ | ---------------- | --------------------------------------------- |
| Python | ≥ 3.11           | Declared by `requires-python` in `pyproject.toml`. |
| pip    | recent           | Bundled with Python; upgraded during install. |
| Git    | any              | To clone / track the challenge.               |

## Install

Create an isolated virtual environment, then install the package in editable
mode with its `dev` extra (which pulls in `pytest`).

```bash
# macOS / Linux
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -e ".[dev]"
```

> Prefer a one-command setup? Run `bash setup.sh` (macOS / Linux) or
> `powershell -ExecutionPolicy Bypass -File setup.ps1` (Windows). Both create
> `.venv` and run the same `pip install -e ".[dev]"` shown above.

## First build

There is no compile step — installing the package editable **is** the build:

```bash
pip install -e ".[dev]"
```

This is exactly how the grader installs the project before running tests.

## Running tests

Activate the venv first (`source .venv/bin/activate`), then:

```bash
# All tests
pytest

# A single marker group (the grader runs one tag at a time)
pytest -m basic
```

The available marker groups are **basic**, **rounding**, **currency**, and
**allocate** (defined under `[tool.pytest.ini_options].markers` in
`pyproject.toml`). The grader runs `pytest -m <tag>` per task.

On the unmodified starter, all `basic` tests pass and exactly one each of the
`rounding`, `currency`, and `allocate` tests fail on purpose — they point at the
three planted bugs.

## Troubleshooting

**`ModuleNotFoundError: No module named 'money'`**
The editable install hasn't run (or you're outside the venv). Activate the venv
and run `pip install -e ".[dev]"` again. The module lives in `src/money.py` and
is exposed via `py-modules = ["money"]` in `pyproject.toml`.

**`PytestUnknownMarkWarning: Unknown pytest.mark.basic`**
pytest isn't seeing the marker config. Make sure you run `pytest` from the
challenge root (where `pyproject.toml` lives) so the `[tool.pytest.ini_options]`
`markers` block is picked up. Don't override it with a stray `pytest.ini`.

**`command not found: pytest` (or wrong Python used)**
The virtual environment isn't active. Run `source .venv/bin/activate`
(Windows: `.\.venv\Scripts\Activate.ps1`) before calling `pytest`, or invoke it
explicitly as `python -m pytest`.
