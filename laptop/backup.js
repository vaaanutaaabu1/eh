"use strict";
/* Backup: the database(s) + every new uploaded file.
     node laptop/backup.js                   now
     node laptop/backup.js --if-stale 0.9    only if the newest backup is older than 0.9 hours (used by the hourly scheduler)
     node laptop/backup.js --full-scan       also compare the whole files folder with the backup copy (slow with many files)
   Database -> backups/<date_time>/db1.dump (+ manifest.json with row counts, config/ with laptop.env)
   Files    -> backups/files/ (a copy of every file; deleted files are kept there on purpose) */
const fs = require("fs");
const path = require("path");
const L = require("./lib");
const S = L.S;

const LOCK = path.join(S.backupDir, ".backup.lock");
const STATE = path.join(S.backupDir, "files-state.json");

function copyOne(id) {
  const src = L.filePath(S.filesDir, id), dst = L.filePath(S.mirrorDir, id);
  if (!fs.existsSync(src)) return "gone";
  const st = fs.statSync(src);
  if (fs.existsSync(dst) && fs.statSync(dst).size === st.size) return "same";
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = dst + ".part";
  fs.copyFileSync(src, tmp); fs.renameSync(tmp, dst);
  return st.size;
}

function backupFiles(full) {
  const r = { copied: 0, bytes: 0, gone: 0 };
  const add = (res) => { if (res === "gone") r.gone++; else if (res !== "same") { r.copied++; r.bytes += res; } };
  let state = { offset: 0 };
  try { state = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (e) { /* first run */ }
  if (fs.existsSync(S.journal)) {
    const size = fs.statSync(S.journal).size;
    if (state.offset > size) state.offset = 0;                      // journal was replaced: start over (copying is idempotent)
    if (size > state.offset) {
      const fd = fs.openSync(S.journal, "r"), buf = Buffer.alloc(size - state.offset);
      fs.readSync(fd, buf, 0, buf.length, state.offset); fs.closeSync(fd);
      const text = buf.toString("utf8"), end = text.lastIndexOf("\n") + 1;
      for (const line of text.slice(0, end).split("\n")) { const id = line.split("\t")[0]; if (L.validId(id)) add(copyOne(id)); }
      state.offset += Buffer.byteLength(text.slice(0, end));
    }
  }
  if (full && fs.existsSync(S.filesDir)) {
    for (const d of fs.readdirSync(S.filesDir)) {
      if (!/^\d{3}$/.test(d)) continue;
      for (const f of fs.readdirSync(path.join(S.filesDir, d))) if (L.validId(f)) add(copyOne(f));
    }
  }
  fs.mkdirSync(S.backupDir, { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(state));
  return r;
}

(async () => {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--if-stale");
  if (i > -1) {
    const h = parseFloat(argv[i + 1]) || 0.9, last = L.listBackups(S.backupDir).pop();
    if (last && Date.now() - L.stampDate(last).getTime() < h * 36e5) { console.log("Newest backup (" + last + ") is recent enough."); return; }
  }
  fs.mkdirSync(S.backupDir, { recursive: true });
  try { if (fs.existsSync(LOCK) && Date.now() - fs.statSync(LOCK).mtimeMs > 6 * 36e5) fs.rmSync(LOCK); fs.closeSync(fs.openSync(LOCK, "wx")); }
  catch (e) { console.log("Another backup is running. Skipping."); return; }
  const tmp = path.join(S.backupDir, ".partial");
  const problems = [];
  let dbInfo = "no database configured", fileInfo = "";
  try {
    const dbs = L.liveDbs();
    if (!dbs.length) throw new Error("LIVE_DATABASE_URL1 is not set in laptop/laptop.env");
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(path.join(tmp, "config"), { recursive: true });
    const manifest = { created: new Date().toISOString(), databases: {} };
    for (const d of dbs) {
      const f = path.join(tmp, "db" + d.n + ".dump");
      let r = await L.run("pg_dump", ["-Fc", "--no-owner", "--no-privileges"].concat(L.conn(L.directUrl(d.url))), { stdout: f });
      if (r.code !== 0) r = await L.run("pg_dump", ["-Fc", "--no-owner", "--no-privileges"].concat(L.conn(d.url)), { stdout: f });
      if (r.code !== 0) throw new Error("pg_dump database " + d.n + " failed: " + r.err.trim().split("\n").slice(-2).join(" "));
      const v = await L.run("pg_restore", ["--list"], { stdin: f });
      if (v.code !== 0) throw new Error("backup of database " + d.n + " is not readable: " + v.err.trim());
      manifest.databases["db" + d.n] = { bytes: fs.statSync(f).size, rows: await L.counts(L.directUrl(d.url)).catch(() => L.counts(d.url)) };
    }
    const envf = path.join(L.HERE, "laptop.env");
    if (fs.existsSync(envf)) fs.copyFileSync(envf, path.join(tmp, "config", "laptop.env"));
    fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify(manifest, null, 2));
    let name = L.stamp(), t = Date.now();
    while (fs.existsSync(path.join(S.backupDir, name))) name = L.stamp(new Date(t += 1000));   // two backups in the same second
    fs.renameSync(tmp, path.join(S.backupDir, name));
    L.prune(S.backupDir);
    dbInfo = "database " + name + " (" + (Object.values(manifest.databases).reduce((s, x) => s + x.bytes, 0) / 1048576).toFixed(1) + " MB)";
  } catch (e) { problems.push(e.message); }
  try {
    const r = backupFiles(argv.includes("--full-scan"));
    fileInfo = "files: " + r.copied + " new copied (" + (r.bytes / 1048576).toFixed(1) + " MB)" + (r.gone ? ", " + r.gone + " already deleted" : "");
  } catch (e) { problems.push("files: " + e.message); }
  fs.rmSync(tmp, { recursive: true, force: true });
  try { fs.rmSync(LOCK); } catch (e) { /* ignore */ }
  if (problems.length) { L.log("Backup PROBLEM: " + problems.join(" | ") + "  [" + dbInfo + "; " + fileInfo + "]"); process.exitCode = 1; }
  else L.log("Backup OK: " + dbInfo + "; " + fileInfo);
})();
