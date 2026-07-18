param(
  [Parameter(Mandatory = $true)]
  [int]$ParentProcessId
)

$ErrorActionPreference = "Stop"
$repo = $PSScriptRoot
$forkBin = Join-Path $repo "packages\opencode\dist\opencode-windows-x64\bin"
$binary = Join-Path $forkBin "opencode.exe"

function Invoke-Checked($command, [string[]]$arguments) {
  & $command @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: $command $($arguments -join ' ')"
  }
}

function Get-UpstreamRemote {
  $remote = (& git remote get-url upstream 2>$null)
  if ($LASTEXITCODE -eq 0 -and $remote) {
    return "upstream"
  }

  $remote = (& git remote get-url origin 2>$null)
  if ($LASTEXITCODE -eq 0 -and $remote -match "anomalyco/opencode(?:\.git)?$") {
    return "origin"
  }

  throw "No upstream OpenCode remote found. Add one with: git remote add upstream https://github.com/anomalyco/opencode.git"
}

function Stop-ForkProcesses {
  Get-Process opencode -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $binary } |
    Stop-Process -Force
}

function Stop-WithRecoveryInstructions($message) {
  Write-Error $message
  Write-Host "The repository may still contain a stash or an in-progress rebase. Inspect git status before continuing."
  exit 1
}

for ($seconds = 0; $seconds -lt 10 -and (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue); $seconds++) {
  Start-Sleep -Seconds 1
}

Stop-ForkProcesses

try {
  Set-Location -LiteralPath $repo
  $dirty = git status --porcelain
  if ($dirty) {
    Invoke-Checked git @("stash", "push", "--include-untracked", "-m", "fork updater pre-rebase")
  }

  $remote = Get-UpstreamRemote
  Invoke-Checked git @("fetch", $remote, "dev:refs/remotes/$remote/dev")
  & git rebase "$remote/dev"
  if ($LASTEXITCODE -ne 0) {
    Stop-WithRecoveryInstructions "Rebase stopped for conflict resolution."
  }

  if ($dirty) {
    & git stash pop
    if ($LASTEXITCODE -ne 0) {
      Stop-WithRecoveryInstructions "Restoring local changes stopped for conflict resolution."
    }
  }

  & "$repo\rebuild-opencode.ps1"
} catch {
  Stop-WithRecoveryInstructions $_
}
