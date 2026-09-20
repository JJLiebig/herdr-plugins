"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { api, watch } = require("./watch.js");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test("socket requests stay async, decode fragmented Unicode, and reject failed or incomplete replies", async () => {
  const socketPath = path.join(os.tmpdir(), `cache-${randomUUID()}.sock`);
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
  const server = net.createServer(socket => {
    socket.once("data", async chunk => {
      const { id, params } = JSON.parse(chunk.toString());
      if (params.failure === "closed") return socket.end();
      if (params.failure === "json") return socket.end("not-json\n");
      if (params.failure === "api") return socket.end(JSON.stringify({ id, error: { message: "pane not found" } }) + "\n");
      await delay(30);
      const body = Buffer.from(JSON.stringify({ id, result: { text: "▰▱" }, future: true }) + "\n");
      const split = body.indexOf(Buffer.from("▰")) + 1;
      socket.write(body.subarray(0, split));
      await delay(5);
      socket.end(body.subarray(split));
    });
  });
  await once(server.listen(endpoint), "listening");
  let heartbeats = 0;
  const heartbeat = setInterval(() => heartbeats++, 5);
  try {
    assert.deepEqual(await api("example", {}, socketPath), { text: "▰▱" });
    assert.ok(heartbeats > 0, "event loop remains available during the request");
    await assert.rejects(api("example", { failure: "api" }, socketPath), /pane not found/);
    await assert.rejects(api("example", { failure: "closed" }, socketPath), /closed before a response/);
    await assert.rejects(api("example", { failure: "json" }, socketPath), SyntaxError);
  } finally {
    clearInterval(heartbeat);
    await new Promise(resolve => server.close(resolve));
  }
});

test("watcher awaits slow async ticks, excludes duplicates, and stops when disabled", async () => {
  const old = { id: process.env.HERDR_PLUGIN_ID, socket: process.env.HERDR_SOCKET_PATH };
  process.env.HERDR_PLUGIN_ID = `test-${randomUUID()}`;
  process.env.HERDR_SOCKET_PATH = randomUUID();
  let enabled = true, active = 0, maximum = 0, ticks = 0, ready;
  const started = new Promise(resolve => { ready = resolve; });
  const request = async () => ({ plugins: [{ plugin_id: process.env.HERDR_PLUGIN_ID, enabled, plugin_root: __dirname }] });
  const tick = async () => {
    maximum = Math.max(maximum, ++active);
    ready();
    await delay(20);
    active--;
    if (++ticks === 2) enabled = false;
  };
  try {
    const running = watch(tick, 1, request, () => true, 123, async () => "version");
    await started;
    await watch(() => assert.fail("duplicate tick"), 1, request, () => true, 123, async () => "version");
    await running;
    assert.equal(ticks, 2);
    assert.equal(maximum, 1);
  } finally {
    for (const [name, value] of [["HERDR_PLUGIN_ID", old.id], ["HERDR_SOCKET_PATH", old.socket]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
