"use strict";
/*
 * File storage spread over several Neon databases.
 *
 *   DATABASE_URL1 .. DATABASE_URLn   one Neon database each. DATABASE_URL1 is also the MAIN database (users, orders, text, settings).
 *
 * Every uploaded file (library documents, their page images, order attachments, citation documents) is stored in a small table
 * "blob_store" on ONE of those databases. The main table keeps only a tiny pointer ("\0SHRD1:<db number>:<id>") in the same BYTEA
 * column that used to hold the file, so nothing else in the code changes and OLD files that are still stored directly keep working.
 *
 * Which database gets the next file: strictly one after the other (file 1 -> DATABASE_URL1, file 2 -> DATABASE_URL2, ... then
 * round again). A database is skipped while it is "full": storage >= SHARD_STOP_PERCENT of SHARD_STORAGE_LIMIT_MB, or this month's
 * transfer >= SHARD_STOP_PERCENT of SHARD_TRANSFER_LIMIT_MB. Reading an existing file always works, even from a full database.
 *
 * All pages and the original file of ONE document are kept together on the database that was picked for that document.
 */
const { Pool } = require("pg");
const { urls } = require("./dbEnv");

const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
const STORAGE_MB = () => num("SHARD_STORAGE_LIMIT_MB", 512);
const TRANSFER_MB = () => num("SHARD_TRANSFER_LIMIT_MB", 5120);
const STOP = () => Math.min(100, num("SHARD_STOP_PERCENT", 95)) / 100;
const CHECK_MS = 60 * 1000;
const { MAGIC, isPtr, mkPtr, parsePtr } = require("./shardPtr");

const N = urls.length;
const pools = new Array(N).fill(null);
const ready = new Array(N).fill(null);          /* promise: blob_store table exists on that database */
const stat = urls.map(() => ({ at: 0, bytes: 0, month: 0, pendingStore: 0 }));   /* cached usage per database */
const pend = new Map();                         /* "<shard>|<yyyy-mm>" -> bytes moved since the last flush */
let main = null;                                /* the main pool (for the round-robin counter and the transfer table) */
const mainQ = (t, p) => { if (!main) main = require("./database").pool; return main.query(t, p); };

const ym = () => new Date().toISOString().slice(0, 7);
const enabled = () => N > 0 || lfsOn();

function pool(i) {
  if (!pools[i]) {
    const url = urls[i].url;
    const p = new Pool({ connectionString: url, max: num("SHARD_POOL_MAX", 2), idleTimeoutMillis: num("PG_IDLE_MS", 20000),
      connectionTimeoutMillis: num("PG_CONNECT_TIMEOUT_MS", 30000), keepAlive: true });
    p.on("error", (e) => console.warn("[SHARD " + urls[i].n + "] idle connection dropped:", e.message));
    pools[i] = p;
  }
  return pools[i];
}
function ensure(i) {
  if (!ready[i]) ready[i] = pool(i).query("CREATE TABLE IF NOT EXISTS blob_store (id BIGSERIAL PRIMARY KEY, data BYTEA NOT NULL, size_bytes INT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())")
    .catch((e) => { ready[i] = null; throw e; });
  return ready[i];
}
const idxOf = (n) => urls.findIndex((u) => u.n === n);

/* ---------- files on the owner's laptop (FILE_STORE_URL) ----------
 * When FILE_STORE_URL is set, every new file goes to the small file server that runs on the laptop (laptop/file-server.js, reached
 * through a Cloudflare Tunnel or Tailscale Funnel) instead of a database. The pointer is the same kind as for a shard, with the
 * reserved database number 99:  "\0SHRD1:99:<file id>". Older pointers (databases 1..N) keep working. */
const LFS_SHARD = 99;
const lfsUrl = () => String(process.env.FILE_STORE_URL || "").trim().replace(/\/+$/, "");
const lfsOn = () => !!lfsUrl();
async function lfsCall(method, p, body, extra) {
  const url = lfsUrl() + p;
  const headers = Object.assign({ Authorization: "Bearer " + String(process.env.FILE_STORE_TOKEN || "").trim() }, extra || {});
  if (body) headers["Content-Type"] = "application/octet-stream";
  let last;
  for (let k = 0; k < 3; k++) {
    try {
      const r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(num("FILE_STORE_TIMEOUT_MS", 120000)) });
      if (r.status === 404) return null;
      if (r.status >= 500) throw new Error("file server answered " + r.status);
      if (!r.ok) throw Object.assign(new Error("file server refused (" + r.status + "): " + (await r.text()).slice(0, 200)), { status: 502, final: true });
      return r;
    } catch (e) {
      last = e; if (e.final) throw e;
      await new Promise((res) => setTimeout(res, 500 * (k + 1) * (k + 1)));
    }
  }
  throw Object.assign(new Error("The file storage (owner's computer) is not reachable right now: " + (last && last.message)), { status: 503 });
}
async function lfsStore(buf) {
  const sha = require("crypto").createHash("sha256").update(buf).digest("hex");
  const r = await lfsCall("POST", "/files", buf, { "X-Content-SHA256": sha });
  const j = await r.json();
  return mkPtr(LFS_SHARD, j.id);
}
async function lfsGet(id) { const r = await lfsCall("GET", "/files/" + id); return r ? Buffer.from(await r.arrayBuffer()) : null; }
async function lfsDelete(id) { try { await lfsCall("DELETE", "/files/" + id); } catch (e) { /* the file stays on the laptop; harmless */ } }

