# Richer Sidebar

**Design scaffold only.** The manifest has no commands, dependencies, or runtime
behavior. This records the intended plugin before proposing the missing Herdr
extension points. Installing it will not change the sidebar.

## The idea

Make the left sidebar fit the user's work, starting with a named **Nextide Live**
category for `live-*` spaces. Support manual assignments and simple matchers,
with regex as an optional plugin-side choice.

- Rearrange Spaces and Agents, or hide either section. Keep New, Menu, machine
  connection/status, and a way to restore the default layout accessible.
- Group spaces under collapsible categories; control category and item order.
  Allow empty named category placeholders without creating fake workspaces.
- Customize displayed names, glyphs, PR titles/status, and token placement.
  A display alias must not rename the actual workspace or agent.
- Ctrl-click a PR token to open the correct pull request in the local browser.
  Ordinary clicks retain normal selection/focus behavior.
- Work across local, SSH, and Cloud endpoints without confusing identically
  named spaces or sending an action to the wrong machine.

## First useful version

One level of categories, with manual assignment taking precedence over ordered
matching rules; first matching rule wins. Unmatched spaces remain visible.
Match the real workspace name or repository/path, not a plugin's display alias.
Scope rules to an endpoint when needed: `live-*` need not mean the same thing on
every machine. Keep existing repository/worktree groups together by default.

Example intent (not executable configuration):

```text
Spaces
  Local
    Nextide Live
      live-api       ○ #123  Fix reconnects
      live-worker    ◇ #456  Queue metrics
    Other spaces
      herdr
  Production SSH
    Nextide Live
      live-api
Agents
New · Menu
```

Section order, visibility, and collapse state belong to the viewing client.
Machine identity stays visible even if a later layout combines categories across
machines. No cross-machine category merging in the first version.

## GitHub Tools

Start by composing with [GitHub Tools](../github-tools/): it already fetches PR
data and publishes sidebar tokens. Richer Sidebar owns presentation, not a
second GitHub poller. A future bundle can install both, but moving or merging
GitHub functionality is not part of this scaffold.

## What needs Herdr support

Current tokens can supply text, glyphs, and display aliases. They cannot add
category rows, reorder/hide whole sections, or attach clickable sidebar links.
The proposed host extension should describe layout and typed interactions;
Herdr still owns rendering, input, focus, and essential controls.

See [the upstream feasibility and proposal](UPSTREAM.md) for the current API
inventory, multi-machine boundaries, candidate delivery slices, and research.
