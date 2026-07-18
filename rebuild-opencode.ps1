$ErrorActionPreference = "Stop"

$repo = $PSScriptRoot
$binary = Join-Path $repo "packages\opencode\dist\opencode-windows-x64\bin\opencode.exe"

$forkProcesses = @(Get-Process opencode -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $binary })
if ($forkProcesses) {
  throw "The compiled fork is running. Close it, then rerun this script so the binary can be replaced safely."
}

Set-Location -LiteralPath $repo
Write-Host "Building OpenCode..."
bun run --cwd packages\opencode build --single
if ($LASTEXITCODE -ne 0) {
  throw "OpenCode build failed with exit code $LASTEXITCODE."
}

Write-Host "Checking the rebuilt binary..."
& $binary --version
if ($LASTEXITCODE -ne 0) {
  throw "The rebuilt OpenCode binary failed its version check."
}

Write-Host "Rebuild succeeded."
