# Worktree Discovery

New worktrees appear under their repository in Herdr while that repository has
an agent session, including an idle or waiting agent. Focus stays where it is.
Works with any agent Herdr recognizes; Codex and Symphony++ are not required.

```powershell
herdr plugin install JJLiebig/herdr-plugins/worktree-discovery
herdr plugin action invoke jjliebig.worktree-discovery.watch
```

Requires Node.js 18+ and Herdr 0.9.0+. Discovery starts automatically with Herdr;
the action starts it immediately after installation. Repeating it is harmless.
Disable the plugin to stop discovery (within one scan, normally ten seconds).

The first scan of a repository remembers existing worktrees without opening
them. Subsequent scans open newly discovered worktrees, one space per checkout.
Already open spaces belong to you. Closing an automatically added space keeps
it dismissed until the worktree is removed and later recreated.

## Keeping and retiring spaces

Focusing an automatically added space makes it yours. You can also use
`jjliebig.worktree-discovery.keep`. Spaces with a changed name, another tab or
pane, a replacement terminal, or an agent are also left alone. Ownership and
dismissals survive plugin restarts; a replaced terminal is never reclaimed.

With [GitHub Tools](../github-tools/) installed and its automatic refresh
running, untouched spaces close 30 minutes after a PR is first observed as
merged or closed. A fresh observation after the deadline must still confirm
that PR and branch. A reopened/replaced PR or failed/stale lookup resets the
wait. Without GitHub Tools, discovery still works; PR-based retirement does not.

Removing a worktree also retires its untouched space. Retirement continues for
already managed spaces after the parent agent exits. Worktree directories,
branches, commits, and files are **never deleted** by this plugin.

Only the plugin's original, unfocused, single-shell space is eligible. The
plugin checks again before closing and leaves foreground processes alone.
Herdr has no atomic conditional-close API or input-history API: focus events
protect interactive use, but an external automation racing the final check
cannot be made atomic. Use Keep before automating a managed space.

## GitHub metadata contract

GitHub Tools owns PR lookup and refresh. This plugin only reads workspace tokens
`github_pr_id`, `github_pr_state`, `github_pr_branch_id`, and
`github_pr_checked_at` (Unix milliseconds). It requires a successful observation
no older than three minutes and matching the current branch. It does not call
GitHub, invoke GitHub Tools actions, or read another plugin's private state.
PR and branch identities are SHA-256 hex digests of the full URL and branch name,
so they fit Herdr's 80-character token cap without truncation.
