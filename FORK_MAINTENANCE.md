# Fork Maintenance

This fork has three independent customization layers:

- `feature/progressive-context` contains the OpenCode source changes, including proactive compaction.
- `C:\Users\chaih\.config\opencode\agents` and `commands` contain the global debate agents and `/debate` command.
- `F:\Github\remote-opencode` contains the Discord companion and `start-fork.ps1` launcher.

Only the first layer needs migration when OpenCode releases a new version. The global configuration and Discord settings survive OpenCode updates unchanged.

## Before Updating

Commit fork changes on `feature/progressive-context`. Do not update with a dirty worktree. Keep one focused commit per customization so a conflict can be resolved and tested independently.

## Update

From the fork root, run:

```powershell
.\script\update-fork.ps1 v1.18.0
```

The script fetches upstream tags, creates a timestamped backup branch, rebases the current feature branch on the requested tag, installs dependencies, and builds the Windows executable.

If Git reports a conflict, resolve it, run `git add <resolved-files>`, then run `git rebase --continue`. Use `git rebase --abort` to return to the pre-update branch; the backup branch remains available either way.

## After Updating

Run the focused compaction tests:

```powershell
bun test test/session/compaction.test.ts
```

Then restart the Discord companion through:

```powershell
F:\Github\remote-opencode\start-fork.ps1
```
