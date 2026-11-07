#!/usr/bin/env node
"use strict";
/*
 * Export every uploaded file in its ORIGINAL format to a normal folder on your computer.
 * Files can sit in the main database (older uploads) or on DATABASE_URL2..N (the file shards); both are handled.
 *
 *   A) straight from the databases named in backend/.env (DATABASE_URL1..N):
 *        npm run export-files
 *        npm run export-files -- --out D:\my-files
 *        npm run export-files -- --only library          (orders | library | citations; several: --only orders,library)
 *
 *   B) from a FULL backup zip you downloaded in Admin > Backup ("Full backup with files"; decrypt a .enc file with backup-tools.js, then unzip):
 *        npm run export-files -- --from-backup <unzipped folder>/database --out D:\my-files
 *      The files of the other databases are read from <unzipped folder>/shards (use --shards <folder> if you moved it).
 *      A normal / lean backup has no file data: it contains only pointers, so make a full backup for this.
 *
 * Output folders:
 *   orders/<order id>/       files customers attached to their orders
 *   library/                 original files of the Doc Library (named "<id> - <title>.<ext>")
 *   citations/               files uploaded in the citation tool
 *   _index.csv               everything exported: source, id, original name, saved path, size, stored_on (main / DB2 ...), note
 * Website pages / static pages are plain text, not binary files: they are in the backup's website/ folder
 * (tick "include code" in Admin > Backup) or in the database tables.
 * Exit code 2 = some files could not be read (they are listed with a note in _index.csv).
 */
const fs = require("fs"), path = require("path");
try { require("dotenv").config({ path: path.join(__dirname, "..", ".env") }); } catch { /* optional */ }
const { isPtr, parsePtr } = require("../config/shardPtr");

const args = process.argv.slice(2);
let fromBackup = null, out = path.resolve("exported-files"), shardsDir = null, only = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--from-backup") fromBackup = args[++i];
  else if (args[i] === "--out") out = path.resolve(args[++i]);
  else if (args[i] === "--shards") shardsDir = path.resolve(args[++i]);
  else if (args[i] === "--only") only = String(args[++i] || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
const want = (k) => !only || only.includes(k);

const EXT = { "application/pdf": ".pdf", "application/msword": ".doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx", "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx", "text/plain": ".txt", "text/csv": ".csv", "text/html": ".html",
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "application/zip": ".zip" };
const safe = (s, max = 120) => String(s == null ? "" : s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, max) || "file";
function withExt(name, mime) {
  if (path.extname(name)) return name;
  return name + (EXT[String(mime || "").toLowerCase()] || "");
}
function uniquePath(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  let p = path.join(dir, name), n = 1;
  const ext = path.extname(name), base = path.basename(name, ext);
  while (fs.existsSync(p)) p = path.join(dir, `${base} (${++n})${ext}`);
  return p;
}
function toBuffer(v) {
  if (!v) return Buffer.alloc(0);
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === "object" && v.__b64 != null) return Buffer.from(v.__b64, "base64");
  if (typeof v === "object") return Buffer.from(Object.values(v));      // a byte array that was saved as {"0":..,"1":..}
  return Buffer.from(String(v));
}

/* The stored value is either the file itself or a small pointer to a file on another database. Returns { buf, on, note }. */
let liveShards = null;
async function fetchFile(raw) {
  const v = toBuffer(raw);
  if (!isPtr(v)) return { buf: v, on: "main" };
  const p = parsePtr(v);
  if (!p) return { buf: Buffer.alloc(0), on: "?", note: "unreadable pointer" };
  const on = "DB" + p.shard;
  try {
    if (fromBackup) {
      const f = path.join(shardsDir, "db" + p.shard, p.id + ".bin");
      if (!fs.existsSync(f)) return { buf: Buffer.alloc(0), on, note: `file ${p.id} is not in the backup (${f}); was this a full backup with files?` };
      return { buf: fs.readFileSync(f), on };
    }
    if (!liveShards) liveShards = require("../config/shards");
    const d = await liveShards.resolve(v);
    return d ? { buf: d, on } : { buf: Buffer.alloc(0), on, note: `file ${p.id} no longer exists on DATABASE_URL${p.shard}` };
  } catch (e) { return { buf: Buffer.alloc(0), on, note: e.message }; }
}

const index = [["source", "id", "original_name", "saved_as", "bytes", "stored_on", "note"]];
let count = 0, skipped = 0, failed = 0; const perPlace = {};
async function save(source, id, dir, name, raw) {
  const f = await fetchFile(raw);
  if (f.note) { failed++; index.push([source, id, name, "", 0, f.on, f.note]); console.warn(`  ${source} ${id}: ${f.note}`); return; }
  if (!f.buf.length) { skipped++; return; }
  const p = uniquePath(dir, name);
  fs.writeFileSync(p, f.buf);
  index.push([source, id, name, path.relative(out, p), f.buf.length, f.on, ""]);
  perPlace[f.on] = (perPlace[f.on] || 0) + 1; count++;
}