/* ---------- transfer counter (monthly, kept in the main database) ---------- */
async function initTables() {
  await mainQ("CREATE TABLE IF NOT EXISTS blob_rr (id SMALLINT PRIMARY KEY, nxt BIGINT NOT NULL)");
  await mainQ("CREATE TABLE IF NOT EXISTS blob_transfer (shard SMALLINT NOT NULL, ym CHAR(7) NOT NULL, bytes BIGINT NOT NULL DEFAULT 0, PRIMARY KEY (shard, ym))");
  if (enabled()) console.log("[SHARDS] " + N + " Neon database(s) for file storage: " + urls.map((u) => { try { return u.n + "=" + new URL(u.url).host.split(".")[0]; } catch (e) { return u.n; } }).join(", "));
}
function addTransfer(i, bytes) { const k = i + "|" + ym(); pend.set(k, (pend.get(k) || 0) + bytes); stat[i].month += bytes; }
async function flushTransfer() {
  for (const [k, b] of [...pend]) {
    pend.delete(k);
    const [i, m] = k.split("|");
    try { await mainQ("INSERT INTO blob_transfer(shard,ym,bytes) VALUES($1,$2,$3) ON CONFLICT (shard,ym) DO UPDATE SET bytes=blob_transfer.bytes+EXCLUDED.bytes", [urls[Number(i)].n, m, Math.round(b)]); }
    catch (e) { pend.set(k, (pend.get(k) || 0) + b); }
  }
}

/* ---------- how full is each database ---------- */
async function refresh(i) {
  const s = stat[i];
  if (Date.now() - s.at < CHECK_MS) return s;
  s.at = Date.now();
  try {
    s.bytes = Number((await pool(i).query("SELECT pg_database_size(current_database()) AS b")).rows[0].b);
    s.pendingStore = 0;
    const r = await mainQ("SELECT bytes FROM blob_transfer WHERE shard=$1 AND ym=$2", [urls[i].n, ym()]);
    s.month = Number(r.rows[0] ? r.rows[0].bytes : 0) + (pend.get(i + "|" + ym()) || 0);
  } catch (e) { s.err = e.message; }
  return s;
}
async function writable(i) {
  const s = await refresh(i);
  if (s.err && !s.bytes) return false;                                        /* unreachable and never measured: skip it */
  const used = (s.bytes + s.pendingStore) / 1048576, moved = s.month / 1048576;
  return used < STORAGE_MB() * STOP() && moved < TRANSFER_MB() * STOP();
}

/* The database that gets the next file: strict rotation, skipping full ones. Returns the 0-based index. */
async function pick() {
  if (!enabled() || lfsOn()) return -1;
  const c = Number((await mainQ("INSERT INTO blob_rr(id,nxt) VALUES(1,1) ON CONFLICT (id) DO UPDATE SET nxt=blob_rr.nxt+1 RETURNING nxt")).rows[0].nxt);
  for (let k = 0; k < N; k++) { const i = (c - 1 + k) % N; if (await writable(i)) return i; }
  throw Object.assign(new Error("File storage is full on all " + N + " databases (stop level " + Math.round(STOP() * 100) + "%). Add another DATABASE_URL" + (N + 1) + " or free some space."), { status: 507 });
}

