"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { advance, config, display, duration, identity, lifetime, setLifetime, ticker } = require("./cache.js");

const agent = (status = "idle", seq = 1, extra = {}) => ({
  terminal_id: "terminal-1", pane_id: "w1:p1", agent: "codex",
  agent_status: status, state_change_seq: seq,
  agent_session: { source: "codex", kind: "id", value: "session-1" }, tokens: {}, ...extra,
});

test("completion ages without focus resets, including a short turn between polls", () => {
  let state = advance(null, agent(), 0);
  assert.equal(display(state, 1800000, 0).cache, "cache ?");
  state = advance(state, agent("working", 2), 1000);
  assert.equal(display(state, 1800000, 1000).cache, "cache working");
  state = advance(state, agent("done", 3), 2000);
  assert.equal(display(state, 1800000, 2000).cache, "cache [##########] ~30m");
  state = advance(state, agent("idle", 3, { title: "renamed", focused: true }), 62000);
  assert.equal(state.completedAt, 2000);
  assert.equal(display(state, 1800000, 362000).cache, "cache [########..] ~24m");
  state = advance(state, agent("idle", 5), 400000);
  assert.equal(state.completedAt, 400000);
  state = advance(state, agent("blocked", 6), 500000);
  assert.equal(display(state, 300000, 699999).cache_short, "cache ~1m");
  assert.equal(display(state, 300000, 700000).cache, "cache [..........] window elapsed");
  assert.equal(display(state, 300000, 1).cache, "cache [##########] ~5m");
});

test("session replacement and sequence rollback discard old estimates; moving preserves them", () => {
  let state = advance(advance(null, agent("working"), 0), agent("idle", 2), 1000);
  const moved = agent("idle", 2, { pane_id: "w2:p9", agent_session: { ...agent().agent_session, future_field: true } });
  state = advance(state, moved, 2000);
  assert.equal(state.completedAt, 1000);
  for (const changed of [agent("idle", 1), agent("idle", 3, { agent: "claude" }),
    agent("idle", 3, { agent_session: { ...agent().agent_session, value: "session-2" } })]) {
    assert.equal(advance(state, changed, 3000).completedAt, null);
  }
  const unknown = advance(state, agent("unknown", 3), 3000);
  assert.equal(display(unknown, 300000, 3000).cache, "cache ?");
  assert.equal(advance(unknown, agent("idle", 4), 4000).completedAt, 1000);
});

test("configuration and session overrides select estimates without guessing unknown providers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cache-timer-test-"));
  try {
    assert.deepEqual(config(root), { codex: 1800000, claude: 300000 });
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ agents: { claude: "1h", codex: null, custom: "10m" }, future: true }));
    const values = config(root);
    assert.equal(lifetime(agent(), values), null);
    assert.equal(lifetime(agent("idle", 1, { agent: "CLAUDE" }), values), 3600000);
    assert.equal(lifetime(agent("idle", 1, { agent: "unknown" }), values), null);
    const selected = agent();
    selected.tokens = { cache_timer_override: "5m", cache_timer_override_identity: identity(selected) };
    assert.equal(lifetime(selected, values), 300000);
    selected.agent_session.value = "other";
    assert.equal(lifetime(selected, values), null);
    for (const bad of ["0m", "-5m", "5", "NaNm", "999999999999999999h", undefined]) assert.throws(() => duration(bad));
    for (const bad of [null, [], 3, "1h", { agents: null }, { agents: [] }, { agents: "1h" }]) {
      fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(bad));
      assert.throws(() => config(root), /config must be an object/);
    }
    fs.writeFileSync(path.join(root, "config.json"), "{");
    assert.throws(() => config(root));
  } finally { fs.rmSync(root, { recursive: true }); }
});

test("ticker publishes expiring metadata, retries failures, and retains time across pane moves", () => {
  let now = 0, current = agent("working"), fail = false;
  const writes = [];
  const request = args => {
    if (args[0] === "agent") return { agents: current ? [current] : [] };
    if (fail) { fail = false; throw new Error("disconnected"); }
    writes.push(args);
  };
  const tick = ticker(request, () => ({ codex: 1800000 }), () => now);
  tick();
  now = 5000; current = agent("done", 2); fail = true;
  assert.throws(tick, /disconnected/);
  now = 10000; tick();
  assert.ok(writes.at(-1).includes("cache=cache [##########] ~30m"));
  now = 20000; tick();
  assert.equal(writes.length, 2);
  now = 25000; tick();
  assert.equal(writes.length, 3);
  assert.ok(writes.at(-1).includes("30000"));
  now = 365000; current.pane_id = "w2:p1"; tick();
  assert.equal(writes.at(-1)[2], "w2:p1");
  assert.ok(writes.at(-1).includes("cache_short=cache ~24m"));
  current = null; tick();
  current = agent("idle", 2); tick();
  assert.ok(writes.at(-1).includes("cache=cache ?"));
});

test("pane action changes only the estimate and auto clears the override", () => {
  const old = process.env.HERDR_PLUGIN_CONTEXT_JSON;
  process.env.HERDR_PLUGIN_CONTEXT_JSON = JSON.stringify({ focused_pane_id: "w1:p1" });
  const writes = [];
  const request = args => {
    if (args[0] === "agent") return { agent: agent() };
    writes.push(args);
  };
  try {
    setLifetime("1h", request);
    assert.ok(writes[0].includes("cache_timer_override=1h"));
    assert.ok(writes[0].includes(`cache_timer_override_identity=${identity(agent())}`));
    setLifetime("auto", request);
    assert.ok(writes[1].includes("--clear-token"));
    assert.ok(writes[1].includes("cache_timer_override"));
    assert.equal(writes[1].includes("--ttl-ms"), false);
  } finally {
    if (old === undefined) delete process.env.HERDR_PLUGIN_CONTEXT_JSON;
    else process.env.HERDR_PLUGIN_CONTEXT_JSON = old;
  }
});
