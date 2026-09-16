# GitHub Tools

Show the current branch's pull request in Herdr's Spaces sidebar (`○ #123` for
open, `◇` draft, `×` closed, `◆` merged).

## Install

Requires Node.js and an authenticated [GitHub CLI](https://cli.github.com/).

```sh
herdr plugin install JJLiebig/herdr-plugins/github-tools
```

Until Herdr supports plugin-provided sidebar rows, add this to the Herdr config
file (`~/.config/herdr/config.toml` on Linux/macOS or
`%APPDATA%\herdr\config.toml` on Windows), then run `herdr server reload-config`:

```toml
[ui.sidebar.spaces]
rows = [["state_icon", "workspace"], ["branch", "git_status", "$github_pr"]]
```

Then run `herdr server reload-config`. The plugin refreshes every minute while
Herdr runs, and when a workspace is created, updated, or focused. After installing
into an already running Herdr session, start automatic refresh with
`herdr plugin action invoke jjliebig.github-tools.watch`. Repeating it is harmless.
Use the
`jjliebig.github-tools.refresh` action for an explicit refresh.

## Nerd Fonts

To use Nerd Font PR glyphs, install a font such as
[JetBrainsMono Nerd Font Mono](https://www.nerdfonts.com/font-downloads) and
select it in the terminal displaying Herdr. In the sidebar `rows` setting
above, replace `$github_pr` with `$github_pr_nerd`, then run
`herdr server reload-config`.

The default `$github_pr` uses portable symbols. Nerd Font glyphs will not
display correctly unless your terminal uses a font that contains them.

## Keybinds

To open the current PR (or the repository when there is no PR), add this optional
keybind to the same Herdr `config.toml`:

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

Herdr does not yet let plugins make sidebar metadata clickable. The
`open-current`, `open-pull-request`, and `open-repository` actions provide the
current fallback.

The sidebar includes the PR title. Structured workspace tokens also expose
`github_pr_url`, `github_pr_state` (`open`, `closed`, or `merged`),
`github_pr_id`, `github_pr_branch_id`, and `github_pr_checked_at` (Unix milliseconds).
The identity tokens are SHA-256 hex digests of the full PR URL and branch name,
respectively, so Herdr's 80-character token limit cannot truncate them. Drafts have
state `open`. Failed lookups clear lifecycle evidence; a changed branch during
lookup cannot authorize cleanup. [Worktree Discovery](../worktree-discovery/)
optionally consumes these tokens; GitHub Tools never closes spaces itself.