/* Stores one file; returns the pointer to keep in the BYTEA column (or the buffer itself when sharding is off / the file is empty). */
async function store(buf, shard, opts) {
  const skip0 = !!(opts && opts.skipMain);
  if (lfsOn() && Buffer.isBuffer(buf) && buf.length) return lfsStore(buf);
  if (!enabled() || !Buffer.isBuffer(buf) || !buf.length) return buf;
  let i = shard == null || shard < 0 ? await pick() : shard;
  const tried = new Set();
  for (let k = 0; k <= N; k++) {
    tried.add(i);
    try {
      await ensure(i);
      const r = await pool(i).query("INSERT INTO blob_store(data,size_bytes) VALUES($1,$2) RETURNING id", [buf, buf.length]);
      stat[i].pendingStore += buf.length; addTransfer(i, buf.length);
      return mkPtr(urls[i].n, r.rows[0].id);
    } catch (e) {
      console.warn("[SHARD " + urls[i].n + "] store failed:", e.message);
      let nxt = -1; for (let j = 1; j <= N; j++) { const c = (i + j) % N; if (!tried.has(c) && !(skip0 && c === 0) && await writable(c)) { nxt = c; break; } }
      if (nxt < 0) throw e;
      i = nxt;
    }
  }
  throw new Error("Could not store the file on any database.");
}
/* 0-based database index a pointer lives on (-1 if it is not a pointer): keeps one document's files together */
const shardOf = (v) => { if (!isPtr(v)) return -1; const p = parsePtr(v); return p ? idxOf(p.shard) : -1; };
const storeMany = (bufs, shard) => Promise.all(bufs.map((b) => store(b, shard)));

/* Turns a pointer back into the file (anything that is not a pointer is returned unchanged). */
async function resolve(v) {
  if (!isPtr(v)) return v;
  const p = parsePtr(v); if (!p) return null;
  if (p.shard === LFS_SHARD) return lfsGet(p.id);
  const i = idxOf(p.shard); if (i < 0) throw new Error("File is on DATABASE_URL" + p.shard + ", which is not configured.");
  await ensure(i);
  const r = await pool(i).query("SELECT data FROM blob_store WHERE id=$1", [p.id]);
  const d = r.rows[0] ? r.rows[0].data : null;
  if (d) addTransfer(i, d.length);
  return d;
}
/* Resolves the named columns of one row (or of a list of rows) in place. */
async function resolveRow(row, cols) {
  if (!row) return row;
  for (const c of cols) if (row[c] != null) row[c] = await resolve(row[c]);
  return row;
}

async function remove(v) {
  if (!isPtr(v)) return;
  const p = parsePtr(v); if (p && p.shard === LFS_SHARD) return lfsDelete(p.id);
  const i = p ? idxOf(p.shard) : -1; if (i < 0) return;
  try { await ensure(i); await pool(i).query("DELETE FROM blob_store WHERE id=$1", [p.id]); } catch (e) { /* the sweeper retries */ }
}

/* ---------- housekeeping: files whose document / order was deleted (cascade) are removed from the shards ---------- */
const PTR_SOURCES = [["doc_files", "data"], ["doc_pages", "preview"], ["doc_pages", '"full"'], ["doc_pages", "bgimg"], ["submission_files", "data"], ["citation_uploads", "data"]];
async function sweepOrphans() {
  if (!enabled()) return { removed: 0 };
  const keep = urls.map(() => new Set());
  for (const [t, c] of PTR_SOURCES) {
    try {
      const rows = (await mainQ(`SELECT ${c} AS v FROM ${t} WHERE ${c} IS NOT NULL AND octet_length(${c}) < 64`)).rows;
      for (const r of rows) if (isPtr(r.v)) { const p = parsePtr(r.v), i = p ? idxOf(p.shard) : -1; if (i >= 0) keep[i].add(p.id); }
    } catch (e) { return { removed: 0, error: t + ": " + e.message }; }   /* a table is unreadable: never delete anything this round */
  }
  let removed = 0;
  for (let i = 0; i < N; i++) {
    try {
      await ensure(i);
      const ids = (await pool(i).query("SELECT id FROM blob_store WHERE created_at < NOW() - INTERVAL '1 day'")).rows.map((r) => Number(r.id)).filter((id) => !keep[i].has(id));
      for (let k = 0; k < ids.length; k += 200) { await pool(i).query("DELETE FROM blob_store WHERE id = ANY($1::bigint[])", [ids.slice(k, k + 200)]); removed += Math.min(200, ids.length - k); }
    } catch (e) { console.warn("[SHARD " + urls[i].n + "] sweep:", e.message); }
  }
  if (removed) console.log("[SHARDS] removed " + removed + " orphaned file(s)");
  return { removed };
}

