"use strict";
/*
 * Website backups: a .zip with (1) every database table as JSON (documents, static pages, users, orders, ...) and
 * (2) the website files (code, css, js, img, "static pages"). Secrets are never included: .env files are skipped.
 *
 *  - Admin console > Backup: set the email address(es), turn automatic backups on, back up now, download.
 *  - Automatic: every BACKUP_EVERY_HOURS (default 24) the site checks whether anything changed (new library
 *    documents, edited pages, new orders...) and only then makes + emails a backup.
 *  - Delivered by email (through whatever mailer is configured, including your own relay) and, optionally, Telegram.
 *    Files above BACKUP_MAX_EMAIL_MB (default 20) are not attached: the email says so and the file stays in
 *    Admin > Backup (and in BACKUP_DIR) for download.
 *  - BACKUP_PASSPHRASE=...  encrypts the file (.zip.enc); open it with: node backend/scripts/backup-tools.js decrypt <file>
 *  - BACKUP_DIR (default backend/backups) keeps the last BACKUP_KEEP (default 5). Hosts like Railway wipe this folder
 *    on every deploy, so rely on the email / Telegram copy, not on this folder.
 *
 * FULL backup WITH FILES (Admin > Backup > "Full backup with files"; also the automatic one when that box is ticked):
 *  - the uploaded files live on DATABASE_URL1..N (config/shards.js) and the tables only hold small pointers, so a normal backup
 *    does not contain them. The full backup also copies every file of every database into  shards/db<N>/<id>.bin
 *    (+ _index.json per database) and puts the tables that hold binary data into numbered parts (database/<table>.part00001.json).
 *  - It is written to disk one entry at a time (never held in memory), runs in the background, and is named backup-full-<time>.zip
 *    (BACKUP_FULL_KEEP, default 1, are kept). Restore: node backend/scripts/restore-backup.js <unzipped>/database
 *    Export the original files: npm run export-files -- --from-backup <unzipped>/database
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { query } = require("../config/database");
const mailer = require("./mailer");
const { createZip, createZipFile } = require("./zipWriter");
const SH = require("../config/shards");
const { encrypt, decrypt, encryptFile, decryptFile } = require("./backupCrypto");

const ROOT = path.resolve(__dirname, "..", "..");
const env = (k, d = "") => String(process.env[k] == null ? d : process.env[k]).trim();
const DIR = () => path.resolve(env("BACKUP_DIR") || path.join(ROOT, "backend", "backups"));
const KEEP = () => Math.max(1, Number(env("BACKUP_KEEP", "5")) || 5);
const FULL_KEEP = () => Math.max(1, Number(env("BACKUP_FULL_KEEP", "1")) || 1);
const CHUNK_BYTES = () => Math.max(1, Number(env("BACKUP_CHUNK_MB", "8")) || 8) * 1048576;   /* binary tables are written in parts of about this size */
const BLOB_BATCH = () => Math.max(1, Number(env("BACKUP_BLOB_BATCH_MB", "8")) || 8) * 1048576;
const MAX_MAIL = () => (Number(env("BACKUP_MAX_EMAIL_MB", "17")) || 17) * 1048576;
const SKIP_TABLES = () => env("BACKUP_SKIP_TABLES").split(",").map((s) => s.trim()).filter(Boolean);
const SITE = () => env("SITE_NAME", "Expert Help");
const EXTERNAL = () => !!env("DATABASE_URL");
/* LEAN backup (default when DATABASE_URL is set): the automatic backup leaves out the big binary data (library document files and page images).
   Reading them every day would use up the free network transfer (Neon: 5 GB/month) and the server memory; Neon itself keeps that data. BACKUP_LEAN=0 turns it off. */
const LEAN = (opts) => !(opts && opts.full) && (env("BACKUP_LEAN") ? env("BACKUP_LEAN") !== "0" : EXTERNAL());
const LEAN_SKIP_TABLES = () => (env("BACKUP_LEAN_SKIP_TABLES") || "doc_files").split(",").map((s) => s.trim()).filter(Boolean);
const LEAN_STRIP_TABLES = () => (env("BACKUP_LEAN_STRIP_TABLES") || "doc_pages").split(",").map((s) => s.trim()).filter(Boolean);

