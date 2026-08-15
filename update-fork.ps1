$ErrorActionPreference = "Stop"
$repo = $PSScriptRoot
Set-Location -LiteralPath $repo

function Get-GitValue([string[]]$arguments) {
  $output = & git @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: git $($arguments -join ' ')"
  }

  return ($output -join "`n").Trim()
}

function Invoke-GitChecked([string[]]$arguments) {
  & git @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: git $($arguments -join ' ')"
  }
}

$rebaseMerge = Get-GitValue @("rev-parse", "--git-path", "rebase-merge")
$rebaseApply = Get-GitValue @("rev-parse", "--git-path", "rebase-apply")
$mergeHead = Get-GitValue @("rev-parse", "--git-path", "MERGE_HEAD")
$cherryPickHead = Get-GitValue @("rev-parse", "--git-path", "CHERRY_PICK_HEAD")

if ((Test-Path -LiteralPath $rebaseMerge) -or (Test-Path -LiteralPath $rebaseApply)) {
  throw "An existing rebase is in progress. Resolve it before running the canonical updater."
}
if (Test-Path -LiteralPath $mergeHead) {
  throw "A merge is in progress. Resolve it before running the canonical updater."
}
if (Test-Path -LiteralPath $cherryPickHead) {
  throw "A cherry-pick is in progress. Resolve it before running the canonical updater."
}

$branch = Get-GitValue @("branch", "--show-current")
if ($branch -ne "leos-opencode") {
  throw "The canonical updater only runs on branch leos-opencode; current branch is '$branch'."
}

$origin = Get-GitValue @("remote", "get-url", "origin")
if ($origin -notmatch "github\.com[/:]anomalyco/opencode(?:\.git)?$") {
  throw "Remote origin must point to the official OpenCode repository."
}

$backupRef = "backup/leos-opencode-$(Get-Date -Format yyyyMMdd-HHmmssfff)"
Invoke-GitChecked @("branch", $backupRef)
Write-Host "Created backup ref $backupRef"

$dirty = Get-GitValue @("status", "--porcelain=v1", "--untracked-files=all")
$stashRef = $null
if ($dirty) {
  $stashMessage = "leos-opencode updater WIP $(Get-Date -Format yyyyMMdd-HHmmssfff)"
  Invoke-GitChecked @("stash", "push", "--include-untracked", "-m", $stashMessage)
  $stashRef = Get-GitValue @("rev-parse", "--verify", "refs/stash")
  Write-Host "Recorded WIP stash $stashRef. It will be retained."
}

try {
  Invoke-GitChecked @("fetch", "origin", "dev:refs/remotes/origin/dev")
  Invoke-GitChecked @("rebase", "origin/dev")
} catch {
  throw "Update stopped before restoration or build. Resolve the rebase state if needed. The WIP stash remains $stashRef. $_"
}

if ($stashRef) {
  try {
    Invoke-GitChecked @("stash", "apply", "--index", $stashRef)
  } catch {
    throw "WIP restoration conflicted. The stash remains $stashRef; resolve the working tree before building. $_"
  }
}

& bun install
if ($LASTEXITCODE -ne 0) {
  throw "Dependency installation failed after the rebase and WIP restoration. The current pointer was not changed."
}

& (Join-Path $repo "rebuild-opencode.ps1")
if ($LASTEXITCODE -ne 0) {
  throw "The rebase and WIP restoration succeeded, but the staged build failed. The current pointer was not changed."
}
