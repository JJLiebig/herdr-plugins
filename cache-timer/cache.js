"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { api, hash, watch } = require("./watch.js");

const defaults = { codex: "30m", claude: "5m" };
const settled = status => status === "idle" || status === "done";
const identity = agent => hash(JSON.stringify([
  agent.terminal_id, agent.agent, agent.agent_session?.source,
  agent.agent_session?.kind, agent.agent_session?.value,
]));

function duration(value) {
  if (value === null) return null;
  const match = /^(\d+)(m|h)$/.exec(value);
  const ms = match && Number(match[1]) * (match[2] === "h" ? 3600000 : 60000);
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error("Cache lifetime must be a positive duration such as 5m, 30m, or 1h, or null for unknown.");
  return ms;
}

function config(directory) {
  let value = {};
  try { value = JSON.parse(fs.readFileSync(path.join(directory, "config.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const isObject = item => item !== null && typeof item === "object" && !Array.isArray(item);
  if (!isObject(value) || (value.agents !== undefined && !isObject(value.agents))) {
    throw new Error('Cache Timer config must be an object with an optional "agents" object.');
  }
  const lifetimes = { ...defaults, ...value.agents };
  return Object.fromEntries(Object.entries(lifetimes).map(([agent, ttl]) => [agent.toLowerCase(), duration(ttl)]));
}

function lifetime(agent, lifetimes) {
  const tokens = agent.tokens || {};
  if (tokens.cache_timer_override_identity === identity(agent)) return duration(tokens.cache_timer_override);
  return lifetimes[String(agent.agent).toLowerCase()] ?? null;
}

function advance(previous, agent, now) {
  const key = identity(agent);
  const seq = agent.state_change_seq;
  if (!previous || previous.identity !== key || seq < previous.seq) {
    return { identity: key, seq, status: agent.agent_status, completedAt: null };
  }
  // Herdr changes this sequence for lifecycle changes, not viewing a completion.
  // ponytail: polling estimates completion within 5s; request hooks if precision matters.
  const completed = Number.isSafeInteger(seq) && seq > previous.seq
    && settled(agent.agent_status) && previous.status !== "unknown";
  return {
    identity: key, seq, status: agent.agent_status,
    completedAt: completed ? now : previous.completedAt,
  };
}

function display(state, ttl, now) {
  if (state.status === "working") return { cache: "cache working", cache_short: "cache working" };
  if (state.status === "unknown" || ttl === null || state.completedAt === null) {
    return { cache: "cache ?", cache_short: "cache ?" };
  }
  const remaining = Math.max(0, ttl - Math.max(0, now - state.completedAt));
  const filled = Math.ceil(remaining / ttl * 10);
  const label = remaining ? `~${Math.ceil(remaining / 60000)}m` : "window elapsed";
  return { cache: `cache [${"#".repeat(filled)}${".".repeat(10 - filled)}] ${label}`, cache_short: `cache ${label}` };
}

function report(paneId, tokens, request = api, ttl = 30000, source = "display") {
  const args = ["pane", "report-metadata", paneId, "--source", `plugin:jjliebig.cache-timer.${source}`];
  if (ttl) args.push("--ttl-ms", String(ttl));
  for (const [name, value] of Object.entries(tokens)) {
    args.push(...(value === null ? ["--clear-token", name] : ["--token", `${name}=${value}`]));
  }
  request(args);
}

function ticker(request = api, readConfig = () => config(process.env.HERDR_PLUGIN_CONFIG_DIR), clock = Date.now) {
  const states = new Map();
  return () => {
    const lifetimes = readConfig();
    const { agents } = request(["agent", "list"]);
    const now = clock();
    const present = new Set();
    for (const agent of agents) {
      present.add(agent.terminal_id);
      const previous = states.get(agent.terminal_id);
      const state = advance(previous, agent, now);
      const tokens = display(state, lifetime(agent, lifetimes), now);
      states.set(agent.terminal_id, { ...state, paneId: agent.pane_id,
        reportedAt: previous?.reportedAt, text: previous?.text });
      if (tokens.cache !== previous?.text || agent.pane_id !== previous?.paneId
          || now - previous.reportedAt >= 15000) {
        report(agent.pane_id, tokens, request);
        states.set(agent.terminal_id, { ...state, paneId: agent.pane_id, reportedAt: now, text: tokens.cache });
      }
    }
    // Display metadata expires even when a pane closes, becomes a shell, or the watcher stops.
    for (const terminalId of states.keys()) if (!present.has(terminalId)) states.delete(terminalId);
  };
}

function setLifetime(value, request = api) {
  if (value !== "auto") duration(value);
  const context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  const paneId = context.focused_pane_id || process.env.HERDR_PANE_ID;
  if (!paneId) throw new Error("Choose a cache lifetime from an agent pane.");
  const { agent } = request(["agent", "get", paneId]);
  report(paneId, {
    cache_timer_override: value === "auto" ? null : value,
    cache_timer_override_identity: value === "auto" ? null : identity(agent),
  }, request, null, "settings");
}

async function main() {
  const [command, value] = process.argv.slice(2);
  if (command === "watch") return watch(ticker(), 5000);
  if (command === "set") return setLifetime(value);
  if (!command || command === "--help") {
    console.log("Cache Timer: start with the Herdr cache-timer.watch action; choose 5m, 30m, 1h, or auto from an agent pane.");
    return;
  }
  throw new Error("Unknown command. Run node cache.js --help.");
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { advance, config, display, duration, identity, lifetime, setLifetime, ticker };
