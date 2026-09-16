"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const digest = value => createHash("sha256").update(value).digest("hex");
const { reconcile, key, GRACE, terminalPR } = require("./discovery.js");

function fixture() {
  const state = { repos: {}, owned: {} };
  const snapshot = { workspaces: [], panes: [] };
  const inventory = { source: { repo_key: "/repo/.git", source_checkout_path: "/repo" }, worktrees: [] };
  const closed = [];
  const kept = new Set();
  let nextWorkspace = 1;
  const io = {
    save: () => {}, kept: id => kept.has(id), exists: id => snapshot.workspaces.some(w => w.workspace_id === id),
    snapshot: () => snapshot, branch: () => "feature", idle: () => true,
    rename: (id, label) => { snapshot.workspaces.find(w => w.workspace_id === id).label = label; },
    open: (cwd, checkout, branch) => {
      const workspace = { workspace_id: `w${nextWorkspace++}`, label: branch || "feature", tab_count: 1,
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
    workspace.tokens = { github_pr_state: status, github_pr_id: digest(url), github_pr_branch_id: digest("feature"), github_pr_checked_at: String(now) };
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

test("managed labels follow branches, retain detached names, and preserve user renames", () => {
  const f = fixture(); const workspace = f.start();
  f.inventory.worktrees[0].branch = "beta/new-branch"; f.step();
  assert.equal(workspace.label, "beta/new-branch");
  assert.equal(f.state.owned[key("/worktrees/feature")].label, "beta/new-branch");
  f.inventory.worktrees[0].branch = null; f.step();
  assert.equal(workspace.label, "beta/new-branch");
  workspace.label = "my notes"; f.inventory.worktrees[0].branch = "another"; f.step();
  assert.equal(workspace.label, "my notes");
  assert.deepEqual(f.state.owned, {});
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
    { github_pr_state: "open" }, { github_pr_checked_at: "0" }, { github_pr_branch_id: digest("other") },
    { github_pr_state: "unknown" }, { github_pr_id: digest("https://github.com/o/r/pull/8") },
  ]) {
    const entry = {};
    f.report(workspace, now); terminalPR(entry, workspace, "feature", now);
    f.report(workspace, now + GRACE); Object.assign(workspace.tokens, change);
    assert.equal(terminalPR(entry, workspace, "feature", now + GRACE), false);
  }
});

test("explicit Keep, user changes, extra panes, and replacement terminal relinquish ownership", () => {
  for (const change of [
    f => f.kept.add("w1"),
    f => { f.snapshot.workspaces[0].label = "mine"; },
    f => { f.snapshot.panes[0].agent = "codex"; },
    f => { f.snapshot.panes[0].terminal_id = "new"; },
    f => f.snapshot.panes.push({ workspace_id: "w1", pane_id: "extra" }),
  ]) {
    const f = fixture(); f.start(); change(f); f.step(); f.inventory.worktrees = []; f.step();
    assert.deepEqual(f.closed, []); assert.deepEqual(f.state.owned, {});
  }
});

test("visiting a space preserves ownership and removed worktrees retire after focus leaves", () => {
  const f = fixture(); const workspace = f.start();
  workspace.focused = true; f.step();
  assert.ok(f.state.owned[key("/worktrees/feature")]);
  f.inventory.worktrees = []; f.step();
  assert.deepEqual(f.closed, []);
  assert.ok(f.state.owned[key("/worktrees/feature")]);
  workspace.focused = false; f.step();
  assert.deepEqual(f.closed, ["w1"]);
});

test("a user rename stays protected when checkout removal precedes the next scan", () => {
  for (const focused of [false, true]) {
    const f = fixture(); const workspace = f.start();
    workspace.focused = focused; f.inventory.worktrees = [];
    workspace.label = "my notes"; f.step();
    workspace.focused = false; f.step();
    assert.deepEqual(f.closed, []);
    assert.deepEqual(f.state.owned, {});
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
  assert.ok(h.state.owned[key("/worktrees/feature")]);
  h.io.idle = () => true; h.step(); assert.deepEqual(h.closed, ["w1"]);
  const i = fixture(); const workspace = i.start(); i.inventory.worktrees = [];
  i.io.snapshot = () => { workspace.focused = true; return i.snapshot; }; i.step();
  assert.deepEqual(i.closed, []); assert.ok(i.state.owned[key("/worktrees/feature")]);
  workspace.focused = false; i.io.snapshot = () => i.snapshot; i.step();
  assert.deepEqual(i.closed, ["w1"]);
});

test("no active parent suppresses discovery but existing managed spaces can retire", () => {
  const f = fixture(); f.start(); f.inventory.active = false; f.add("/inactive-new"); f.step();
  assert.equal(f.snapshot.workspaces.length, 1);
  f.inventory.active = true; f.step();
  assert.equal(f.snapshot.workspaces.length, 2);
  f.inventory.worktrees = []; f.step(); assert.deepEqual(f.closed, ["w1", "w2"]);
  assert.ok(f.state.repos[key("/repo/.git")]);
});

test("a failed open remains retryable and does not block other worktrees or retirement", () => {
  const f = fixture(); f.start(); f.add("/bad"); f.add("/good");
  const open = f.io.open;
  f.io.open = (cwd, checkout) => { if (checkout === "/bad") throw new Error("unavailable"); return open(cwd, checkout); };
  f.inventory.worktrees = f.inventory.worktrees.filter(w => w.path !== "/worktrees/feature");
  f.step();
  assert.deepEqual(f.closed, ["w1"]);
  assert.ok(f.state.owned[key("/good")]);
  assert.ok(!f.state.repos[key("/repo/.git")].includes(key("/bad")));
  f.io.open = open; f.step(); assert.ok(f.state.owned[key("/bad")]);
});

test("a failing retirement probe does not block another eligible space", () => {
  const f = fixture(); f.start(); f.add("/second"); f.step(); f.inventory.worktrees = [];
  f.io.idle = id => { if (id === "w1:p1") throw new Error("probe unavailable"); return true; };
  f.step();
  assert.deepEqual(f.closed, ["w2"]);
  assert.ok(f.state.owned[key("/worktrees/feature")]);
});
