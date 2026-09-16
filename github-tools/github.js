#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");

const herdr = process.env.HERDR_BIN_PATH || "herdr";
const gh = process.env.GH_BIN_PATH || "gh";
const metadataSource = "plugin:jjliebig.github-tools";

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
    windowsHide: true,
  });
}

function context() {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch {
    return {};
  }
}

function formatPullRequest(pr) {
  const state = pr.mergedAt ? "merged" : pr.isDraft ? "draft" : String(pr.state).toLowerCase();
  return `PR #${pr.number} · ${state}`;
}

function isMissingPullRequest(message) {
  return /no pull requests found|not a git repository|unable to determine (base )?repository/i.test(message);
}

function report(workspaceId, pr) {
  const args = ["workspace", "report-metadata", workspaceId, "--source", metadataSource];
  if (pr) {
    args.push("--token", `github_pr=${formatPullRequest(pr)}`, "--token", `github_pr_url=${pr.url}`);
  } else {
    args.push("--clear-token", "github_pr", "--clear-token", "github_pr_url");
  }
  const result = run(herdr, args);
  if (result.status !== 0) throw new Error(result.stderr.trim() || "failed to report workspace metadata");
}

function pullRequest(cwd) {
  const result = run(gh, ["pr", "view", "--json", "number,state,isDraft,mergedAt,url"], { cwd });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const message = result.stderr.trim();
    if (isMissingPullRequest(message)) return null;
    throw new Error(message || "GitHub pull-request lookup failed");
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function refresh(workspaceId, cwd) {
  if (!workspaceId || !cwd) return;
  report(workspaceId, pullRequest(cwd));
}

function snapshotTargets(snapshot) {
  const panes = new Map();
  for (const pane of snapshot.panes || []) {
    if (pane.cwd && !panes.has(pane.workspace_id)) panes.set(pane.workspace_id, pane.cwd);
  }
  return (snapshot.workspaces || []).flatMap((workspace) => {
    const cwd = workspace.worktree?.checkout_path || panes.get(workspace.workspace_id);
    return cwd ? [{ workspaceId: workspace.workspace_id, cwd }] : [];
  });
}

function refreshAll() {
  const result = run(herdr, ["api", "snapshot"]);
  if (result.status !== 0) throw new Error(result.stderr.trim() || "failed to read Herdr session");
  const snapshot = JSON.parse(result.stdout).result?.snapshot;
  let failed = false;
  for (const target of snapshotTargets(snapshot || {})) {
    try {
      refresh(target.workspaceId, target.cwd);
    } catch (error) {
      failed = true;
      console.error(`${target.cwd}: ${error.message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

function currentTarget() {
  const value = context();
  return {
    workspaceId: value.workspace_id,
    cwd: value.workspace_cwd || value.worktree?.checkout_path || value.focused_pane_cwd,
  };
}

function open(kind) {
  const { cwd } = currentTarget();
  if (!cwd) throw new Error("workspace path is unavailable");
  if (kind === "current") {
    const pr = run(gh, ["pr", "view", "--web"], { cwd });
    if (pr.error) throw pr.error;
    if (pr.status === 0) return;
    if (!isMissingPullRequest(pr.stderr || "")) {
      throw new Error(pr.stderr.trim() || "GitHub pull-request lookup failed");
    }
  }
  const args = kind === "pull-request" ? ["pr", "view", "--web"] : ["browse"];
  const result = run(gh, args, { cwd, inherit: true });
  if (result.status !== 0) process.exitCode = result.status || 1;
}

function main(mode = process.argv[2]) {
  if (mode === "refresh-all") return refreshAll();
  if (mode === "refresh-current") {
    const target = currentTarget();
    return refresh(target.workspaceId, target.cwd);
  }
  if (mode === "open-pull-request") return open("pull-request");
  if (mode === "open-repository") return open("repository");
  if (mode === "open-current") return open("current");
  throw new Error(`unknown command: ${mode || "<missing>"}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { formatPullRequest, isMissingPullRequest, snapshotTargets };
