<p align="center">
  <br>
  <strong>Leo's OpenCode</strong>
  <br>
  <sub>A long-session focused personal fork of the open source coding agent.</sub>
  <br><br>
  <a href="https://github.com/anomalyco/opencode">
    <img alt="Based on OpenCode" src="https://img.shields.io/badge/based%20on-anomalyco%2Fopencode-6e56cf?style=for-the-badge">
  </a>
  <a href="LICENSE">
    <img alt="MIT License" src="https://img.shields.io/badge/license-MIT-111827?style=for-the-badge">
  </a>
  <a href="https://github.com/TheLeoChai/leos-opencode/commits/leos-opencode">
    <img alt="Upstream tracked" src="https://img.shields.io/badge/branch-upstream--tracked-0f766e?style=for-the-badge">
  </a>
</p>

<p align="center">
  <a href="#what-changed">What changed</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#staying-current">Staying current</a> ·
  <a href="https://github.com/anomalyco/opencode">Official OpenCode</a>
</p>

> [!IMPORTANT]
> Leo's OpenCode is an independent personal fork. It is not created,
> maintained, endorsed, sponsored, or affiliated with anomalyco or the
> official OpenCode team. Use the upstream project for official releases,
> support, security notices, and community documentation.

## Why This Fork Exists

OpenCode is already an excellent terminal coding agent. This project is a
small, upstream-tracking playground for improvements that make long-running
sessions easier to monitor and less likely to hit a hard context boundary.

The goal is not to replace upstream OpenCode. The goal is to keep a focused,
reviewable personal layer on top of it.

## What Changed

<table>
  <tr>
    <td width="33%"><strong>More context headroom</strong><br><sub>Proactive compaction begins before the model reaches the hard context limit.</sub></td>
    <td width="33%"><strong>Visible session navigation</strong><br><sub>The conversation scrollbar is enabled by default and remains toggleable.</sub></td>
    <td width="33%"><strong>Upstream-first maintenance</strong><br><sub>Fork changes stay in a small branch that can be rebased onto upstream <code>dev</code>.</sub></td>
  </tr>
</table>

### Proactive Context Compaction

The fork starts automatic compaction at 70% of usable context by default and
retains a larger recent-context budget during that proactive pass. Both values
are configurable:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "compaction": {
    "auto": true,
    "threshold": 0.70,
    "target": 0.45
  }
}
```

- `threshold` controls when automatic compaction begins. It must be greater than `0` and no greater than `1`.
- `target` controls the fraction of usable context reserved for recent history during proactive compaction.
- `preserve_recent_tokens`, when set, takes precedence over `target`.

### Session Scrollbar

The terminal session view uses OpenTUI's native `scrollbox` and shows a
scrollbar by default. Open the command palette and choose
`Toggle session scrollbar` to hide or restore it.

## Quick Start

This fork currently ships as a source build. It does not claim a separate npm,
Homebrew, desktop, or signed binary release channel.

### Requirements

- Git
- Bun `1.3.14` or newer
- Credentials for at least one supported model provider

### Run From Source

```bash
git clone --branch leos-opencode https://github.com/TheLeoChai/leos-opencode.git
cd leos-opencode
bun install
bun dev
```

### Build A Local Binary

```bash
bun run --cwd packages/opencode build --single
```

The generated binary is written below `packages/opencode/dist/`. The exact
directory depends on the operating system and architecture.

## Staying Current

Keep the official repository separate from the personal fork:

```bash
git remote add upstream https://github.com/anomalyco/opencode.git
git fetch upstream dev
git rebase upstream/dev
bun install
bun run --cwd packages/opencode build --single
```

Resolve fork conflicts deliberately, especially in the session compaction
implementation and the terminal session route. The detailed workflow lives in
[`FORK_MAINTENANCE.md`](FORK_MAINTENANCE.md).

## Project Status

This is a personal side project. APIs, defaults, and build instructions may
change as upstream OpenCode evolves. Treat it as an experimental source fork,
not as a drop-in replacement for the official distribution.

## Credits And License

Leo's OpenCode is built from [OpenCode](https://github.com/anomalyco/opencode),
maintained by anomalyco and its contributors. Upstream source, documentation,
and assets remain attributable to their original authors.

This project is distributed under the MIT License. See [`LICENSE`](LICENSE).
