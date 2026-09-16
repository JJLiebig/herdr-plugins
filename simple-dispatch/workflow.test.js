"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  agentMatchesHarness, agentSessionTitle, autoCleanupOnPrMerge, canonicalRepositoryRoot, checksSummary, codexAgentStartArgs, completeGitHubTarget, confirmView, controllerProtocol, defaultHarnessKind, harnessStartArgs, installedIntegrations, openConfirmPopup, openInputPopup,
  project, startParentAgent,
  implementationPullRequest, isAgentPromptStalled, monitor, openProgressPane, popupFields, popupInputKey, popupInputView, popupSelection, popupState, progressView, pullRequestReadiness, readPluginState, resolveRepository,
  sourceDirectory, stalledPromptRecovery, stalledPromptRecoveryCommands, trackedPullRequest, waitForActivity, writePluginState,
} = require("./controller.js");
const { issuePrompt, prPrompt, taskPrompt, opencodeIssuePrompt } = require("./prompts.js");
const { getHarness, harnessList, sessionMatches } = require("./harnesses.js");
const {
  Lifecycle,
  collisionReason,
  connectPipe,
  createPipeServer,
  makeIdentity,
  makePipeName,
  parseGitHubRemote,
  parseTarget,
} = require("./workflow.js");

test("pull-request merge cleanup is opt-in", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-codex-workflows-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.equal(autoCleanupOnPrMerge(directory), false);
  fs.writeFileSync(path.join(directory, "config.json"), '{"auto-cleanup-on-pr-merge":false}');
  assert.equal(autoCleanupOnPrMerge(directory), false);
  fs.writeFileSync(path.join(directory, "config.json"), '{"auto-cleanup-on-pr-merge":true}');
  assert.equal(autoCleanupOnPrMerge(directory), true);
});

test("remembers the last harness and defaults to it next time", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-workflows-state-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.deepEqual(readPluginState(directory), {});
  writePluginState({ "last-harness": "opencode" }, directory);
  assert.equal(readPluginState(directory)["last-harness"], "opencode");
  writePluginState({ "auto-cleanup-on-pr-merge": false }, directory);
  assert.deepEqual(readPluginState(directory), { "last-harness": "opencode", "auto-cleanup-on-pr-merge": false });
});

test("default harness prefers the remembered value, then config, then codex", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-workflows-default-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.equal(defaultHarnessKind(directory), "codex");
  fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify({ "default-harness": "opencode" }));
  assert.equal(defaultHarnessKind(directory), "opencode");
  writePluginState({ "last-harness": "claude" }, directory);
  assert.equal(defaultHarnessKind(directory), "claude");
});

test("full links select their repository while shorthand stays current", () => {
  assert.deepEqual(parseTarget("#42", "owner/repo"), {
    number: 42, input: "#42", repo: "owner/repo", repositorySource: "current",
  });
  assert.deepEqual(parseTarget("github.com/other/repo/issues/42", "owner/repo"), {
    number: 42, input: "github.com/other/repo/issues/42", repo: "owner/repo", repositorySource: "current",
  });
  assert.deepEqual(parseTarget("pull/7", "owner/repo"), {
    number: 7, input: "pull/7", repo: "owner/repo", repositorySource: "current",
  });
  assert.equal(parseTarget("https://github.com/Other/Repo/pull/7/files", "owner/repo").repo, "other/repo");
  assert.deepEqual(parseTarget("https://github.com/Other/Repo/issues/42?notification=1", "owner/repo"), {
    number: 42, input: "https://github.com/Other/Repo/issues/42?notification=1", repo: "other/repo", repositorySource: "link",
  });
  assert.throws(() => parseTarget("fix the startup race", "owner/repo"), /URL or number/);
  assert.throws(() => parseTarget("#0", "owner/repo"), /positive safe integer/);
  assert.throws(() => parseTarget("https://github.com/owner/repo/issues/0", "owner/repo"), /positive safe integer/);
});

test("GitHub issue objects select the workflow and canonical URL", () => {
  const target = parseTarget("#42", "owner/repo");
  assert.deepEqual(completeGitHubTarget(target, { number: 42, html_url: "https://github.com/owner/repo/issues/42" }), {
    ...target, type: "issue", url: "https://github.com/owner/repo/issues/42",
  });
  assert.equal(completeGitHubTarget(target, {
    number: 42, html_url: "https://github.com/owner/repo/pull/42", pull_request: {},
  }).type, "pr");
  assert.throws(() => completeGitHubTarget(target, { number: 41 }), /requested issue or pull request/);
});

test("resolves repositories by full owner and name identity", () => {
  const codeRoot = "C:\\Code", current = { root: "C:\\Code\\current", repo: "owner/current", repoName: "current" };
  const matching = { root: "C:\\Code\\target", repo: "other/target", repoName: "target" };
  assert.equal(resolveRepository({ repo: "other/target" }, current, {
    codeRoot,
    exists: (root) => root === path.join(codeRoot, "target"),
    identify: () => matching,
    clone: () => assert.fail("matching checkout must be reused"),
  }), matching);

  const clones = [], canonical = path.join(codeRoot, "other", "target");
  assert.deepEqual(resolveRepository({ repo: "other/target" }, current, {
    codeRoot,
    exists: () => false,
    clone: (repo, root) => clones.push([repo, root]),
    identify: (root) => ({ root, repo: "other/target", repoName: "target" }),
  }), { root: canonical, repo: "other/target", repoName: "target" });
  assert.deepEqual(clones, [["other/target", canonical]]);

  assert.throws(() => resolveRepository({ repo: "other/target" }, current, {
    codeRoot,
    exists: (root) => root === canonical,
    identify: () => ({ root: canonical, repo: "another/target", repoName: "target" }),
  }), /belongs to another\/target/);
});

