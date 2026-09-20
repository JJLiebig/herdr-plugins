# Herdr Plugins

Small, independently installable plugins for [Herdr](https://github.com/herdrdev/herdr).

| Plugin | What it does | Install |
| --- | --- | --- |
| [GitHub Tools](github-tools/) | Shows pull-request status in the Spaces sidebar and opens the current repository or pull request. | `herdr plugin install JJLiebig/herdr-plugins/github-tools` |
| [Cache Timer](cache-timer/) | Shows an estimated cache countdown in the Agents sidebar. | `herdr plugin install JJLiebig/herdr-plugins/cache-timer` |
| [Worktree Discovery](worktree-discovery/) | Automatically shows new agent worktrees and retires untouched spaces after their PR closes. | `herdr plugin install JJLiebig/herdr-plugins/worktree-discovery` |
| [Simple Dispatch](simple-dispatch/) | Turns issues, pull requests, features, and fixes into isolated agent workflows. | `herdr plugin install JJLiebig/herdr-plugins/simple-dispatch` |
| [Herdr Stream Deck+](stream-deck/) | Adds physical triage and control for Herdr on Stream Deck+. | `herdr plugin install JJLiebig/herdr-plugins/stream-deck` |

Install only the plugins you want. Each plugin owns its manifest, dependencies,
configuration, state, and tests.

## Cache Timer

Estimated cache time remaining, with slim progress bars. [Setup and options](cache-timer/).

![Cache Timer showing remaining minutes and slim progress bars in the Agents sidebar](cache-timer/assets/screenshot_cache.png)

Design scaffold: [Richer Sidebar](richer-sidebar/) explores categories, sidebar
layout, and clickable decorations. It has no runtime behavior yet.

## Worktree Discovery

New worktrees appear automatically while their repository has an agent session,
without moving your focus. Works with any agent Herdr recognizes, including
Codex and Symphony++. Existing worktrees are left alone on the first scan.

```sh
herdr plugin install JJLiebig/herdr-plugins/worktree-discovery
herdr plugin action invoke jjliebig.worktree-discovery.watch
```

Requires Herdr 0.9.0+ and Node.js 18+. The action starts discovery in an existing
session; future Herdr sessions start it automatically.

Pair it with **GitHub Tools** for PR status and automatic retirement: untouched
spaces close 30 minutes after their PR is observed as merged or closed. Only
spaces opened by discovery are eligible. Visiting one only pauses cleanup while
it is focused; explicit Keep or customization makes it yours. Removed worktrees
lose their idle, unfocused auto-added views on the next scan. Worktree files and
branches are never deleted.

See the [Worktree Discovery guide](worktree-discovery/) for ownership rules and
the [GitHub Tools setup](github-tools/) for sidebar configuration.

## GitHub Tools visual direction

These screenshots are from the earlier [Herdr PR #4089](https://github.com/herdrdev/herdr/pull/4089) design exploration. GitHub Tools currently shows pull-request status through the `$github_pr` sidebar token; the symbol and Nerd Font icon modes pictured below are **not** part of the plugin.

| Before | Symbols | Nerd Font |
| --- | --- | --- |
| <img src="github-tools/assets/pr4089-before-off.png" width="220" alt="Spaces sidebar before pull-request indicators"> | <img src="github-tools/assets/pr4089-symbols.png" width="220" alt="Proposed pull-request indicators using portable symbols"> | <img src="github-tools/assets/pr4089-nerd-font.png" width="220" alt="Proposed pull-request indicators using Nerd Font icons"> |