/* ---------- admin report ---------- */
/* How many uploaded files sit on which database: library documents, order attachments, citation uploads (page images are counted in "blobs"). */
async function countsByShard() {
  const kinds = { documents: ["doc_files", "data"], orders: ["submission_files", "data"], citations: ["citation_uploads", "data"] };
  const per = urls.map(() => ({ documents: 0, orders: 0, citations: 0 })), inline = { documents: 0, orders: 0, citations: 0 };
  for (const [k, [t, c]] of Object.entries(kinds)) {
    try {
      const rows = (await mainQ(`SELECT ${c} AS v FROM ${t} WHERE ${c} IS NOT NULL AND octet_length(${c}) < 64`)).rows;
      for (const r of rows) if (isPtr(r.v)) { const i = shardOf(r.v); if (i >= 0) per[i][k]++; }
      inline[k] = Number((await mainQ(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} IS NOT NULL AND octet_length(${c}) >= 64`)).rows[0].n);
    } catch (e) { /* table not created yet */ }
  }
  return { per, inline };
}
async function report() {
  const out = [], cnt = await countsByShard();
  for (let i = 0; i < N; i++) {
    stat[i].at = 0; const s = await refresh(i);
    let blobs = null, blobMB = null; try { await ensure(i); const b = (await pool(i).query("SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS b FROM blob_store")).rows[0]; blobs = Number(b.n); blobMB = Math.round(Number(b.b) / 1048576 * 10) / 10; } catch (e) { /* ignore */ }
    let host = "?"; try { host = new URL(urls[i].url).host.split(".")[0]; } catch (e) { /* ignore */ }
    const used = s.bytes / 1048576, moved = s.month / 1048576;
    out.push({ database: urls[i].n, host, main: i === 0, usedMB: Math.round(used * 10) / 10, limitMB: STORAGE_MB(), storagePct: Math.round(used / STORAGE_MB() * 1000) / 10,
      transferMB: Math.round(moved * 10) / 10, transferLimitMB: TRANSFER_MB(), transferPct: Math.round(moved / TRANSFER_MB() * 1000) / 10,
      documents: cnt.per[i].documents, orders: cnt.per[i].orders, citations: cnt.per[i].citations, blobs, blobMB,
      files: cnt.per[i].documents + cnt.per[i].orders + cnt.per[i].citations + (i === 0 ? cnt.inline.documents + cnt.inline.orders + cnt.inline.citations : 0),
      accepting: await writable(i), error: s.err || null });
  }
  return out;
}

/* ---------- tools for the Shards screen, the backup and the scripts ---------- */
const limits = () => ({ storageLimitMB: STORAGE_MB(), transferLimitMB: TRANSFER_MB(), stopPercent: Math.round(STOP() * 100) });

/* Where pointers can live: [table, column, label]. The label groups them in the admin screen. */
const SOURCES = [["doc_files", "data", "documents"], ["doc_pages", "preview", "pages"], ["doc_pages", '"full"', "pages"], ["doc_pages", "bgimg", "pages"],
  ["submission_files", "data", "orders"], ["citation_uploads", "data", "citations"]];
const LABELS = { documents: "Library documents (original file)", pages: "Library page images", orders: "Order attachments", citations: "Citation uploads" };

/* Files still stored directly in the main database (older than the sharding): how many and how big, per kind. */
async function inlineSummary() {
  const out = {};
  for (const k of Object.keys(LABELS)) out[k] = { label: LABELS[k], count: 0, bytes: 0 };
  for (const [t, c, k] of SOURCES) {
    try {
      const r = (await mainQ(`SELECT COUNT(*) AS n, COALESCE(SUM(octet_length(${c})),0) AS b FROM ${t} WHERE ${c} IS NOT NULL AND octet_length(${c}) >= 64`)).rows[0];
      out[k].count += Number(r.n); out[k].bytes += Number(r.b);
    } catch (e) { /* table not created yet */ }
  }
  for (const k of Object.keys(out)) out[k].mb = Math.round(out[k].bytes / 1048576 * 10) / 10;
  return out;
}

/* Does every pointer in the main database lead to a file that exists? Reads ids only, never the files. */
async function verifyPointers() {
  const want = urls.map(() => new Set()), perTable = {}, unconfigured = new Set();
  let pointers = 0, laptop = 0;
  for (const [t, c] of SOURCES) {
    const key = t + "." + c.replace(/"/g, "");
    perTable[key] = { pointers: 0, missing: 0 };
    const rows = (await mainQ(`SELECT ${c} AS v FROM ${t} WHERE ${c} IS NOT NULL AND octet_length(${c}) < 64`).catch(() => ({ rows: [] }))).rows;
    for (const r of rows) {
      if (!isPtr(r.v)) continue;
      const p = parsePtr(r.v); if (!p) continue;
      pointers++; perTable[key].pointers++;
      if (p.shard === LFS_SHARD) { laptop++; continue; }   /* on the laptop file server; checked there, not here */
      const i = idxOf(p.shard);
      if (i < 0) { unconfigured.add(p.shard); perTable[key].missing++; continue; }
      want[i].add(p.id);
    }
  }
  const missing = [], unreachable = [];
  let ok = 0;
  for (let i = 0; i < N; i++) {
    const ids = [...want[i]]; if (!ids.length) continue;
    try {
      await ensure(i);
      const have = new Set();
      for (let k = 0; k < ids.length; k += 2000) (await pool(i).query("SELECT id FROM blob_store WHERE id = ANY($1::bigint[])", [ids.slice(k, k + 2000)])).rows.forEach((r) => have.add(Number(r.id)));
      for (const id of ids) { if (have.has(id)) ok++; else missing.push({ database: urls[i].n, id }); }
    } catch (e) { unreachable.push({ database: urls[i].n, error: e.message }); }
  }
  return { pointers, laptop, ok, missing: missing.length, missingSample: missing.slice(0, 30), unreachable, unconfigured: [...unconfigured], perTable };
}

/* The database (0-based index) for the next file that is MOVED away from the main database: DATABASE_URL2..N only, in turn, skipping full ones. */
let rrOther = 0;
async function pickOther() {
  if (N < 2) throw Object.assign(new Error("Only DATABASE_URL1 is set, so there is no other database to move files to. Add DATABASE_URL2 first."), { status: 400 });
  for (let k = 0; k < N - 1; k++) { const i = 1 + (rrOther++ % (N - 1)); if (await writable(i)) return i; }
  throw Object.assign(new Error("DATABASE_URL2.." + N + " are all full (stop level " + Math.round(STOP() * 100) + "%)."), { status: 507 });
}

/* Backup / export helpers: list a database's files without their data, then read them in small batches. */
async function listBlobs(i, afterId, limit) {
  await ensure(i);
  return (await pool(i).query("SELECT id, size_bytes, created_at FROM blob_store WHERE id > $1 ORDER BY id LIMIT $2", [afterId || 0, limit || 500])).rows
    .map((r) => ({ id: Number(r.id), size: Number(r.size_bytes), created: r.created_at }));
}
async function readBlobs(i, ids) {
  await ensure(i);
  const rows = (await pool(i).query("SELECT id, data, size_bytes FROM blob_store WHERE id = ANY($1::bigint[]) ORDER BY id", [ids])).rows;
  let bytes = 0; rows.forEach((r) => { bytes += r.data ? r.data.length : 0; });
  addTransfer(i, bytes);
  return rows.map((r) => ({ id: Number(r.id), data: r.data, size: Number(r.size_bytes) }));
}
/* Restore: puts files back under their ORIGINAL ids, so the pointers in the main database keep working. Existing ids are left alone. */
async function importBlobs(i, rows) {
  await ensure(i);
  let added = 0, same = 0; const differ = [];
  for (const r of rows) {
    const ins = await pool(i).query("INSERT INTO blob_store(id,data,size_bytes,created_at) VALUES($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING RETURNING id", [r.id, r.data, r.data.length, r.created || new Date()]);
    if (ins.rowCount) { added++; addTransfer(i, r.data.length); continue; }
    const e = (await pool(i).query("SELECT size_bytes FROM blob_store WHERE id=$1", [r.id])).rows[0];
    if (e && Number(e.size_bytes) === r.data.length) same++; else differ.push(r.id);
  }
  await pool(i).query("SELECT setval(pg_get_serial_sequence('blob_store','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM blob_store),1))");
  return { added, same, differ };
}
async function blobTotals(i) {
  await ensure(i);
  const r = (await pool(i).query("SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS b FROM blob_store")).rows[0];
  return { n: Number(r.n), bytes: Number(r.b) };
}
const databases = () => urls.map((u) => ({ n: u.n, main: u.n === urls[0].n }));

function start() {
  if (!enabled()) return;
  initTables().catch((e) => console.warn("[SHARDS] init:", e.message));
  setInterval(() => flushTransfer().catch(() => {}), 30 * 1000).unref();
  setTimeout(() => sweepOrphans().catch(() => {}), 6 * 3600 * 1000).unref();
  setInterval(() => sweepOrphans().catch(() => {}), 24 * 3600 * 1000).unref();
  const bye = () => { flushTransfer().catch(() => {}); };
  process.once("SIGTERM", bye); process.once("beforeExit", bye);
}

module.exports = { enabled, initTables, pick, pickOther, store, storeMany, resolve, resolveRow, remove, isPtr, shardOf, sweepOrphans, report, start, count: N,
  limits, inlineSummary, verifyPointers, listBlobs, readBlobs, importBlobs, blobTotals, idxOf, databases, flushTransfer, SOURCES, LABELS, writable };
