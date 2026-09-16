"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { formatPullRequest, isMissingPullRequest, snapshotTargets } = require("./github.js");

test("shows the portable symbol for each pull-request state", () => {
  assert.equal(formatPullRequest({ number: 6, state: "OPEN", isDraft: false, mergedAt: null }), "○ #6");
  assert.equal(formatPullRequest({ number: 7, state: "OPEN", isDraft: true, mergedAt: null }), "◇ #7");
  assert.equal(formatPullRequest({ number: 8, state: "CLOSED", isDraft: false, mergedAt: null }), "× #8");
  assert.equal(formatPullRequest({ number: 9, state: "CLOSED", isDraft: false, mergedAt: "2026-01-01" }), "◆ #9");
});

test("distinguishes no pull request from provider failures", () => {
  assert.equal(isMissingPullRequest('no pull requests found for branch "main"'), true);
  assert.equal(isMissingPullRequest("authentication failed: invalid token"), false);
});

test("prefers checkout paths and falls back to pane cwd", () => {
  assert.deepEqual(snapshotTargets({
    workspaces: [
      { workspace_id: "w1", worktree: { checkout_path: "C:/one" } },
      { workspace_id: "w2" },
      { workspace_id: "w3" },
    ],
    panes: [
      { workspace_id: "w1", cwd: "C:/wrong" },
      { workspace_id: "w2", cwd: "C:/two" },
    ],
  }), [
    { workspaceId: "w1", cwd: "C:/one" },
    { workspaceId: "w2", cwd: "C:/two" },
  ]);
});
