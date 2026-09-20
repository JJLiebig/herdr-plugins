# Herdr sidebar extension proposal

Status: investigation and proposed direction, not an agreed API or implementation.
Inspected 2026-09-19 against upstream `e0507237ad8d41f60aece10d00ef29ce2339ca34`.

## What exists and what is missing

| Capability | Current support | Proposed increment |
| --- | --- | --- |
| Text, PR glyphs, custom display aliases | Workspace/pane metadata and configurable row tokens; replacing the visible name token need not rename anything | Plugin-provided row presets, selected by the user, with normal-name fallback |
| Token appearance | Color, bold/dim, and conditional rules already exist | Reuse this vocabulary |
| Agent filtering/sorting | `agent.view.set` with built-in/token fields; a server-wide single active override | Respect existing views; do not silently replace another plugin's view |
| Space ordering | Runtime workspace move APIs; automatic Git worktree grouping | Presentation-only sort/group settings; do not move actual workspaces to simulate a view |
| Categories/placeholders | No arbitrary category/header entries | One-level named groups and optional empty headers; retain real item identity |
| Spaces/Agents order and visibility | Fixed section composition; configurable row content and split geometry | Client-side section order and visibility with a separate host-owned footer |
| Ctrl-click sidebar tokens | No token hit targets; pane URLs already have Ctrl-click handling | Typed link targets and token hit regions, using the existing client browser opener |
| Plugin UI integration | Manifest actions, startup/events, terminal panes, link handlers | Declarative presentation contribution, not a drawing callback or arbitrary widget SDK |

The existing metadata transport truncates values at **80 characters**. It is
fine for short category labels; it is not a reliable URL transport. A clickable
link needs a full, validated URL field rather than making the existing
`github_pr_url` display token clickable as-is.

## Recommended ownership

**Plugin:** category names, assignments, matchers, display text, and presentation
presets. Keep GitHub querying in GitHub Tools. Do not run network calls or plugin
commands during rendering.

**Herdr client:** section layout, collapse state, drawing, scrolling, keyboard
navigation, mouse hit testing, opening URLs, and restoring the default view.
New/Menu and machine connection/status controls remain host-owned and reachable
when Spaces, Agents, or both are hidden. Hidden sections do not close terminals
or stop agents; normal global navigation remains available.

**Endpoint server:** real workspace/agent identities and reported facts. Local
sidebar ordering and aliases must not rewrite those facts. Continue using the
neutral public API for facts; do not introduce server-owned sidebar geometry or
a private TUI-only API for shared behavior.

## Small contract to explore

1. A user-selected, declarative **client presentation preset**, contributed by a
   locally installed plugin. It describes section order/visibility, existing row
   token layouts, display-name fallback, and grouping/sort fields. One selected
   layout provider avoids competing plugins racing to replace the sidebar;
   multiple plugins can still supply distinct metadata tokens.
2. Category definitions plus per-item category identity/order, consumed by the
   client. Empty categories need definitions independent of workspace tokens.
   Existing token transport may carry simple membership, but category definition
   delivery and source ownership still need an agreed contract.
3. A typed link attached to a displayed token. Ctrl-click opens its full URL on
   the viewing machine; no shell command encoded in metadata. Start with HTTP(S)
   links for the concrete PR use case. Keyboard activation needs an equivalent
   action. Arbitrary inline buttons/plugin action callbacks are a later scope.

These are semantic requirements, not proposed manifest keys or wire shapes.
Prefer extending current row/token configuration over introducing a parallel
rendering language. The hard new boundary is how a **local client** selects and
loads a plugin preset: today's startup/actions run against an endpoint server,
so a new server `sidebar.set` method alone would put ownership in the wrong place.
Decide this contract before implementing runtime plugin code.

Plugin data must use explicit distinct keys: current metadata `source` sequences
updates but does not automatically namespace token keys. User configuration wins
over plugin defaults. Disabling the layout provider restores the normal sidebar;
missing decoration data falls back to the real name and remains navigable.

## Multiple machines and clients

- Install the presentation preset on the viewing machine. Install data-producing
  plugins on endpoints where they need repository access or credentials. Do not
  assume installing a plugin locally installs it on SSH/Cloud endpoints.
- Never identify a runtime item by name or bare workspace ID across machines.
  Reuse endpoint identity plus workspace/pane identity and the existing session
  boot/generation checks for actions. Reconnection must not retarget an old click.
