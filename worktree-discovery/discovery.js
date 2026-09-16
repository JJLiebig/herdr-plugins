#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { api, hash, scope, watch } = require("./watch.js");

const GRACE = 30 * 60 * 1000;
const FRESH = 3 * 60 * 1000;
function key(value) {
  const normalized = path.resolve(value.replace(/^\\\\\?\\/, ""));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function directory() {
  if (!process.env.HERDR_PLUGIN_STATE_DIR) throw new Error("Start this action through Herdr.");
  const dir = path.join(process.env.HERDR_PLUGIN_STATE_DIR, scope());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function keepFile(workspaceId) { return path.join(directory(), `keep-${hash(workspaceId)}`); }
function load(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return { repos: {}, owned: {} }; throw error; }
}
function save(file, state) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
  fs.renameSync(`${file}.tmp`, file);
}

function untouched(entry, snapshot, kept) {
  const workspace = snapshot.workspaces.find(w => w.workspace_id === entry.workspaceId);
  const panes = snapshot.panes.filter(p => p.workspace_id === entry.workspaceId);
  return !!workspace && !kept && !workspace.focused && workspace.label === entry.label
    && workspace.tab_count === 1 && panes.length === 1
    && panes[0].pane_id === entry.paneId && panes[0].terminal_id === entry.terminalId
    && !panes[0].agent && !panes[0].agent_session
    && key(workspace.worktree?.checkout_path || panes[0].cwd || "/") === key(entry.path);
}

function terminalPR(entry, workspace, branch, now) {
  const tokens = workspace.tokens || {};
  const checked = Number(tokens.github_pr_checked_at);
  const branchId = branch ? createHash("sha256").update(branch).digest("hex") : null;
  if (!["merged", "closed"].includes(tokens.github_pr_state) || !tokens.github_pr_id
    || tokens.github_pr_branch_id !== branchId || !branchId || !Number.isFinite(checked)
    || checked > now || now - checked > FRESH) {
    delete entry.terminal;
    return false;
  }
  const identity = `${tokens.github_pr_id}:${tokens.github_pr_state}:${branchId}`;
  if (entry.terminal?.identity !== identity) entry.terminal = { identity, since: now };
  return now - entry.terminal.since >= GRACE && checked >= entry.terminal.since + GRACE;
}

// GitHub Tools is optional: discovery reads its metadata, never its files or commands.
function reconcile(state, snapshot, inventories, io, now = Date.now()) {
  for (const inventory of inventories) {
    const repo = key(inventory.source.repo_key);
    const entries = inventory.worktrees.filter(w => w.is_linked_worktree && !w.is_bare && !w.is_prunable);
    const current = entries.map(w => key(w.path));
    const previous = state.repos[repo];
    const failed = new Set();
    if (previous && inventory.active !== false) {
      for (const worktree of entries) {
        const checkout = key(worktree.path);
        if (previous.includes(checkout) || worktree.open_workspace_id) continue;
        // Save successful opens one at a time; a later failed open remains retryable.
        let opened;
        try { opened = io.open(inventory.source.source_checkout_path, worktree.path); }
        catch (error) { failed.add(checkout); console.error(`${worktree.path}: ${error.message}`); continue; }
        if (!opened.already_open) {
          state.owned[checkout] = {
            repo, path: worktree.path, cwd: inventory.source.source_checkout_path,
            workspaceId: opened.workspace.workspace_id, paneId: opened.root_pane.pane_id,
            terminalId: opened.root_pane.terminal_id, label: opened.workspace.label,
          };
        }
        previous.push(checkout);
        io.save(state);
      }
    }
    state.repos[repo] = current.filter(checkout => !failed.has(checkout)
      && (inventory.active !== false || !previous || previous.includes(checkout)));
    io.save(state);
  }

  for (const [checkout, entry] of Object.entries(state.owned)) {
    try {
    if (!untouched(entry, snapshot, io.kept(entry.workspaceId))) {
      // The opening snapshot predates spaces created above.
      if (snapshot.workspaces.some(w => w.workspace_id === entry.workspaceId) || io.exists(entry.workspaceId) === false) {
        delete state.owned[checkout];
      }
      continue;
    }
    const inventory = inventories.find(item => key(item.source.repo_key) === entry.repo);
    if (!inventory) continue; // Git lookup failed: leave the space alone.
    const worktree = inventory.worktrees.find(w => key(w.path) === checkout && !w.is_prunable);
    const workspace = snapshot.workspaces.find(w => w.workspace_id === entry.workspaceId);
    const expired = terminalPR(entry, workspace, worktree?.branch, now);
    if (worktree && !expired) continue;

    // Recheck immediately before closing; workspace close also terminates terminals.
    const latest = io.snapshot();
    if (!untouched(entry, latest, io.kept(entry.workspaceId))) {
      delete state.owned[checkout];
      continue;
    }
    const latestWorkspace = latest.workspaces.find(w => w.workspace_id === entry.workspaceId);
    if (worktree && !terminalPR(entry, latestWorkspace, io.branch(entry.path), now)) continue;
    if (!io.idle(entry.paneId)) {
      delete state.owned[checkout];
      continue;
    }
    // Focus events write independently even while this process waits on CLI calls.
    if (io.kept(entry.workspaceId)) { delete state.owned[checkout]; continue; }
    io.close(entry.workspaceId);
    delete state.owned[checkout];
    } catch (error) { console.error(`${entry.path}: ${error.message}`); }
    io.save(state);
  }
  io.save(state);
}

