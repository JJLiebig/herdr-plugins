# GitHub Tools

Shows the pull request associated with each Git workspace and provides actions
to refresh it or open the current repository or pull request in a browser.

## Visual direction

These screenshots came from the earlier [Herdr PR #4089](https://github.com/herdrdev/herdr/pull/4089). They show a proposed native sidebar treatment, not the exact output of this plugin. GitHub Tools reports the portable symbols (`○` open, `◇` draft, `×` closed, `◆` merged) and number through the `$github_pr` sidebar token; it does not provide the pictured native placement, colors, or Nerd Font icon mode.

| Before | Symbols | Nerd Font |
| --- | --- | --- |
| <img src="assets/pr4089-before-off.png" width="260" alt="Spaces sidebar before pull-request indicators"> | <img src="assets/pr4089-symbols.png" width="260" alt="Proposed pull-request indicators using portable symbols"> | <img src="assets/pr4089-nerd-font.png" width="260" alt="Proposed pull-request indicators using Nerd Font icons"> |

## Install

```powershell
herdr plugin install JJLiebig/herdr-plugins/github-tools
```

Requires Node.js, GitHub CLI authentication, and Herdr 0.8.2 or newer.

Add the reported pull request to the Spaces sidebar:

```toml
[ui.sidebar.spaces]
rows = [["state_icon", "workspace"], ["branch", "git_status", "$github_pr"]]
```

Then run `herdr server reload-config`. The plugin refreshes on startup and when
a workspace is created, updated, or focused. Use the
`jjliebig.github-tools.refresh` action for an explicit refresh.

To open the current pull request, or the repository if there is no PR, add:

```toml
[[keys.command]]
key = "alt+shift+g"
type = "plugin_action"
command = "jjliebig.github-tools.open-current"
description = "open GitHub PR or repository"
```

Then run `herdr server reload-config`.

If you installed the former `jjliebig.github` plugin, uninstall it before
installing GitHub Tools: `herdr plugin uninstall jjliebig.github`.

Herdr does not yet let plugins make sidebar metadata clickable or schedule a
periodic refresh. The `open-current`, `open-pull-request`, and `open-repository`
actions provide the current fallback.
