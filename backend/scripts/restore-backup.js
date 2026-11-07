#!/usr/bin/env node
"use strict";
/*
 * Put a backup back.
 *   1) unzip the backup (decrypt it first if it ends in .enc)
 *   2) start the site once on the new databases (it creates the empty tables), stop it, then run:
 *        node backend/scripts/restore-backup.js <unzipped-folder>/database
 *        node backend/scripts/restore-backup.js <unzipped-folder>/database --shards <other folder with the db2, db3 ... folders>
 *
 * - Tables: rows that already exist are left alone (ON CONFLICT DO NOTHING), so it is safe on a fresh or a live database.
 *   Big tables are stored in parts (<table>.part00001.json ...); all parts are read.
 * - Files of a FULL backup (<unzipped-folder>/shards/db<N>/<id>.bin) go back to DATABASE_URL<N> under their ORIGINAL ids, so the pointers in the
 *   tables keep working. DATABASE_URL1..N in backend/.env must be the same numbers as when the backup was made (a new Neon database can take the
 *   place of an old one). A file id that already exists with different content is NOT overwritten and is reported.
 * - Website files are in <unzipped-folder>/website: copy them over your project (your own .env stays untouched).
 */
const path = require("path"), fs = require("fs");
try { require("dotenv").config({ path: path.join(__dirname, "..", ".env") }); } catch { /* optional */ }
const { query } = require("../config/database");

const argv = process.argv.slice(2);
const dir = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--shards");
const sIdx = argv.indexOf("--shards");
const shardsDir = sIdx >= 0 && argv[sIdx + 1] ? path.resolve(argv[sIdx + 1]) : dir ? path.join(path.resolve(dir), "..", "shards") : null;
if (!dir || !fs.existsSync(dir)) { console.error("Usage: node backend/scripts/restore-backup.js <folder with the .json files> [--shards <folder>]"); process.exit(1); }
const unb = (v) => (v && typeof v === "object" && v.__b64 != null ? Buffer.from(v.__b64, "base64") : v && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v);
const q = (t) => '"' + String(t).replace(/"/g, '""') + '"';

async function restoreTables() {
  const groups = new Map();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const m = /^(.+?)(\.part\d+)?\.json$/.exec(f); if (!m) continue;
    if (!groups.has(m[1])) groups.set(m[1], []);
    groups.get(m[1]).push(f);
  }
  let todo = [...groups].filter(([t]) => t !== "backup_settings").map(([table, files]) => ({ table, files, fi: 0, ri: 0, cur: null, total: 0 }));
  const all = todo.map((t) => t.table);
  for (let pass = 1; pass <= 4 && todo.length; pass++) {           // several passes so tables that reference others find their parents
    const left = [];
    for (const t of todo) {
      let failed = false;
      while (t.fi < t.files.length) {
        if (!t.cur) { t.cur = JSON.parse(fs.readFileSync(path.join(dir, t.files[t.fi]), "utf8")); if (t.ri === 0) t.total += t.cur.length; }
        for (; t.ri < t.cur.length; t.ri++) {
          const r = t.cur[t.ri], cols = Object.keys(r); if (!cols.length) continue;
          try { await query(`INSERT INTO ${q(t.table)} (${cols.map(q).join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")}) ON CONFLICT DO NOTHING`, cols.map((c) => unb(r[c]))); }
          catch (e) { failed = true; if (pass === 4) console.warn(`  ${t.table}: ${e.message}`); break; }
        }
        if (failed) break;
        t.fi++; t.ri = 0; t.cur = null;
      }
      if (failed) left.push(t); else console.log(`  ${t.table}: ${t.total} rows`);
    }
    todo = left;
  }
  /* rows were inserted with their old ids: move every id counter past the highest one, or the next upload would collide */
  for (const t of all) {
    try {
      const cols = (await query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_default LIKE 'nextval%'", [t])).rows;
      for (const c of cols) await query(`SELECT setval(pg_get_serial_sequence($1, $2), GREATEST((SELECT COALESCE(MAX(${q(c.column_name)}),1) FROM ${q(t)}),1))`, [q(t), c.column_name]);
    } catch { /* table missing: already reported */ }
  }
  return todo;
}

async function restoreFiles() {
  if (!shardsDir || !fs.existsSync(shardsDir)) { console.log("No shards folder next to the database folder: no files to put back (normal backup, or the files are still on the databases)."); return 0; }
  const SH = require("../config/shards");
  let problems = 0;
  for (const d of fs.readdirSync(shardsDir).filter((x) => /^db\d+$/.test(x)).sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)))) {
    const n = Number(d.slice(2)), i = SH.idxOf(n), folder = path.join(shardsDir, d);
    const ids = fs.readdirSync(folder).filter((x) => /^\d+\.bin$/.test(x)).map((x) => Number(x.slice(0, -4))).sort((a, b) => a - b);
    if (i < 0) { console.warn(`  DATABASE_URL${n} is not set in backend/.env: its ${ids.length} file(s) were NOT restored.`); problems++; continue; }
    let created = {}; try { for (const r of JSON.parse(fs.readFileSync(path.join(folder, "_index.json"), "utf8"))) created[r.id] = r.created; } catch { /* index is optional */ }
    let added = 0, same = 0, differ = [], batch = [], bytes = 0;
    const flush = async () => { if (!batch.length) return; const r = await SH.importBlobs(i, batch); added += r.added; same += r.same; differ.push(...r.differ); batch = []; bytes = 0; };
    for (const id of ids) {
      const data = fs.readFileSync(path.join(folder, id + ".bin"));
      batch.push({ id, data, created: created[id] ? new Date(created[id]) : null }); bytes += data.length;
      if (bytes >= 8 * 1048576 || batch.length >= 40) await flush();
    }
    await flush();
    console.log(`  DATABASE_URL${n}: ${added} file(s) restored, ${same} already there` + (differ.length ? `, ${differ.length} NOT restored because the id exists with different content (${differ.slice(0, 10).join(", ")})` : ""));
    if (differ.length) problems++;
  }
  return problems;
}

(async () => {
  const bad = await restoreTables();
  const fileProblems = await restoreFiles();
  console.log(bad.length ? `Finished with problems in: ${bad.map((t) => t.table).join(", ")}` : fileProblems ? "Restore finished, but some files were not restored (see above)." : "Restore finished.");
  process.exit(bad.length || fileProblems ? 2 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
