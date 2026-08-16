# Fork Maintenance

Leo's OpenCode keeps its customization layer small so official OpenCode
changes remain easy to rebase.

## Remote Layout

The canonical branch is `leos-opencode`. The remotes have fixed roles:

| Remote | Role | URL |
| --- | --- | --- |
| `origin` | Official OpenCode source | `https://github.com/anomalyco/opencode.git` |
| `leo` | Personal fork | `git@github.com:TheLeoChai/leos-opencode.git` |

Verify the layout before maintenance:

```powershell
git remote -v
git branch --show-current
```

Do not rename these remotes or add a tag-based source workflow.

## Canonical Update

Run the root updater while already on `leos-opencode`:

```powershell
.\update-fork.ps1
```

The updater refuses an existing rebase, merge, or cherry-pick and refuses any
other branch. It creates a timestamped backup ref, then stashes tracked and
untracked work while recording the stash object. It fetches `origin/dev` and
rebases only `leos-opencode` onto `origin/dev`.

Do not use the built-in `opencode upgrade` flow for this fork. Official
installation updates are disabled for the `leos-opencode` channel; this updater
is the supported path because it preserves the fork commits and rebuilds the
canonical launcher.

If the rebase conflicts, the updater stops immediately. It does not restore
the stash or build while the rebase is unresolved. Resolve and continue the
rebase deliberately, then inspect the recorded stash before restoring it.

After a successful rebase, the updater restores the recorded work with
`git stash apply --index`. The stash is retained, including when restoration
conflicts. A build starts only after restoration succeeds.

Inspect the resulting history and worktree before publishing:

```powershell
git diff origin/dev...HEAD
git status
```

## Staged Builds

The Windows rebuild helper never stops or waits for existing OpenCode
processes. Each build is written to a new immutable directory below
`dist\updates\<timestamp>`. The staged Windows binary is version-checked, then
the helper atomically replaces the ignored `bin\current.txt` pointer.

```powershell
.\rebuild-opencode.ps1
.\bin\opencode.cmd --version
```

The launcher fails if `bin\current.txt` is missing, empty, or points to a
missing/non-file target. It invokes only the resolved pointer target. Normal
builds without `OPENCODE_BUILD_DIR` continue to use
`packages\opencode\dist`.

The launcher reads `bin\current.txt` on every invocation. After a successful
update, exit the old OpenCode process and run `opencode` again in the same
terminal. A terminal restart is only needed for a terminal that predates the
canonical PATH setup; future pointer updates do not require restarting the
terminal itself.

## Publishing Updates

The personal remote is `leo`, so publish the rebased canonical branch there
with the safer force option only after reviewing the diff:

```powershell
git push --force-with-lease leo leos-opencode
```

## What Does Not Belong In The Repository

Keep provider credentials, OAuth tokens, local databases, generated binaries,
logs, machine-specific configuration, and private agent definitions outside
the repository. The root `.gitignore` covers the common forms; inspect
`git status --ignored` before publishing.
