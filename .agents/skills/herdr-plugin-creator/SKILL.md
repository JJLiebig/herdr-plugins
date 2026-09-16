---
name: herdr-plugin-creator
description: Create or change Herdr workflow plugins in this monorepo. Use for Herdr plugin manifests, actions, events, panes, install flows, and plugin API decisions; not for Codex plugins.
---

# Herdr plugin creator

Read the [official Herdr plugin authoring guide](https://github.com/herdrdev/herdr/blob/master/docs/next/website/src/content/docs/plugins.mdx) for the current manifest and plugin contract. Consult the [CLI reference](https://github.com/herdrdev/herdr/blob/master/docs/next/website/src/content/docs/cli-reference.mdx) for commands a plugin calls. Check the installed `herdr plugin --help` when validating against a particular binary version.

Keep each plugin independently installable in its own directory here, with its own `herdr-plugin.toml`. Use nearby plugins only for repository conventions; the official guide is the API authority. Run checks relevant to the plugin changed.

The [official Herdr skill](https://github.com/herdrdev/herdr/blob/master/skills/herdr/SKILL.md) is for controlling a Herdr session from an agent pane, not for authoring plugins. Use it separately only when the task calls for live session control.