test("renders repository provenance and launch checkpoints", () => {
  const loading = progressView({ status: "running", step: 0, repo: "owner/repo", repositorySource: "current" }, 0);
  assert.match(loading, /owner\/repo \(current workspace\)/);
  assert.match(loading, /\| Resolve repository/);
  assert.match(loading, /0%/);
  assert.equal(loading.trim().split("\n").length, 2);
  const started = progressView({ status: "started", step: 4, repo: "other/repo", repositorySource: "link" });
  assert.match(started, /other\/repo \(full link\)/);
  assert.match(started, /Codex started/);
  assert.match(started, /100%/);
});

test("normalizes common GitHub origin forms", () => {
  assert.equal(parseGitHubRemote("git@github.com:Owner/Repo.git"), "owner/repo");
  assert.equal(parseGitHubRemote("https://github.com/Owner/Repo.git"), "owner/repo");
  assert.equal(parseGitHubRemote("ssh://git@github.com/Owner/Repo.git"), "owner/repo");
});

test("opens popup on Herdr's active pane without rejected target flags", () => {
  let args;
  openInputPopup("pipe-1", "task", (value) => { args = value; });
  assert.equal(args.includes("--workspace"), false);
  assert.equal(args.includes("--target-pane"), false);
  assert.equal(args[args.indexOf("--cwd") + 1], __dirname);
  assert.equal(args[args.indexOf("HERDR_CODEX_WORKFLOW_MODE=task") - 1], "--env");
  assert.equal(args.at(-1), "--focus");
});

test("opens a focused confirmation popup for a dirty cleanup", () => {
  let args;
  openConfirmPopup("pipe-1", (value) => { args = value; });
  assert.deepEqual(args.slice(0, 4), ["plugin", "pane", "open", "--plugin"]);
  assert.equal(args[args.indexOf("--entrypoint") + 1], "confirm");
  assert.equal(args[args.indexOf("--cwd") + 1], __dirname);
  assert.equal(args[args.indexOf("HERDR_CODEX_WORKFLOW_PIPE=pipe-1") - 1], "--env");
  assert.equal(args.at(-1), "--focus");
  assert.match(confirmView("This workflow worktree has uncommitted changes."), /remove it anyway/i);
});

