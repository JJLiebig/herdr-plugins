"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { randomUUID, createHash } = require("node:crypto");
const { reconcile, GRACE } = require("./discovery.js");

// Opt-in: creates and closes only its own unfocused spaces in the current session.
test("live Herdr discovery preserves focus and PR retirement leaves the checkout intact", {
  skip: !process.env.HERDR_DISCOVERY_TEST_BIN,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-discovery-test-"));
  const checkout = path.resolve(process.platform === "win32" ? "C:/Code/.worktrees/herdr-plugins" : os.tmpdir(), `discovery-smoke-${randomUUID()}`);
  const run = (command, args, cwd = root) => {
    const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout;
  };
  const api = args => {
    const output = run(process.env.HERDR_DISCOVERY_TEST_BIN, args);
    return output.trim() ? JSON.parse(output).result : undefined;
  };
  const snapshot = () => api(["api", "snapshot"]).snapshot;
  const focus = snapshot().focused_workspace_id;
  const owned = new Set();
  let parent;
  try {
    run("git", ["init", "--quiet"]);
    run("git", ["-c", "user.name=Herdr test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "test"]);
    parent = api(["workspace", "create", "--cwd", root, "--no-focus"]).workspace.workspace_id;
    const stateFile = path.join(root, "state.json");
    let state = { repos: {}, owned: {} };
    const io = {
      save: value => fs.writeFileSync(stateFile, JSON.stringify(value)), kept: () => false,
      exists: id => snapshot().workspaces.some(w => w.workspace_id === id), snapshot,
      branch: cwd => run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], cwd).trim(),
      rename: (id, label) => api(["workspace", "rename", id, label]),
      idle: id => {
        const info = api(["pane", "process-info", "--pane", id]).process_info;
        return !!info.shell_pid && info.foreground_processes.length === 1 && info.foreground_processes[0].pid === info.shell_pid;
      },
      open: (cwd, target) => {
        const result = api(["worktree", "open", "--cwd", cwd, "--path", target, "--no-focus"]);
        if (!result.already_open) owned.add(result.workspace.workspace_id);
        return result;
      },
      close: id => { assert.ok(owned.has(id)); api(["workspace", "close", id]); owned.delete(id); },
    };
    const step = now => reconcile(state, snapshot(), [api(["worktree", "list", "--cwd", root])], io, now);
    step(Date.now());
    run("git", ["worktree", "add", "--quiet", "-b", "feature", checkout]);
    step(Date.now());
    assert.equal(owned.size, 1);
    assert.equal(snapshot().focused_workspace_id, focus);
    const id = [...owned][0];
    step(Date.now());
    assert.equal(snapshot().workspaces.find(w => w.workspace_id === id).label, "feature");
    const report = checked => api(["workspace", "report-metadata", id, "--source", "test:github-lifecycle",
      "--token", `github_pr_id=${createHash("sha256").update("https://github.com/test/test/pull/1").digest("hex")}`, "--token", "github_pr_state=merged",
      "--token", `github_pr_branch_id=${createHash("sha256").update("feature").digest("hex")}`, "--token", `github_pr_checked_at=${checked}`]);
    const started = Date.now();
    report(started); step(started);
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    await new Promise(resolve => setTimeout(resolve, 1500));
    report(started + GRACE); step(started + GRACE);
    assert.equal(owned.size, 0);
    assert.ok(fs.existsSync(path.join(checkout, ".git")));
    assert.equal(snapshot().focused_workspace_id, focus);
    step(started + GRACE + 1);
    assert.equal(owned.size, 0);
  } finally {
    for (const id of owned) api(["workspace", "close", id]);
    if (parent) api(["workspace", "close", parent]);
    if (fs.existsSync(path.join(checkout, ".git"))) {
      run("git", ["worktree", "remove", checkout]);
      run("git", ["worktree", "prune"]);
    }
    assert.ok(root.startsWith(path.join(os.tmpdir(), "herdr-discovery-test-")));
    fs.rmSync(root, { recursive: true });
  }
});
