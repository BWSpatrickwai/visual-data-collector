$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if (Get-Command node -ErrorAction SilentlyContinue) {
  $Node = "node"
} elseif (Test-Path $BundledNode) {
  $Node = $BundledNode
} else {
  throw "Node.js was not found. Please install Node.js or run this from Codex where the bundled Node runtime exists."
}

Set-Location $ProjectDir
& $Node ".\server.mjs"