let ready = null, running = false, timer = null, nextCheck = 0;   // nextCheck: do not query the database again before this time
function ensure() {
  return ready || (ready = query("CREATE TABLE IF NOT EXISTS backup_settings (key VARCHAR(40) PRIMARY KEY, value TEXT NOT NULL DEFAULT '')").catch((e) => { ready = null; throw e; }));
}
async function getSettings() {
  await ensure();
  const v = Object.fromEntries((await query("SELECT key,value FROM backup_settings")).rows.map((r) => [r.key, r.value]));
  return {
    emails: v.emails != null ? v.emails : env("EMAIL_TO"),
    enabled: v.enabled == null ? true : v.enabled === "1",
    hours: Math.max(1, Number(v.hours) || Number(env("BACKUP_EVERY_HOURS", EXTERNAL() ? "168" : "24")) || 24),
    onlyChanged: v.onlyChanged !== "0",
    includeCode: v.includeCode !== "0",
    includeShardFiles: v.shardFiles === "1",
    lastRun: v.lastRun || null, lastStatus: v.lastStatus || "", lastFingerprint: v.lastFingerprint || ""
  };
}
async function put(k, val) { await ensure(); await query("INSERT INTO backup_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [k, String(val)]); }
async function saveSettings(b) {
  const emails = String(b.emails || "").split(/[,;\s]+/).filter(Boolean);
  if (emails.some((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e))) throw Object.assign(new Error("One of the email addresses is not valid."), { status: 400 });
  await put("emails", emails.join(", ")); await put("enabled", b.enabled ? "1" : "0");
  await put("hours", Math.min(24 * 30, Math.max(1, Number(b.hours) || 24))); await put("onlyChanged", b.onlyChanged ? "1" : "0"); await put("includeCode", b.includeCode ? "1" : "0"); await put("shardFiles", b.includeShardFiles ? "1" : "0");
  nextCheck = 0;
  return getSettings();
}

/* ---------- what is in the database ---------- */
async function tableList() {
  const skip = new Set([...SKIP_TABLES(), "_failover_meta"]);
  return (await query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")).rows.map((r) => r.table_name).filter((t) => !skip.has(t));
}
/* cheap "did anything change" check: row counts + newest created/updated time of every table */
async function fingerprint() {
  const cols = (await query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('updated_at','created_at')")).rows;
  const stamp = {}; cols.forEach((c) => { (stamp[c.table_name] = stamp[c.table_name] || []).push(c.column_name); });
  const h = crypto.createHash("sha256");
  for (const t of (await tableList()).filter((x) => x !== "backup_settings")) {
    try {
      const q = `SELECT COUNT(*)::text AS c${(stamp[t] || []).map((c, i) => `, MAX("${c}")::text AS m${i}`).join("")} FROM "${t}"`;
      h.update(t + JSON.stringify((await query(q)).rows[0]));
    } catch { /* table vanished: ignore */ }
  }
  return h.digest("hex");
}
const ser = (rows) => JSON.stringify(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Buffer.isBuffer(v) ? { __b64: v.toString("base64") } : v]))));

/* ---------- website files ---------- */
const SKIP_DIR = new Set(["node_modules", ".git", "backups", ".cache"]);
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".env") || /\.(gz|br|pem|key|part)$/i.test(e.name) || /^backup-.*\.zip(\.enc)?$/.test(e.name)) continue;   // secrets, rebuildable copies, earlier backups
    const p = path.join(dir, e.name);
    if (path.resolve(p) === DIR()) continue;
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(p, out); } else if (e.isFile()) out.push(p);
  }
  return out;
}

