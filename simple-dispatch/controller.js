#!/usr/bin/env node
"use strict";

const fs = require("node:fs"), crypto = require("node:crypto");
const path = require("node:path"), readline = require("node:readline");
const readlinePromises = require("node:readline/promises"), { spawn, spawnSync } = require("node:child_process");
const { stdin: input, stdout: output } = require("node:process");
const {
  associatedPr, cleanupTransaction, decodePayload, handoffWatcher, manualWorkspace, matchingOwnedSession, matchingSession, watch, withCleanupClaim,
  readWorkflowIdentity, writeWorkflowIdentity, recoveredWorkspace,
} = require("./cleanup.js");
const { DEFAULT_HARNESS, getHarness, harnessList, normalizeHarness } = require("./harnesses.js");
const {
  Lifecycle, WORKTREE_ROOT, collisionReason, connectPipe, createPipeServer, makeIdentity,
  makePipeName, parseGitHubRemote, parseTarget, parseWorktreeList,
} = require("./workflow.js");

const PLUGIN_ID = "jjliebig.simple-dispatch";
const METADATA_SOURCE = `plugin:${PLUGIN_ID}`;
const herdr = process.env.HERDR_BIN_PATH || "herdr", gitBin = process.env.GIT_BIN_PATH || "git";
const gh = process.env.GH_BIN_PATH || "gh";
const CODE_ROOT = path.dirname(WORKTREE_ROOT);
const launchSteps = ["Resolve repository", "Prepare request", "Create worktree", "Start agent"];
const cleanupSteps = ["Check workspace", "Stop agent", "Finalize session", "Check worktree", "Remove worktree"];
function readJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
function readPluginConfig(configDir = process.env.HERDR_PLUGIN_CONFIG_DIR) {
  if (!configDir) return {};
  try {
    const value = readJson(fs.readFileSync(path.join(configDir, "config.json"), "utf8"), {});
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
function autoCleanupOnPrMerge(configDir = process.env.HERDR_PLUGIN_CONFIG_DIR) {
  return readPluginConfig(configDir)["auto-cleanup-on-pr-merge"] === true;
}
function readPluginState(configDir = process.env.HERDR_PLUGIN_CONFIG_DIR) {
  if (!configDir) return {};
  try {
    const value = readJson(fs.readFileSync(path.join(configDir, "state.json"), "utf8"), {});
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
function writePluginState(patch, configDir = process.env.HERDR_PLUGIN_CONFIG_DIR) {
  if (!configDir) return;
  const target = path.join(configDir, "state.json");
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ ...readPluginState(configDir), ...patch }));
    fs.renameSync(temporary, target);
  } catch {
    // Remembering the last harness is best effort.
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* best effort */ }
  }
}
function installedIntegrations(run = runHerdr, warn = (message) => console.error(message)) {
  try {
    const installed = new Set();
    let parsed = 0;
    for (const line of String(run(["integration", "status"])).split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z0-9_-]+):\s+(.+)$/);
      if (!match) continue;
      parsed += 1;
      if (!/^not installed\b/i.test(match[2])) installed.add(match[1].toLowerCase());
    }
    if (!parsed) {
      warn("could not read `herdr integration status`; offering every harness");
      return null;
    }
    return installed;
  } catch (error) {
    warn(`could not read \`herdr integration status\` (${error.message}); offering every harness`);
    return null;
  }
}
function configuredHarnesses() {
  return harnessList(installedIntegrations());
}
function defaultHarnessKind(configDir = process.env.HERDR_PLUGIN_CONFIG_DIR) {
  const remembered = readPluginState(configDir)["last-harness"];
  const configured = readPluginConfig(configDir)["default-harness"];
  return (remembered && normalizeHarness(remembered)) || (configured && normalizeHarness(configured)) || DEFAULT_HARNESS;
}
function execute(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const detail = compact(result.stderr) || compact(result.stdout) || result.error?.message || `exit ${result.status}`;
    const error = new Error(`${command} ${args.join(" ")} failed: ${detail}`);
    error.herdrCode = readJson(detail)?.error?.code;
    throw error;
  }
  return result.stdout.trim();
}
function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
function preserveLines(value) {
  return String(value || "").replace(/\r\n?/g, "\n").trim();
}
function isImplementationWorkflow(workflow) {
  return workflow !== "pr";
}
function succeeds(command, args) {
  const result = spawnSync(command, args, { stdio: "ignore", windowsHide: true });
  return !result.error && result.status === 0;
}
function runJson(command, args) {
  const stdout = execute(command, args);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${command} returned non-JSON output`);
  }
}
function runHerdr(args) {
  return execute(herdr, args);
}
function runHerdrJson(args) {
  return runJson(herdr, args);
}

function runCanonicalCodex(args) {
  return execute(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "codex", ...args]);
}

function runHarness(harness, args) {
  const override = process.env[harness.envBin];
  if (override) return execute(override, args);
  return execute(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", harness.binary, ...args]);
}

function advertisesAutoAccount(readHelp = () => runCanonicalCodex(["--help"])) {
  try {
    return /(?:^|\s)--auto-account(?=\s|$)/m.test(readHelp());
  } catch {
    return false;
  }
}

function harnessStartArgs(harness, agentName, paneId, readHelp) {
  const options = {};
  if (harness.supportsAutoAccount) options.autoAccount = advertisesAutoAccount(readHelp);
  return harness.startArgs(agentName, paneId, options);
}

function codexAgentStartArgs(agentName, paneId, readHelp) {
  return harnessStartArgs(getHarness("codex"), agentName, paneId, readHelp);
}

function isAgentPromptStalled(stderr) {
  return /"code"\s*:\s*"agent_prompt_stalled"/.test(stderr);
}

function stalledPromptRecovery(status) {
  if (["idle", "done"].includes(status)) return "submit";
  if (["working", "blocked"].includes(status)) return "started";
  return "failed";
}

function stalledPromptRecoveryCommands(agentName) {
  return [
    ["agent", "send-keys", agentName, "enter"],
    ["agent", "wait", agentName, "--until", "working", "--until", "blocked", "--timeout", "5000"],
  ];
}

function git(cwd, args) {
  return execute(gitBin, ["-C", cwd, ...args]);
}

function fetchPinned(repository, remoteRef) {
  const temporaryRef = `refs/codex-workflows/${crypto.randomUUID()}`;
  try {
    git(repository.root, ["fetch", "--no-tags", "origin", `+${remoteRef}:${temporaryRef}`]);
    return git(repository.root, ["rev-parse", `${temporaryRef}^{commit}`]);
  } finally {
    succeeds(gitBin, ["-C", repository.root, "update-ref", "-d", temporaryRef]);
  }
}

function notify(title, body, sound = "request") {
  try {
    runHerdr(["notification", "show", title, "--body", compact(body).slice(0, 240), "--sound", sound]);
  } catch (error) {
    console.error(error.message);
  }
}

function canonicalRepositoryRoot(checkoutRoot, commonDirectory) {
  const commonRoot = path.resolve(checkoutRoot, commonDirectory);
  return path.basename(commonRoot) === ".git" ? path.dirname(commonRoot) : path.resolve(checkoutRoot);
}

function repositoryAt(root) {
  root = git(root, ["rev-parse", "--show-toplevel"]);
  root = canonicalRepositoryRoot(root, git(root, ["rev-parse", "--git-common-dir"]));
  const repo = parseGitHubRemote(git(root, ["remote", "get-url", "origin"]));
  return { root: path.resolve(root), repo, repoName: repo.split("/").pop() };
}

function sourceDirectory(context) {
  return context.focused_pane_cwd || context.worktree?.repo_root || context.worktree?.checkout_path || context.workspace_cwd;
}

function sourceRepository(context) {
  const cwd = sourceDirectory(context);
  if (!cwd) throw new Error("the action did not receive a workspace checkout");
  return repositoryAt(cwd);
}

function resolveRepository(target, current, operations = {}) {
  if (target.repo === current.repo) return current;
  const exists = operations.exists || fs.existsSync;
  const identify = operations.identify || repositoryAt;
  const codeRoot = operations.codeRoot || CODE_ROOT;
  const clone = operations.clone || ((repo, root) => {
    fs.mkdirSync(path.dirname(root), { recursive: true });
    execute(gh, ["repo", "clone", repo, root]);
  });
  const [owner, name] = target.repo.split("/");
  const familiar = path.join(codeRoot, name);
  if (exists(familiar)) {
    try {
      const repository = identify(familiar);
      if (repository.repo === target.repo) return repository;
    } catch {}
  }
  const root = path.join(codeRoot, owner, name);
  if (!exists(root)) clone(target.repo, root);
  const repository = identify(root);
  if (repository.repo !== target.repo) throw new Error(`repository path ${root} belongs to ${repository.repo}, not ${target.repo}`);
  return repository;
}

function requireGitHubAuth() {
  execute(gh, ["auth", "status", "--hostname", "github.com"]);
}

function implementationBase(repository) {
  const data = readJson(execute(gh, ["repo", "view", repository.repo, "--json", "nameWithOwner,defaultBranchRef"]));
  if (!data?.defaultBranchRef?.name || String(data.nameWithOwner || "").toLowerCase() !== repository.repo) {
    throw new Error("GitHub did not return the expected repository default branch");
  }
  return {
    baseBranch: data.defaultBranchRef.name,
    baseSha: fetchPinned(repository, `refs/heads/${data.defaultBranchRef.name}`),
  };
}

function completeGitHubTarget(target, data) {
  if (Number(data?.number) !== target.number || !data?.html_url) throw new Error("GitHub did not return the requested issue or pull request");
  return { ...target, type: data.pull_request ? "pr" : "issue", url: data.html_url };
}

function checksSummary(rollup) {
  const summary = { passing: 0, pending: 0, failing: 0 };
  for (const check of Array.isArray(rollup) ? rollup : []) {
    const state = String(check?.state || "").toUpperCase();
    const status = String(check?.status || "").toUpperCase();
    const conclusion = String(check?.conclusion || "").toUpperCase();
    if (state && !status) {
      if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(state)) summary.passing += 1;
      else if (["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS"].includes(state)) summary.pending += 1;
      else summary.failing += 1;
    } else if (status !== "COMPLETED") {
      summary.pending += 1;
    } else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) {
      summary.passing += 1;
    } else {
      summary.failing += 1;
    }
  }
  return summary;
}

function pullRequestReadiness(data) {
  return {
    mergeable: data.mergeable || null,
    mergeStateStatus: data.mergeStateStatus || null,
    reviewDecision: data.reviewDecision || null,
    checks: checksSummary(data.statusCheckRollup),
  };
}

function pullRequest(repository, number) {
  const data = readJson(execute(gh, [
    "pr", "view", String(number), "--repo", repository.repo,
    "--json", "number,url,baseRefName,baseRefOid,headRefOid,headRefName,headRepository,isCrossRepository,maintainerCanModify,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision",
  ]));
  if (!data?.headRefOid || !data?.baseRefOid || !data?.headRefName || Number(data.number) !== number) {
    throw new Error("GitHub did not return exact pull-request identities");
  }
  const fetchedBase = fetchPinned(repository, data.baseRefOid);
  if (fetchedBase.toLowerCase() !== data.baseRefOid.toLowerCase()) throw new Error(`fetched pull-request base ${fetchedBase} does not match ${data.baseRefOid}`);
  const fetched = fetchPinned(repository, `refs/pull/${number}/head`);
  if (fetched.toLowerCase() !== data.headRefOid.toLowerCase()) {
    throw new Error(`fetched pull-request head ${fetched} does not match ${data.headRefOid}`);
  }
  return {
    prNumber: number,
    prUrl: data.url,
    baseBranch: data.baseRefName,
    baseSha: data.baseRefOid,
    headSha: data.headRefOid,
    headRefName: data.headRefName,
    headRepository: data.headRepository?.nameWithOwner || null,
    crossRepository: data.isCrossRepository === true,
    maintainerCanModify: data.maintainerCanModify === true,
    readiness: pullRequestReadiness(data),
  };
}
function assertNoCollision(repository, branch, worktree) {
  const herdrWorktrees = runHerdrJson(["worktree", "list", "--cwd", repository.root])?.result?.worktrees || [];
  const reason = collisionReason({
    branch,
    path: worktree,
    branchExists: succeeds(gitBin, ["-C", repository.root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]),
    pathExists: fs.existsSync(worktree),
    gitWorktrees: parseWorktreeList(git(repository.root, ["worktree", "list", "--porcelain"])),
    herdrWorktrees,
  });
  if (reason) throw new Error(reason);
}

function createWorktree(repository, identity, baseSha) {
  const worktree = path.join(WORKTREE_ROOT, repository.repoName, identity.directory);
  assertNoCollision(repository, identity.branch, worktree);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  const result = runHerdrJson([
    "worktree", "create", "--cwd", repository.root,
    "--branch", identity.branch, "--base", baseSha, "--path", worktree,
    "--label", identity.shortLabel, "--no-focus",
  ])?.result;
  if (!result?.workspace?.workspace_id || !result?.root_pane?.pane_id || !result?.tab?.tab_id || !result?.worktree?.path) {
    throw new Error("Herdr worktree.create omitted workspace, tab, root pane, or worktree data");
  }
  return { ...result, path: worktree };
}

function saveWorkflowIdentity(runtime) {
  writeWorkflowIdentity(git(runtime.worktree.path, ["rev-parse", "--absolute-git-dir"]), {
    workflow_kind: runtime.workflow,
    workflow_harness: harnessKind(runtime),
    workflow_branch: runtime.identity.branch,
    workflow_root_pane: runtime.worktree.root_pane.pane_id,
    workflow_session: runtime.ownerSessionId,
    workflow_controller_pipe: runtime.controllerPipe,
  });
}

function captureWorkflowIdentity(runtime, save = saveWorkflowIdentity) {
  if (!runtime.ownerSessionId || runtime.identitySaved) return;
  try {
    save(runtime);
    runtime.identitySaved = true;
  } catch (error) {
    console.error(`workflow identity could not be saved: ${error.message}`);
  }
}

async function restoreWorkflowIdentity(workspace) {
  if (!workspace.worktree?.is_linked_worktree || workspace.tokens?.workflow_kind) return;
  let gitDir;
  try { gitDir = git(workspace.worktree.checkout_path, ["rev-parse", "--absolute-git-dir"]); }
  catch { return; }
  const identity = readWorkflowIdentity(gitDir);
  if (!identity) return;
  // Validate the stored identity before probing its controller pipe.
  recoveredWorkspace(workspace, identity, true);
  let controllerAlive = false;
  try {
    const client = await connectPipe(identity.workflow_controller_pipe);
    client.socket.end();
    controllerAlive = true;
  } catch (error) {
    if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
  }
  workspace.tokens = recoveredWorkspace(workspace, identity, controllerAlive).tokens;
  runHerdr(["workspace", "report-metadata", workspace.workspace_id, "--source", METADATA_SOURCE,
    ...Object.entries(workspace.tokens).flatMap(([key, value]) => ["--token", `${key}=${value}`])]);
}

function harnessLabel(runtime) {
  return runtime.harness?.label || "Codex";
}

function harnessKind(runtime) {
  return runtime.harness?.kind || DEFAULT_HARNESS;
}

const HARNESS_TITLE_TAGS = new Set(["codex", "opencode", "claude", "cursor", "copilot", "devin", "droid", "kimi", "kilo",
  "mastracode", "omp", "pi", "qwen", "qoder", "qodercli", "grok", "hermes", "antigravity", "agy", "oc", "cx"]);

function agentSessionTitle(agent, harness) {
  const raw = compact(agent?.terminal_title_stripped || agent?.terminal_title || "");
  if (!raw) return "";
  const isTag = (part) => /^[A-Z0-9]{1,4}$/.test(part)
    || part.toLowerCase() === (harness?.kind || "").toLowerCase()
    || part.toLowerCase() === (harness?.label || "").toLowerCase()
    || HARNESS_TITLE_TAGS.has(part.toLowerCase());
  const parts = raw.split("|").map((part) => part.trim()).filter(Boolean);
  while (parts.length > 1 && isTag(parts[0])) parts.shift();
  // Codex appends the working-directory name after a pipe; a trailing token with
  // no whitespace is decoration rather than part of the session title.
  while (parts.length > 1 && (isTag(parts[parts.length - 1]) || !/\s/.test(parts[parts.length - 1]))) parts.pop();
  const title = compact(parts.join(" | "));
  // Harnesses report a bare harness name or the working-directory name until a
  // real session title exists; never adopt those as the label.
  if (!title || isTag(title)
    || (agent?.name && title.toLowerCase() === String(agent.name).toLowerCase())
    || (agent?.cwd && title.toLowerCase() === path.basename(agent.cwd).toLowerCase())) return "";
  return [...title].length > 40 ? `${[...title].slice(0, 39).join("")}…` : title;
}

function displayLabel(runtime, agent) {
  // Only freefield workflows borrow the session title; issue and pull-request
  // workflows keep their meaningful identity label.
  if (runtime.workflow !== "task") return runtime.identity.shortLabel;
  const title = agentSessionTitle(agent, runtime.harness);
  if (title) runtime.label = title;
  return runtime.label || runtime.identity.shortLabel;
}

function project(runtime, state = "working", reason = "", operations = {}) {
  const phase = state === "waiting" ? "waiting" : "working";
  const text = state === "blocked" ? "working · blocked" : phase;
  const workspaceId = runtime.worktree.workspace.workspace_id;
  const paneId = runtime.worktree.root_pane.pane_id;
  let owner = null;
  try {
    owner = (operations.agent || getAgent)(runtime.identity.agentName);
    if (owner && !runtime.ownerSessionId) runtime.ownerSessionId = matchingSession([owner], workspaceId, paneId, runtime.harness).agent_session.value;
  } catch (error) {
    console.error(`session discovery pending: ${error.message}`);
  }
  const label = displayLabel(runtime, owner);
  captureWorkflowIdentity(runtime, operations.save);
  try {
    const report = operations.report || runHerdr;
    report(["workspace", "rename", workspaceId, `[${label}] ${text}`]);
    report([
      "workspace", "report-metadata", workspaceId, "--source", METADATA_SOURCE,
      "--token", `workflow_kind=${runtime.workflow}`,
      "--token", `workflow_harness=${harnessKind(runtime)}`,
      "--token", `workflow_state=${runtime.lifecycle.state}`,
      "--token", `workflow_phase=${phase}`,
      "--token", "workflow_controller=active",
      "--token", `workflow_branch=${runtime.identity.branch}`,
      "--token", `workflow_controller_pipe=${runtime.controllerPipe}`,
      ...(runtime.ownerSessionId ? ["--token", `workflow_root_pane=${paneId}`, "--token", `workflow_session=${runtime.ownerSessionId}`] : []),
    ]);
    report([
      "pane", "report-metadata", paneId, "--source", METADATA_SOURCE,
      "--display-agent", `${harnessLabel(runtime)} workflow`, "--title", `${label} parent`,
      "--state-label", `working=${text}`, "--state-label", `blocked=${compact(reason) || "needs input"}`,
      "--token", `workflow_phase=${phase}`,
    ]);
  } catch (error) {
    console.error(`metadata update failed: ${error.message}`);
  }
}

function projectTerminal(runtime, report, candidate = getAgent(runtime.identity.agentName)) {
  const workspaceId = runtime.worktree.workspace.workspace_id;
  const paneId = runtime.worktree.root_pane.pane_id;
  let owner = null;
  try { owner = candidate && matchingSession([candidate], workspaceId, paneId, runtime.harness); } catch {}
  if (owner && !runtime.ownerSessionId) runtime.ownerSessionId = owner.agent_session.value;
  const label = displayLabel(runtime, candidate || owner);
  captureWorkflowIdentity(runtime);
  const resultText = report.status === "complete" ? (isImplementationWorkflow(runtime.workflow) ? "complete · PR open" : "complete") : report.status;
  try {
    runHerdr(["workspace", "rename", workspaceId, `[${label}] ${resultText}`]);
    runHerdr([
      "workspace", "report-metadata", workspaceId, "--source", METADATA_SOURCE,
      "--token", `workflow_harness=${harnessKind(runtime)}`,
      "--token", `workflow_state=${report.status}`,
      "--token", `workflow_controller=${report.status === "complete" ? "active" : "inactive"}`,
      "--token", `workflow_phase=${resultText}`,
      ...(runtime.ownerSessionId ? ["--token", `workflow_root_pane=${paneId}`, "--token", `workflow_session=${runtime.ownerSessionId}`] : []),
    ]);
    runHerdr(["pane", "rename", paneId, `${label} ${harnessLabel(runtime)} parent`]);
  } catch (error) {
    console.error(`terminal metadata update failed: ${error.message}`);
  }
  const body = report.status === "complete" ? report["pr-url"] || resultText : report.reason;
  notify(`${harnessLabel(runtime)} workflow ${report.status}`, body, report.status === "complete" ? "done" : "request");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForShell(paneId, cwd) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const info = runHerdrJson(["pane", "process-info", "--pane", paneId])?.result?.process_info;
      if (info?.shell_pid
        && info.foreground_process_group_id === info.shell_pid
        && info.foreground_processes?.length === 1
        && info.foreground_processes[0].pid === info.shell_pid
        && (!cwd || path.resolve(info.foreground_processes[0].cwd || "").toLowerCase() === path.resolve(cwd).toLowerCase())) return;
    } catch {
      // New pane shells can take a moment to appear.
    }
    await delay(100);
  }
  throw new Error(`root pane ${paneId} did not reach an available shell`);
}

function promptOnce(agentName, prompt, onChild) {
  return new Promise((resolve) => {
    const child = spawn(herdr, ["agent", "prompt", agentName, prompt, "--wait", "--until", "working", "--until", "blocked"], {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    onChild(child);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => resolve({ error }));
    child.once("close", (code) => {
      if (code === 0) return resolve({ ok: true });
      if (isAgentPromptStalled(stderr)) return resolve({ stalled: true });
      resolve({ error: new Error(compact(stderr) || `agent prompt exited ${code}`) });
    });
  });
}

function agentMatchesHarness(agent, harness) {
  if (!agent) return false;
  if (agent.agent_session?.source === harness.source) return true;
  const label = String(agent.agent || "").toLowerCase();
  return label === harness.kind || label === harness.label.toLowerCase();
}

function startParentAgent(runtime, agentName, paneId, run = runHerdr, lookup = getAgent, readHelp) {
  try {
    run(harnessStartArgs(runtime.harness, agentName, paneId, readHelp));
    return;
  } catch (error) {
    // `agent start` waits for interactive readiness. An agent that is already
    // busy before the wait observes it — Codex++ selecting an account with
    // --auto-account, or a prompt typed while startup is still settling — never
    // reports idle, so the wait times out although the agent is running. When
    // that agent is present in the pane, re-adopt it under the workflow name
    // instead of failing the whole launch.
    if (error.herdrCode !== "timeout") throw error;
    if (!agentMatchesHarness(lookup(paneId), runtime.harness)) throw error;
    try {
      run(["agent", "rename", paneId, agentName]);
    } catch {
      throw error;
    }
  }
}

async function startParent(runtime, prompt) {
  const paneId = runtime.worktree.root_pane.pane_id;
  const agentName = runtime.identity.agentName;
  await waitForShell(paneId);
  startParentAgent(runtime, agentName, paneId);
  runtime.prompt = { child: null, finished: false, error: null };
  // Give a freshly detected agent time to finish bringing up its integrations.
  await delay(1000);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (runtime.prompt.error) break;
    const result = await promptOnce(agentName, prompt, (child) => { runtime.prompt.child = child; });
    runtime.prompt.child = null;
    if (result.ok) { runtime.prompt.finished = true; return; }
    if (result.error) { runtime.prompt.error = result.error; runtime.prompt.finished = true; return; }
    try {
      const recovery = stalledPromptRecovery(getAgent(agentName)?.agent_status);
      if (recovery === "started") { runtime.prompt.finished = true; return; }
      if (recovery === "submit") {
        // The composer may hold the prompt; try to submit it and re-check before re-delivering.
        try { for (const args of stalledPromptRecoveryCommands(agentName)) runHerdr(args); } catch { /* the wait timed out */ }
        const settled = stalledPromptRecovery(getAgent(agentName)?.agent_status);
        if (settled === "started") { runtime.prompt.finished = true; return; }
        if (settled === "failed") {
          runtime.prompt.error = new Error(`${runtime.harness.label} did not report a usable state after the prompt`);
          runtime.prompt.finished = true;
          return;
        }
      } else {
        // Unknown state: re-delivering could submit the prompt twice.
        runtime.prompt.error = new Error(`${runtime.harness.label} did not report a usable state after the prompt`);
        runtime.prompt.finished = true;
        return;
      }
    } catch {
      // The agent could not be inspected; let the next attempt surface the failure.
    }
    if (attempt < 3) await delay(1000);
  }
  runtime.prompt.error = new Error(`${runtime.harness.label} did not accept the workflow prompt`);
  runtime.prompt.finished = true;
}

async function stopParent(runtime) {
  try {
    const agent = getAgent(runtime.identity.agentName);
    if (agent && !["idle", "done"].includes(agent.agent_status)) {
      runHerdr(["agent", "send-keys", runtime.identity.agentName, "ctrl+c"]);
      try { runHerdr(["agent", "wait", runtime.identity.agentName, "--until", "idle", "--until", "done", "--timeout", "30000"]); }
      catch {
        runHerdr(["agent", "send-keys", runtime.identity.agentName, "ctrl+c"]);
        try { runHerdr(["agent", "wait", runtime.identity.agentName, "--until", "idle", "--until", "done", "--timeout", "5000"]); }
        catch (error) {
          const remaining = getAgent(runtime.identity.agentName);
          if (remaining && !["idle", "done"].includes(remaining.agent_status)) throw error;
        }
      }
    }
  } finally {
    if (!runtime.prompt.finished && runtime.prompt.child) {
      const child = runtime.prompt.child;
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill(); await Promise.race([closed, delay(5000)]);
    }
  }
}

function getWorkspace(workspaceId) {
  try {
    return runHerdrJson(["workspace", "get", workspaceId])?.result?.workspace || null;
  } catch (error) {
    if (error.herdrCode === "workspace_not_found") return null;
    throw error;
  }
}

function getAgent(name) {
  try {
    return runHerdrJson(["agent", "get", name])?.result?.agent || null;
  } catch (error) {
    if (["agent_not_found", "pane_not_found"].includes(error.herdrCode)) return null;
    throw error;
  }
}

function waitForActivity(name, wait = runHerdrJson) {
  try {
    return wait(["agent", "wait", name, "--until", "working", "--until", "blocked", "--timeout", "1000"])?.result?.agent || null;
  } catch (error) {
    if (["timeout", "agent_not_running"].includes(error.herdrCode)) return null;
    throw error;
  }
}

function listAgents() {
  return runHerdrJson(["agent", "list"])?.result?.agents || [];
}

function projectCleanup(workspaceId, state, workflowState, owner) {
  if (!getWorkspace(workspaceId)) return;
  runHerdr([
    "workspace", "report-metadata", workspaceId, "--source", METADATA_SOURCE,
    "--token", "workflow_controller=inactive", "--token", `workflow_cleanup=${state}`,
    ...(workflowState ? ["--token", `workflow_state=${workflowState}`, "--token", `workflow_phase=${workflowState}`] : []),
    ...(owner ? ["--token", `workflow_root_pane=${owner.rootPaneId}`, "--token", `workflow_session=${owner.sessionId}`] : []),
  ]);
}

function cleanupOps(workspaceId, abandon, harness = getHarness(DEFAULT_HARNESS), force = false) {
  return {
    workspace: async (workspaceId) => getWorkspace(workspaceId),
    agents: async () => listAgents(),
    git: async (cwd, args) => git(cwd, args),
    force,
    pullRequest: async (repo, number) => readJson(execute(gh, ["pr", "view", String(number), "--repo", repo, "--json", "state,mergedAt"])),
    release: (workspaceId, paneId, sessionId, worktreePath) => releaseOwnedAgent(workspaceId, paneId, sessionId, worktreePath, harness, true),
    archive: async (sessionId) => {
      if (harness.archiveArgs) runHarness(harness, harness.archiveArgs(sessionId));
    },
    remove: async (workspaceId) => {
      const checkout = getWorkspace(workspaceId)?.worktree?.checkout_path;
      if (checkout && !succeeds(gitBin, ["-C", checkout, "rev-parse", "--git-dir"])) {
        // The Git registration was pruned after the workflow finished; close the
        // workspace and clear the leftover directory instead.
        const leftover = fs.existsSync(checkout) ? fs.readdirSync(checkout) : [];
        if (leftover.length) throw new Error(`worktree directory is not empty: ${checkout}`);
        runHerdr(["workspace", "close", workspaceId]);
        if (fs.existsSync(checkout)) fs.rmdirSync(checkout);
        return;
      }
      runHerdr(["worktree", "remove", "--workspace", workspaceId, ...(force ? ["--force"] : [])]);
    },
    cleanup: async () => (await cleanupCurrentWorkflow(workspaceId)).result,
    project: async (state) => projectCleanup(workspaceId, state),
    merged: async (workspace) => {
      const prefix = workspace.label.match(/^\[[^\]]+\]/)?.[0] || workspace.label;
      runHerdr(["workspace", "rename", workspaceId, `✓ ${prefix} merged`]);
      runHerdr(["workspace", "report-metadata", workspaceId, "--source", METADATA_SOURCE,
        "--token", "workflow_phase=merged", "--token", "workflow_pr_state=merged"]);
    },
    notify: async (title, body) => notify(title, body, / workflow cleaned up$/.test(title) ? "done" : "request"),
    delay,
    ...(abandon ? { abandon: async () => {
      await requestControllerCleanup(abandon);
    } } : {}),
  };
}

async function handoffCleanup(runtime, repository) {
  const workspaceId = runtime.worktree.workspace.workspace_id;
  const rootPaneId = runtime.worktree.root_pane.pane_id;
  const payload = {
    version: 1, workflow: runtime.workflow, harness: harnessKind(runtime), workspaceId, rootPaneId,
    worktreePath: runtime.worktree.path, repoRoot: repository.root, repo: repository.repo,
    branch: runtime.identity.branch, sessionId: runtime.ownerSessionId,
    prNumber: associatedPr(runtime.workflow, runtime.terminal, runtime.prNumber, repository.repo),
    indicatorOnly: !autoCleanupOnPrMerge(),
  };
  await handoffWatcher(__filename, payload, async () => {
    runHerdr([
      "workspace", "report-metadata", workspaceId, "--source", METADATA_SOURCE,
      "--token", "workflow_state=complete", "--token", "workflow_controller=inactive",
      "--token", `workflow_harness=${harnessKind(runtime)}`,
      "--token", `workflow_branch=${runtime.identity.branch}`, "--token", `workflow_cleanup=${payload.indicatorOnly ? "manual" : "waiting"}`,
    ]);
  });
  if (!payload.indicatorOnly) notify(`${harnessLabel(runtime)} workflow waiting for PR merge`, "The workspace will be cleaned up after this pull request merges.");
}

async function cleanupCurrentWorkflow(workspaceId, progress, confirm) {
  const workspace = getWorkspace(workspaceId);
  if (!workspace) return { result: { status: "missing" }, worktree: null, branch: null };
  await restoreWorkflowIdentity(workspace);
  const harness = getHarness(workspace.tokens?.workflow_harness) || getHarness(DEFAULT_HARNESS);
  const { worktree, tokens } = manualWorkspace(workspace, listAgents(), harness);
  const abandon = tokens.workflow_state === "RUNNING";
  // A checkout can be pruned after the workflow finishes. Herdr metadata still
  // owns the workspace, so use the main checkout for identity and let the
  // transaction clear the leftover directory.
  const orphaned = !succeeds(gitBin, ["-C", worktree.checkout_path, "rev-parse", "--git-dir"]);
  const branch = tokens.workflow_branch || (orphaned ? "" : git(worktree.checkout_path, ["branch", "--show-current"]));
  if (!branch) throw new Error("cleanup could not determine the workflow branch");
  let repo;
  try { repo = parseGitHubRemote(git(worktree.repo_root, ["remote", "get-url", "origin"])); }
  catch { throw new Error("cleanup could not determine the repository from the workspace checkout"); }
  const payload = {
    version: 1, workflow: tokens.workflow_kind, harness: harness.kind, workspaceId,
    rootPaneId: tokens.workflow_root_pane, worktreePath: worktree.checkout_path, repoRoot: worktree.repo_root,
    repo, branch, sessionId: tokens.workflow_session, prNumber: null,
  };
  const attempt = (force) => withCleanupClaim(payload, async () => {
    if (!abandon) projectCleanup(workspaceId, "manual");
    return cleanupTransaction(payload, {
      ...cleanupOps(workspaceId, abandon ? { ...payload, controllerPipe: tokens.workflow_controller_pipe } : null, harness, force),
      progress,
    }, true);
  });
  let result = await attempt(false);
  if (result.status === "dirty") {
    const approved = confirm ? await confirm("This workflow worktree has uncommitted changes.") : false;
    result = approved ? await attempt(true)
      : { status: "stopped", reason: "Cleanup cancelled; the worktree has uncommitted changes." };
  }
  return { result, worktree, branch, abandon, harness };
}

async function waitForAgentExit(paneId, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!getAgent(paneId)) return true;
    await delay(100);
  }
  return !getAgent(paneId);
}

async function releaseOwnedAgent(workspaceId, paneId, sessionId, worktreePath, harness = getHarness(DEFAULT_HARNESS), moveOut = false) {
  const agent = getAgent(paneId);
  if (agent) {
    matchingOwnedSession([agent], workspaceId, paneId, sessionId, harness);
    if (harness.quit.prompt) {
      runHerdr(["agent", "prompt", paneId, harness.quit.prompt]);
      await waitForAgentExit(paneId, 5000);
    }
    for (const key of harness.quit.keys || []) {
      if (!getAgent(paneId)) break;
      try { runHerdr(["agent", "send-keys", paneId, key]); } catch {}
      await waitForAgentExit(paneId, 1000);
    }
  }
  await waitForShell(paneId);
  if (moveOut) {
    // A worktree cannot be removed while a live shell is sitting inside it, so
    // cleanup moves the shell to the drive root and confirms the move before
    // Herdr deletes the checkout. Controller-only releases leave the shell
    // wherever the agent left it.
    const outsideCwd = path.parse(path.resolve(worktreePath)).root;
    runHerdr(["pane", "run", paneId, `cd ${outsideCwd}`]);
    await waitForShell(paneId, outsideCwd);
  }
}

async function requestControllerCleanup(owner) {
  const client = await connectPipe(owner.controllerPipe);
  let timer;
  try {
    const reply = await Promise.race([
      client.request({ type: "cleanup", rootPaneId: owner.rootPaneId, sessionId: owner.sessionId }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("workflow controller did not release cleanup ownership")), 30000); }),
    ]);
    if (!reply.ok) throw new Error(reply.error);
  } finally {
    clearTimeout(timer);
    client.socket.end();
  }
}

async function releaseParent(runtime) {
  return releaseOwnedAgent(runtime.worktree.workspace.workspace_id, runtime.worktree.root_pane.pane_id,
    runtime.ownerSessionId, runtime.worktree.path, runtime.harness);
}

function implementationPullRequest(runtime, repository, matches = readJson(execute(gh, [
    "pr", "list", "--repo", repository.repo, "--head", runtime.identity.branch, "--state", "open",
    "--json", "number,url,headRefOid,baseRefName,headRefName",
  ]), [])) {
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error(`${harnessLabel(runtime)} left multiple open pull requests for the workflow branch`);
  const pullRequest = matches[0];
  if (!pullRequest.headRefOid || pullRequest.baseRefName !== runtime.baseBranch || pullRequest.headRefName !== runtime.identity.branch
    || !succeeds(gitBin, ["-C", runtime.worktree.path, "merge-base", "--is-ancestor", runtime.baseSha, pullRequest.headRefOid])) {
    throw new Error("workflow pull request does not connect the pinned base to the workflow branch");
  }
  return pullRequest;
}

function trackedPullRequest(runtime, repository, matches = readJson(execute(gh, [
    "pr", "list", "--repo", repository.repo, "--head", runtime.identity.branch, "--state", "open",
    "--json", "number,url",
  ]), [])) {
  if (matches.length > 1) throw new Error(`${harnessLabel(runtime)} left multiple open pull requests for the workflow branch`);
  if (matches.length === 1) return matches[0];
  return runtime.prUrl ? { number: runtime.prNumber, url: runtime.prUrl } : null;
}

async function monitor(runtime, repository, operations = {}) {
  const workspace = operations.workspace || getWorkspace;
  const agentByName = operations.agent || getAgent;
  const findImplementationPullRequest = operations.implementationPullRequest || implementationPullRequest;
  const findTrackedPullRequest = operations.trackedPullRequest || trackedPullRequest;
  const updateProject = operations.project || project;
  const updateTerminal = operations.projectTerminal || projectTerminal;
  const activity = operations.activity || waitForActivity;
  const wait = operations.delay || delay;
  let lastProjection = "working", wasSettled = false;
  while (true) {
    if (runtime.cleanupRequest) return "cleanup";
    const currentWorkspace = workspace(runtime.worktree.workspace.workspace_id);
    if (!currentWorkspace) {
      runtime.terminal = { type: "terminal", status: "cancelled", reason: "workflow workspace was closed" };
    }
    const agent = agentByName(runtime.identity.agentName);
    const agentTitle = runtime.workflow === "task" && agent ? agentSessionTitle(agent, runtime.harness) : "";
    if (!runtime.terminal && agent?.agent_session && (!runtime.identitySaved || (agentTitle && agentTitle !== runtime.label))) updateProject(runtime, lastProjection);
    if (runtime.terminal) {
      runtime.lifecycle.transition("cancel");
      updateTerminal(runtime, runtime.terminal, agent);
      return;
    } else if (runtime.prompt?.error) {
      throw runtime.prompt.error;
    } else if (!agent) {
      throw new Error(`${harnessLabel(runtime)} parent exited before the workflow completed`);
    } else if (runtime.prompt?.finished && ["idle", "done"].includes(agent.agent_status)) {
        if (wasSettled) {
          const resumed = await activity(runtime.identity.agentName);
          await new Promise((resolve) => setImmediate(resolve));
          if (runtime.cleanupRequest) return "cleanup";
        if (resumed) {
          wasSettled = false;
          const projection = resumed.agent_status === "blocked" ? "blocked" : "working";
          if (projection !== lastProjection) updateProject(runtime, projection, `${harnessLabel(runtime)} needs input`);
          lastProjection = projection;
        }
        continue;
      }
      wasSettled = true;
      if (isImplementationWorkflow(runtime.workflow)) {
        const pullRequest = findImplementationPullRequest(runtime, repository);
        if (!pullRequest) {
          updateProject(runtime, "waiting");
          lastProjection = "waiting";
          continue;
        }
        runtime.prNumber = Number(pullRequest.number);
        runtime.terminal = { type: "terminal", status: "complete", "pr-url": pullRequest.url, "head-sha": pullRequest.headRefOid };
      } else {
        const pullRequest = findTrackedPullRequest(runtime, repository);
        if (!pullRequest) {
          updateProject(runtime, "waiting");
          lastProjection = "waiting";
          continue;
        }
        runtime.prNumber = Number(pullRequest.number);
        runtime.terminal = { type: "terminal", status: "complete", "pr-url": pullRequest.url };
      }
      runtime.lifecycle.transition("complete");
      updateTerminal(runtime, runtime.terminal, agent);
      return;
    } else {
      wasSettled = false;
      const projection = agent.agent_status === "blocked" ? "blocked" : "working";
      if (projection !== lastProjection) updateProject(runtime, projection, `${harnessLabel(runtime)} needs input`);
      lastProjection = projection;
    }
    await wait(1000);
  }
}

function progressView(launch, frame = 0) {
  const steps = launch.kind === "cleanup" ? cleanupSteps : launchSteps;
  const step = Math.max(0, Math.min(steps.length, Number(launch.step) || 0));
  const complete = launch.status === "started" ? steps.length : step;
  const width = 20, filled = Math.round((complete / steps.length) * width);
  const spinner = "|/-\\"[frame % 4];
  const source = launch.repositorySource === "link" ? "full link" : "current workspace";
  const checkpoint = launch.status === "started" ? (launch.kind === "cleanup" ? "Cleaned up" : `${launch.harness || "Codex"} started`) : steps[Math.min(step, steps.length - 1)];
  const title = launch.kind === "cleanup" ? "Cleaning up workspace" : `${launch.repo} (${source})`;
  if (launch.status === "failed") return `\x1b[2J\x1b[H${title} stopped — Enter/Esc to close\n${launch.error}\n`;
  return `\x1b[2J\x1b[H${title}\n`
    + `[${"#".repeat(filled)}${".".repeat(width - filled)}] ${Math.round((complete / steps.length) * 100)}% ${spinner} ${checkpoint}\n`;
}

function openInputPopup(pipeName, mode = "github", invoke = runHerdr) {
  const args = [
    "plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", "input",
    "--cwd", __dirname,
    "--env", `HERDR_CODEX_WORKFLOW_PIPE=${pipeName}`,
    "--env", `HERDR_CODEX_WORKFLOW_MODE=${mode}`,
    "--focus",
  ];
  invoke(args);
}

function openProgressPane(pipeName, context, open = runHerdrJson, resize = runHerdr) {
  if (!context.focused_pane_id) throw new Error("the action did not receive a focused pane");
  open([
    "plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", "progress",
    "--placement", "split", "--target-pane", context.focused_pane_id, "--direction", "down",
    "--cwd", __dirname, "--env", `HERDR_CODEX_WORKFLOW_PIPE=${pipeName}`, "--no-focus",
  ]);
  resize(["pane", "resize", "--pane", context.focused_pane_id, "--direction", "down", "--amount", "0.4"]);
}

function openConfirmPopup(pipeName, invoke = runHerdr) {
  invoke([
    "plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", "confirm",
    "--cwd", __dirname,
    "--env", `HERDR_CODEX_WORKFLOW_PIPE=${pipeName}`,
    "--focus",
  ]);
}

function controllerProtocol(runtime, lifecycle, resolveHello, resolveInput, resolveProgress = () => {}) {
  return {
    async message(message, connection) {
      if (message?.type === "hello" && message.role === "input") {
        if (lifecycle.state !== "COLLECTING" || runtime.inputConnected) throw new Error("controller is not collecting input");
        connection.role = "input";
        runtime.inputConnected = true;
        resolveHello();
        return { harnesses: runtime.harnesses, defaultHarness: harnessKind(runtime) };
      }
      if (message?.type === "hello" && message.role === "progress") {
        connection.role = "progress";
        resolveProgress();
        return {};
      }
      if (connection.role === "input" && ["input", "cancel"].includes(message?.type)) {
        if (lifecycle.state !== "COLLECTING") throw new Error("input was already submitted");
        let harness;
        if (message.harness) {
          harness = getHarness(message.harness);
          if (!harness) throw new Error(`unsupported harness: ${message.harness}`);
          if (Array.isArray(runtime.harnesses) && runtime.harnesses.length
            && !runtime.harnesses.some((entry) => entry.kind === harness.kind)) {
            throw new Error(`harness is not available: ${message.harness}`);
          }
        } else {
          harness = runtime.harness || getHarness(DEFAULT_HARNESS);
        }
        lifecycle.transition(message.type === "input" ? "submit" : "cancel");
        resolveInput(message.type === "input" ? (runtime.workflow === "task"
          ? { request: preserveLines(message.request), harness: harness.kind }
          : { target: compact(message.target), instructions: preserveLines(message.instructions), harness: harness.kind }) : null);
        return {};
      }
      if (connection.role === "progress" && message?.type === "status") return { launch: { ...runtime.launch } };
      if (message?.type === "cleanup") {
        if (runtime.cleanupRequest) throw new Error("controller cleanup is already requested");
        if (message.rootPaneId !== runtime.worktree?.root_pane?.pane_id
          || message.sessionId !== runtime.ownerSessionId) throw new Error("cleanup requester does not own this workflow");
        let acknowledge, cancel;
        const request = { connection, owner: { rootPaneId: message.rootPaneId, sessionId: message.sessionId },
          acknowledged: new Promise((resolve, reject) => { acknowledge = resolve; cancel = reject; }) };
        Object.assign(request, { acknowledge, cancel });
        runtime.cleanupRequest = request;
        try { await request.acknowledged; return {}; }
        finally { if (runtime.cleanupRequest === request) runtime.cleanupRequest = null; }
      }
      throw new Error("unsupported workflow message");
    },
    disconnect(connection) {
      if (runtime.cleanupRequest?.connection === connection) runtime.cleanupRequest.cancel(new Error("cleanup requester disconnected"));
      if (connection.role === "input" && lifecycle.state === "COLLECTING") {
        lifecycle.transition("cancel");
        resolveInput(null);
      }
    },
  };
}

async function controller(mode = "github") {
  if (process.platform !== "win32") throw new Error("This plugin supports Windows only");
  const context = readJson(process.env.HERDR_PLUGIN_CONTEXT_JSON, {});
  let repository = sourceRepository(context);
  const lifecycle = new Lifecycle();
  const pipeName = makePipeName();
  let resolveInput;
  let resolveHello;
  let resolveProgress;
  const inputPromise = new Promise((resolve) => { resolveInput = resolve; });
  const helloPromise = new Promise((resolve) => { resolveHello = resolve; });
  const progressPromise = new Promise((resolve) => { resolveProgress = resolve; });
  const runtime = {
    workflow: mode === "task" ? "task" : null, lifecycle, terminal: null,
    controllerPipe: pipeName, cleanupRequest: null, harnesses: configuredHarnesses(),
    harness: getHarness(defaultHarnessKind()),
    launch: { status: "collecting", step: 0, repo: repository.repo, repositorySource: "current" },
  };
  const server = await createPipeServer(pipeName, controllerProtocol(runtime, lifecycle, resolveHello, resolveInput, resolveProgress));

  try {
    if (!runtime.harnesses.length) {
      notify("No agent harness installed", "Install a Herdr integration such as codex or opencode with `herdr integration install <name>`.");
      return;
    }
    openInputPopup(pipeName, mode);
    await Promise.race([helloPromise, delay(30000).then(() => { throw new Error("input popup did not connect to its controller"); })]);
    const submission = await inputPromise;
    if (submission === null) return;
    runtime.harness = getHarness(submission.harness) || runtime.harness;
    writePluginState({ "last-harness": runtime.harness.kind });
    runtime.launch.harness = runtime.harness.label;
    runtime.launch.status = "running";
    let target;
    if (runtime.workflow !== "task") {
      target = parseTarget(submission.target, repository.repo);
      runtime.launch.repo = target.repo;
      runtime.launch.repositorySource = target.repositorySource;
    }
    openProgressPane(pipeName, context);
    await Promise.race([progressPromise, delay(30000).then(() => { throw new Error("progress pane did not connect to its controller"); })]);
    await delay(0);
    requireGitHubAuth();
    if (runtime.workflow !== "task") repository = resolveRepository(target, repository);
    runtime.launch.step = 1;
    await delay(0);
    if (runtime.workflow !== "task") {
      target = completeGitHubTarget(target, readJson(execute(gh, ["api", `repos/${repository.repo}/issues/${target.number}`])));
      runtime.workflow = target.type;
    }
    let details;
    let identity;
    if (isImplementationWorkflow(runtime.workflow)) {
      details = implementationBase(repository);
      identity = makeIdentity(runtime.workflow, target);
    } else {
      details = pullRequest(repository, target.number);
      identity = makeIdentity(runtime.workflow, target, details.headSha);
      runtime.prNumber = details.prNumber; runtime.prUrl = details.prUrl;
    }
    runtime.identity = identity; runtime.baseBranch = details.baseBranch; runtime.baseSha = details.baseSha;
    runtime.launch.step = 2;
    await delay(0);
    runtime.worktree = createWorktree(repository, identity, isImplementationWorkflow(runtime.workflow) ? details.baseSha : details.headSha);
    project(runtime);
    const promptData = {
      repo: repository.repo,
      target,
      branch: identity.branch,
      worktree: runtime.worktree.path,
      instructions: submission.instructions,
      request: submission.request,
      ...details,
    };
    runtime.launch.step = 3;
    await delay(0);
    const prompt = runtime.harness.prompts[runtime.workflow](promptData);
    await startParent(runtime, prompt);
    lifecycle.transition("provisioned");
    runtime.launch.status = "started";
    runtime.launch.step = launchSteps.length;
    await delay(0);
    project(runtime);
    if (await monitor(runtime, repository) === "cleanup") {
      const cleanupRequest = runtime.cleanupRequest;
      try { projectCleanup(runtime.worktree.workspace.workspace_id, "manual", "cancelled", cleanupRequest.owner); }
      catch (error) { cleanupRequest.cancel(error); throw error; }
      cleanupRequest.acknowledge();
      return;
    }
    if (runtime.terminal?.status === "complete") {
        try {
          await handoffCleanup(runtime, repository);
        }
        catch (error) {
          try { projectCleanup(runtime.worktree.workspace.workspace_id, "stopped"); } catch (projectError) { console.error(`cleanup metadata update failed: ${projectError.message}`); }
          notify(`${harnessLabel(runtime)} workflow PR tracking stopped`, "Could not watch for PR merge; the workspace and branch remain.");
          console.error(`cleanup handoff failed: ${error.message}`);
        }
    } else {
      try { await releaseParent(runtime); } catch (error) { console.error(`parent release failed: ${error.message}`); }
    }
  } catch (error) {
    runtime.launch.status = "failed";
    runtime.launch.error = error.message;
    if (runtime.inputConnected) await delay(100);
    if (runtime.prompt) try { await stopParent(runtime); } catch (stopError) { console.error(`parent shutdown failed: ${stopError.message}`); }
    if (!["COMPLETE", "FAILED", "CANCELLED"].includes(lifecycle.state)) lifecycle.transition("fail");
    if (runtime.worktree) {
      projectTerminal(runtime, { type: "terminal", status: "failed", reason: error.message });
      try { await releaseParent(runtime); } catch (releaseError) { console.error(`parent release failed: ${releaseError.message}`); }
    } else {
      notify(`${harnessLabel(runtime)} workflow failed`, error.message);
    }
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await server.shutdown();
  }
}

async function showLaunchProgress(client) {
  let reply = await client.request({ type: "hello", role: "progress" });
  if (!reply.ok) throw new Error(reply.error);
  let launch = reply.launch || { status: "running", step: 0, repo: "Starting workflow", repositorySource: "current" };
  for (let frame = 0; ; frame += 1) {
    let failure, settled = false;
    reply = null;
    client.request({ type: "status" }).then((value) => { reply = value; settled = true; }, (error) => { failure = error; settled = true; });
    while (!settled) {
      output.write(progressView(launch, frame));
      await delay(80);
    }
    if (failure) throw failure;
    if (!reply.ok) throw new Error(reply.error);
    launch = reply.launch;
    output.write(progressView(launch, frame));
    if (launch.status === "failed") {
      client.socket.end();
      await dismissProgress();
      return;
    }
    if (launch.status === "started") { await delay(200); return; }
    await delay(80);
  }
}

async function popup() {
  const pipeName = process.env.HERDR_CODEX_WORKFLOW_PIPE;
  if (!pipeName) throw new Error("popup was not launched by a workflow controller");
  const client = await connectPipe(pipeName);
  try {
    let reply = await client.request({ type: "hello", role: "input" });
    if (!reply.ok) throw new Error(reply.error);
    const value = await readPopupInput(process.env.HERDR_CODEX_WORKFLOW_MODE, reply.harnesses, reply.defaultHarness);
    reply = await client.request(value === null ? { type: "cancel" } : { type: "input", ...value });
    if (!reply.ok) throw new Error(reply.error);
  } finally {
    client.socket.end();
  }
}

async function progress() {
  const pipeName = process.env.HERDR_CODEX_WORKFLOW_PIPE;
  if (!pipeName) throw new Error("progress pane was not launched by a workflow controller");
  const client = await connectPipe(pipeName);
  try { await showLaunchProgress(client); }
  catch (error) {
    output.write(`\x1b[2J\x1b[HProgress stopped — Enter/Esc to close\n${error.message}\n`);
    await dismissProgress();
  }
  finally { client.socket.end(); }
}

function confirmView(question) {
  return `\x1b[2J\x1b[HRemove worktree anyway?\n\n${question}\n\n`
    + `  [Y] Yes, I know — remove it anyway\n`
    + `  [N] No, keep the worktree\n\n`
    + `Press Y or N.\n`;
}

async function readConfirm(question) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    const rl = readlinePromises.createInterface({ input, output });
    try {
      const answer = compact(await rl.question(`${question} Remove anyway? (y/N) `)).toLowerCase();
      return answer === "y" || answer === "yes";
    } finally { rl.close(); }
  }
  return new Promise((resolve) => {
    let settled = false;
    input.setRawMode(true);
    readline.emitKeypressEvents(input);
    input.resume();
    output.write(confirmView(question));
    function finish(approved) {
      if (settled) return;
      settled = true;
      input.off("keypress", onKey);
      input.setRawMode(false);
      input.pause();
      output.write(approved ? "\nRemoving anyway.\n" : "\nKeeping the worktree.\n");
      resolve(approved);
    }
    function onKey(sequence, key) {
      const value = String(sequence || "").toLowerCase();
      if (value === "y") return finish(true);
      if (value === "n" || key?.name === "escape" || (key?.ctrl && key?.name === "c")) return finish(false);
    }
    input.on("keypress", onKey);
  });
}

async function confirmPane() {
  const pipeName = process.env.HERDR_CODEX_WORKFLOW_PIPE;
  if (!pipeName) throw new Error("confirmation pane was not launched by a cleanup controller");
  const client = await connectPipe(pipeName);
  try {
    const reply = await client.request({ type: "hello", role: "confirm" });
    if (!reply.ok) throw new Error(reply.error);
    const approved = await readConfirm(reply.question || "This workflow worktree has uncommitted changes.");
    await client.request({ type: "decision", value: approved });
  } finally {
    client.socket.end();
  }
}

function popupFields(state) {
  return state.mode === "task" ? ["harness", "request"] : ["harness", "target", "instructions"];
}

function textFieldIndex(field) {
  return field === "instructions" ? 1 : 0;
}

function visualLines(value, width) {
  const lines = [];
  let offset = 0;
  for (const logical of String(value || "").split("\n")) {
    const chars = [...logical];
    let index = 0;
    do {
      const slice = chars.slice(index, index + width);
      lines.push({ start: offset + index, end: offset + index + slice.length, text: slice.join("") });
      index += width;
    } while (index < chars.length);
    offset += chars.length + 1;
  }
  return lines;
}

function visualRow(lines, cursor) {
  let row = 0;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].start > cursor) break;
    row = index;
  }
  return row;
}

function popupInputView(state, width = output.columns || 80, height = output.rows || 10) {
  state.width = width;
  const fields = popupFields(state);
  const harness = state.harnesses[state.harnessIndex] || { label: "Codex" };
  const active = fields[state.active];
  const marker = (field) => (field === active ? ">" : " ");
  const instructionWidth = Math.max(1, width - 3);
  const rows = [];
  let caretRow = 1, caretCol = 1;

  rows.push(`${marker("harness")} Harness: < ${harness.label} >`);
  if (active === "harness") { caretRow = 1; caretCol = [...rows[0]].length + 1; }

  const topRows = rows.length;
  const budget = Math.max(2, height - topRows);

  if (state.mode === "task") {
    const cursor = state.cursors[0];
    const lines = visualLines(state.values[0], instructionWidth);
    const row = visualRow(lines, cursor);
    const visibleCount = Math.max(1, budget - 1);
    const windowStart = Math.max(0, Math.min(row - Math.floor(visibleCount / 2), lines.length - visibleCount));
    rows.push(`${marker("request")} Describe the feature or fix:`);
    const bodyStart = rows.length;
    rows.push(...lines.slice(windowStart, windowStart + visibleCount).map((line) => `  ${line.text}`));
    if (active === "request") {
      caretRow = bodyStart + (row - windowStart) + 1;
      caretCol = (cursor - lines[row].start) + 3;
    }
  } else {
    const target = state.values[0], targetCursor = state.cursors[0], targetChars = [...target];
    const targetPrefix = `${marker("target")} Paste issue or PR: `;
    const available = Math.max(1, width - targetPrefix.length - 1);
    let windowStart = targetCursor <= available ? 0 : targetCursor - available + 1;
    windowStart = Math.max(0, Math.min(windowStart, Math.max(0, targetChars.length - available)));
    rows.push(targetPrefix + targetChars.slice(windowStart, windowStart + available).join(""));
    if (active === "target") { caretRow = topRows + 1; caretCol = targetPrefix.length + (targetCursor - windowStart) + 1; }
    rows.push("─".repeat(Math.max(1, width - 1)));

    const cursor = state.cursors[1];
    const lines = visualLines(state.values[1], instructionWidth);
    const row = visualRow(lines, cursor);
    const visibleCount = Math.max(1, budget - 3);
    const instructionsStart = Math.max(0, Math.min(row - Math.floor(visibleCount / 2), lines.length - visibleCount));
    rows.push(`${marker("instructions")} Custom instructions:`);
    const bodyStart = rows.length;
    rows.push(...lines.slice(instructionsStart, instructionsStart + visibleCount).map((line) => `  ${line.text}`));
    if (active === "instructions") {
      caretRow = bodyStart + (row - instructionsStart) + 1;
      caretCol = (cursor - lines[row].start) + 3;
    }
  }
  return `\x1b[2J\x1b[H${rows.join("\n")}\x1b[${caretRow};${caretCol}H`;
}

async function dismissProgress() {
  if (!input.isTTY) return;
  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  try {
    await new Promise((resolve) => {
      function keypress(_text, key) {
        if (["return", "enter", "escape"].includes(key.name) || (key.ctrl && key.name === "c")) {
          input.off("keypress", keypress);
          resolve();
        }
      }
      input.on("keypress", keypress);
    });
  } finally { input.setRawMode(false); input.pause(); }
}

function selectHarness(state, index) {
  state.harnessIndex = index;
  state.typeahead = null;
}

function popupSubmit(state) {
  return state.values[0].trim() ? "submit" : null;
}

function popupInputKey(state, sequence, key) {
  sequence ??= key.sequence;
  const fields = popupFields(state);
  const active = fields[state.active];
  const width = state.width || output.columns || 80;
  const focus = (index) => {
    state.active = Math.max(0, Math.min(index, fields.length - 1));
    state.typeahead = null;
    const field = fields[state.active];
    if (field !== "harness") {
      const valueIndex = textFieldIndex(field);
      state.cursors[valueIndex] = Math.min(state.cursors[valueIndex], [...state.values[valueIndex]].length);
    }
  };
  const submitting = ["return", "enter"].includes(key.name) || sequence === "\x1b[13;2u";

  if (key.name === "escape" || (key.ctrl && key.name === "c") || ["\x1b[27u", "\x1b[99;5u"].includes(sequence)) return "cancel";
  if (key.name === "tab") { focus((state.active + (key.shift ? -1 : 1) + fields.length) % fields.length); return "render"; }

  if (active === "harness") {
    if (key.name === "left" || key.name === "right") {
      const step = key.name === "right" ? 1 : -1;
      selectHarness(state, (state.harnessIndex + step + state.harnesses.length) % state.harnesses.length);
      return "render";
    }
    if (key.name === "down") { focus(state.active + 1); return "render"; }
    if (key.name === "up") return null;
    if (submitting) return popupSubmit(state);
    if (sequence && /^[A-Za-z0-9]$/.test(sequence) && !key.ctrl && !key.meta) {
      const needle = sequence.toLowerCase();
      const start = state.typeahead === needle ? 1 : 0;
      for (let step = start; step < state.harnesses.length; step += 1) {
        const index = (state.harnessIndex + step) % state.harnesses.length;
        if (!state.harnesses[index].label.toLowerCase().startsWith(needle)) continue;
        if (step) selectHarness(state, index);
        state.typeahead = needle;
        return "render";
      }
      state.typeahead = null;
    }
    return null;
  }

  const valueIndex = textFieldIndex(active);
  const chars = [...state.values[valueIndex]];
  let cursor = state.cursors[valueIndex];
  const multiline = active === "instructions" || active === "request";
  const lineWidth = multiline ? Math.max(1, width - 3) : Math.max(1, width);
  const lines = visualLines(state.values[valueIndex], lineWidth);
  const row = visualRow(lines, cursor);
  const column = cursor - lines[row].start;

  if (submitting) {
    if (multiline && (key.shift || sequence === "\x1b[13;2u")) {
      chars.splice(cursor, 0, "\n");
      state.values[valueIndex] = chars.join("");
      state.cursors[valueIndex] = cursor + 1;
      return "render";
    }
    return popupSubmit(state);
  }
  if (key.name === "left") { if (cursor === 0) return null; state.cursors[valueIndex] = cursor - 1; return "render"; }
  if (key.name === "right") { if (cursor >= chars.length) return null; state.cursors[valueIndex] = cursor + 1; return "render"; }
  if (key.name === "home") { state.cursors[valueIndex] = multiline ? lines[row].start : 0; return "render"; }
  if (key.name === "end") { state.cursors[valueIndex] = multiline ? lines[row].end : chars.length; return "render"; }
  if (key.name === "up") {
    if (multiline && row > 0) {
      state.cursors[valueIndex] = lines[row - 1].start + Math.min(column, lines[row - 1].end - lines[row - 1].start);
      return "render";
    }
    if (state.active > 0) { focus(state.active - 1); return "render"; }
    return null;
  }
  if (key.name === "down") {
    if (multiline && row < lines.length - 1) {
      state.cursors[valueIndex] = lines[row + 1].start + Math.min(column, lines[row + 1].end - lines[row + 1].start);
      return "render";
    }
    if (state.active < fields.length - 1) { focus(state.active + 1); return "render"; }
    return null;
  }
  if (key.name === "backspace") {
    if (cursor === 0) return null;
    chars.splice(cursor - 1, 1);
    state.values[valueIndex] = chars.join("");
    state.cursors[valueIndex] = cursor - 1;
    return "render";
  }
  if (key.name === "delete") {
    if (cursor >= chars.length) return null;
    chars.splice(cursor, 1);
    state.values[valueIndex] = chars.join("");
    return "render";
  }
  if (sequence && !key.ctrl && !key.meta && !sequence.startsWith("\x1b")) {
    const inserted = [...sequence.replace(/\r\n?/g, "\n").replace(/\t/g, "  ")];
    chars.splice(cursor, 0, ...inserted);
    state.values[valueIndex] = chars.join("");
    state.cursors[valueIndex] = cursor + inserted.length;
    return "render";
  }
  return null;
}

function popupSelection(state) {
  const harness = state.harnesses[state.harnessIndex] || harnessList()[0];
  return { kind: harness.kind, label: harness.label };
}

function popupHarnesses(harnesses) {
  return Array.isArray(harnesses) ? harnesses : harnessList();
}

function popupState(mode, harnesses, defaultHarness) {
  const list = popupHarnesses(harnesses);
  if (!list.length) throw new Error("No agent harness is installed; run `herdr integration install <name>`.");
  const harnessIndex = Math.max(0, list.findIndex((harness) => harness.kind === defaultHarness));
  const state = { mode, harnesses: list, harnessIndex, active: 0, typeahead: null, values: ["", ""], cursors: [0, 0], width: output.columns || 80 };
  state.active = popupFields(state).findIndex((field) => field !== "harness");
  return state;
}

async function readPopupInput(mode = "github", harnesses, defaultHarness = defaultHarnessKind()) {
  const list = popupHarnesses(harnesses);
  const fallback = list.find((harness) => harness.kind === defaultHarness) || list[0];
  if (!fallback) throw new Error("No agent harness is installed; run `herdr integration install <name>`.");
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    const rl = readlinePromises.createInterface({ input, output });
    if (mode === "task") {
      const request = preserveLines(await rl.question("Describe the feature or fix: "));
      rl.close();
      return request ? { request, harness: fallback.kind } : null;
    }
    const target = compact(await rl.question("Paste issue or PR: "));
    const instructions = target ? compact(await rl.question("Custom instructions (optional): ")) : "";
    rl.close();
    return target ? { target, instructions, harness: fallback.kind } : null;
  }
  const state = popupState(mode, list, defaultHarness);
  output.write(`\x1b[>1u${popupInputView(state)}`);
  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve) => {
    function finish(result) {
      input.off("keypress", onKey);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      resolve(result);
    }
    function onKey(sequence, key) {
      const action = popupInputKey(state, sequence, key);
      if (action === "cancel") return finish(null);
      if (action === "submit") {
        const { kind } = popupSelection(state);
        return finish(mode === "task"
          ? { request: preserveLines(state.values[0]), harness: kind }
          : { target: compact(state.values[0]), instructions: preserveLines(state.values[1]), harness: kind });
      }
      if (action === "render") output.write(popupInputView(state));
    }
    input.on("keypress", onKey);
  });
}

async function runCleanup(context, progress, confirm) {
  if (!context.workspace_id) throw new Error("cleanup requires a current workflow workspace");
  let cleanup;
  try { cleanup = await cleanupCurrentWorkflow(context.workspace_id, progress, confirm); }
  catch (error) {
    notify("Workflow cleanup stopped", error.message);
    throw error;
  }
  const { result, worktree, branch, abandon, harness } = cleanup;
  const label = harness?.label || "Codex";
  const archived = harness?.archiveArgs ? `Archived its ${label} session and removed` : "Removed";
  if (result.status === "removed") return notify(`${label} workflow cleaned up`, `${archived} ${worktree.checkout_path}; branch ${branch} remains.`, "done");
  if (result.status === "missing") return;
  if (result.status === "busy") {
    notify(`${label} workflow cleanup stopped`, result.reason);
    throw new Error(result.reason);
  }
  if (!abandon) projectCleanup(context.workspace_id, result.status);
  notify(result.status === "partial" ? `${label} workflow partially cleaned up` : `${label} workflow cleanup stopped`, result.reason);
  throw new Error(result.reason);
}

async function cleanup() {
  const context = readJson(process.env.HERDR_PLUGIN_CONTEXT_JSON, {});
  const pipeName = makePipeName();
  const launch = { kind: "cleanup", status: "running", step: 0 };
  let ready, delivered;
  const connected = new Promise((resolve) => { ready = resolve; });
  const finished = new Promise((resolve) => { delivered = resolve; });
  let confirmQuestion = "";
  let resolveConfirm = null;
  const server = await createPipeServer(pipeName, {
    message(message, connection) {
      if (message.type === "hello" && message.role === "confirm") {
        connection.role = "confirm";
        return { question: confirmQuestion };
      }
      if (message.type === "decision" && connection.role === "confirm") {
        const resolve = resolveConfirm; resolveConfirm = null;
        if (resolve) resolve(message.value === true);
        return {};
      }
      if (message.type === "hello") ready();
      if (message.type === "status" && launch.status !== "running") delivered();
      return { launch: { ...launch } };
    },
    disconnect(connection) {
      if (connection.role === "confirm") {
        const resolve = resolveConfirm; resolveConfirm = null;
        if (resolve) resolve(false);
        return;
      }
      delivered();
    },
  });
  const confirm = (question) => {
    confirmQuestion = question;
    return new Promise((resolve) => {
      resolveConfirm = resolve;
      try { openConfirmPopup(pipeName); }
      catch { resolveConfirm = null; resolve(false); }
    });
  };
  let timer;
  try {
    openProgressPane(pipeName, context);
    await Promise.race([connected, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Cleanup progress pane could not connect.")), 30000);
    })]);
    clearTimeout(timer);
    try {
      await runCleanup(context, async (step) => {
        launch.step = step;
        await new Promise((resolve) => setImmediate(resolve));
      }, confirm);
      launch.status = "started";
    } catch (error) {
      launch.status = "failed";
      launch.error = error.message;
      console.error(error.message);
      process.exitCode = 1;
    }
    await Promise.race([finished, new Promise((resolve) => { timer = setTimeout(resolve, 2000); })]);
  } finally { clearTimeout(timer); await server.shutdown(); }
}

async function watcher(encodedPayload) {
  const payload = decodePayload(encodedPayload);
  if (typeof process.send !== "function") throw new Error("cleanup watcher requires its controller IPC channel");
  const disconnected = new Promise((resolve) => process.once("disconnect", resolve));
  await new Promise((resolve, reject) => process.send({ type: "armed" }, (error) => error ? reject(error) : resolve()));
  await disconnected;
  const harness = getHarness(payload.harness) || getHarness(DEFAULT_HARNESS);
  return watch(payload, cleanupOps(payload.workspaceId, null, harness));
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "start") return controller(args[0]);
  if (mode === "popup") return popup();
  if (mode === "progress") return progress();
  if (mode === "confirm") return confirmPane();
  if (mode === "cleanup") return cleanup();
  if (mode === "watch") return watcher(args[0]);
  throw new Error("expected start, popup, progress, confirm, cleanup, or watch mode");
}

module.exports = { agentMatchesHarness, agentSessionTitle, autoCleanupOnPrMerge, canonicalRepositoryRoot, codexAgentStartArgs, completeGitHubTarget, configuredHarnesses, confirmView, controllerProtocol, defaultHarnessKind,
  harnessStartArgs, installedIntegrations, openConfirmPopup, openInputPopup, openProgressPane,
  popupFields, popupInputKey, popupInputView, popupSelection, popupState,
  project, startParentAgent,
  checksSummary, implementationPullRequest, isAgentPromptStalled, monitor, progressView, pullRequestReadiness, readPluginConfig, readPluginState, resolveRepository, sourceDirectory, stalledPromptRecovery, stalledPromptRecoveryCommands,
  trackedPullRequest, waitForActivity, writePluginState };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
