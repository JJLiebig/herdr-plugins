"use strict";

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { once } = require("node:events");

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
const parentPid = process.ppid;
function parentAlive() {
  try { process.kill(parentPid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
async function watch(tick, interval = 60000, request = api, alive = parentAlive, owner = parentPid) {
  const id = process.env.HERDR_PLUGIN_ID;
  if (!id || !process.env.HERDR_SOCKET_PATH) throw new Error("Start this action through Herdr.");
  const name = `herdr-plugin-${hash(`${os.userInfo().username}:${id}:${scope()}`)}`;
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
  const server = net.createServer(socket => socket.end(String(owner)));
  const listen = () => once(server.listen(endpoint), "listening");
  while (true) {
    try { await listen(); break; } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
      const occupant = await new Promise((resolve, reject) => {
        const client = net.connect(endpoint);
        let data = "";
        client.setEncoding("utf8");
        client.on("data", chunk => { data += chunk; });
        client.once("end", () => resolve(data));
        client.once("error", err => {
          if (["ECONNREFUSED", "ENOENT"].includes(err.code)) resolve(null);
          else reject(err);
        });
      });
      if (occupant === String(owner) || !alive()) return;
      if (occupant === null && process.platform !== "win32") {
        try { fs.unlinkSync(endpoint); } catch (err) { if (err.code !== "ENOENT") throw err; }
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(interval, 1000)));
    }
  }
  try {
    while (alive()) {
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
