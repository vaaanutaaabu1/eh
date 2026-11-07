"use strict";
/* Moves the files that are ALREADY stored in your Neon databases (inside the tables, or in blob_store) to the laptop file server,
   and updates the pointers. Safe to repeat: finished rows are skipped. Old copies in Neon are NOT deleted.
     node laptop/migrate-files.js --dry     count only
     node laptop/migrate-files.js           do it
   Run it AFTER the new website version (with FILE_STORE_URL) is live, so every file stays readable the whole time. */
const path = require("path");
const crypto = require("crypto");
const L = require("./lib");
const { Client } = require(path.join(L.ROOT, "node_modules", "pg"));
const { isPtr, mkPtr, parsePtr } = require(path.join(L.ROOT, "backend", "config", "shardPtr.js"));

const LFS = 99;
const SOURCES = [["doc_files", "data"], ["doc_pages", "preview"], ["doc_pages", '"full"'], ["doc_pages", "bgimg"], ["submission_files", "data"], ["citation_uploads", "data"]];
const dry = process.argv.includes("--dry");
const base = "http://127.0.0.1:" + L.S.port;

async function upload(buf) {
  const r = await fetch(base + "/files", { method: "POST", body: buf, headers: { Authorization: "Bearer " + L.S.token, "Content-Type": "application/octet-stream", "X-Content-SHA256": crypto.createHash("sha256").update(buf).digest("hex") } });
  if (!r.ok) throw new Error("file server answered " + r.status + " " + (await r.text()).slice(0, 120));
  return (await r.json()).id;
}

(async () => {
  const dbs = L.liveDbs();
  if (!dbs.length) throw new Error("LIVE_DATABASE_URL1 is not set in laptop/laptop.env");
  if (!dry) { const h = await fetch(base + "/health").catch(() => null); if (!h || !h.ok) throw new Error("The file server is not running on this laptop. Start it first: npm run laptop:server"); }
  const clients = new Map();
  const client = async (n) => {
    if (!clients.has(n)) { const d = dbs.find((x) => x.n === n); if (!d) return null; const c = new Client({ connectionString: d.url }); await c.connect(); clients.set(n, c); }
    return clients.get(n);
  };
  const main = await client(1);
  const stats = { moved: 0, bytes: 0, already: 0, tiny: 0, missing: 0, failed: 0 };
  const cache = new Map();                       // old pointer -> new pointer (one blob can be used by several rows)

  for (const [table, col] of SOURCES) {
    let rows;
    try { rows = (await main.query(`SELECT ctid::text AS c, octet_length(${col}) AS n, CASE WHEN octet_length(${col}) < 64 THEN ${col} END AS v FROM ${table} WHERE ${col} IS NOT NULL`)).rows; }
    catch (e) { console.log(table + ": skipped (" + e.message + ")"); continue; }
    console.log(table + "." + col.replace(/"/g, "") + ": " + rows.length + " row(s)");
    let idx = 0;
    const worker = async () => {
      while (idx < rows.length) {
        const r = rows[idx++];
        try {
          let blob = null, key = null, n = Number(r.n);
          if (r.v && isPtr(r.v)) {
            const p = parsePtr(r.v);
            if (!p) { stats.failed++; continue; }
            if (p.shard === LFS) { stats.already++; continue; }
            key = p.shard + ":" + p.id;
            if (cache.has(key)) { if (!dry) { await main.query(`UPDATE ${table} SET ${col}=$1 WHERE ctid=$2::tid`, [cache.get(key), r.c]); } stats.moved++; continue; }
            const c = await client(p.shard);
            if (!c) { console.log("  no LIVE_DATABASE_URL" + p.shard + " in laptop.env, cannot read file " + key); stats.missing++; continue; }
            const b = await c.query("SELECT data FROM blob_store WHERE id=$1", [p.id]);
            blob = b.rows[0] ? b.rows[0].data : null;
            if (!blob) { stats.missing++; console.log("  file " + key + " does not exist in its database"); continue; }
          } else if (n >= 64) {
            blob = (await main.query(`SELECT ${col} AS d FROM ${table} WHERE ctid=$1::tid`, [r.c])).rows[0].d;
          } else { stats.tiny++; continue; }
          if (dry) { stats.moved++; stats.bytes += blob.length; continue; }
          const id = await upload(blob);
          const np = mkPtr(LFS, id);
          const u = await main.query(`UPDATE ${table} SET ${col}=$1 WHERE ctid=$2::tid`, [np, r.c]);
          if (!u.rowCount) { stats.failed++; console.log("  row changed while copying; run the script again"); continue; }
          if (key) cache.set(key, np);
          stats.moved++; stats.bytes += blob.length;
          if (stats.moved % 200 === 0) console.log("  moved " + stats.moved + " (" + (stats.bytes / 1048576).toFixed(0) + " MB)");
        } catch (e) { stats.failed++; console.log("  error: " + e.message); }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }
  for (const c of clients.values()) await c.end();
  console.log((dry ? "\nDRY RUN: would move " : "\nMoved ") + stats.moved + " file(s), " + (stats.bytes / 1048576).toFixed(1) + " MB. Already on laptop: " + stats.already + ". Missing: " + stats.missing + ". Failed: " + stats.failed + ".");
  if (!dry && !stats.failed && !stats.missing) console.log("Done. The old copies are still in Neon; delete them only after a good backup (npm run laptop:backup) and a few days of checking.");
  process.exit(stats.failed || stats.missing ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
