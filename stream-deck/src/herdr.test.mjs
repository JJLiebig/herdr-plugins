import assert from "node:assert/strict";
import test from "node:test";

import { HerdrBridge } from "../.preview/herdr.js";

test("brief snapshot failures preserve state; sustained failures go offline and recover", async (t) => {
  const bridge = new HerdrBridge();
  let now = 0;
  let response = new Error("snapshot timed out");
  let updates = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.method(bridge, "command", async (args) => {
    if (args[0] === "api") {
      if (response instanceof Error) throw response;
      return { stdout: JSON.stringify(response) };
    }
    return { stdout: JSON.stringify({ result: { layout: { zoomed: false } } }) };
  });
  bridge.subscribe(() => updates++);
  const refresh = () => bridge.focusPane("test-pane");
  const online = { result: { panes: [{ pane_id: "test-pane", agent_status: "working" }] } };

  await refresh();
  assert.equal(bridge.snapshot, null);
  assert.equal(updates, 0);

  response = online;
  await refresh();
  const snapshot = bridge.snapshot;
  const theme = bridge.theme;
  assert.equal(snapshot.panes[0].agent_status, "working");
  assert.equal(updates, 1);

  response = new Error("snapshot timed out");
  now = 4000;
  await refresh();
  now = 9999;
  await refresh();
  assert.equal(bridge.snapshot, snapshot);
  assert.equal(bridge.theme, theme);
  assert.equal(updates, 1);

  response = online;
  await refresh();
  assert.equal(updates, 1);
  response = { result: {} };
  now = 15000;
  await refresh();
  assert.ok(bridge.snapshot);
  now = 19999;
  await refresh();
  assert.equal(bridge.snapshot, null);
  assert.equal(bridge.theme, null);
  assert.equal(updates, 2);
  await refresh();
  assert.equal(updates, 2);

  response = online;
  await refresh();
  assert.equal(bridge.snapshot.panes[0].agent_status, "working");
  assert.equal(updates, 3);
});
