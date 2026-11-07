"use strict";
/*
 * Tools behind the admin "Shards" screen.
 *
 *  - move job   Files that were uploaded BEFORE the sharding still sit inside the main database (DATABASE_URL1). This copies them,
 *               one at a time, to DATABASE_URL2..N (in turn, skipping a database that is >= SHARD_STOP_PERCENT full) and puts a pointer
 *               in their place. Safe to stop and start again: only files that are still stored directly are touched.
 *               A document's file and its page images go to the SAME database. Nothing is deleted before the pointer is saved.
 *  - verify     checks that every pointer in the main database leads to a file that exists (reads ids only).
 *  - sweep      removes files on the shards that no row points to any more (also runs by itself once a day).
 */
const SH = require("../config/shards");
const { query } = require("../config/database");

const KINDS = ["documents", "orders", "citations"];
let job = null;                                   /* the current / last move job */
const tick = () => new Promise((r) => setImmediate(r));
const mb = (n) => Math.round(n / 1048576 * 10) / 10;

const moveRunning = () => !!(job && job.running);
function say(msg) { if (!job) return; job.log.push(new Date().toLocaleTimeString("en-GB") + "  " + msg); if (job.log.length > 300) job.log.splice(0, job.log.length - 300); }

/* Stores one file on `target` and swaps the pointer into the row (the pointer is $1, so `where` uses $2, $3 ...). false = the row changed meanwhile (the stored copy is removed again). */
async function swap(table, col, where, params, buf, target) {
  const ptr = await SH.store(buf, target, { skipMain: true });
  if (!SH.isPtr(ptr) || SH.shardOf(ptr) === 0) { await SH.remove(ptr); throw Object.assign(new Error("No database besides DATABASE_URL1 accepted the file."), { status: 507 }); }
  const r = await query(`UPDATE ${table} SET ${col}=$1 WHERE ${where} AND octet_length(${col})=$${params.length + 2}`, [ptr, ...params, buf.length]);
  if (!r.rowCount) { await SH.remove(ptr); return false; }
  job.movedBytes += buf.length;
  return true;
}
const inline = (b) => Buffer.isBuffer(b) && b.length >= 64;      /* shorter values are pointers (or empty): nothing to move */

async function moveDocs() {
  const ids = (await query(`SELECT d.id FROM docs d WHERE EXISTS (SELECT 1 FROM doc_files f WHERE f.doc_id=d.id AND octet_length(f.data) >= 64)
      OR EXISTS (SELECT 1 FROM doc_pages p WHERE p.doc_id=d.id AND (octet_length(p.preview) >= 64 OR octet_length(p."full") >= 64 OR octet_length(p.bgimg) >= 64)) ORDER BY d.id`)).rows.map((r) => r.id);
  job.total.documents = ids.length; say("Library: " + ids.length + " document(s) still stored in the main database.");
  for (const id of ids) {
    if (job.stop) return;
    try {
      const target = await SH.pickOther();                           /* one database for the whole document */
      const f = (await query("SELECT data FROM doc_files WHERE doc_id=$1", [id])).rows[0];
      if (f && inline(f.data) && await swap("doc_files", "data", "doc_id=$2", [id], f.data, target)) job.done.files++;
      const pages = (await query(`SELECT page_no FROM doc_pages WHERE doc_id=$1 AND (octet_length(preview) >= 64 OR octet_length("full") >= 64 OR octet_length(bgimg) >= 64) ORDER BY page_no`, [id])).rows;
      for (const pg of pages) {
        if (job.stop) return;
        const row = (await query('SELECT preview, "full" AS fullimg, bgimg FROM doc_pages WHERE doc_id=$1 AND page_no=$2', [id, pg.page_no])).rows[0] || {};
        for (const [col, val] of [["preview", row.preview], ['"full"', row.fullimg], ["bgimg", row.bgimg]]) {
          if (inline(val) && await swap("doc_pages", col, "doc_id=$2 AND page_no=$3", [id, pg.page_no], val, target)) job.done.pages++;
        }
        await tick();
      }
      job.done.documents++;
    } catch (e) { if (e.status === 507 || e.status === 400) throw e; job.failed++; say("Document " + id + " skipped: " + e.message); }
    await tick();
  }
}