test("popup edits and renders multiline custom instructions", () => {
  const state = popupState("github", harnessList(), "codex");
  assert.deepEqual(popupFields(state), ["harness", "target", "instructions"]);
  assert.equal(state.active, 1);
  popupInputKey(state, "#42", {});
  assert.match(popupInputView(state, 40), /> Paste issue or PR: #42/);
  assert.equal(popupInputKey(state, "", { name: "tab" }), "render");
  assert.equal(state.active, 2);
  popupInputKey(state, "focus startup", {});
  assert.equal(popupInputKey(state, undefined, { name: "undefined", sequence: "\x1b[13;2u" }), "render");
  popupInputKey(state, "then test", {});
  assert.deepEqual(state.values, ["#42", "focus startup\nthen test"]);
  assert.match(popupInputView(state, 40, 6), /─+\n> Custom instructions:\n  focus startup\n  then test/);
  assert.equal(popupInputKey(state, "", { name: "return" }), "submit");
  assert.equal(popupInputKey(state, undefined, { name: "undefined", sequence: "\x1b[27u" }), "cancel");
  assert.equal(popupInputKey(state, undefined, { name: "undefined", sequence: "\x1b[99;5u" }), "cancel");

  state.values[1] = "x".repeat(100);
  const lines = popupInputView(state, 40, 6).replace(/^\x1b\[2J\x1b\[H/, "").replace(/\x1b\[\d+;\d+H$/, "").split("\n");
  assert.ok(lines.length <= 6 && lines.every((line) => [...line].length < 40));

  const promptInput = { repo: "owner/repo", target: { url: "https://github.com/owner/repo/issues/42" }, prUrl: "https://github.com/owner/repo/pull/42", instructions: "focus startup\nthen test" };
  assert.match(issuePrompt(promptInput), /Important! Custom Instructions:\nfocus startup\nthen test/);
  assert.match(prPrompt(promptInput), /Important! Custom Instructions:\nfocus startup\nthen test/);
  assert.doesNotMatch(issuePrompt({ ...promptInput, instructions: "" }), /Custom Instructions/);
  assert.match(issuePrompt(promptInput), /\$review-suite:review \(note: herdrdev\/herdr uses mode fast\)/);
  assert.match(prPrompt(promptInput), /\$review-suite:review \(note: herdrdev\/herdr uses mode fast\)/);
});

test("shepherding prompt injects readiness, fork gate, and push target", () => {
  const sameRepo = prPrompt({
    repo: "owner/repo", prUrl: "https://github.com/owner/repo/pull/7",
    headRefName: "fix/x", headRepository: "owner/repo", crossRepository: false,
    readiness: { mergeable: "MERGEABLE", mergeStateStatus: "BEHIND", reviewDecision: "APPROVED", checks: { passing: 3, pending: 1, failing: 0 } },
    instructions: "",
  });
  assert.match(sameRepo, /checks 3 passing \/ 1 pending \/ 0 failing, review approved/);
  assert.match(sameRepo, /git push origin HEAD:fix\/x/);
  assert.doesNotMatch(sameRepo, /AGENTS\.md/);

  const fork = prPrompt({
    repo: "owner/repo", prUrl: "https://github.com/owner/repo/pull/8",
    headRefName: "fix/y", headRepository: "someone/repo", crossRepository: true, maintainerCanModify: false,
    readiness: null, instructions: "",
  });
  assert.match(fork, /does not allow maintainer edits\. Stop and ask before changing anything/);
  assert.match(fork, /push a new branch and open a replacement pull request that preserves/);
  assert.match(fork, /only if you can push to it; otherwise stop and ask/);

  const editableFork = prPrompt({
    repo: "owner/repo", prUrl: "https://github.com/owner/repo/pull/9",
    headRefName: "fix/z", headRepository: "someone/repo", crossRepository: true, maintainerCanModify: true,
    readiness: null, instructions: "",
  });
  assert.match(editableFork, /allows maintainer edits; update the existing pull request in place/);
  assert.match(editableFork, /maintainer edits are allowed, so add the fork as a remote and push there/);
  assert.doesNotMatch(editableFork, /open a replacement pull request that preserves/);
});

test("classifies pull-request checks and tracks the workflow pull request", () => {
  assert.deepEqual(checksSummary([
    { name: "a", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "b", status: "IN_PROGRESS", conclusion: "" },
    { name: "c", status: "COMPLETED", conclusion: "FAILURE" },
    { name: "d", state: "PENDING" },
    { name: "e", state: "SUCCESS" },
    { name: "f", state: "ERROR" },
  ]), { passing: 2, pending: 2, failing: 2 });
  assert.deepEqual(pullRequestReadiness({
    mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", reviewDecision: "REVIEW_REQUIRED",
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
  }), {
    mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", reviewDecision: "REVIEW_REQUIRED",
    checks: { passing: 1, pending: 0, failing: 0 },
  });
  assert.equal(pullRequestReadiness({}).checks.pending, 0);

  const runtime = { identity: { branch: "auto-pr-7-abc123" }, prNumber: 7, prUrl: "https://github.com/owner/repo/pull/7" };
  assert.deepEqual(trackedPullRequest(runtime, { repo: "owner/repo" }, []), { number: 7, url: runtime.prUrl });
  assert.deepEqual(trackedPullRequest(runtime, { repo: "owner/repo" }, [{ number: 9, url: "replacement" }]), { number: 9, url: "replacement" });
  assert.throws(() => trackedPullRequest(runtime, { repo: "owner/repo" }, [{}, {}]), /multiple open pull requests/);
});

test("pull-request identity uses the shepherding branch stem", () => {
  assert.match(makeIdentity("pr", { number: 7 }, "abcdef123456").branch, /^auto-pr-7-abcdef12-[0-9a-f]{6}$/);
});

test("cleans harness decoration from session titles", () => {
  assert.equal(agentSessionTitle({ terminal_title_stripped: "OC | Flexible PR Review" }, getHarness("opencode")), "Flexible PR Review");
  assert.equal(agentSessionTitle({ terminal_title_stripped: "Fix compact mode text scrolling | codex" }, getHarness("codex")), "Fix compact mode text scrolling");
  assert.equal(agentSessionTitle({ terminal_title: "CX | Add retry" }, getHarness("codex")), "Add retry");
  assert.equal(agentSessionTitle({ terminal_title_stripped: "Integrate tag, release, and build | destructive_command_g..." }, getHarness("codex")), "Integrate tag, release, and build");
  assert.equal(agentSessionTitle({ terminal_title_stripped: "" }, getHarness("codex")), "");
  assert.equal(agentSessionTitle({}, getHarness("codex")), "");
  assert.equal([...agentSessionTitle({ terminal_title_stripped: "y".repeat(80) }, null)].length, 40);
  assert.equal(agentSessionTitle({ terminal_title_stripped: "OC | OpenCode" }, getHarness("opencode")), "");
  assert.equal(agentSessionTitle({ terminal_title_stripped: "task-1e5f3b | codex", cwd: "C:\\Code\\.worktrees\\herdr\\task-1e5f3b" }, getHarness("codex")), "");
  assert.equal(agentSessionTitle({ terminal_title_stripped: "cw-1e5f3b", name: "cw-1e5f3b" }, getHarness("opencode")), "");
});

test("project names the workspace and pane from the session title", () => {
  const harness = getHarness("opencode");
  const runtime = {
    lifecycle: { state: "RUNNING" }, workflow: "task", harness,
    identity: { agentName: "worker", shortLabel: "T-1e5f3b", branch: "auto-task-1e5f3b" },
    worktree: { workspace: { workspace_id: "w1" }, root_pane: { pane_id: "w1:p1" } },
  };
  const agent = {
    workspace_id: "w1", pane_id: "w1:p1", agent_status: "working",
    agent_session: { source: "herdr:opencode", kind: "id", value: "ses_abc123def" },
    terminal_title_stripped: "OC | Flexible PR Review",
  };
  const reports = [];
  project(runtime, "working", "", { agent: () => agent, report: (args) => reports.push(args), save: () => {} });
  const rename = reports.find((args) => args[0] === "workspace" && args[1] === "rename");
  assert.equal(rename[3], "[Flexible PR Review] working");
  const pane = reports.find((args) => args[0] === "pane" && args[1] === "report-metadata");
  assert.equal(pane[pane.indexOf("--title") + 1], "Flexible PR Review parent");
  assert.equal(runtime.label, "Flexible PR Review");
});

test("issue and pull-request labels keep their workflow identity", () => {
  const harness = getHarness("opencode");
  const runtime = {
    lifecycle: { state: "RUNNING" }, workflow: "issue", harness,
    identity: { agentName: "worker", shortLabel: "I-3932", branch: "auto-issue-3932" },
    worktree: { workspace: { workspace_id: "w13" }, root_pane: { pane_id: "w13:p1" } },
  };
  const agent = {
    workspace_id: "w13", pane_id: "w13:p1", agent_status: "working",
    agent_session: { source: "herdr:opencode", kind: "id", value: "ses_abc123def" },
    terminal_title_stripped: "OC | Investigate Herdr Issue #3932",
  };
  const reports = [];
  project(runtime, "working", "", { agent: () => agent, report: (args) => reports.push(args), save: () => {} });
  const rename = reports.find((args) => args[0] === "workspace" && args[1] === "rename");
  assert.equal(rename[3], "[I-3932] working");
  assert.equal(runtime.label, undefined);
});

test("popup selects a harness with the arrow keys and type-ahead", () => {
  const state = popupState("github", harnessList(), "codex");
  assert.deepEqual(popupFields(state), ["harness", "target", "instructions"]);
  assert.equal(popupSelection(state).kind, "codex");
  state.active = 0;
  popupInputKey(state, undefined, { name: "right" });
  assert.equal(popupSelection(state).kind, "opencode");
  popupInputKey(state, undefined, { name: "left" });
  assert.equal(popupSelection(state).kind, "codex");
  assert.equal(popupInputKey(state, "o", { name: "o", sequence: "o" }), "render");
  assert.equal(popupSelection(state).kind, "opencode");
  assert.match(popupInputView(state, 60), /Harness: < opencode >/);

  const repeat = popupState("github", harnessList(), "codex");
  repeat.active = 0;
  popupInputKey(repeat, "c", { name: "c", sequence: "c" });
  assert.equal(popupSelection(repeat).kind, "codex");
  popupInputKey(repeat, "c", { name: "c", sequence: "c" });
  assert.equal(popupSelection(repeat).kind, "claude");
  popupInputKey(repeat, "c", { name: "c", sequence: "c" });
  assert.equal(popupSelection(repeat).kind, "cursor");
});

test("parses installed integrations from Herdr status output", () => {
  const output = "pi: not installed (C:\\x)\ncodex: current (v8) (C:\\y)\nantigravity-cli: outdated (C:\\z)\n";
  const quiet = () => {};
  assert.deepEqual([...installedIntegrations(() => output, quiet)].sort(), ["antigravity-cli", "codex"]);
  assert.deepEqual([...installedIntegrations(() => "  qodercli: current (v1) (p)\n", quiet)], ["qodercli"]);
  assert.deepEqual([...installedIntegrations(() => "  herdr_opencode: current (v1) (p)\n", quiet)], ["herdr_opencode"]);
  assert.equal(installedIntegrations(() => { throw new Error("offline"); }, quiet), null);
  assert.equal(installedIntegrations(() => "unrecognized output", quiet), null);
});

test("arrow keys edit the text and leave the field at the edges", () => {
  const state = popupState("task", harnessList(), "codex");
  assert.deepEqual(popupFields(state), ["harness", "request"]);
  assert.equal(state.active, 1);
  popupInputKey(state, "abc", { sequence: "abc" });
  assert.equal(state.values[0], "abc");
  assert.equal(state.cursors[0], 3);
  popupInputKey(state, undefined, { name: "left" });
  assert.equal(state.cursors[0], 2);
  popupInputKey(state, undefined, { name: "home" });
  assert.equal(state.cursors[0], 0);
  assert.equal(popupInputKey(state, undefined, { name: "up" }), "render");
  assert.equal(state.active, 0);
  popupInputKey(state, undefined, { name: "down" });
  assert.equal(state.active, 1);
  popupInputKey(state, undefined, { name: "end" });
  assert.equal(state.cursors[0], 3);
  popupInputKey(state, "X", { sequence: "X" });
  assert.equal(state.values[0], "abcX");
});

test("multiline cursor stays in bounds across hard newlines", () => {
  const state = popupState("task", harnessList(), "codex");
  popupInputKey(state, "ab", { sequence: "ab" });
  popupInputKey(state, "\x1b[13;2u", {});
  popupInputKey(state, "cd", { sequence: "cd" });
  assert.equal(state.values[0], "ab\ncd");
  assert.equal(state.cursors[0], 5);
  popupInputKey(state, undefined, { name: "up" });
  assert.equal(state.cursors[0], 2);
  popupInputKey(state, undefined, { name: "up" });
  assert.equal(state.active, 0);
  assert.ok(state.cursors[0] >= 0);
  popupInputKey(state, undefined, { name: "down" });
  assert.equal(state.active, 1);
  popupInputKey(state, undefined, { name: "up" });
  assert.equal(state.cursors[0], 2);
  assert.doesNotMatch(popupInputView(state, 40, 6), /-1H|;-?\d*0H/);
});

test("home and end use field edges for the single-line target", () => {
  const state = popupState("github", harnessList(), "codex");
  state.values[0] = "x".repeat(100);
  state.cursors[0] = 100;
  popupInputKey(state, undefined, { name: "home" });
  assert.equal(state.cursors[0], 0);
  popupInputKey(state, undefined, { name: "end" });
  assert.equal(state.cursors[0], 100);
  state.active = 2;
  state.values[1] = "ab\ncd";
  state.cursors[1] = 5;
  popupInputKey(state, undefined, { name: "home" });
  assert.equal(state.cursors[1], 3);
  popupInputKey(state, undefined, { name: "end" });
  assert.equal(state.cursors[1], 5);
});

test("a full-width line before a newline does not render a phantom blank line", () => {
  const state = popupState("task", harnessList(), "codex");
  state.values[0] = "abc\nxyz";
  state.cursors[0] = 7;
  const body = popupInputView(state, 6, 8).replace(/^\x1b\[2J\x1b\[H/, "").replace(/\x1b\[\d+;\d+H$/, "").split("\n");
  assert.deepEqual(body, ["  Harness: < Codex >", "> Describe the feature or fix:", "  abc", "  xyz"]);
});

test("popup refuses to open when no harness integration is available", () => {
  assert.throws(() => popupState("github", [], "codex"), /No agent harness is installed/);
});

test("harness list filters by installed integrations and defaults to generic cleanup", () => {
  assert.deepEqual(harnessList(new Set(["codex", "opencode"])).map((harness) => harness.kind), ["codex", "opencode"]);
  assert.deepEqual(harnessList().map((harness) => harness.kind).slice(0, 3), ["codex", "opencode", "claude"]);
  const claude = getHarness("claude");
  assert.equal(claude.archiveArgs, null);
  assert.deepEqual(claude.quit, { keys: ["ctrl+c", "ctrl+c"] });
  assert.equal(sessionMatches(claude, { source: "herdr:claude", kind: "id", value: "abc-123" }), true);
  assert.equal(sessionMatches(claude, { source: "herdr:codex", kind: "id", value: "abc-123" }), false);
  const omp = getHarness("omp");
  assert.equal(sessionMatches(omp, { source: "herdr:omp", kind: "path", value: "C:\\sessions\\omp.jsonl" }), true);
  assert.equal(getHarness("agy").integration, "antigravity-cli");
  assert.equal(getHarness("qodercli").integration, "qodercli");
});

test("opencode and codex expose different session identity and resume semantics", () => {
  const codex = getHarness("codex"), opencode = getHarness("opencode");
  assert.equal(codex.sessionValue("019cbe72-e55b-73d1-87d8-4e01f1f75043"), true);
  assert.equal(codex.sessionValue("ses_abc123"), false);
  assert.equal(opencode.sessionValue("ses_abc123"), true);
  assert.equal(sessionMatches(opencode, { source: "herdr:opencode", kind: "id", value: "ses_abc123" }), true);
  assert.equal(sessionMatches(codex, { source: "herdr:opencode", kind: "id", value: "ses_abc123" }), false);
  assert.deepEqual(opencode.startArgs("worker", "w1:p2"), [
    "agent", "start", "worker", "--kind", "opencode", "--pane", "w1:p2",
  ]);
  assert.deepEqual(opencode.archiveArgs("ses_abc123"), ["session", "delete", "ses_abc123"]);
  assert.deepEqual(harnessStartArgs(opencode, "worker", "w1:p2"), [
    "agent", "start", "worker", "--kind", "opencode", "--pane", "w1:p2",
  ]);
  assert.match(opencode.prompts.issue({ repo: "owner/repo", target: { url: "https://github.com/owner/repo/issues/42" } }), /GitHub CLI/);
  assert.doesNotMatch(opencode.prompts.issue({ repo: "owner/repo", target: { url: "x" } }), /\$review-suite/);
  assert.match(opencodeIssuePrompt({ repo: "owner/repo", target: { url: "x" } }), /pull request/);
});

test("rejects an unsupported or unavailable harness", async () => {
  const attempt = async (message, harnesses = harnessList()) => {
    const runtime = { workflow: "issue", launch: {}, harness: getHarness("codex"), harnesses };
    const connection = {};
    const protocol = controllerProtocol(runtime, new Lifecycle(), () => {}, () => {});
    await protocol.message({ type: "hello", role: "input" }, connection);
    return protocol.message({ type: "input", target: "#1", ...message }, connection);
  };
  await assert.rejects(attempt({ harness: "nope" }), /unsupported harness/);
  await assert.rejects(attempt({ harness: "opencode" }, harnessList(new Set(["codex"]))), /harness is not available/);
});

test("task input and prompt preserve a multiline request", () => {
  const state = popupState("task", harnessList(), "codex");
  assert.deepEqual(popupFields(state), ["harness", "request"]);
  popupInputKey(state, "Build the thing", { sequence: "Build the thing" });
  assert.match(popupInputView(state, 40, 5), /Describe the feature or fix:\n  Build the thing/);
  assert.equal(popupInputKey(state, "\x1b[13;2u", {}), "render");
  popupInputKey(state, "Then test it", { sequence: "Then test it" });
  assert.equal(state.values[0], "Build the thing\nThen test it");
  assert.equal(popupInputKey(state, "", { name: "return" }), "submit");

  const identity = makeIdentity("task");
  assert.match(identity.branch, /^auto-task-[0-9a-f]{6}$/);
  assert.equal(identity.directory, identity.branch.slice("auto-".length));
  const prompt = taskPrompt({ repo: "owner/repo", request: state.values[0] });
  assert.match(prompt, /Build the thing\nThen test it/);
  assert.match(prompt, /tricky.*\$ask-pro:ask-pro.*otherwise.*\$review-suite:review-plan/);
  assert.doesNotMatch(prompt, /Custom Instructions/);
});

test("shorthand follows the focused pane repository", () => {
  assert.equal(sourceDirectory({
    focused_pane_cwd: "C:\\Code\\plugin",
    worktree: { repo_root: "C:\\Users\\jonat\\.codex" },
    workspace_cwd: "C:\\Users\\jonat\\.codex",
  }), "C:\\Code\\plugin");
  assert.equal(canonicalRepositoryRoot(
    "C:\\Code\\.worktrees\\plugin\\review-pr-1", "C:\\Code\\plugin\\.git",
  ), "C:\\Code\\plugin");
  assert.equal(canonicalRepositoryRoot("C:\\Code\\plugin", ".git"), "C:\\Code\\plugin");
  assert.equal(canonicalRepositoryRoot(
    "C:\\Code\\parent\\submodule", "C:\\Code\\parent\\.git\\modules\\submodule",
  ), "C:\\Code\\parent\\submodule");
});

test("opens a slim unfocused progress split under the invoking pane", () => {
  let openArgs, resizeArgs;
  openProgressPane("pipe-1", { focused_pane_id: "w1:p2" }, (value) => {
    openArgs = value;
  }, (value) => { resizeArgs = value; });
  assert.deepEqual(openArgs.slice(openArgs.indexOf("--placement"), openArgs.indexOf("--cwd")), [
    "--placement", "split", "--target-pane", "w1:p2", "--direction", "down",
  ]);
  assert.equal(openArgs.at(-1), "--no-focus");
  assert.deepEqual(resizeArgs, ["pane", "resize", "--pane", "w1:p2", "--direction", "down", "--amount", "0.4"]);
});

test("progress can observe launch status after input submits", async () => {
  const lifecycle = new Lifecycle(), runtime = { launch: { status: "collecting", step: 0 } };
  let submitted, hello = false, progressHello = false;
  const protocol = controllerProtocol(runtime, lifecycle, () => { hello = true; }, (value) => { submitted = value; }, () => { progressHello = true; });
  const inputConnection = {}, progressConnection = {};
  await protocol.message({ type: "hello", role: "input" }, inputConnection);
  await protocol.message({ type: "input", target: "#42", instructions: "focus startup\r\nthen test" }, inputConnection);
  runtime.launch.status = "running";
  await protocol.message({ type: "hello", role: "progress" }, progressConnection);
  assert.equal(hello, true);
  assert.equal(progressHello, true);
  assert.deepEqual(submitted, { target: "#42", instructions: "focus startup\nthen test", harness: "codex" });
  assert.equal((await protocol.message({ type: "status" }, progressConnection)).launch.status, "running");

  const taskLifecycle = new Lifecycle(), taskRuntime = { workflow: "task", launch: {} };
  let taskSubmission;
  const taskProtocol = controllerProtocol(taskRuntime, taskLifecycle, () => {}, (value) => { taskSubmission = value; });
  const taskConnection = {};
  await taskProtocol.message({ type: "hello", role: "input" }, taskConnection);
  await taskProtocol.message({ type: "input", request: "Build it\r\nThen test it" }, taskConnection);
  assert.deepEqual(taskSubmission, { request: "Build it\nThen test it", harness: "codex" });

  const opencodeRuntime = { workflow: "issue", launch: {}, harness: getHarness("opencode"), harnesses: harnessList() };
  let opencodeSubmission;
  const opencodeProtocol = controllerProtocol(opencodeRuntime, new Lifecycle(), () => {}, (value) => { opencodeSubmission = value; });
  const opencodeConnection = {};
  await opencodeProtocol.message({ type: "hello", role: "input" }, opencodeConnection);
  await opencodeProtocol.message({ type: "input", target: "#7", instructions: "", harness: "opencode" }, opencodeConnection);
  assert.deepEqual(opencodeSubmission, { target: "#7", instructions: "", harness: "opencode" });
});

test("forwards Codex++ auto-account only when the executable advertises it", () => {
  const base = ["agent", "start", "worker", "--kind", "codex", "--pane", "w1:p2"];
  assert.deepEqual(codexAgentStartArgs("worker", "w1:p2", () => "  --auto-account  Immediately select an account"), [
    ...base, "--", "--auto-account",
  ]);
  assert.deepEqual(codexAgentStartArgs("worker", "w1:p2", () => "  --version  Print version"), base);
  assert.deepEqual(codexAgentStartArgs("worker", "w1:p2", () => "  --auto-accounting  Not the capability"), base);
  assert.deepEqual(codexAgentStartArgs("worker", "w1:p2", () => { throw new Error("probe failed"); }), base);
});

test("agent start timeouts adopt an already-running agent instead of failing", () => {
  const runtime = { harness: getHarness("codex") };
  const readHelp = () => "  --auto-account  Immediately select an account";
  const startArgs = ["agent", "start", "worker", "--kind", "codex", "--pane", "w1:p2", "--", "--auto-account"];
  const timeout = () => { const error = new Error("timed out waiting for agent startup"); error.herdrCode = "timeout"; return error; };

  const adopted = [];
  startParentAgent(runtime, "worker", "w1:p2",
    (args) => { adopted.push(args); if (args[1] === "start") throw timeout(); },
    () => ({ agent: "codex", agent_status: "working" }), readHelp);
  assert.deepEqual(adopted, [startArgs, ["agent", "rename", "w1:p2", "worker"]]);

  const started = [];
  startParentAgent(runtime, "worker", "w1:p2",
    (args) => started.push(args),
    () => assert.fail("a successful start must not look up the pane"), readHelp);
  assert.deepEqual(started, [startArgs]);

  const fatal = new Error("busy"); fatal.herdrCode = "agent_pane_busy";
  assert.throws(() => startParentAgent(runtime, "worker", "w1:p2",
    () => { throw fatal; }, () => ({ agent: "codex" }), readHelp), /busy/);

  assert.throws(() => startParentAgent(runtime, "worker", "w1:p2",
    () => { throw timeout(); }, () => null, readHelp), /timed out/);
  assert.throws(() => startParentAgent(runtime, "worker", "w1:p2",
    () => { throw timeout(); }, () => ({ agent: "opencode" }), readHelp), /timed out/);
});

test("agent harness matching follows kind, label, and session source", () => {
  assert.equal(agentMatchesHarness({ agent: "codex" }, getHarness("codex")), true);
  assert.equal(agentMatchesHarness({ agent_session: { source: "herdr:codex" } }, getHarness("codex")), true);
  assert.equal(agentMatchesHarness({ agent: "antigravity" }, getHarness("agy")), true);
  assert.equal(agentMatchesHarness({ agent: "opencode" }, getHarness("codex")), false);
  assert.equal(agentMatchesHarness(null, getHarness("codex")), false);
});

test("stalled prompts submit the pasted composer without repeating the prompt", () => {
  assert.equal(isAgentPromptStalled('{"error":{"code":"agent_prompt_stalled"}}'), true);
  assert.equal(isAgentPromptStalled('{"error":{"code":"timeout"}}'), false);
  assert.deepEqual(stalledPromptRecoveryCommands("worker"), [
    ["agent", "send-keys", "worker", "enter"],
    ["agent", "wait", "worker", "--until", "working", "--until", "blocked", "--timeout", "5000"],
  ]);
  assert.equal(stalledPromptRecovery("idle"), "submit");
  assert.equal(stalledPromptRecovery("done"), "submit");
  assert.equal(stalledPromptRecovery("working"), "started");
  assert.equal(stalledPromptRecovery("blocked"), "started");
  assert.equal(stalledPromptRecovery(), "failed");
  assert.equal(stalledPromptRecovery("unknown"), "failed");
});

test("issue completion waits for a PR and rechecks after follow-up activity", async () => {
  const lifecycle = new Lifecycle();
  lifecycle.transition("submit");
  lifecycle.transition("provisioned");
  const runtime = {
    workflow: "issue", lifecycle, terminal: null, prompt: { finished: true },
    identity: { agentName: "worker" }, worktree: { workspace: { workspace_id: "w1" } },
  };
  let checks = 0, resume, reachedWaiting;
  const waiting = new Promise((resolve) => { reachedWaiting = resolve; });
  const paused = new Promise((resolve) => { resume = resolve; });
  const projections = [];
  let completed = false;
  const monitoring = monitor(runtime, {}, {
    workspace: () => ({}), agent: () => ({ agent_status: "idle" }),
    implementationPullRequest: () => ++checks === 1 ? null : ({ number: 12, url: "https://github.com/owner/repo/pull/12", headRefOid: "head" }),
    project: (_runtime, state) => projections.push(state), projectTerminal: () => {},
    activity: async () => {
      reachedWaiting();
      await paused;
      return { agent_status: "working" };
    },
  }).then(() => { completed = true; });
  await waiting;
  assert.equal(completed, false);
  assert.equal(runtime.terminal, null);
  assert.equal(runtime.lifecycle.state, "RUNNING");
  resume();
  await monitoring;
  assert.equal(checks, 2);
  assert.deepEqual(projections, ["waiting", "working"]);
  assert.equal(runtime.terminal["pr-url"], "https://github.com/owner/repo/pull/12");
});

test("controller yields when manual cleanup takes ownership", async () => {
  const result = await monitor({ terminal: null, cleanupRequest: {}, worktree: { workspace: { workspace_id: "w1" } } }, {}, {
    workspace: () => assert.fail("cleanup is checked before workspace state"),
    agent: () => assert.fail("cleanup owns the agent before monitor checks it"),
  });
  assert.equal(result, "cleanup");
});

test("late session discovery does not block status and is retried while Codex stays working", async () => {
  const runtime = {
    lifecycle: { state: "RUNNING" }, workflow: "issue", prompt: {},
    identity: { agentName: "worker", shortLabel: "I-1", branch: "codex/issue-1" },
    worktree: { workspace: { workspace_id: "w1" }, root_pane: { pane_id: "w1:p1" } },
  };
  const agent = { workspace_id: "w1", pane_id: "w1:p1", agent_status: "working" };
  const reports = [], saved = [];
  let saveAttempts = 0;
  const update = (runtime, state) => project(runtime, state, "", {
    agent: () => agent, report: (args) => reports.push(args), save: (runtime) => {
      if (++saveAttempts === 1) throw new Error("worktree temporarily unavailable");
      saved.push(runtime.ownerSessionId);
    },
  });
  update(runtime, "working");
  assert.ok(reports.some((args) => args.includes("workflow_state=RUNNING")));
  assert.deepEqual(saved, []);
  let polls = 0;
  await monitor(runtime, {}, {
    workspace: () => ({}), agent: () => agent, project: update,
    delay: async () => {
      if (++polls === 1) agent.agent_session = { source: "herdr:codex", kind: "id", value: "019cbe72-e55b-73d1-87d8-4e01f1f75043" };
      else if (polls === 3) runtime.cleanupRequest = {};
    },
  });
  assert.deepEqual(saved, ["019cbe72-e55b-73d1-87d8-4e01f1f75043"]);
  assert.equal(saveAttempts, 2);
  assert.ok(reports.some((args) => args.includes("workflow_session=019cbe72-e55b-73d1-87d8-4e01f1f75043")));
});

test("controller acknowledges cleanup only after yielding", async () => {
  const runtime = { cleanupRequest: null, ownerSessionId: "019cbe72-e55b-73d1-87d8-4e01f1f75043",
    worktree: { root_pane: { pane_id: "w1:p1" } }, launch: {} };
  const protocol = controllerProtocol(runtime, new Lifecycle(), () => {}, () => {});
  let settled = false;
  const request = protocol.message({ type: "cleanup", rootPaneId: "w1:p1", sessionId: runtime.ownerSessionId }, {})
    .then((reply) => { settled = true; return reply; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(runtime.cleanupRequest);
  assert.equal(settled, false);
  runtime.cleanupRequest.acknowledge();
  assert.deepEqual(await request, {});
});

test("task completion uses the implementation pull request path", async () => {
  const lifecycle = new Lifecycle();
  lifecycle.transition("submit");
  lifecycle.transition("provisioned");
  const runtime = {
    workflow: "task", lifecycle, terminal: null, prompt: { finished: true },
    identity: { agentName: "worker" }, worktree: { workspace: { workspace_id: "w1" } },
  };
  await monitor(runtime, {}, {
    workspace: () => ({}), agent: () => ({ agent_status: "idle" }),
    implementationPullRequest: () => ({ number: 13, url: "https://github.com/owner/repo/pull/13", headRefOid: "head" }),
    projectTerminal: () => {},
  });
  assert.equal(runtime.terminal["pr-url"], "https://github.com/owner/repo/pull/13");
});

test("implementation PR lookup distinguishes zero, multiple, and invalid matches", () => {
  const runtime = { identity: { branch: "codex/issue-1-a" }, baseBranch: "master", baseSha: "base", worktree: { path: "." } };
  const repository = { repo: "owner/repo" };
  assert.equal(implementationPullRequest(runtime, repository, []), null);
  assert.throws(() => implementationPullRequest(runtime, repository, [{}, {}]), /multiple open pull requests/);
  assert.throws(() => implementationPullRequest(runtime, repository, [{}]), /does not connect the pinned base/);
});

test("activity wait returns control when its agent disappears", () => {
  assert.equal(waitForActivity("worker", () => { const error = new Error(); error.herdrCode = "agent_not_running"; throw error; }), null);
  assert.throws(() => waitForActivity("worker", () => { throw new Error("offline"); }), /offline/);
});

test("refuses local, path, Git worktree, and Herdr collisions", () => {
  const base = { branch: "codex/issue-1-a", path: "C:\\Code\\.worktrees\\repo\\issue-1-a", gitWorktrees: [], herdrWorktrees: [] };
  assert.match(collisionReason({ ...base, branchExists: true, pathExists: false }), /local branch/);
  assert.match(collisionReason({ ...base, branchExists: false, pathExists: true }), /path already exists/);
  assert.match(collisionReason({ ...base, branchExists: false, pathExists: false, gitWorktrees: [{ path: base.path }] }), /Git worktree/);
  assert.match(collisionReason({ ...base, branchExists: false, pathExists: false, herdrWorktrees: [{ path: "C:\\other", branch: base.branch }] }), /Herdr/);
  assert.equal(collisionReason({ ...base, branchExists: false, pathExists: false }), "");
});

test("controller lifecycle has explicit failure and cancellation terminals", () => {
  const cancelled = new Lifecycle();
  assert.equal(cancelled.transition("cancel"), "CANCELLED");

  const failed = new Lifecycle();
  failed.transition("submit");
  assert.equal(failed.transition("fail"), "FAILED");

  const complete = new Lifecycle();
  complete.transition("submit");
  complete.transition("provisioned");
  assert.equal(complete.transition("complete"), "COMPLETE");
  assert.throws(() => complete.transition("fail"), /invalid controller transition/);
});

test("two pipe identities carry independent invocation messages", async (t) => {
  const firstPipe = makePipeName();
  const secondPipe = makePipeName();
  assert.notEqual(firstPipe, secondPipe);
  const received = [[], []];
  const first = await createPipeServer(firstPipe, { message(message) { received[0].push(message); return {}; } });
  const second = await createPipeServer(secondPipe, { message(message) { received[1].push(message); return {}; } });
  t.after(() => { first.close(); second.close(); });

  const [firstClient, secondClient] = await Promise.all([connectPipe(firstPipe), connectPipe(secondPipe)]);
  await Promise.all([
    firstClient.request({ type: "status" }),
    secondClient.request({ type: "status" }),
  ]);
  firstClient.socket.end(); secondClient.socket.end();
  assert.deepEqual(received, [
    [{ type: "status" }],
    [{ type: "status" }],
  ]);
});

test("pipe server consumes repeated server errors after listening", async (t) => {
  const server = await createPipeServer(makePipeName(), { message() { return {}; } });
  t.after(() => server.close());
  assert.doesNotThrow(() => {
    server.emit("error", new Error("first late server error"));
    server.emit("error", new Error("second late server error"));
  });
});

test("pipe shutdown flushes accepted replies before closing", async (t) => {
  let releaseShutdown;
  const shutdown = new Promise((resolve) => { releaseShutdown = resolve; });
  const server = await createPipeServer(makePipeName(), { message() { releaseShutdown(); return {}; } });
  const client = await connectPipe(server.address());
  t.after(() => { client.socket.destroy(); if (server.listening) server.close(); });
  const closed = new Promise((resolve) => client.socket.once("close", resolve));
  const reply = client.request({ type: "cancel" });
  await shutdown;
  await server.shutdown();
  assert.equal((await reply).ok, true);
  await closed;
  assert.equal(client.socket.destroyed, true);
});

test("popup connection lifetime exposes close-before-submit cancellation", async (t) => {
  const pipe = makePipeName();
  let disconnected;
  const closed = new Promise((resolve) => { disconnected = resolve; });
  const server = await createPipeServer(pipe, {
    message(message, connection) {
      if (message.type === "hello") connection.popup = true;
      return {};
    },
    disconnect(connection) {
      if (connection.popup) disconnected();
    },
  });
  t.after(() => server.close());
  const client = await connectPipe(pipe);
  assert.equal((await client.request({ type: "hello" })).ok, true);
  client.socket.end();
  await closed;
});

test("pipe close rejects an unanswered request", async (t) => {
  const pipe = makePipeName();
  const server = net.createServer((socket) => socket.once("data", () => socket.destroy()));
  await new Promise((resolve) => server.listen(pipe, resolve));
  t.after(() => server.close());
  const client = await connectPipe(pipe);
  await assert.rejects(client.request({ type: "phase", phase: "planning" }), /controller pipe closed/);
});
