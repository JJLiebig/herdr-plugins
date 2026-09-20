"use strict";

const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { once } = require("node:events");

const hash = value => createHash("sha256").update(value).digest("hex").slice(0, 24);
const scope = () => hash(process.env.HERDR_SOCKET_PATH || "default");

function api(method, params = {}, socketPath = process.env.HERDR_SOCKET_PATH) {
  if (!socketPath) return Promise.reject(new Error("Start this action through Herdr."));
  // Herdr namespaces the socket path verbatim on Windows (src/ipc.rs).
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint);
    let data = "";
    const finish = (error, result) => {
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timeout = setTimeout(() => finish(new Error("Herdr request timed out")), 15000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(JSON.stringify({ id: "cache-timer", method, params }) + "\n"));
    socket.once("error", error => finish(error));
    socket.once("close", () => finish(new Error("Herdr connection closed before a response")));
    socket.on("data", chunk => {
      data += chunk;
      if (Buffer.byteLength(data) > 8 * 1024 * 1024) return finish(new Error("Herdr response exceeds 8 MiB"));
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(data.slice(0, newline));
        if (response.id !== "cache-timer") throw new Error("Unexpected Herdr response ID");
        if (response.error) throw new Error(response.error.message);
        finish(null, response.result);
      } catch (error) { finish(error); }
    });
  });
}

// Each independently installable plugin carries this small process wrapper.
const parentPid = process.ppid;
function parentAlive() {
  try { process.kill(parentPid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
async function codeVersion() {
  const files = (await fs.readdir(__dirname)).sort().filter(name => name.endsWith(".js") && !name.endsWith(".test.js"));
  return hash(await fs.realpath(__dirname) + (await Promise.all(files.map(name => fs.readFile(path.join(__dirname, name), "utf8")))).join("\n"));
}
async function watch(tick, interval = 60000, request = api, alive = parentAlive, owner = parentPid, version = codeVersion) {
  const id = process.env.HERDR_PLUGIN_ID;
  if (!id || !process.env.HERDR_SOCKET_PATH) throw new Error("Start this action through Herdr.");
  const name = `herdr-plugin-${hash(`${os.userInfo().username}:${id}:${scope()}`)}`;
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
  const startedVersion = await version();
  const identity = `${owner}:${startedVersion}`;
  const server = net.createServer(socket => socket.end(identity));
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
          if (err.code === "ECONNRESET") { resolve(""); return; }
          if (["ECONNREFUSED", "ENOENT"].includes(err.code)) resolve(null);
          else reject(err);
        });
      });
      if (occupant === identity || !alive() || await version() !== startedVersion) return;
      if (occupant === null && process.platform !== "win32") {
        try { await fs.unlink(endpoint); } catch (err) { if (err.code !== "ENOENT") throw err; }
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(interval, 1000)));
    }
  }
  try {
    while (alive() && await version() === startedVersion) {
      try {
        const plugin = (await request("plugin.list")).plugins.find(item => item.plugin_id === id);
        if (!plugin?.enabled || await fs.realpath(plugin.plugin_root) !== await fs.realpath(__dirname)) break;
        await tick();
      } catch (error) { console.error(error.message); }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
}

module.exports = { api, hash, scope, watch };