- Manual assignments that survive restarts need an explicit durable selector
  (for example endpoint plus checkout path), not a saved transient workspace ID.
  Non-repository workspace persistence remains a design question.
- Keep categories within machine boundaries initially. Collapse and layout state
  remain client-local; two attached clients can have different presentation.
- Show disconnected machines honestly. Do not turn retained remote rows into
  local targets. A public PR URL may still open locally when its endpoint is down;
  endpoint actions require a valid current target.
- GitHub credentials stay with the data-producing endpoint. The viewer only needs
  the URL to open its own browser.
- Existing endpoint capability negotiation and frozen protocol contracts govern
  any new shared fields. Unsupported decorations should be absent without making
  a mixed-version connection unusable. No new protocol framework is proposed.

## Proposed delivery sequence

Do not submit a single giant sidebar SDK PR.

1. **Agree on the product and ownership boundary.** Present category grouping,
   section visibility/order, and clickable PR decorations as the concrete needs.
   Decide client preset delivery, coexistence with server agent views, and how
   categories contain existing repository/worktree groups.
2. **First functional slice: categories.** Implement only the accepted preset/
   grouping path needed for `live-*`, manual overrides, default fallback, and
   per-endpoint identity. Empty placeholders are optional within this slice.
3. **Section composition.** Hide/reorder Spaces and Agents while preserving the
   host footer, machine controls, keyboard access, and reset path. Can be a
   separate focused PR once the preset contract exists.
4. **Linked decorations.** Full URL payloads, token hit regions, Ctrl-click/local
   browser dispatch, and keyboard equivalent. Reuse GitHub Tools' existing PR
   lookup; change only its reporting when this API is available.

If maintainers prefer configuration-only presentation rather than plugin preset
loading, that is a smaller viable host design: the plugin supplies metadata and
users configure the layout. It costs setup convenience, not category behavior.
Do not compensate with config-file rewriting or fake workspace rows.

Relevant implementation checks: category/order consistency across render,
keyboard and mouse; existing worktree groups; same IDs on two endpoints;
disconnect/reconnect; independent clients; disabled provider; both sections
hidden; long URLs; stale PR/branch changes; narrow/collapsed/mobile layouts.
Herdr's render-path guidance also requires 1-versus-15-pane measurements for
affected layout/render work. No tests are needed for this documentation scaffold.

## Upstream route

Read-only checks found authenticated account `JJLiebig` in upstream
`.github/MAINTAINERS` and `.github/APPROVED_CONTRIBUTORS`, with repository push
permission and the canonical `origin`. An upstream PR is therefore feasible;
recheck those facts when submitting. This is new UI/product scope, so align the
proposal before writing the host implementation. No post, branch push, or PR is
part of this investigation.

Suggested short pitch for a maintainer conversation (not posted):

> I'd like plugins to organize and decorate the sidebar: group `live-*` spaces
> under a named category, optionally hide/reorder Spaces and Agents, and Ctrl-click
> a PR decoration to open GitHub. Existing metadata covers most of the content,
> but not category rows, panel composition, or clickable tokens. Could we agree
> on a small declarative client presentation extension, keeping New/Menu,
> navigation, and machine identity owned by Herdr? I'd start with categories and
> keep section layout and links as separate follow-ups. GitHub lookup and matching
> rules would stay in plugins.

## Community candidates

Luna's read-only discussion sweep found the following related requests. These
are evidence of demand and design input, not proof that an API was accepted.
Older claims about missing APIs must be compared with today's source above.

