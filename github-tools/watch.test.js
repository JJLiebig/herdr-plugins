"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { watch } = require("./watch.js");

test("watcher survives a transient health failure, excludes a duplicate, and exits when disabled", async () => {
  const previous = { id: process.env.HERDR_PLUGIN_ID, socket: process.env.HERDR_SOCKET_PATH };
  const id = `test-${randomUUID()}`;
  process.env.HERDR_PLUGIN_ID = id;
  process.env.HERDR_SOCKET_PATH = id;
  let requests = 0, ticks = 0, enabled = true;
  const request = () => {
    if (++requests === 1) throw new Error("temporary health failure");
    return { plugins: [{ plugin_id: id, enabled, plugin_root: __dirname }] };
  };
  try {
    await watch(async () => {
      ticks++;
      await watch(() => assert.fail("duplicate watcher ran"), 1, request);
      enabled = false;
    }, 1, request);
    assert.equal(ticks, 1);
    assert.equal(requests, 3);
  } finally {
    for (const [name, value] of [["HERDR_PLUGIN_ID", previous.id], ["HERDR_SOCKET_PATH", previous.socket]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
