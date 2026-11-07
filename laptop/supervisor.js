"use strict";
/* Keeps the file server running: restarts it if it ever stops. Log: laptop-data/server.log */
const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const L = require("./lib");
fs.mkdirSync(L.S.dataDir, { recursive: true });
const logf = fs.openSync(path.join(L.S.dataDir, "server.log"), "a");
(function start() {
  const c = cp.spawn(process.execPath, [path.join(__dirname, "file-server.js")], { stdio: ["ignore", logf, logf], windowsHide: true });
  c.on("exit", (code) => { fs.writeSync(logf, "[" + new Date().toISOString() + "] file server stopped (" + code + "), restarting in 3 s\n"); setTimeout(start, 3000); });
})();
