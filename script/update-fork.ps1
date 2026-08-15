$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

try {
  & (Join-Path $root "update-fork.ps1") @args
} catch {
  Write-Error $_
  exit 1
}
