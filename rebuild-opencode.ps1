$ErrorActionPreference = "Stop"

$repo = $PSScriptRoot
$updates = Join-Path $repo "dist\updates"
$bin = Join-Path $repo "bin"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmssfff"
$staging = Join-Path $updates $timestamp
$binary = Join-Path $staging "opencode-windows-x64\bin\opencode.exe"
$pointer = Join-Path $bin "current.txt"
$pointerTemp = Join-Path $bin ("current.txt.{0}.tmp" -f [Guid]::NewGuid().ToString("N"))
$pointerBackup = Join-Path $bin ("current.txt.{0}.bak" -f [Guid]::NewGuid().ToString("N"))
$relativeTarget = Join-Path (Join-Path "dist\updates" $timestamp) "opencode-windows-x64\bin\opencode.exe"
$previousBuildDir = $env:OPENCODE_BUILD_DIR
$previousChannel = $env:OPENCODE_CHANNEL

function Set-UserPathFirst([string]$entry) {
  $normalized = $entry.TrimEnd("\")
  $legacyRepo = Join-Path (Split-Path -Parent $repo) "Opencode"
  $legacyEntries = @(
    (Join-Path $legacyRepo "bin").TrimEnd("\"),
    (Join-Path $legacyRepo "packages\opencode\dist\opencode-windows-x64\bin").TrimEnd("\")
  )
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $entries = $userPath -split ";" | Where-Object {
    $value = $_.TrimEnd("\")
    $_ -and $value -ine $normalized -and $legacyEntries -notcontains $value
  }
  [Environment]::SetEnvironmentVariable("Path", "$entry;$($entries -join ';')", "User")
}

Set-Location -LiteralPath $repo
New-Item -ItemType Directory -Path $updates -Force | Out-Null
New-Item -ItemType Directory -Path $staging -ErrorAction Stop | Out-Null
New-Item -ItemType Directory -Path $bin -Force | Out-Null
Set-UserPathFirst $bin

try {
  $env:OPENCODE_BUILD_DIR = $staging
  $env:OPENCODE_CHANNEL = "leos-opencode"
  Write-Host "Building OpenCode in $staging..."
  & bun run --cwd packages\opencode build --single --skip-install
  if ($LASTEXITCODE -ne 0) {
    throw "OpenCode build failed with exit code $LASTEXITCODE. The current pointer was not changed."
  }

  if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
    throw "The staged OpenCode binary was not produced at $binary. The current pointer was not changed."
  }

  Write-Host "Checking the staged binary..."
  & $binary --version
  if ($LASTEXITCODE -ne 0) {
    throw "The staged OpenCode binary failed its version check. The current pointer was not changed."
  }

  [System.IO.File]::WriteAllText(
    $pointerTemp,
    $relativeTarget + [Environment]::NewLine,
    (New-Object System.Text.UTF8Encoding($false))
  )

  if (Test-Path -LiteralPath $pointer) {
    [System.IO.File]::Replace($pointerTemp, $pointer, $pointerBackup)
  } else {
    [System.IO.File]::Move($pointerTemp, $pointer)
  }

  Write-Host "Activated $relativeTarget"
} finally {
  if ($null -eq $previousBuildDir) {
    Remove-Item Env:OPENCODE_BUILD_DIR -ErrorAction SilentlyContinue
  } else {
    $env:OPENCODE_BUILD_DIR = $previousBuildDir
  }

  if ($null -eq $previousChannel) {
    Remove-Item Env:OPENCODE_CHANNEL -ErrorAction SilentlyContinue
  } else {
    $env:OPENCODE_CHANNEL = $previousChannel
  }

  Remove-Item -LiteralPath $pointerTemp -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $pointerBackup -Force -ErrorAction SilentlyContinue
}
