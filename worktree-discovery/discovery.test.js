"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { reconcile, key, GRACE, terminalPR } = require("./discovery.js");

function fixture() {
  const state = { repos: {}, owned: {} };
  const snapshot = { workspaces: [], panes: [] };
  const inventory = { source: { repo_key: "/repo/.git", source_checkout_path: "/repo" }, worktrees: [] };
  const closed = [];
  const kept = new Set();
  const io = {
    save: () => {}, kept: id => kept.has(id), exists: id => snapshot.workspaces.some(w => w.workspace_id === id),
    snapshot: () => snapshot, branch: () => "feature", idle: () => true,
    open: (cwd, checkout) => {
      const workspace = { workspace_id: `w${snapshot.workspaces.length + 1}`, label: "feature", tab_count: 1,
        focused: false, worktree: { checkout_path: checkout }, tokens: {} };
      const root_pane = { workspace_id: workspace.workspace_id, pane_id: `${workspace.workspace_id}:p1`, terminal_id: `t${snapshot.panes.length}` };
      snapshot.workspaces.push(workspace); snapshot.panes.push(root_pane);
      return { workspace, root_pane, already_open: false };
    },
    close: id => { closed.push(id); snapshot.workspaces = snapshot.workspaces.filter(w => w.workspace_id !== id); },
  };
  const step = (now = 10000000) => reconcile(state, snapshot, [inventory], io, now);
  const add = (checkout = "/worktrees/feature") => inventory.worktrees.push({ path: checkout, branch: "feature", is_linked_worktree: true });
  const start = () => { step(); add(); step(); return snapshot.workspaces[0]; };
  const report = (workspace, now, status = "merged", url = "https://github.com/o/r/pull/7") => {
    workspace.tokens = { github_pr_state: status, github_pr_url: url, github_pr_branch: "feature", github_pr_checked_at: String(now) };
  };
  return { state, snapshot, inventory, io, closed, kept, step, add, start, report };
}

test("baseline is quiet; new worktrees open once and manual dismissal survives restart", () => {
  const f = fixture(); f.add("/old"); f.step();
  assert.equal(f.snapshot.workspaces.length, 0);
  f.add(); f.step(); f.step();
  assert.equal(f.snapshot.workspaces.length, 1);
  f.snapshot.workspaces = []; f.step();
  const persisted = JSON.parse(JSON.stringify(f.state));
  reconcile(persisted, f.snapshot, [f.inventory], f.io);
  assert.equal(f.snapshot.workspaces.length, 0);
  assert.deepEqual(persisted.owned, {});
});

test("spaces opened by someone else, including an open race, are never owned", () => {
  const f = fixture(); f.step(); f.add();
  f.inventory.worktrees[0].open_workspace_id = "manual"; f.step();
  assert.deepEqual(f.state.owned, {});
  f.add("/race");
  const open = f.io.open;
  f.io.open = (...args) => ({ ...open(...args), already_open: true });
  f.step();
  assert.deepEqual(f.state.owned, {});
});

test("terminal PR needs thirty minutes plus a fresh post-deadline observation; checkout is retained", () => {
  const f = fixture(); const workspace = f.start(); const now = 10000000;
  f.report(workspace, now); f.step(now);
  const restored = JSON.parse(JSON.stringify(f.state));
  f.report(workspace, now + GRACE - 1);
  reconcile(restored, f.snapshot, [f.inventory], f.io, now + GRACE);
  assert.deepEqual(f.closed, []);
  f.report(workspace, now + GRACE);
  reconcile(restored, f.snapshot, [f.inventory], f.io, now + GRACE);
  assert.deepEqual(f.closed, ["w1"]);
  assert.equal(f.inventory.worktrees.length, 1);
  reconcile(restored, f.snapshot, [f.inventory], f.io, now + GRACE + 1);
  assert.equal(f.snapshot.workspaces.length, 0);
});

test("reopened, replaced, unknown, stale, or wrong-branch PR cannot inherit a cleanup deadline", () => {
  const f = fixture(); const workspace = f.start(); const now = 10000000;
  for (const change of [
    { github_pr_state: "open" }, { github_pr_checked_at: "0" }, { github_pr_branch: "other" },
    { github_pr_state: "unknown" }, { github_pr_url: "https://github.com/o/r/pull/8" },
  ]) {
    const entry = {};
    f.report(workspace, now); terminalPR(entry, workspace, "feature", now);
    f.report(workspace, now + GRACE); Object.assign(workspace.tokens, change);
    assert.equal(terminalPR(entry, workspace, "feature", now + GRACE), false);
  }
});

test("focus, user changes, extra panes, and replacement terminal relinquish ownership", () => {
  for (const change of [
    f => f.kept.add("w1"), f => { f.snapshot.workspaces[0].focused = true; },
    f => { f.snapshot.workspaces[0].label = "mine"; },
    f => { f.snapshot.panes[0].agent = "codex"; },
    f => { f.snapshot.panes[0].terminal_id = "new"; },
    f => f.snapshot.panes.push({ workspace_id: "w1", pane_id: "extra" }),
  ]) {
    const f = fixture(); f.start(); change(f); f.inventory.worktrees = []; f.step();
    assert.deepEqual(f.closed, []); assert.deepEqual(f.state.owned, {});
  }
});

test("removed checkout closes only an untouched idle space; last-minute focus is preserved", () => {
  const f = fixture(); f.start(); f.inventory.worktrees = []; f.step();
  assert.deepEqual(f.closed, ["w1"]);
  const g = fixture(); g.start(); g.inventory.worktrees = [];
  g.io.idle = () => { g.kept.add("w1"); return true; }; g.step();
  assert.deepEqual(g.closed, []);
  const h = fixture(); h.start(); h.inventory.worktrees = []; h.io.idle = () => false; h.step();
  assert.deepEqual(h.closed, []);
});

test("no active parent suppresses discovery but existing managed spaces can retire", () => {
  const f = fixture(); f.start(); f.inventory.active = false; f.add("/inactive-new"); f.step();
  assert.equal(f.snapshot.workspaces.length, 1);
  f.inventory.worktrees = []; f.step(); assert.deepEqual(f.closed, ["w1"]);
  assert.ok(f.state.repos[key("/repo/.git")]);
});
