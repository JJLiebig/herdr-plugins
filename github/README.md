# GitHub

Shows the pull request associated with each Git workspace and provides actions
to refresh it or open the current repository or pull request in a browser.

## Install

```powershell
herdr plugin install JJLiebig/herdr-plugins/github
```

Requires Node.js, GitHub CLI authentication, and Herdr 0.8.2 or newer.

Add the reported pull request to the Spaces sidebar:

```toml
[ui.sidebar.spaces]
rows = [["state_icon", "workspace"], ["branch", "git_status", "$github_pr"]]
```

Then run `herdr server reload-config`. The plugin refreshes on startup and when
a workspace is created, updated, or focused. Use the
`jjliebig.github.refresh` action for an explicit refresh.

Herdr does not yet let plugins make sidebar metadata clickable or schedule a
periodic refresh. The `open-pull-request` and `open-repository` actions provide
the current fallback.
