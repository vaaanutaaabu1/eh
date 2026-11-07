"use strict";
/* Restore.
     node laptop/restore.js db <latest|folder> --to <postgres connection string> [--yes]   load a database backup into a (new, empty) database
     node laptop/restore.js files [--yes]                                                  copy any missing file from the backup copy back to the files folder
   After restoring the database point the website's DATABASE_URL1 at it; the files folder is what the file server serves. */
const fs = require("fs");
const path = require("path");
const L = require("./lib");
const S = L.S;

(async () => {
  const a = process.argv.slice(2), yes = a.includes("--yes"), what = a[0];
  if (what === "files") {
    let n = 0, bytes = 0;
    if (!fs.existsSync(S.mirrorDir)) throw new Error("No backup copy of the files at " + S.mirrorDir);
    for (const d of fs.readdirSync(S.mirrorDir)) {
      if (!/^\d{3}$/.test(d)) continue;
      for (const f of fs.readdirSync(path.join(S.mirrorDir, d))) {
        if (!L.validId(f)) continue;
        const dst = L.filePath(S.filesDir, f);
        if (fs.existsSync(dst)) continue;
        n++; bytes += fs.statSync(path.join(S.mirrorDir, d, f)).size;
        if (yes) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(path.join(S.mirrorDir, d, f), dst); }
      }
    }
    console.log((yes ? "Copied back " : "Would copy back ") + n + " file(s), " + (bytes / 1048576).toFixed(1) + " MB." + (yes ? "" : "  Add --yes to do it."));
    return;
  }
  if (what !== "db") throw new Error("Usage: restore.js db <latest|folder> --to <url> [--yes]   |   restore.js files [--yes]");
  let target = a[1] && !a[1].startsWith("--") ? a[1] : "latest";
  if (target === "latest") { target = L.listBackups(S.backupDir).pop(); if (!target) throw new Error("No backups in " + S.backupDir); }
  const dir = fs.existsSync(target) ? path.resolve(target) : path.join(S.backupDir, target);
  const ti = a.indexOf("--to"), to = ti > -1 ? a[ti + 1] : "";
  if (!to) throw new Error("Give the empty database to restore into:  --to \"postgresql://user:pass@host/db?sslmode=require\"");
  const files = fs.readdirSync(dir).filter((f) => /^db\d+\.dump$/.test(f));
  if (files.length !== 1 && !a.includes("--file")) { console.log("Backup has: " + files.join(", ") + ". Restoring db1.dump (use --file dbN.dump for another)."); }
  const fi = a.indexOf("--file"), file = fi > -1 ? a[fi + 1] : "db1.dump";
  console.log("Backup: " + path.join(dir, file) + "\nInto:   " + to.replace(/:[^:@/]+@/, ":***@"));
  if (!yes) { console.log("\nThis REPLACES the tables in that database. Run again with --yes."); return; }
  const r = await L.run("pg_restore", ["--no-owner", "--no-privileges", "--clean", "--if-exists"].concat(L.conn(to)), { stdin: path.join(dir, file) });
  if (r.err.trim()) console.log("messages:\n" + r.err.trim().split("\n").slice(0, 8).join("\n"));
  const man = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).databases[file.replace(".dump", "")];
  const now = await L.counts(to);
  const bad = Object.keys(man.rows).filter((t) => man.rows[t] !== now[t]);
  console.log(bad.length ? "WARNING: row counts differ for: " + bad.join(", ") : "Restored. Every table's row count matches the backup.");
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
