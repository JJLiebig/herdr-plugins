"use strict";

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto"), net = require("node:net");
const { spawn } = require("node:child_process");
const { WORKTREE_ROOT, normalizePath, parseGitHubRemote, parseSameRepositoryPullRequest, parseWorktreeList } = require("./workflow.js");
const { DEFAULT_HARNESS, getHarness, sessionMatches: harnessSessionMatches } = require("./harnesses.js");

const TERMINAL_STATES = new Set(["complete", "failed", "cancelled"]);
const WORKFLOW_KINDS = new Set(["issue", "pr", "task"]);

class CleanupStop extends Error {}

function writeWorkflowIdentity(gitDir, identity) {
  const target = path.join(gitDir, "herdr-codex-workflow.json");
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(identity));
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function readWorkflowIdentity(gitDir) {
  try { return JSON.parse(fs.readFileSync(path.join(gitDir, "herdr-codex-workflow.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function recoveredWorkspace(workspace, identity, controllerAlive) {
  const restored = { ...workspace, tokens: {
    ...identity,
    workflow_state: controllerAlive ? "RUNNING" : "cancelled",
    workflow_controller: controllerAlive ? "active" : "inactive",
    workflow_cleanup: "manual",
  } };
  manualWorkspace(restored, [], getHarness(identity.workflow_harness) || getHarness(DEFAULT_HARNESS));
  return restored;
}

function safeReason(error, fallback) {
  return error instanceof CleanupStop ? error.message : fallback;
}

function validatePayload(value) {
  const harness = getHarness(value?.harness) || getHarness(DEFAULT_HARNESS);
  if (!value || value.version !== 1 || !WORKFLOW_KINDS.has(value.workflow)
    || !value.workspaceId || !value.rootPaneId || !value.worktreePath || !value.repoRoot
    || !/^[^/\s]+\/[^/\s]+$/.test(value.repo) || !/^(?:codex\/|auto-)(?:issue|pr|review-pr|task)-/.test(value.branch) || !harness.sessionValue(value.sessionId)
    || (value.prNumber !== null && (!Number.isSafeInteger(value.prNumber) || value.prNumber < 1))) {
    throw new Error("invalid cleanup watcher payload");
  }
  return Object.freeze({ ...value, repo: value.repo.toLowerCase(), harness: harness.kind });
}

function encodePayload(value) {
  return Buffer.from(JSON.stringify(validatePayload(value))).toString("base64url");
}

function decodePayload(value) {
  try { return validatePayload(JSON.parse(Buffer.from(value, "base64url").toString("utf8"))); }
  catch { throw new Error("invalid cleanup watcher payload"); }
}

function associatedPr(workflow, report, originalNumber, repo) {
  if (workflow === "pr") {
    if (!Number.isSafeInteger(originalNumber) || originalNumber < 1) throw new Error("pull-request number is missing");
    return originalNumber;
  }
  return parseSameRepositoryPullRequest(report?.["pr-url"], repo).number;
}

function matchingSession(agents, workspaceId, rootPaneId, harness = getHarness(DEFAULT_HARNESS)) {
  const matches = agents.filter((agent) => agent.workspace_id === workspaceId
    && (!rootPaneId || agent.pane_id === rootPaneId)
    && harnessSessionMatches(harness, agent.agent_session));
  if (matches.length !== 1) throw new CleanupStop(`expected one owning ${harness.label} session; found ${matches.length}`);
  return matches[0];
}

function matchingOwnedSession(agents, workspaceId, rootPaneId, sessionId, harness = getHarness(DEFAULT_HARNESS)) {
  const agent = matchingSession(agents, workspaceId, rootPaneId, harness);
  if (!harness.sessionValue(sessionId) || agent.agent_session.value.toLowerCase() !== sessionId.toLowerCase()) throw new CleanupStop(`owning ${harness.label} session changed`);
  if (!["idle", "done"].includes(agent.agent_status)) {
    const error = new CleanupStop(`owning ${harness.label} session is still active`);
    error.retryable = true;
    throw error;
  }
  return agent;
}

function manualWorkspace(workspace, agents = [], harness = getHarness(DEFAULT_HARNESS)) {
  const worktree = workspace?.worktree;
  let tokens = workspace?.tokens || {};
  const running = tokens.workflow_state === "RUNNING";
  if (running && (!tokens.workflow_root_pane || !harness.sessionValue(tokens.workflow_session))) {
    const owner = matchingSession(agents, workspace.workspace_id, tokens.workflow_root_pane, harness);
    tokens = { ...tokens, workflow_root_pane: owner.pane_id, workflow_session: owner.agent_session.value };
  }
  if (!worktree?.is_linked_worktree || (!TERMINAL_STATES.has(tokens.workflow_state) && !running)
    || !WORKFLOW_KINDS.has(tokens.workflow_kind) || !tokens.workflow_root_pane
    || !harness.sessionValue(tokens.workflow_session)) throw new CleanupStop("This workspace has no managed workflow to clean up.");
  if (tokens.workflow_controller !== (running ? "active" : "inactive")) throw new CleanupStop("workflow controller state is inconsistent");
  if (running && !String(tokens.workflow_controller_pipe || "").startsWith("\\\\.\\pipe\\herdr-codex-workflows-")) {
    throw new CleanupStop("active workflow does not support coordinated cleanup");
  }
  return { worktree, tokens };
}

function classifyPullRequest(value) {
  if (value?.state === "OPEN" && !value.mergedAt) return "open";
  if (value?.state === "MERGED" && value.mergedAt) return "merged";
  if (value?.state === "CLOSED" && !value.mergedAt) return "closed";
  return "retry";
}

function assertLocalIdentity(payload, snapshot, allowOwner = false, allowRunning = false, allowDirty = false) {
  const workspace = snapshot.workspace;
  if (!workspace) return false;
  const worktree = workspace.worktree, tokens = workspace.tokens || {};
  const harness = getHarness(tokens.workflow_harness) || getHarness(payload.harness) || getHarness(DEFAULT_HARNESS);
  if (workspace.workspace_id !== payload.workspaceId || !worktree?.is_linked_worktree
    || normalizePath(worktree.checkout_path) !== normalizePath(payload.worktreePath)
    || normalizePath(worktree.repo_root) !== normalizePath(payload.repoRoot)) throw new CleanupStop("workspace identity changed");
  const lifecycleMatches = (TERMINAL_STATES.has(tokens.workflow_state) && tokens.workflow_controller === "inactive")
    || (allowRunning && tokens.workflow_state === "RUNNING" && tokens.workflow_controller === "active");
  const rootMatches = tokens.workflow_root_pane ? tokens.workflow_root_pane === payload.rootPaneId : allowRunning;
  const sessionMatches = tokens.workflow_session ? String(tokens.workflow_session).toLowerCase() === payload.sessionId.toLowerCase() : allowRunning;
  if (!lifecycleMatches || tokens.workflow_kind !== payload.workflow || harness.kind !== payload.harness
    || tokens.workflow_branch !== payload.branch || !rootMatches || !sessionMatches) {
    throw new CleanupStop("workflow cleanup metadata changed");
  }
  const rootAgents = snapshot.agents.filter((agent) => agent.workspace_id === payload.workspaceId && agent.pane_id === payload.rootPaneId);
  if (rootAgents.length) {
    if (!allowOwner) throw new CleanupStop("root pane agent changed after session archive");
    matchingOwnedSession(rootAgents, payload.workspaceId, payload.rootPaneId, payload.sessionId, harness);
  }
  if (snapshot.agents.some((agent) => agent.workspace_id === payload.workspaceId
    && agent.pane_id !== payload.rootPaneId && !["idle", "done"].includes(agent.agent_status))) {
    throw new CleanupStop("workflow workspace has an active sibling agent");
  }
  const repoName = payload.repo.split("/")[1];
  const expectedRoot = normalizePath(path.join(WORKTREE_ROOT, repoName));
  if (!normalizePath(payload.worktreePath).startsWith(`${expectedRoot}${path.sep}`)) throw new CleanupStop("workflow worktree is outside the managed root");
  if (snapshot.orphaned) return true;
  if (snapshot.repo !== payload.repo) throw new CleanupStop("Git identity changed");
  if (snapshot.status && !allowDirty) {
    const error = new CleanupStop("workflow worktree has uncommitted changes");
    error.dirty = true;
    throw error;
  }
  // The checkout may have been repurposed onto another branch after the workflow
  // finished. The recorded workspace identity and the linked-worktree path prove
  // ownership; a clean checkout is safe to remove because its branch survives.
  const mapping = parseWorktreeList(snapshot.worktrees).filter((item) => normalizePath(item.path) === normalizePath(payload.worktreePath));
  if (mapping.length !== 1) throw new CleanupStop("Git worktree mapping changed");
  return true;
}

async function snapshot(payload, ops) {
  const workspace = await ops.workspace(payload.workspaceId);
  if (!workspace) return { workspace: null };
  const agents = await ops.agents();
  try {
    const repo = parseGitHubRemote(await ops.git(payload.worktreePath, ["remote", "get-url", "origin"]));
    const branch = await ops.git(payload.worktreePath, ["branch", "--show-current"]);
    const status = await ops.git(payload.worktreePath, ["status", "--porcelain"]);
    const worktrees = await ops.git(payload.repoRoot, ["worktree", "list", "--porcelain"]);
    return { workspace, repo, branch, status, worktrees, agents };
  } catch {
    // The checkout was pruned or removed. Herdr metadata still proves ownership,
    // so cleanup proceeds without Git identity checks and clears the leftovers.
    return { workspace, orphaned: true, agents };
  }
}

async function preflight(payload, ops, allowOwner = false, allowRunning = false, allowDirty = false) {
  payload = validatePayload(payload);
  return assertLocalIdentity(payload, await snapshot(payload, ops), allowOwner, allowRunning, allowDirty);
}

async function withCleanupClaim(payload, callback) {
  payload = validatePayload(payload);
  const key = crypto.createHash("sha256").update(`${payload.workspaceId}\0${normalizePath(payload.worktreePath)}`).digest("hex").slice(0, 32);
  const server = net.createServer((socket) => socket.destroy());
  server.on("error", () => {});
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(`\\\\.\\pipe\\herdr-codex-cleanup-${key}`, resolve);
    });
  } catch (error) {
    if (error.code === "EADDRINUSE") return { status: "busy", reason: "Another cleanup transaction is already running." };
    return { status: "stopped", reason: "Cleanup ownership could not be established; the workspace was retained." };
  }
  try { return await callback(); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function cleanupTransaction(payload, ops, claimed = false) {
  payload = validatePayload(payload);
  if (!claimed) return withCleanupClaim(payload, () => cleanupTransaction(payload, ops, true));
  const abandon = typeof ops.abandon === "function";
  const force = ops.force === true;
  try {
    await ops.progress?.(0);
    if (!await preflight(payload, ops, true, abandon, force)) return { status: "missing" };
  } catch (error) {
    if (error.dirty) return { status: "dirty", reason: safeReason(error, "workflow worktree has uncommitted changes") };
    if (error.retryable) return { status: "retry", reason: safeReason(error, "Owning agent session is still active.") };
    return { status: "stopped", reason: safeReason(error, "Cleanup preflight failed; the workspace was retained.") };
  }
  try {
    await ops.progress?.(1);
    if (abandon) await ops.abandon();
    await ops.release(payload.workspaceId, payload.rootPaneId, payload.sessionId, payload.worktreePath);
  } catch (error) {
    if (error.retryable) return { status: "retry", reason: safeReason(error, "Owning agent session is still active.") };
    return { status: "stopped", reason: "Agent session release failed; the workspace and worktree were retained." };
  }
  try {
    await ops.progress?.(2);
    await ops.archive(payload.sessionId);
  } catch {
    return { status: "stopped", reason: "Agent session archive failed; the worktree was not removed." };
  }
  try {
    await ops.progress?.(3);
    const after = await snapshot(payload, ops);
    if (!assertLocalIdentity(payload, after, false, false, force)) throw new CleanupStop("workspace disappeared after session archive");
  } catch (error) {
    return { status: "partial", reason: safeReason(error, "Post-archive validation failed; the worktree was retained.") };
  }
  try { await ops.progress?.(4); await ops.remove(payload.workspaceId); }
  catch { return { status: "partial", reason: "Herdr could not remove the worktree after session archive; manual inspection is required." }; }
  return { status: "removed" };
}

async function handoffWatcher(controller, payload, authorize, options = {}) {
  payload = validatePayload(payload);
  if (payload.prNumber === null) throw new Error("cleanup watcher has no pull request");
  const child = (options.spawn || spawn)(process.execPath, [path.resolve(controller), "watch", encodePayload(payload)], {
    shell: false, detached: true, windowsHide: true, cwd: path.parse(path.resolve(payload.worktreePath)).root,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("cleanup watcher did not arm")), options.timeout || 10000);
      const finish = (callback) => (value) => { clearTimeout(timer); callback(value); };
      child.once("message", finish((message) => message?.type === "armed" ? resolve() : reject(new Error("cleanup watcher sent an invalid acknowledgement"))));
      child.once("error", finish(reject));
      child.once("exit", finish((code) => reject(new Error(`cleanup watcher exited before arming (${code})`))));
    });
    await authorize();
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    if (child.connected) child.disconnect();
    child.unref();
  }
}

