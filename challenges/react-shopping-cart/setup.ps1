# =============================================================================
# react-shopping-cart - one-command setup  (Windows / PowerShell)
#
# WHAT THIS IS
#   An optional helper that gets this challenge ready to run. Every command it
#   runs is also written out in the README under "How to run tests" - so if you
#   would rather do it by hand, you can. Nothing here is hidden or destructive.
#
# WHAT IT DOES
#   1. Checks for Node.js 18+. If it is missing, it installs the current LTS
#      with winget (Windows' built-in package manager).
#   2. Runs `npm install` to pull this challenge's test tools (vitest + jsdom +
#      testing-library) into .\node_modules.
#
# WHAT IT MIGHT ASK FOR
#   Installing a *missing* Node may show a Windows permission (UAC) prompt.
#   If Node 18+ is already on your machine, nothing is installed.
#
# HOW TO RUN  (in PowerShell, from this challenge folder)
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#
# WHEN IT FINISHES
#   npm test
# =============================================================================
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot   # run from this challenge folder

function Test-Node18 {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
    try { $major = [int]((node -p "process.versions.node.split('.')[0]") 2>$null) }
    catch { $major = 0 }
    return $major -ge 18
}

if (-not (Test-Node18)) {
    Write-Host "Node.js 18+ not found - installing via winget..."
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Error "winget is not available. Install Node 18+ from https://nodejs.org and re-run."
        exit 1
    }
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    Write-Host ""
    Write-Host "Node was just installed. Close and reopen your terminal (or VS Code)"
    Write-Host "so it appears on your PATH, then run this script again."
    exit 0
}
Write-Host "Using node $(node --version) / npm $(npm --version)"

npm install

Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "Setup complete. Run the tests with:"
Write-Host ""
Write-Host "  npm test"
Write-Host ""
Write-Host "On the unmodified starter, the @basic tests pass and one each of the"
Write-Host "@discount / @clamp / @coupons tests fail on purpose - those point at the"
Write-Host "bugs you are here to fix."
Write-Host ""
Write-Host "Optional: launch the visual playground (not graded) to click through"
Write-Host "your cart in a browser:"
Write-Host ""
Write-Host "  npm run dev"
Write-Host "------------------------------------------------------------"
