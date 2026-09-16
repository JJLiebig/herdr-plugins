# GitHub Tools

Show the current branch's pull request in Herdr's Spaces sidebar (`○ #123` for
open, `◇` draft, `×` closed, `◆` merged).

## Install

Requires Node.js and an authenticated [GitHub CLI](https://cli.github.com/).

```sh
herdr plugin install JJLiebig/herdr-plugins/github-tools
```

Until Herdr supports plugin-provided sidebar rows, add this to your Herdr
`config.toml` and run `herdr server reload-config`:

```toml
[ui.sidebar.spaces]
rows = [["state_icon", "workspace"], ["branch", "git_status", "$github_pr"]]
```

## Nerd Fonts

Nerd Font icons are not supported yet; the plugin uses symbols that work with
any font. If you want a Nerd Font for your terminal, [download one](https://www.nerdfonts.com/font-downloads),
install it, and select it in your terminal settings.

## Keybinds

Optionally bind a key to open the current PR, or the repository if there is no PR:

```toml
[[keys.command]]
key = "alt+shift+g"
type = "plugin_action"
command = "jjliebig.github-tools.open-current"
description = "open GitHub PR or repository"
```

Run `herdr server reload-config` after changing the keybind.