async function buildBackup(opts = {}) {
  const s = opts.settings || (await getSettings()), zip = createZip(), stamp = new Date().toISOString();
  const tables = {}, errors = [];
  const lean = LEAN(opts), leanSkipped = [];
  for (const t of await tableList()) {
    try {
      let cols = "*";
      if (lean && LEAN_SKIP_TABLES().includes(t)) { leanSkipped.push(t); continue; }
      if (lean && LEAN_STRIP_TABLES().includes(t)) {   /* every column except the binary ones */
        const c = (await query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND udt_name<>'bytea' ORDER BY ordinal_position", [t])).rows;
        if (c.length) { cols = c.map((x) => `"${x.column_name}"`).join(","); leanSkipped.push(t + " (images)"); }
      }
      const rows = (await query(`SELECT ${cols} FROM "${t}"`)).rows; zip.add(`database/${t}.json`, ser(rows)); tables[t] = rows.length;
    }
    catch (e) { errors.push(`${t}: ${e.message}`); }
  }
  let files = 0;
  if (s.includeCode) for (const f of walk(ROOT, [])) { try { zip.add("website/" + path.relative(ROOT, f), fs.readFileSync(f)); files++; } catch { /* unreadable: skip */ } }
  const database = null;
  zip.add("MANIFEST.json", JSON.stringify({ site: SITE(), created: stamp, database, tables, websiteFiles: files, errors, lean: lean ? { note: "Binary data (document files / page images) is NOT in this backup; it is kept in the database itself.", left_out: leanSkipped } : false, note: "Restore database/*.json with backend/scripts/restore-backup.js. .env files are never included." }, null, 2));
  let buf = zip.finish(), name = `backup-${stamp.replace(/[:.]/g, "-").slice(0, 19)}.zip`;
  if (env("BACKUP_PASSPHRASE")) { buf = encrypt(buf, env("BACKUP_PASSPHRASE")); name += ".enc"; }
  return { buf, name, tables, files, errors };
}

/* ---------- full backup written to disk (with the files from every database) ---------- */
const progress = { running: false };
const prog = (patch) => Object.assign(progress, patch);
const q = (t) => '"' + String(t).replace(/"/g, '""') + '"';

/* Rows of a table that holds binary data are fetched in groups of about CHUNK_BYTES, so memory stays small even with big old files stored inline. */
async function tableChunks(t) {
  const bytea = (await query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND udt_name='bytea' ORDER BY ordinal_position", [t])).rows.map((r) => r.column_name);
  if (!bytea.length) return null;
  const pk = (await query(`SELECT a.attname AS n FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY array_position(i.indkey::int2[], a.attnum)`, ["public." + q(t)])).rows.map((r) => r.n);
  const order = pk.length ? pk.map(q).join(",") : "ctid";
  const sizes = (await query(`SELECT ${bytea.map((c) => `COALESCE(octet_length(${q(c)}),0)`).join("+")} AS sz FROM ${q(t)} ORDER BY ${order}`)).rows.map((r) => Number(r.sz));
  const chunks = []; let from = 0, acc = 0;
  for (let i = 0; i < sizes.length; i++) {
    acc += sizes[i] + 200;
    if (acc >= CHUNK_BYTES() || i === sizes.length - 1) { chunks.push({ offset: from, limit: i - from + 1, order }); from = i + 1; acc = 0; }
  }
  return chunks;
}

/* Every file of every database -> shards/db<N>/<id>.bin, read in small batches. Returns what it saved per database. */
async function addShardFiles(zip, errors, total) {
  const out = {};
  if (!SH.enabled()) return out;
  for (const d of SH.databases()) {
    const i = SH.idxOf(d.n), info = { files: 0, bytes: 0 };
    out["db" + d.n] = info;
    try {
      const index = []; let after = 0;
      for (;;) {
        const page = await SH.listBlobs(i, after, 500);
        if (!page.length) break;
        after = page[page.length - 1].id;
        for (let a = 0; a < page.length;) {                       /* batches of at most BLOB_BATCH bytes (or 40 files) */
          let b = a, sz = 0; while (b < page.length && b - a < 40 && (b === a || sz + page[b].size <= BLOB_BATCH())) sz += page[b++].size;
          const got = await SH.readBlobs(i, page.slice(a, b).map((x) => x.id)), byId = new Map(got.map((x) => [x.id, x]));
          for (const m of page.slice(a, b)) {
            const g = byId.get(m.id);
            if (!g || !g.data) { errors.push(`database ${d.n}: file ${m.id} could not be read`); continue; }
            if (g.data.length !== m.size) errors.push(`database ${d.n}: file ${m.id} has ${g.data.length} bytes, expected ${m.size}`);
            await zip.add(`shards/db${d.n}/${m.id}.bin`, g.data, { level: 1 });
            index.push({ id: m.id, size: g.data.length, created: m.created }); info.files++; info.bytes += g.data.length;
            prog({ blobsDone: total.done = (total.done || 0) + 1, bytes: (progress.bytes || 0) + g.data.length });
          }
          a = b;
        }
      }
      await zip.add(`shards/db${d.n}/_index.json`, JSON.stringify(index));
    } catch (e) { info.error = e.message; errors.push(`database ${d.n}: ${e.message}`); }
  }
  return out;
}

async function buildBackupFile(opts = {}) {
  const s = opts.settings || (await getSettings()), stamp = new Date().toISOString(), errors = [], tables = {}, parts = {};
  const name = `backup-full-${stamp.replace(/[:.]/g, "-").slice(0, 19)}.zip`;
  fs.mkdirSync(DIR(), { recursive: true });
  const tmp = path.join(DIR(), name + ".part");
  const zip = await createZipFile(tmp, { level: 6 });
  try {
    const list = await tableList();
    let blobsTotal = 0, blobBytes = 0;
    if (SH.enabled()) for (const d of SH.databases()) { try { const t = await SH.blobTotals(SH.idxOf(d.n)); blobsTotal += t.n; blobBytes += t.bytes; } catch (e) { /* reported when the files are read */ } }
    prog({ running: true, full: true, phase: "database tables", startedAt: stamp, tablesTotal: list.length, tablesDone: 0, blobsTotal, blobsBytesTotal: blobBytes, blobsDone: 0, bytes: 0, name, error: null, finished: null });
    for (const t of list) {
      try {
        const ch = await tableChunks(t);
        if (!ch) { const rows = (await query(`SELECT * FROM ${q(t)}`)).rows; await zip.add(`database/${t}.json`, ser(rows)); tables[t] = rows.length; }
        else {
          tables[t] = 0; parts[t] = ch.length;
          if (!ch.length) await zip.add(`database/${t}.part00001.json`, "[]");
          for (let k = 0; k < ch.length; k++) {
            const rows = (await query(`SELECT * FROM ${q(t)} ORDER BY ${ch[k].order} LIMIT ${ch[k].limit} OFFSET ${ch[k].offset}`)).rows;
            await zip.add(`database/${t}.part${String(k + 1).padStart(5, "0")}.json`, ser(rows)); tables[t] += rows.length;
          }
        }
      } catch (e) { errors.push(`${t}: ${e.message}`); }
      prog({ tablesDone: progress.tablesDone + 1 });
    }
    prog({ phase: "files on the databases" });
    const shards = await addShardFiles(zip, errors, {});
    let files = 0;
    if (s.includeCode) { prog({ phase: "website files" }); for (const f of walk(ROOT, [])) { try { await zip.add("website/" + path.relative(ROOT, f), fs.readFileSync(f)); files++; } catch { /* unreadable: skip */ } } }
    await zip.add("MANIFEST.json", JSON.stringify({ site: SITE(), created: stamp, full: true, tables, tableParts: parts, shards, websiteFiles: files, errors,
      note: "Tables with binary data are split in database/<table>.partNNNNN.json. Files from DATABASE_URL<N> are in shards/db<N>/<id>.bin (the tables keep pointers to them). Restore with backend/scripts/restore-backup.js <this folder>/database; .env files are never included." }, null, 2));
    prog({ phase: "closing the file" });
    const { size } = await zip.finish();
    let final = path.join(DIR(), name), outName = name;
    if (env("BACKUP_PASSPHRASE")) { prog({ phase: "encrypting" }); outName = name + ".enc"; final = path.join(DIR(), outName); await encryptFile(tmp, final, env("BACKUP_PASSPHRASE")); fs.unlinkSync(tmp); }
    else fs.renameSync(tmp, final);
    const sizeOut = fs.statSync(final).size;
    rotate();
    return { path: final, name: outName, size: sizeOut, tables, files, errors, shards, full: true, rawSize: size };
  } catch (e) { await zip.abort(); try { fs.unlinkSync(tmp + ".enc"); } catch { /* ignore */ } throw e; }
}



/* ---------- local copies ---------- */
const LOCAL_RE = /^backup-(full-)?[0-9T-]+\.zip(\.enc)?$/;
function rotate() {
  try {
    const all = fs.readdirSync(DIR());
    const del = (f) => { try { fs.unlinkSync(path.join(DIR(), f)); } catch { /* ignore */ } };
    all.filter((f) => /^backup-full-[0-9T-]+\.zip(\.enc)?$/.test(f)).sort().reverse().slice(FULL_KEEP()).forEach(del);
    all.filter((f) => /^backup-[0-9T-]+\.zip(\.enc)?$/.test(f)).sort().reverse().slice(KEEP()).forEach(del);
    all.filter((f) => f.endsWith(".part") && Date.now() - fs.statSync(path.join(DIR(), f)).mtimeMs > 24 * 3600 * 1000).forEach(del);   /* leftovers of a backup that was cut off */
  } catch { /* ignore */ }
}
function saveLocal(name, buf) {
  try { fs.mkdirSync(DIR(), { recursive: true }); fs.writeFileSync(path.join(DIR(), name), buf); rotate(); return true; }
  catch (e) { console.warn("[BACKUP] could not save a local copy:", e.message); return false; }
}
function listLocal() {
  try { return fs.readdirSync(DIR()).filter((f) => LOCAL_RE.test(f)).map((f) => { const st = fs.statSync(path.join(DIR(), f)); return { name: f, size: st.size, full: f.startsWith("backup-full-"), modified: st.mtime }; }).sort((a, b) => (a.name < b.name ? 1 : -1)); } catch { return []; }
}
function localPath(name) { return LOCAL_RE.test(name) ? path.join(DIR(), name) : null; }

/* ---------- delivery ---------- */
async function sendTelegram(name, size, getBuf, caption) {
  const tok = env("TELEGRAM_BOT_TOKEN"), chat = env("TELEGRAM_CHAT_ID");
  if (!tok || !chat) return null;
  try {
    const big = size > 49 * 1048576, fd = new FormData();
    fd.append("chat_id", chat);
    if (big) { fd.append("text", caption + "\n(File is over Telegram's 50 MB limit: download it in Admin > Backup.)"); }
    else { fd.append("caption", caption); fd.append("document", new Blob([getBuf()]), name); }
    const r = await fetch(`https://api.telegram.org/bot${tok}/${big ? "sendMessage" : "sendDocument"}`, { method: "POST", body: fd, signal: AbortSignal.timeout(180000) });
    return r.ok ? (big ? "message only" : "sent") : "failed (" + r.status + ")";
  } catch (e) { return "failed (" + e.message + ")"; }
}
const mb = (n) => (n / 1048576).toFixed(1) + " MB";

const busyOther = () => { try { return require("./shardTools").moveRunning(); } catch { return false; } };
async function runBackup({ reason = "manual", force = true, withFiles } = {}) {
  if (running) throw Object.assign(new Error("A backup is already running."), { status: 409 });
  if (busyOther()) throw Object.assign(new Error("Files are being moved to the other databases right now. Try again when that has finished (Shards screen)."), { status: 409 });
  running = true;
  try {
    const s = await getSettings();
    const full = withFiles == null ? !!(s.includeShardFiles && SH.enabled()) : !!withFiles;
    const fp = await fingerprint();
    if (!force && s.onlyChanged && fp === s.lastFingerprint) return { skipped: true, message: "Nothing changed since the last backup." };
    prog({ running: true, full, phase: full ? "starting" : "database tables", startedAt: new Date().toISOString(), finished: null, error: null, ok: null, name: null, tablesDone: 0, tablesTotal: 0, blobsDone: 0, blobsTotal: 0, bytes: 0 });
    const b = full ? await buildBackupFile({ settings: s }) : await buildBackup({ settings: s });
    if (!full) saveLocal(b.name, b.buf);
    const bsize = full ? b.size : b.buf.length, getBuf = () => (b.buf || fs.readFileSync(b.path));
    const to = s.emails.split(/[,;\s]+/).filter(Boolean), out = { name: b.name, size: bsize, tables: Object.keys(b.tables).length, files: b.files, errors: b.errors, email: "not sent", telegram: null, full, shards: b.shards || null };
    const when = new Date().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }), attach = bsize <= MAX_MAIL();
    if (to.length && mailer.isConfigured()) {
      try {
        const rowsTotal = Object.values(b.tables).reduce((a, n) => a + n, 0);
        await mailer.send({
          to: to.join(","), subject: `[${SITE()}] Website backup${full ? " (with files)" : ""} ${when}${attach ? "" : " (download from admin)"}`,
          html: `<div style="font-family:Arial,sans-serif;max-width:520px;color:#1e1b4b"><h2 style="color:#5b21b6;margin:0 0 10px">${SITE()} backup</h2><p>Created ${when} (${reason}).</p>
            <p>${Object.keys(b.tables).length} database tables (${rowsTotal} rows)${full ? ", the uploaded files from every database" : ""} and ${b.files} website files, ${mb(bsize)}.</p>
            <p>${attach ? "The backup is attached." : "The file is larger than the email limit, so it is not attached. Download it from <b>Admin &gt; Backup</b>."}</p>
            ${env("BACKUP_PASSPHRASE") ? "<p>It is encrypted with your BACKUP_PASSPHRASE.</p>" : "<p style='color:#b45309'>It is not encrypted and contains user data. Keep it private, or set BACKUP_PASSPHRASE.</p>"}
            ${b.errors.length ? `<p style="color:#b91c1c">Some tables could not be read: ${b.errors.join("; ")}</p>` : ""}</div>`,
          text: `${SITE()} backup ${when} (${reason}). ${Object.keys(b.tables).length} tables, ${b.files} files, ${mb(bsize)}. ${attach ? "Attached." : "Too large to attach: download it from Admin > Backup."}`,
          attachments: attach ? [{ filename: b.name, content: getBuf().toString("base64") }] : []
        });
        out.email = attach ? "sent to " + to.join(", ") : "sent without attachment (too large)";
      } catch (e) { out.email = "failed: " + e.message; }
    } else if (!to.length) out.email = "no email address set";
    else out.email = "email is not configured on the server";
    out.telegram = await sendTelegram(b.name, bsize, getBuf, `${SITE()} backup ${when} (${mb(bsize)})`);
    /* with files the copy on the server is the real result (it is usually too big to attach), so a failed email alone is not a problem there */
    const ok = !b.errors.length && (full || !/^failed/.test(out.email) || (out.telegram && !/^failed/.test(out.telegram)));
    await put("lastFingerprint", fp); await put("lastRun", new Date().toISOString());
    await put("lastStatus", `${ok ? "OK" : "PROBLEM"}: ${b.name} (${mb(bsize)})${full ? " with files" : ""}${b.errors.length ? "; " + b.errors.length + " read error(s), see the server log" : ""}; email: ${out.email}${out.telegram ? "; telegram: " + out.telegram : ""}`);
    if (b.errors.length) console.warn("[BACKUP] read errors:", b.errors.slice(0, 10).join(" | "));
    prog({ running: false, phase: "done", ok, finished: new Date().toISOString(), name: b.name });
    return out;
  } catch (e) { prog({ running: false, phase: "failed", ok: false, error: e.message, finished: new Date().toISOString() }); throw e; }
  finally { running = false; }
}

/* "Full backup with files": answers at once, the work continues in the background (progress is in status().job). */
function startFullBackup(reason) {
  if (running) throw Object.assign(new Error("A backup is already running."), { status: 409 });
  if (busyOther()) throw Object.assign(new Error("Files are being moved to the other databases right now. Try again when that has finished."), { status: 409 });
  prog({ running: true, full: true, phase: "starting", error: null, ok: null, finished: null, bytes: 0, blobsDone: 0, tablesDone: 0 });
  runBackup({ reason, force: true, withFiles: true }).then((r) => console.log("[BACKUP] full backup done:", r.name, r.email)).catch((e) => console.error("[BACKUP] full backup failed:", e.message));
  return { started: true };
}

async function tick() {
  try {
    if (running || Date.now() < nextCheck) return;   // not due yet: no database query
    const s = await getSettings();
    if (!s.enabled) { nextCheck = Date.now() + 6 * 3600 * 1000; return; }   // saving the settings resets this
    if (s.lastRun && Date.now() - new Date(s.lastRun).getTime() < s.hours * 3600 * 1000) { nextCheck = new Date(s.lastRun).getTime() + s.hours * 3600 * 1000; return; }
    const r = await runBackup({ reason: "automatic", force: false });
    nextCheck = 0;   // re-read lastRun on the next tick
    if (r.skipped) console.log("[BACKUP] skipped:", r.message); else console.log("[BACKUP] done:", r.name, r.email);
  } catch (e) { console.error("[BACKUP] automatic backup failed:", e.message); }
}
function start() { if (timer) return; timer = setInterval(tick, 15 * 60 * 1000); setTimeout(tick, 2 * 60 * 1000); }

async function status() {
  const s = await getSettings(), next = s.enabled && s.lastRun ? new Date(new Date(s.lastRun).getTime() + s.hours * 3600 * 1000).toISOString() : null;
  let freeMB = null; try { const st = fs.statfsSync(fs.existsSync(DIR()) ? DIR() : ROOT); freeMB = Math.round(Number(st.bavail) * Number(st.bsize) / 1048576); } catch { /* not available */ }
  return { settings: s, next, running, job: { ...progress }, freeMB, shardFiles: SH.enabled() ? SH.count : 0, fullKeep: FULL_KEEP(), mail: { provider: mailer.provider(), configured: mailer.isConfigured() }, telegram: !!(env("TELEGRAM_BOT_TOKEN") && env("TELEGRAM_CHAT_ID")), encrypted: !!env("BACKUP_PASSPHRASE"), maxEmailMB: MAX_MAIL() / 1048576, files: listLocal() };
}
module.exports = { start, status, getSettings, saveSettings, runBackup, startFullBackup, buildBackup, buildBackupFile, listLocal, localPath, decrypt, decryptFile, isRunning: () => running };
