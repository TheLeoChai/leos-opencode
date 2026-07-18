param(
  [Parameter(Mandatory = $true)]
  [string]$Version
)

$ErrorActionPreference = "Stop"

if ($Version -notmatch "^v\d+\.\d+\.\d+$") {
  throw "Version must be an upstream tag such as v1.18.0."
}

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

if (git status --porcelain) {
  throw "Worktree is not clean. Commit or stash changes before updating the fork."
}

git fetch upstream --tags
if (-not (git tag --list $Version)) {
  throw "Upstream tag $Version was not found."
}

$branch = git branch --show-current
if (-not $branch) {
  throw "Checkout a feature branch before updating the fork."
}

git branch "backup/$branch-$(Get-Date -Format yyyyMMddHHmmss)"
git rebase --rebase-merges $Version

bun install
bun run packages/opencode/script/build.ts --single
