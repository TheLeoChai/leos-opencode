# Fork Maintenance

Leo's OpenCode keeps its customization layer small so official OpenCode
changes remain easy to rebase.

## Remote Layout

Use the personal repository as `origin` and the official repository as
`upstream`:

```powershell
git remote rename origin upstream
git remote add origin git@github.com:TheLeoChai/leos-opencode.git
git remote -v
```

The customization branch is `leos-opencode`. The official base branch is
`upstream/dev`.

## Updating The Fork

Do not rebase with a dirty worktree. Commit or stash local work first, then:

```powershell
git fetch upstream --prune
git switch leos-opencode
git rebase upstream/dev
bun install
bun run --cwd packages/opencode build --single
```

Run the focused compaction tests after resolving any conflicts:

```powershell
cd packages/opencode
bun test test/session/compaction.test.ts
```

If a rebase conflicts, resolve the files, stage them, and continue:

```powershell
git add <resolved-files>
git rebase --continue
```

Use `git rebase --abort` only when abandoning the update. Inspect the diff
before pushing the rebased branch:

```powershell
git diff upstream/dev...HEAD
git status
```

## Publishing Updates

The branch is intentionally kept separate from `dev`, so upstream's branch
can remain a clean reference point. A rebase changes commit IDs; update the
personal remote with the safer force option:

```powershell
git push --force-with-lease origin leos-opencode
```

## Windows Helpers

The root `rebuild-opencode.cmd` and `rebuild-opencode.ps1` scripts build the
current checkout's Windows binary without assuming a particular machine path.
They refuse to replace a binary that is still running.

The optional root `update-fork.ps1` helper is intended for a compiled Windows
fork. It waits for the current process to exit, stashes local changes,
rebases onto `upstream/dev`, rebuilds, and restores the changes. Review its
output before accepting a rebase or resolving conflicts.

## What Does Not Belong In The Repository

Keep provider credentials, OAuth tokens, local databases, generated binaries,
logs, machine-specific configuration, and private agent definitions outside
the repository. The root `.gitignore` covers the common forms; inspect
`git status --ignored` before publishing.