async function watch(payload, ops, interval = 60000) {
  payload = validatePayload(payload);
  if (payload.prNumber === null) throw new Error("cleanup watcher has no pull request");
  if (payload.indicatorOnly) {
    while (true) {
      try {
        const workspace = await ops.workspace(payload.workspaceId);
        if (!workspace || workspace.tokens?.workflow_branch !== payload.branch) return "superseded";
        const state = classifyPullRequest(await ops.pullRequest(payload.repo, payload.prNumber));
        if (state === "merged") { await ops.merged(workspace); return "merged"; }
        if (state === "closed") return "closed";
      } catch { /* Retry transient workspace/GitHub failures without touching the session. */ }
      await ops.delay(interval);
    }
  }
  const harness = getHarness(payload.harness) || getHarness(DEFAULT_HARNESS);
  const label = harness.label;
  try {
    if (!await preflight(payload, ops, true)) return "superseded";
  } catch (error) {
    if (!error.retryable) {
      await ops.project("stopped"); await ops.notify(`${label} workflow cleanup stopped`, safeReason(error, "Cleanup preflight failed; the workspace was retained."));
      return "stopped";
    }
  }
  while (true) {
    try {
      const workspace = await ops.workspace(payload.workspaceId);
      if (!workspace || workspace.tokens?.workflow_cleanup !== "waiting") return "superseded";
    } catch { await ops.delay(interval); continue; }
    let state;
    try { state = classifyPullRequest(await ops.pullRequest(payload.repo, payload.prNumber)); }
    catch { state = "retry"; }
    if (state === "open" || state === "retry") { await ops.delay(interval); continue; }
    if (state === "closed") { await ops.project("retained"); await ops.notify(`${label} workflow retained`, "Pull request closed without merge; workspace and branch remain."); return "retained"; }
    const result = await ops.cleanup();
    if (result.status === "busy") { await ops.delay(interval); continue; }
    if (result.status === "retry") { await ops.delay(interval); continue; }
    if (result.status === "missing") return "superseded";
    if (result.status === "removed") {
      const archived = harness.archiveArgs ? `Archived its ${label} session and removed` : "Removed";
      await ops.notify(`${label} workflow cleaned up`, `${archived} the worktree; branch ${payload.branch} remains.`);
      return "removed";
    }
    await ops.project(result.status);
    await ops.notify(result.status === "partial" ? `${label} workflow partially cleaned up` : `${label} workflow cleanup stopped`, result.reason);
    return result.status;
  }
}

module.exports = {
  readWorkflowIdentity, writeWorkflowIdentity, recoveredWorkspace,
  associatedPr, classifyPullRequest, cleanupTransaction, decodePayload, encodePayload,
  handoffWatcher, manualWorkspace, matchingOwnedSession, matchingSession, watch, withCleanupClaim,
};