async function moveRows(kind, table, countLabel) {
  let ids;
  try { ids = (await query(`SELECT id FROM ${table} WHERE octet_length(data) >= 64 ORDER BY id`)).rows.map((r) => r.id); }
  catch (e) { say(countLabel + ": table not found, skipped."); return; }
  job.total[kind] = ids.length; say(countLabel + ": " + ids.length + " file(s) still stored in the main database.");
  for (const id of ids) {
    if (job.stop) return;
    try {
      const row = (await query(`SELECT data FROM ${table} WHERE id=$1`, [id])).rows[0];
      if (row && inline(row.data) && await swap(table, "data", "id=$2", [id], row.data, await SH.pickOther())) job.done[kind]++;
    } catch (e) { if (e.status === 507 || e.status === 400) throw e; job.failed++; say(countLabel + " " + id + " skipped: " + e.message); }
    await tick();
  }
}

async function run(kinds) {
  try {
    if (kinds.includes("documents")) await moveDocs();
    if (!job.stop && kinds.includes("orders")) await moveRows("orders", "submission_files", "Order attachments");
    if (!job.stop && kinds.includes("citations")) await moveRows("citations", "citation_uploads", "Citation uploads");
    const moved = job.done.files + job.done.pages + job.done.orders + job.done.citations;
    if (moved) {                                                          /* plain VACUUM: the emptied space can be reused by new rows (it does not lock the tables) */
      job.phase = "tidying the main database";
      for (const t of ["doc_files", "doc_pages", "submission_files", "citation_uploads"]) { try { await query("VACUUM (ANALYZE) " + t); } catch (e) { /* table missing or not allowed: not important */ } }
    }
    job.phase = job.stop ? "stopped" : "finished";
    say((job.stop ? "Stopped. " : "Finished. ") + moved + " file(s), " + mb(job.movedBytes) + " MB moved" + (job.failed ? ", " + job.failed + " skipped" : "") + ".");
  } catch (e) { job.phase = "failed"; job.error = e.message; say("STOPPED: " + e.message); }
  finally { job.running = false; job.finishedAt = new Date().toISOString(); SH.flushTransfer().catch(() => {}); }
}

function moveStart(kinds) {
  if (SH.count < 2) throw Object.assign(new Error("Only DATABASE_URL1 is set. Add DATABASE_URL2 (a second Neon database) first."), { status: 400 });
  if (moveRunning()) throw Object.assign(new Error("A move is already running."), { status: 409 });
  let busy = false; try { busy = require("./backupService").isRunning(); } catch { /* ignore */ }
  if (busy) throw Object.assign(new Error("A backup is running right now. Start the move when it has finished."), { status: 409 });
  const k = [].concat(kinds || KINDS).filter((x) => KINDS.includes(x));
  if (!k.length) throw Object.assign(new Error("Choose what to move."), { status: 400 });
  job = { running: true, stop: false, phase: "running", startedAt: new Date().toISOString(), finishedAt: null, kinds: k, total: { documents: 0, orders: 0, citations: 0 },
    done: { documents: 0, files: 0, pages: 0, orders: 0, citations: 0 }, movedBytes: 0, failed: 0, error: null, log: [] };
  say("Started: " + k.join(", ") + ".");
  run(k);                                                                 /* runs in the background */
  return moveStatus();
}
function moveStop() { if (job && job.running) { job.stop = true; job.phase = "stopping after the current file"; say("Stop requested."); } return moveStatus(); }
function moveStatus() { return job ? { ...job, movedMB: mb(job.movedBytes), log: job.log.slice(-60) } : { running: false, phase: "idle", log: [] }; }

async function verify() { return SH.verifyPointers(); }
async function sweep() {
  if (moveRunning()) throw Object.assign(new Error("Wait until the move has finished."), { status: 409 });
  return SH.sweepOrphans();
}

async function overview() {
  const [databases, inl] = await Promise.all([SH.report(), SH.inlineSummary()]);
  const totalInline = Object.values(inl).reduce((a, x) => ({ count: a.count + x.count, bytes: a.bytes + x.bytes }), { count: 0, bytes: 0 });
  return { databases, inline: inl, inlineTotal: { count: totalInline.count, mb: mb(totalInline.bytes) }, limits: SH.limits(), configured: SH.count, job: moveStatus() };
}

module.exports = { moveStart, moveStop, moveStatus, moveRunning, verify, sweep, overview };
