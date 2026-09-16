# Simple Dispatch

Windows-only Herdr actions for turning a feature request or issue into an open
pull request, or shepherding an existing pull request to a mergeable state in an
isolated agent workspace. Supports every Herdr agent kind that reports a stable
session, and is built around per-harness adapters so new kinds are a one-line
addition.

Loosely inspired by Can's [GitHub Start plugin](https://github.com/ogulcancelik/herdr-plugin-github-start).

## Harnesses

Pick the harness in the workflow popup. The first row is a selector:
`Harness: < Codex >`. The issue/feature input is focused by default. Arrow keys
are first-class: Left/Right/Home/End move the caret, and Up/Down move between
wrapped lines. When the caret reaches the top line, Up moves focus to the
harness selector; from the selector, Down returns to the input, and Left/Right
change the harness. On the selector you can also type the first letter of a
harness to jump to it (repeat to cycle). Tab moves between rows.

The popup selects the harness only; the plugin does not pass a model, so each
harness launches with its own configured default. Only harnesses whose Herdr
integration is installed are offered.

| Kind | Label | Session archive | Notes |
| --- | --- | --- | --- |
| `codex` | Codex | `codex archive <id>` | Forwards `--auto-account` when the executable advertises it |
| `opencode` | opencode | `opencode session delete <id>` | Uses opencode's own configured model |
| `claude` | Claude | none, session retained | |
| `cursor` | Cursor | none, session retained | |
| `copilot` | Copilot | none, session retained | |
| `devin` | Devin | none, session retained | |
| `droid` | Droid | none, session retained | |
| `kimi` | Kimi | none, session retained | |
| `kilo` | Kilo | none, session retained | |
| `mastracode` | Mastracode | none, session retained | |
| `pi` | Pi | none, session retained | Path or id session |
| `omp` | OMP | none, session retained | Path or id session |
| `qwen` | Qwen | none, session retained | |
| `qodercli` | Qoder | none, session retained | |
| `grok` | Grok | none, session retained | |
| `hermes` | Hermes | none, session retained | |
| `agy` | Antigravity | none, session retained | Integration installs as `antigravity-cli` |

For kinds without an archive command, cleanup still stops the agent and removes
the worktree; the agent's own session data is left on disk. Kinds that Herdr
does not give a stable session (for example `gemini`, `cline`, `kiro`, `amp`,
and `maki`) are not offered, because cleanup could not verify workspace
ownership.

The default harness comes from the plugin config directory (see below); the
last harness you pick is remembered and used as the next default.

## Install

```powershell
herdr plugin install JJLiebig/herdr-plugins/simple-dispatch
```

For local development:

```powershell
git clone https://github.com/JJLiebig/herdr-plugins.git
herdr plugin link .\herdr-plugins\simple-dispatch
```

Requires Windows, Node.js 18+, Git, GitHub CLI authentication, and Herdr 0.8.2+.
Install the CLI and Herdr integration for the harnesses you want to use
(`herdr integration install <name>`); the picker only offers installed ones. For
Codex, use Codex CLI 0.151.0-fork.1 or a compatible later version with the
Ponytail and Review Suite Codex plugins (Ask Pro optional). Codex is the only
harness that runs the Codex-specific skills; other harnesses use a neutral
prompt.

## Hotkeys

Add the actions you want to Herdr's `config.toml`:

```toml
[[keys.command]]
key = "alt+i"
type = "plugin_action"
command = "jjliebig.simple-dispatch.issue-to-pr"
description = "issue or pull request"

[[keys.command]]
key = "alt+u"
type = "plugin_action"
command = "jjliebig.simple-dispatch.feature-to-pr"
description = "feature or fix"

[[keys.command]]
key = "alt+shift+d"
type = "plugin_action"
command = "jjliebig.simple-dispatch.cleanup-current-workflow"
description = "clean up workflow"
```

Then run `herdr server reload-config`.

The plugin id is part of every binding. Replace older
`jjliebig.codex-workflows.*` bindings with `jjliebig.simple-dispatch.*`, then
reload the config and re-link or reinstall the plugin.

`issue-to-pr` accepts a complete issue or pull-request URL, partial link, or
number. A complete GitHub URL selects its repository; the other forms use the
current repository. Enter starts the workflow; Shift+Enter adds an instruction
line. The caret and field navigation behave like a small editor (see Harnesses
above). Long target text scrolls horizontally, while instructions wrap and
scroll vertically.
GitHub identifies whether the number is an issue or
pull request. Issue workflows pin the fetched default-branch SHA and start one
agent parent that owns implementation, review, CI, and an open pull request.
Pull-request workflows check out the exact pull-request head SHA and ask the
agent to bring the existing pull request to a mergeable state: validate and sign
off when it is already green and approved, or take over — rebase, resolve
conflicts, fix failing checks, and address open review findings — when it is not.
The controller injects a launch summary (mergeability, check counts, review
decision) and the agent re-checks with the GitHub CLI. It updates the existing
pull request in place, including a fork that allows maintainer edits; only a head
the agent cannot push to prompts a replacement pull request, and only after
asking. Missing required human review is reported as the remaining step rather
than self-approved. A custom instruction such as "review only" keeps the agent
strictly read-only. The prompt is chosen per harness; Codex uses the Ponytail and
Review Suite skills, opencode uses a harness-neutral prompt.

