# =============================================================================
# python-money - one-command setup  (Windows / PowerShell)
#
# WHAT THIS IS
#   An optional helper that gets this challenge ready to run. Every command it
#   runs is also written out in the README under "How to run tests" - so if you
#   would rather do it by hand, you can. Nothing here is hidden or destructive.
#
# WHAT IT DOES
#   1. Checks for Python 3.11+. If it is missing, it installs it with winget
#      (Windows' built-in package manager).
#   2. Creates an isolated virtual environment in .\.venv - this does NOT touch
#      your system Python.
#   3. Installs this project's test tool (pytest) into that .venv.
#
# WHAT IT MIGHT ASK FOR
#   Installing a *missing* Python may show a Windows permission (UAC) prompt.
#   If Python 3.11+ is already on your machine, nothing is installed.
#
# HOW TO RUN  (in PowerShell, from this challenge folder)
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#
# WHEN IT FINISHES
#   .\.venv\Scripts\Activate.ps1
#   pytest
# =============================================================================
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot   # run from this challenge folder

function Find-Python311 {
    foreach ($c in @('python', 'python3', 'py')) {
        if (Get-Command $c -ErrorAction SilentlyContinue) {
            # Parse `--version` output ("Python 3.11.9"). We deliberately avoid
            # `-c "..."` here: PowerShell mangles embedded double quotes when
            # passing them to a native command, which would break detection.
            $out = (& $c --version 2>&1 | Out-String).Trim()
            if ($out -match '(\d+)\.(\d+)') {
                if ([int]$Matches[1] -eq 3 -and [int]$Matches[2] -ge 11) { return $c }
            }
        }
    }
    return $null
}

$py = Find-Python311
if (-not $py) {
    Write-Host "Python 3.11+ not found - installing via winget..."
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Error "winget is not available. Install Python 3.11+ from https://python.org/downloads and re-run."
        exit 1
    }
    winget install -e --id Python.Python.3.11 --accept-source-agreements --accept-package-agreements
    Write-Host ""
    Write-Host "Python was just installed. Close and reopen your terminal (or VS Code)"
    Write-Host "so it appears on your PATH, then run this script again."
    exit 0
}
Write-Host "Using $py ($(& $py --version))"

# Isolated environment so the challenge's deps never touch your system Python.
if (-not (Test-Path .venv)) { & $py -m venv .venv }
& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install -e ".[dev]"

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "Setup complete. Run the tests with:"
Write-Host ""
Write-Host "  .\.venv\Scripts\Activate.ps1"
Write-Host "  pytest"
Write-Host ""
Write-Host "On the unmodified starter, the basic tests pass and one each of the"
Write-Host "rounding / currency / allocate tests fail on purpose - those point at"
Write-Host "the bugs you are here to fix."
Write-Host "------------------------------------------------------------"
