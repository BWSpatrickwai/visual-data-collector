$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$BundledPnpm = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\bin\pnpm.cmd"

if (Get-Command node -ErrorAction SilentlyContinue) {
  $Node = "node"
} elseif (Test-Path $BundledNode) {
  $Node = $BundledNode
} else {
  throw "Node.js was not found. Please install Node.js or run this from Codex where the bundled Node runtime exists."
}

Set-Location $ProjectDir

$HasPlaywright = Test-Path ".\node_modules\playwright"
$HasPlaywrightCore = (Test-Path ".\node_modules\playwright-core") -or (Test-Path ".\node_modules\.pnpm\playwright-core@1.60.0\node_modules\playwright-core")
if (-not ($HasPlaywright -and $HasPlaywrightCore)) {
  Write-Host "Installing local dependencies. This is needed the first time, or if node_modules was removed..."
  if (Get-Command npm -ErrorAction SilentlyContinue) {
    & npm install
  } elseif (Test-Path $BundledPnpm) {
    & $BundledPnpm install
  } else {
    throw "npm/pnpm was not found. Please install Node.js from https://nodejs.org, then run this script again."
  }
}

& $Node ".\server.mjs"
