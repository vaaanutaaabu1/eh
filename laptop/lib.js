"use strict";
/* Shared helpers for the laptop kit. Pure Node (18+), no npm packages except `pg` in migrate-files.js (installed with the site). */
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const HERE = __dirname;
const ROOT = path.resolve(HERE, "..");

function loadEnv(file) {
  const o = {};
  if (!fs.existsSync(file)) return o;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    o[m[1]] = v;
  }
  return o;
}
const cfg = Object.assign({}, loadEnv(path.join(HERE, "laptop.env")), process.env);
const rel = (v, d) => path.resolve(ROOT, v || d);

const S = {
  mode: (cfg.PG_MODE || "docker").toLowerCase(),            // docker = run pg_dump inside a postgres image (nothing to install) | native
  image: cfg.PG_IMAGE || "postgres:17",
  nativeBin: cfg.PG_NATIVE_BIN || "",
  port: Number(cfg.FILE_STORE_PORT) || 8787,
  token: String(cfg.FILE_STORE_TOKEN || "").trim(),
  maxMB: Number(cfg.FILE_MAX_MB) || 200,
  dataDir: rel(cfg.LAPTOP_DATA, "laptop-data"),
  filesDir: cfg.FILES_DIR ? path.resolve(ROOT, cfg.FILES_DIR) : path.join(rel(cfg.LAPTOP_DATA, "laptop-data"), "files"),
  backupDir: rel(cfg.BACKUP_DIR, "backups"),
  keepDays: Number(cfg.KEEP_DAILY) > 0 ? Number(cfg.KEEP_DAILY) : 30
};
S.journal = path.join(S.dataDir, "journal.log");
S.mirrorDir = cfg.FILES_MIRROR_DIR ? path.resolve(ROOT, cfg.FILES_MIRROR_DIR) : path.join(S.backupDir, "files");

function urlsFor(prefix) {
  const out = [];
  for (let i = 1; i <= 20; i++) { const u = String(cfg[prefix + i] || (i === 1 ? cfg[prefix] : "") || "").trim(); if (u) out.push({ n: i, url: u }); }
  return out;
}
const liveDbs = () => urlsFor("LIVE_DATABASE_URL");      // = the site's DATABASE_URL1..N (your Neon databases): backed up here, and where OLD files still sit

/* file layout: <root>/<id % 1000, 3 digits>/<id>  (about 1000 files per folder for 1 million files) */
const validId = (id) => /^\d{1,16}$/.test(String(id));
const filePath = (root, id) => path.join(root, String(Number(id) % 1000).padStart(3, "0"), String(id));

/* run a PostgreSQL client tool */
function run(tool, args, opt) {
  opt = opt || {};
  return new Promise((resolve) => {
    let cmd, a; const env = Object.assign({}, process.env);
    if (S.mode === "docker") { cmd = "docker"; a = ["run", "--rm", "-i", S.image, tool].concat(args); }
    else { cmd = S.nativeBin ? path.join(S.nativeBin, tool) : tool; a = args; }
    const child = cp.spawn(cmd, a, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "", wsDone = null;
    child.stdin.on("error", () => {});
    if (opt.stdin) fs.createReadStream(opt.stdin).pipe(child.stdin); else child.stdin.end();
    if (opt.stdout) { const ws = fs.createWriteStream(opt.stdout); wsDone = new Promise((r) => ws.on("close", r)); child.stdout.pipe(ws); }
    else child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => resolve({ code: -1, out, err: String(e.message || e) }));
    child.on("close", async (code) => { if (wsDone) await wsDone; resolve({ code, out, err }); });
  });
}
const conn = (url) => ["--dbname=" + url];
async function psql(url, sql) {
  const r = await run("psql", ["-X", "-At", "-F", "|", "-v", "ON_ERROR_STOP=1", "--dbname=" + url, "-c", sql]);
  if (r.code !== 0) throw new Error(r.err.trim() || "psql failed");
  return r.out.trim();
}
const COUNT_SQL = "select table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text " +
  "from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1";
async function counts(url) {
  const o = {}, t = await psql(url, COUNT_SQL);
  if (t) for (const l of t.split("\n")) { const [k, v] = l.split("|"); o[k] = Number(v); }
  return o;
}
/* Neon: the direct host (no -pooler) is the right one for pg_dump */
function directUrl(url) {
  try { const u = new URL(url); u.hostname = u.hostname.replace("-pooler", ""); u.searchParams.delete("channel_binding"); return u.toString(); }
  catch (e) { return url; }
}

const pad = (n) => String(n).padStart(2, "0");
function stamp(d) { d = d || new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "_" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()); }
const STAMP_RE = /^(\d{4})-(\d\d)-(\d\d)_(\d\d)(\d\d)(\d\d)$/;
const stampDate = (s) => { const m = s.match(STAMP_RE); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null; };
function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => STAMP_RE.test(f) && fs.existsSync(path.join(dir, f, "manifest.json"))).sort();
}
/* keep every backup of the last 2 days, then one per day up to keepDays; never fewer than 3 in total */
function prune(dir) {
  const names = listBackups(dir), now = Date.now(), recent = now - 2 * 864e5, oldest = now - S.keepDays * 864e5, lastOfDay = {};
  for (const n of names) lastOfDay[n.slice(0, 10)] = n;
  const keep3 = new Set(names.slice(-3));
  for (const n of names) {
    const t = stampDate(n).getTime();
    if (t >= recent || keep3.has(n)) continue;
    if (t < oldest || lastOfDay[n.slice(0, 10)] !== n) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
  }
}
function log(msg) {
  const line = "[" + new Date().toISOString() + "] " + msg;
  console.log(line);
  try { fs.mkdirSync(S.backupDir, { recursive: true }); fs.appendFileSync(path.join(S.backupDir, "backup.log"), line + "\n"); } catch (e) { /* ignore */ }
}
module.exports = { ROOT, HERE, S, cfg, liveDbs, validId, filePath, run, conn, psql, counts, directUrl, stamp, stampDate, listBackups, prune, log, loadEnv };