/* ---------- source A: the live databases ---------- */
async function fromDatabase() {
  const { query } = require("../config/database");
  const tryRun = async (label, fn) => { try { await fn(); } catch (e) { console.warn(`  ${label}: skipped (${e.message})`); } };

  if (want("orders")) await tryRun("orders", async () => {
    const r = await query("SELECT f.id, f.original_file_name AS name, f.mime_type AS mime, COALESCE(s.order_id, 'order-' || f.submission_id::text) AS oid FROM submission_files f LEFT JOIN submissions s ON s.id = f.submission_id ORDER BY f.id");
    for (const row of r.rows) {
      const d = (await query("SELECT data FROM submission_files WHERE id=$1", [row.id])).rows[0];
      await save("order", row.id, path.join(out, "orders", safe(row.oid, 40)), safe(withExt(row.name, row.mime), 150), d && d.data);
    }
  });
  if (want("library")) await tryRun("library", async () => {
    const r = await query("SELECT d.id, d.title, d.filename, d.mime FROM docs d JOIN doc_files f ON f.doc_id = d.id ORDER BY d.id");
    for (const row of r.rows) {
      const d = (await query("SELECT data FROM doc_files WHERE doc_id=$1", [row.id])).rows[0];
      const base = row.filename ? row.filename : row.title;
      await save("library", row.id, path.join(out, "library"), safe(`${row.id} - ${withExt(base, row.mime)}`, 160), d && d.data);
    }
  });
  if (want("citations")) await tryRun("citations", async () => {
    const r = await query("SELECT id, filename FROM citation_uploads ORDER BY id");
    for (const row of r.rows) {
      const d = (await query("SELECT data FROM citation_uploads WHERE id=$1", [row.id])).rows[0];
      await save("citation", row.id, path.join(out, "citations"), safe(`${row.id} - ${row.filename || "file"}`, 160), d && d.data);
    }
  });
}

/* ---------- source B: an unzipped backup (database/*.json, big tables in <table>.partNNNNN.json) ---------- */
function tableFiles(dir, t) {
  const re = new RegExp("^" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\.part\\d+)?\\.json$");
  return fs.readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f));
}
function* rowsOf(dir, t) { for (const f of tableFiles(dir, t)) for (const r of JSON.parse(fs.readFileSync(f, "utf8"))) yield r; }   /* one part in memory at a time */
async function fromBackupFolder(dir) {
  const all = (t) => [...rowsOf(dir, t)];
  const subs = new Map(all("submissions").map((s) => [String(s.id), s]));
  if (want("orders")) for (const row of rowsOf(dir, "submission_files")) {
    const s = subs.get(String(row.submission_id));
    await save("order", row.id, path.join(out, "orders", safe((s && s.order_id) || "order-" + row.submission_id, 40)), safe(withExt(row.original_file_name, row.mime_type), 150), row.data);
  }
  if (want("library")) {
    const docs = new Map(all("docs").map((d) => [String(d.id), d]));
    for (const row of rowsOf(dir, "doc_files")) {
      const d = docs.get(String(row.doc_id)) || {};
      await save("library", row.doc_id, path.join(out, "library"), safe(`${row.doc_id} - ${withExt(d.filename || d.title || "document", d.mime)}`, 160), row.data);
    }
  }
  if (want("citations")) for (const row of rowsOf(dir, "citation_uploads")) {
    await save("citation", row.id, path.join(out, "citations"), safe(`${row.id} - ${row.filename || "file"}`, 160), row.data);
  }
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  if (fromBackup) {
    if (!fs.existsSync(fromBackup)) { console.error("Backup folder not found: " + fromBackup); process.exit(1); }
    fromBackup = path.resolve(fromBackup);
    if (!shardsDir) shardsDir = path.join(fromBackup, "..", "shards");
    console.log("Reading the backup in " + fromBackup);
    try {
      const m = JSON.parse(fs.readFileSync(path.join(fromBackup, "..", "MANIFEST.json"), "utf8"));
      if (m.lean) console.warn("NOTE: this backup was made without file data (lean). Only files stored directly in the tables can be exported; make a \"Full backup with files\" in Admin > Backup for the rest.");
      else if (!m.full) console.warn("NOTE: this is a normal backup, not a full backup with files. Files on the other databases are not in it.");
      if (m.errors && m.errors.length) console.warn("NOTE: the backup itself reported " + m.errors.length + " read error(s): see MANIFEST.json.");
    } catch { /* no manifest: fine */ }
    await fromBackupFolder(fromBackup);
  } else {
    console.log("Reading files from the databases in backend/.env ...");
    await fromDatabase();
  }
  const csv = index.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  fs.writeFileSync(path.join(out, "_index.csv"), csv);
  const where = Object.keys(perPlace).sort().map((k) => `${k}: ${perPlace[k]}`).join(", ");
  console.log(`Done: ${count} files saved to ${out}` + (where ? ` (${where})` : "") + (skipped ? ` (${skipped} empty entries skipped)` : ""));
  if (failed) console.warn(`WARNING: ${failed} file(s) could not be read. They are listed with a note in _index.csv.`);
  process.exit(failed ? 2 : 0);
})().catch((e) => { console.error("Export failed:", e.message); process.exit(1); });
