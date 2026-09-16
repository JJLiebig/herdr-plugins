"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const digest = value => createHash("sha256").update(value).digest("hex");
const { formatPullRequest, isMissingPullRequest, snapshotTargets, lifecycleTokens } = require("./github.js");

test("shows the portable symbol for each pull-request state", () => {
  assert.equal(formatPullRequest({ number: 6, state: "OPEN", isDraft: false, mergedAt: null }), "○ #6");
  assert.equal(formatPullRequest({ number: 7, state: "OPEN", isDraft: true, mergedAt: null }), "◇ #7");
  assert.equal(formatPullRequest({ number: 8, state: "CLOSED", isDraft: false, mergedAt: null }), "× #8");
  assert.equal(formatPullRequest({ number: 9, state: "CLOSED", isDraft: false, mergedAt: "2026-01-01" }), "◆ #9");
});

test("shows the Nerd Font glyph for each pull-request state", () => {
  assert.equal(formatPullRequest({ number: 6, state: "OPEN", isDraft: false, mergedAt: null }, "nerd_font"), " #6");
  assert.equal(formatPullRequest({ number: 7, state: "OPEN", isDraft: true, mergedAt: null }, "nerd_font"), " #7");
  assert.equal(formatPullRequest({ number: 8, state: "CLOSED", isDraft: false, mergedAt: null }, "nerd_font"), " #8");
  assert.equal(formatPullRequest({ number: 9, state: "CLOSED", isDraft: false, mergedAt: "2026-01-01" }, "nerd_font"), " #9");
});

test("lifecycle metadata separates draft presentation from state and clears absent PRs", () => {
  assert.deepEqual(lifecycleTokens({ number: 9, title: "Fix\nwidgets", state: "OPEN", isDraft: true, url: "https://github.com/o/r/pull/9" }, "fix", 123), {
    github_pr: "◇ #9 · Fix widgets", github_pr_nerd: " #9 · Fix widgets", github_pr_url: "https://github.com/o/r/pull/9",
    github_pr_state: "open", github_pr_id: digest("https://github.com/o/r/pull/9"), github_pr_branch_id: digest("fix"), github_pr_checked_at: "123",
  });
  assert.deepEqual(lifecycleTokens(null, null, 0), {
    github_pr: null, github_pr_nerd: null, github_pr_url: null, github_pr_state: null, github_pr_id: null, github_pr_branch_id: null, github_pr_checked_at: "0",
  });
});

test("long URLs and branches preserve distinct lifecycle identities within Herdr's token cap", () => {
  const prefix = `https://github.com/owner/${"repo".repeat(30)}/pull/`;
  const first = lifecycleTokens({ url: `${prefix}1`, state: "CLOSED" }, "branch".repeat(30), 1);
  const second = lifecycleTokens({ url: `${prefix}2`, state: "CLOSED" }, "branch".repeat(30) + "2", 1);
  assert.notEqual(first.github_pr_id.slice(0, 80), second.github_pr_id.slice(0, 80));
  assert.notEqual(first.github_pr_branch_id.slice(0, 80), second.github_pr_branch_id.slice(0, 80));
  assert.ok(first.github_pr_id.length <= 80 && first.github_pr_branch_id.length <= 80);
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