function tick() {
  const file = path.join(directory(), "state.json");
  const state = load(file);
  const snapshot = api(["api", "snapshot"]).snapshot;
  const inventories = new Map();
  const paths = new Set(snapshot.panes.filter(p => p.agent && p.cwd).map(p => p.cwd));
  for (const cwd of paths) {
    try {
      const inventory = api(["worktree", "list", "--cwd", cwd]);
      inventories.set(key(inventory.source.repo_key), inventory);
    } catch (error) { console.error(`${cwd}: ${error.message}`); }
  }
  // Existing managed spaces keep their cleanup lifecycle after the parent exits.
  for (const entry of Object.values(state.owned)) {
    if (inventories.has(entry.repo)) continue;
    try {
      const inventory = api(["worktree", "list", "--cwd", entry.cwd]);
      inventory.active = false;
      inventories.set(key(inventory.source.repo_key), inventory);
    } catch (error) { console.error(`${entry.cwd}: ${error.message}`); }
  }
  const io = {
    save: state => save(file, state),
    open: (cwd, checkout) => api(["worktree", "open", "--cwd", cwd, "--path", checkout, "--no-focus"]),
    close: workspaceId => api(["workspace", "close", workspaceId]),
    kept: workspaceId => fs.existsSync(keepFile(workspaceId)),
    exists: workspaceId => api(["api", "snapshot"]).snapshot.workspaces.some(w => w.workspace_id === workspaceId),
    snapshot: () => api(["api", "snapshot"]).snapshot,
    branch: cwd => {
      const result = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd, encoding: "utf8", windowsHide: true });
      return result.status === 0 ? result.stdout.trim() : null;
    },
    idle: paneId => {
      const info = api(["pane", "process-info", "--pane", paneId]).process_info;
      return !!info.shell_pid && info.foreground_processes.length === 1
        && info.foreground_processes[0].pid === info.shell_pid;
    },
  };
  reconcile(state, snapshot, [...inventories.values()], io);
}

function main(mode = process.argv[2]) {
  if (mode === "watch") return watch(tick, 10000);
  if (mode === "keep") {
    const context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
    if (context.workspace_id) fs.writeFileSync(keepFile(context.workspace_id), "");
    return;
  }
  throw new Error(`unknown command: ${mode || "<missing>"}`);
}
if (require.main === module) Promise.resolve().then(() => main()).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
module.exports = { reconcile, terminalPR, untouched, key, GRACE, FRESH };