`feature-to-pr` uses the current repository. Its single multiline field accepts
the feature or fix description. Enter starts the workflow; Shift+Enter adds a line.

For a full link to another repository, the plugin reuses a matching
`C:\Code\<repo>` checkout when present. Otherwise it clones to
`C:\Code\<owner>\<repo>` before creating the isolated worktree.

## Lifecycle and cleanup

Each action invocation has its own controller process and Windows named pipe
for its input and progress panes. Its state is only in memory: `COLLECTING -> PROVISIONING ->
RUNNING ->` a terminal result. Concurrent invocations do not share a queue or
registry. The controller uses Herdr's native `agent start` and `agent prompt`
lifecycle. When the canonical `codex` command advertises `--auto-account`, the
controller forwards that startup option through Herdr; otherwise the launch is
unchanged. `agent start` waits for the agent to become interactive, which an
already-busy agent never reports: if that wait times out while the requested
agent is running in the pane, the controller re-adopts it under the workflow
name instead of failing the launch.

An implementation workflow with no pull request remains active. When the agent
becomes idle or done, its workspace is marked waiting. A blocked agent stays
marked blocked for human input. In each case, the agent, the controller,
worktree, and workspace stay available for follow-up. The controller checks
again after follow-up activity settles. Once an implementation workflow has
exactly one valid pull request, or a pull-request workflow settles, the
controller leaves the agent session and worktree available and exits. A detached
watcher checks the associated PR once per minute and changes the workspace label
to `✓ [I-3611] merged` (or the corresponding PR/task label) on merge. It does
not stop or archive the agent, or remove the worktree. Closed, unmerged PRs do
not get a merged indicator.
Issue and pull-request workflows keep their identity label (`I-3611`, `PR-42`).
A freefield `feature-to-pr` workflow switches from `T-<nonce>` to the harness
session title once the agent reports one, so it reads like
`[Fix compact mode text scrolling] working`. The title is best-effort: harnesses
that expose none keep `T-<nonce>`, and the branch and worktree keep the stable
`auto-…` name.
Cleanup is manual by default. This applies to newly dispatched workflows;
existing completed workspaces are not retroactively watched.

To clean up automatically after the pull request merges, run
`herdr plugin config-dir jjliebig.simple-dispatch` and create `config.json` in
that directory:

```json
{"auto-cleanup-on-pr-merge": true}
```

The same file sets the default harness:

```json
{ "default-harness": "opencode" }
```

Only harness kinds with a shipped adapter are usable; an unknown
`default-harness` falls back to `codex`. The last harness you pick is remembered
in `state.json` and used as the next default.

When enabled, a detached watcher waits for an unambiguous merge, then invokes
the same current-workflow cleanup used by `Alt+Shift+D`. An open or closed,
unmerged pull request keeps the agent and workspace intact. Cleanup waits for
the exact owning agent to settle, quits it, runs the harness session-finalize
step, then rechecks the local identity and cleanliness and asks Herdr to remove
the workspace and worktree without force. The workflow branch remains. The
finalize step is harness-specific: `codex archive <id>` for Codex and
`opencode session delete <id>` for opencode (which removes that session), and a
no-op for harnesses that have no archive command, leaving their session data on
disk.
Workflow branches use the `auto-` prefix (for example `auto-issue-3611-a1b2c3`);
legacy `codex/` branches remain valid for cleanup. The agent is asked to exit
with the harness quit command (`/quit` for Codex, `/exit` for opencode, or
Ctrl+C for the others).

Failure and cancellation keep all workflow state. The
`cleanup-current-workflow` action uses the same finalize-first transaction
without waiting for a merge. Manual cleanup opens the same slim bottom progress
pane as dispatch, showing workspace checks, agent shutdown, session finalize,
and worktree removal. Failures stay visible; focus the pane and press Enter,
Escape, or Ctrl+C to close it. Successful removal closes the workspace and its
progress pane. Closing the progress pane does not cancel cleanup.
For an idle or waiting active workflow, it first
cancels the controller. It refuses a changed identity, working or changed agent,
path outside `C:\Code\.worktrees`, or an ambiguous agent session. A worktree
whose branch was later repurposed (for example reused for a rebase) is still
removable: the recorded workspace identity and the linked-worktree path
establish ownership, and the branch itself is preserved. A dirty worktree opens
a focused confirmation popup; choosing "remove it anyway" reruns the transaction
and force-removes the checkout, while any other answer keeps it. A finalize
failure removes nothing; a failure after finalize keeps the worktree for manual
inspection.

A Herdr or machine restart loses an active watcher. The plugin has no registry
or startup recovery and does not reconstruct the wait after restart. Use the
manual cleanup action after inspection when its safety checks still pass.

Workflow identity is saved in `herdr-codex-workflow.json` inside each worktree's
private Git directory, outside tracked files. After Herdr loses its display
metadata on restart, manual cleanup restores identity from this record and checks
whether the original controller is still alive before proceeding. It still checks
the owning session and worktree before archiving or removing anything. Older
workflows without this record cannot be recovered automatically.

Non-goals are persistent workflow state, dashboards, background services,
automatic recovery, automatic merge, force removal, and workflow-branch
deletion.
