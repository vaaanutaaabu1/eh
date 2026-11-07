"use strict";
/* Starts the file server when you log in (and keeps it running) and backs up every hour.
     node laptop/schedule.js           install
     node laptop/schedule.js --remove  uninstall */
const cp = require("child_process");
const path = require("path");
const L = require("./lib");

const remove = process.argv.includes("--remove");
const node = process.execPath;
const sup = path.join(__dirname, "supervisor.js"), bak = path.join(__dirname, "backup.js");
const logf = path.join(L.S.backupDir, "backup.log");

if (process.platform === "win32") {
  const tasks = [
    ["LibFileServer", "ONLOGON", '"' + node + '" "' + sup + '"'],
    ["LibBackup-Hourly", "HOURLY", '"' + node + '" "' + bak + '" --if-stale 0.9'],
    ["LibBackup-Logon", "ONLOGON", '"' + node + '" "' + bak + '" --if-stale 0.9']
  ];
  for (const [name, sc, tr] of tasks) {
    const a = remove ? ["/Delete", "/TN", name, "/F"] : ["/Create", "/TN", name, "/SC", sc, "/TR", tr, "/F"];
    const r = cp.spawnSync("schtasks", a, { encoding: "utf8" });
    console.log(name + ": " + (r.status === 0 ? (remove ? "removed" : "installed") : (r.stdout + r.stderr).trim()));
  }
  if (!remove) { const r = cp.spawnSync("schtasks", ["/Run", "/TN", "LibFileServer"], { encoding: "utf8" }); console.log("Starting the file server now: " + (r.status === 0 ? "ok" : (r.stdout + r.stderr).trim())); }
} else {
  const MARK = "# lib-laptop";
  const cur = cp.spawnSync("crontab", ["-l"], { encoding: "utf8" });
  const keep = (cur.status === 0 ? cur.stdout : "").split("\n").filter((l) => l.trim() && !l.includes(MARK));
  if (!remove) {
    keep.push('@reboot "' + node + '" "' + sup + '" ' + MARK);
    keep.push('0 * * * * "' + node + '" "' + bak + '" --if-stale 0.9 >> "' + logf + '" 2>&1 ' + MARK);
  }
  const r = cp.spawnSync("crontab", ["-"], { input: keep.join("\n") + "\n", encoding: "utf8" });
  console.log(r.status === 0 ? (remove ? "Removed." : "Installed (crontab). Start the file server now with: npm run laptop:server") : "crontab failed: " + r.stderr);
}