| Thread | Why it matters | Status/interpretation |
| --- | --- | --- |
| [Discussion #1953: user-created folders](https://github.com/herdrdev/herdr/discussions/1953) | Closest match: persistent categories, collapse, assignment, and optional Agents visibility; later feedback explicitly suggests machine > group > space > worktree | Community prototypes and interest; no visible maintainer acceptance |
| [Discussion #1609: persistent plugin sidebar sections](https://github.com/herdrdev/herdr/discussions/1609) | A prototype and feedback favoring neutral plugin-owned summary data with client-owned rendering | Useful ownership precedent; comments are community proposals, not a settled contract |
| [Discussion #801: sidebar structure](https://github.com/herdrdev/herdr/discussions/801) | Manual/automatic/external grouping, including PR-driven organization | Supports plugin-controlled membership, without requiring delimiter-based workspace renames |
| [Discussion #1407: Spaces sorting](https://github.com/herdrdev/herdr/discussions/1407) | MRU, status/priority, and alphabetical ordering | Stable display sorting is relevant; MRU needs trustworthy activity data and is not part of our first slice |
| [Issue #2639: hide Agents](https://github.com/herdrdev/herdr/issues/2639) | Empty rows/filtering do not reclaim the panel's space | Closed `not_planned`, but the bot explicitly redirected this feature request to Ideas; this is not evidence of a product veto |
| [Issue #226: hide/reveal spaces](https://github.com/herdrdev/herdr/issues/226) | Recovery/discoverability concerns for individual hidden spaces | Closed `not_planned`; distinct from hiding a whole panel, and outside our initial category scope |
| [Discussion #713: progress/sidebar logs](https://github.com/herdrdev/herdr/discussions/713) | Plugin authors need persistent per-agent information | Related demand; bars/log feeds would expand this proposal and are deferred |
| [Discussion #1361: provider usage](https://github.com/herdrdev/herdr/discussions/1361) | Session-level information does not naturally belong to each workspace | Possible later summary block; no provider polling in Herdr core |
| [Discussion #1465: left/right placement](https://github.com/herdrdev/herdr/discussions/1465) | Moving the sidebar or splitting Spaces and Agents across sides | Record as future layout demand; not required for reorder/hide within the current sidebar |
| [Discussion #515: multiple remote servers](https://github.com/herdrdev/herdr/discussions/515) | Historical multi-machine design context | Current endpoint/client implementation is the authority; do not treat its older UX uncertainty as current state |

Session summaries and left/right placement are promising future consumers, but
neither is necessary to prove the category, panel composition, and link contract.

## Source map

All Herdr paths below refer to the inspected commit:

- [Plugin contract](https://github.com/herdrdev/herdr/blob/e0507237ad8d41f60aece10d00ef29ce2339ca34/docs/next/website/src/content/docs/plugins.mdx): executable plugins; no native non-terminal plugin UI.
- [Sidebar configuration](https://github.com/herdrdev/herdr/blob/e0507237ad8d41f60aece10d00ef29ce2339ca34/src/config/sidebar.rs): row composition, custom tokens, styles, and conditional rules.
- [Sidebar rendering](https://github.com/herdrdev/herdr/blob/e0507237ad8d41f60aece10d00ef29ce2339ca34/src/client/shell/sidebar.rs): Git-specific grouping, fixed section composition, and New/Menu footer.
- [Endpoint sidebar](https://github.com/herdrdev/herdr/blob/e0507237ad8d41f60aece10d00ef29ce2339ca34/src/client/shell/endpoint_sidebar.rs) and [navigation](https://github.com/herdrdev/herdr/blob/e0507237ad8d41f60aece10d00ef29ce2339ca34/src/client/shell/workspace_navigation.rs): machine scoping and boot/generation identity.
- [Client config](https://github.com/herdrdev/herdr/blob/e0507237ad8d41f60aece10d00ef29ce2339ca34/src/client/shell/config.rs): local client config reload.
- [Agent view handler](https://github.com/herdrdev/herdr/blob/e0507237ad8d41f60aece10d00ef29ce2339ca34/src/app/api/agent_view.rs): server-owned single active view.
- [Metadata normalization](https://github.com/herdrdev/herdr/blob/e0507237ad8d41f60aece10d00ef29ce2339ca34/src/app/api_helpers.rs) and [storage](https://github.com/herdrdev/herdr/blob/e0507237ad8d41f60aece10d00ef29ce2339ca34/src/metadata_tokens.rs): 80-character values and source/key semantics.
- [Mouse handling](https://github.com/herdrdev/herdr/blob/e0507237ad8d41f60aece10d00ef29ce2339ca34/src/client/shell/mouse.rs) and [client dispatch](https://github.com/herdrdev/herdr/blob/e0507237ad8d41f60aece10d00ef29ce2339ca34/src/client/shell_runtime.rs): existing pane Ctrl-click path and client-side URL opener.
- [Contributor policy](https://github.com/herdrdev/herdr/blob/e0507237ad8d41f60aece10d00ef29ce2339ca34/CONTRIBUTING.md) and [repository guidance](https://github.com/herdrdev/herdr/blob/e0507237ad8d41f60aece10d00ef29ce2339ca34/AGENTS.md).
