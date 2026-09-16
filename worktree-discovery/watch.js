"use strict";

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const hash = value => createHash("sha256").update(value).digest("hex").slice(0, 24);
const scope = () => hash(process.env.HERDR_SOCKET_PATH || "default");

function api(args) {
  const result = spawnSync(process.env.HERDR_BIN_PATH || "herdr", args, {
    encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Herdr request failed");
  const response = JSON.parse(result.stdout);
  if (response.error) throw new Error(response.error.message);
  return response.result;
}

// Each independently installable plugin carries this small process wrapper.
async function watch(tick, interval = 60000, request = api) {
  const id = process.env.HERDR_PLUGIN_ID;
  if (!id || !process.env.HERDR_SOCKET_PATH) throw new Error("Start this action through Herdr.");
  const name = `herdr-plugin-${hash(`${os.userInfo().username}:${id}:${scope()}`)}`;
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
  const server = net.createServer(socket => socket.end());
  const listen = () => new Promise((resolve, reject) => {
    const fail = error => { server.removeListener("listening", ready); reject(error); };
    const ready = () => { server.removeListener("error", fail); resolve(); };
    server.once("error", fail).once("listening", ready).listen(endpoint);
  });
  try { await listen(); } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    if (process.platform === "win32") return;
    const alive = await new Promise(resolve => {
      const client = net.connect(endpoint);
      client.once("connect", () => { client.destroy(); resolve(true); });
      client.once("error", err => resolve(err.code !== "ECONNREFUSED"));
    });
    if (alive) return;
    fs.unlinkSync(endpoint);
    try { await listen(); } catch (err) { if (err.code === "EADDRINUSE") return; throw err; }
  }
  try {
    while (true) {
      try {
        const plugin = request(["plugin", "list", "--json"]).plugins.find(item => item.plugin_id === id);
        if (!plugin?.enabled || fs.realpathSync(plugin.plugin_root) !== fs.realpathSync(__dirname)) break;
        await tick();
      } catch (error) { console.error(error.message); }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
}

module.exports = { api, hash, scope, watch };
