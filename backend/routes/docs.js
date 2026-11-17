"use strict";
const express = require("express");
const multer = require("multer");
const { query } = require("../config/database");
const { requireUser, optionalUser } = require("../middleware/userAuth");
const { chatRateLimit, uploadRateLimit } = require("../middleware/chatRateLimit");
const S = require("../services/docService");

const router = express.Router();
/* Uploading needs no account. A visitor gets an "ah_guest" cookie; the uploads are theirs and move to the account the moment they sign up or log in. */
const crypto = require("crypto");
const guestOf = (req) => { const m = /(?:^|;\s*)ah_guest=([a-f0-9]{24})/.exec(req.headers.cookie || ""); return m ? m[1] : ""; };
const guestCookie = (req, res, gid) => res.append("Set-Cookie", `ah_guest=${gid}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${req.secure || process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
const clearGuest = (res) => res.append("Set-Cookie", "ah_guest=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
/* Logged in with a guest cookie: hand the guest uploads to the account (once), then drop the cookie. */
router.use(optionalUser, (req, res, next) => {
  const g = guestOf(req);
  if (!g || !req.user) return next();
  S.claimGuest(g, req.user.id).then(() => { clearGuest(res); next(); }, () => next());
});
const creditsOf = (req) => (req.user ? S.uploadCredits(req.user.id) : S.guestCredits(guestOf(req)));
router.use((req, res, next) => { res.setHeader("X-Robots-Tag", "noindex, nofollow"); next(); });
/* Express 5 has no inline regex in paths: non-numeric ids (e.g. "plan") fall through to the other routes. */
router.param("id", (req, res, next, v) => (/^\d{1,18}$/.test(v) ? next() : next("route")));
const SH = require("../config/shards");
const { viewerOf, isDocAdmin } = require("../middleware/docAdmin");
const MAX_FILES = Math.max(1, Number(process.env.MAX_FILES || 20));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: Number(process.env.MAX_FILE_SIZE_MB || 20) * 1048576, files: MAX_FILES } });
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { if (!e.status || e.status >= 500) console.error("[DOCS] " + req.method + " " + req.originalUrl + " failed:", e && e.stack || e); return res.status(e.status || 500).json({ success: false, message: e.status ? e.message : "Something went wrong: " + String(e && e.message || e).slice(0, 160) }); });
const base = (req) => String(process.env.WEBSITE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
const card = (r) => ({ id: r.id, title: r.title, school: r.school, course: r.course, pages: r.page_count, kind: r.kind, thumb: r.thumb || "", bg: /^#[0-9a-f]{6}$/i.test(r.bg || "") ? r.bg : "", img: r.img ? `/api/docs/${r.id}/page/1?p=1&v=4` : "", url: S.urlFor(r) });

/* Upload: no courses. Title = what the user typed, else the file name, else the first heading in the document; the URL slug is that title. */
/* Files now upload in PARALLEL (all bytes arrive at once). Page rendering is memory-heavy, so only UPLOAD_CONCURRENCY files (default 4)
   are converted at the same time; the rest wait their turn on the server and show "Reading the pages" in the browser. */
const UPLOAD_CONCURRENCY = Math.max(1, Number(process.env.UPLOAD_CONCURRENCY || 1));
let activeUploads = 0; const uploadWaiters = [];
const oneAtATime = (req, res, next) => {
  let done = false;
  const free = () => { if (done) return; done = true; activeUploads--; const w = uploadWaiters.shift(); if (w) w(); };
  const go = () => { if (done) return; activeUploads++; next(); };
  res.on("close", () => { if (!done) { const i = uploadWaiters.indexOf(start); if (i >= 0) { uploadWaiters.splice(i, 1); done = true; return; } } free(); });
  res.on("finish", free);
  const start = () => go();
  if (activeUploads < UPLOAD_CONCURRENCY) start(); else uploadWaiters.push(start);
};
/* identical files uploaded at the same moment: the second one is refused (the library duplicate check only sees finished documents) */
const IN_FLIGHT = new Set();

/* One uploaded file through the whole pipeline (duplicate check, page rendering, spam check, database rows).
   Used by the normal upload route and by the resumable background uploads. */
/* The address is only held in memory to find the uploader's country (flag). It is never written to the database. */
const ctxOf = (req, gid) => ({ user: req.user || null, gid: gid || "", ip: String(req.ip || req.socket.remoteAddress || "").slice(0, 64),
  cc: String(req.headers["cf-ipcountry"] || req.headers["x-vercel-ip-country"] || req.headers["cloudfront-viewer-country"] || req.headers["x-country-code"] || "").slice(0, 2) });
/* "Not uploaded" message shown to the visitor when the content already exists */
const dupMsg = (name, d) => `Not uploaded: "${name}" has ${d.similarity}% similar content to "${d.title}", which is already in the library.`;
async function processFile(f, titleIn, ctx, out, rejected, noCredit, release) {
  const reject = (file, message) => rejected.push({ name: file.originalname, message });
    const fh = crypto.createHash("sha256").update(f.buffer).digest("hex");
    if (IN_FLIGHT.has(fh)) { reject(f, `Not uploaded: "${f.originalname}" is 100% similar to a file being uploaded at the same moment.`); return; }
    IN_FLIGHT.add(fh); release(() => IN_FLIGHT.delete(fh));
    /* 1) exact same file already in the library: refuse before any work is done */
    const sameFile = await S.findDuplicate(f.buffer, "");
    if (sameFile && !sameFile.none) { reject(f, dupMsg(f.originalname, sameFile)); return; }
    const ex = await S.extract(f);
    ex.pages = ex.pages.map(S.tidy);
    /* Word / Excel / text files are converted by LibreOffice so they are shown exactly as uploaded; if that is unavailable they fall back to text. */
    let imgs = null, officePdf = null;
    if (["doc", "text", "sheet"].includes(ex.kind)) { const o = await S.officeRender(f, ex.kind); if (o) { imgs = o.imgs; officePdf = o.pdf || null; if (o.pages.length) ex.pages = o.pages; } }
    else imgs = await S.renderPages(f, ex.kind);
    /* Documents uploaded to push links / sell SEO are not accepted. */
    const spam = S.seoSpamReason((titleIn || "") + "\n" + ex.pages.join("\n"));
    if (spam) { reject(f, `"${f.originalname}" was not added: it looks like it was uploaded for SEO or link promotion (${spam}).`); return; }
    if (!imgs && ex.kind === "pdf" && ex.pages.join("").trim().length < 20)
      { reject(f, `"${f.originalname}" has no selectable text and the server could not render its pages (poppler-utils / sharp missing).`); return; }
    if (imgs) ex.count = imgs.length;
    /* 2) any number of pages may be uploaded, but only documents with MIN_PAGES (3) or more pages count toward free unlocks */
    const NOCREDIT = ex.count < S.MIN_PAGES();
    /* 3) same file, same words, same pages, or 80%+ the same text as a document already in the library (or one saved a moment ago): refuse.
          The check and the saving of the new fingerprints run under one lock, so two copies uploaded together cannot both get in. */
    const unlock = await S.dupLock();
    let dup, title, d, slug;
    try {
      dup = await S.findDuplicate(f.buffer, ex.pages.join("\n"), imgs);
      if (dup && !dup.none) { reject(f, dupMsg(f.originalname, dup)); return; }
      title = S.pickTitle(titleIn, f.originalname, ex.pages);
      for (let t = 0; t < 5 && !d; t++) {
        slug = await S.uniqueSlug(S.slugify(title));
        try {
          d = (await query("INSERT INTO docs(owner_id,guest_id,title,slug,filename,mime,kind,page_count,img) VALUES($1,$9,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
            [ctx.user ? ctx.user.id : null, title, slug, f.originalname.slice(0, 300), f.mimetype, ex.kind, ex.count, !!imgs, ctx.gid || null])).rows[0];
        } catch (e) { if (e.code !== "23505") throw e; }   /* someone took the slug a moment ago: pick the next one */
      }
      if (!d) { reject(f, `"${f.originalname}": could not create a unique link. Please try again.`); return; }
      await S.saveFingerprints(d.id, dup);
    } finally { unlock(); }
    S.recordUploaderCountry(d.id, ctx.ip, ctx.cc);   /* flag only; runs in the background */
    /* this document (original file + all its page images) goes to the next Neon database in rotation */
    let shard;
    /* Only the REDUCED file goes to the database: anything over STORE_LIMIT_MB (5) is shrunk first, text kept sharp (see reduceService). */
    const red = await require("../services/reduceService").reduceForStorage({ buffer: f.buffer, name: f.originalname, mime: f.mimetype, kind: ex.kind, pdf: officePdf });
    try { shard = await SH.pick(); await query("INSERT INTO doc_files(doc_id,data) VALUES($1,$2)", [d.id, await SH.store(red.buffer, shard)]); }
    catch (e) { await query("DELETE FROM docs WHERE id=$1", [d.id]).catch(() => {}); throw e; }
    await query("UPDATE docs SET orig_bytes=$2, stored_bytes=$3, reduced=$4, reduce_note=$5, filename=$6, mime=$7 WHERE id=$1",
      [d.id, red.originalBytes, red.storedBytes, red.reduced, red.note || (red.overLimit ? "above the limit" : null), red.filename.slice(0, 300), red.mime]).catch((e) => console.warn("[DOCS] size record:", e.message));
    try {   /* who uploaded what (copyright / takedown evidence). No IP address, forwarded-for or browser string is stored. */
      const u = ctx.user ? (await query("SELECT name,email,phone FROM users WHERE id=$1", [ctx.user.id])).rows[0] || {} : {};
      await query("INSERT INTO doc_upload_log(doc_id,user_id,user_name,user_email,user_phone,ip,forwarded_for,user_agent,title,original_filename,mime,size_bytes,sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
        [d.id, ctx.user ? ctx.user.id : null, u.name || null, u.email || null, u.phone || null, null, null,
         null, title, f.originalname.slice(0, 300), f.mimetype, f.size || f.buffer.length, require("crypto").createHash("sha256").update(f.buffer).digest("hex")]);
    } catch (e) { console.warn("[DOCS] upload log:", e.message); }
    /* pages are written 4 at a time (was one after the other) */
    const pageRows = Array.from({ length: ex.count }, (_, n) => n);
    const writePage = async (n) => query('INSERT INTO doc_pages(doc_id,page_no,body,preview,"full",bg,lay,bgimg) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [d.id, n + 1, imgs && imgs[n].lay && imgs[n].lay.t.length >= 3 ? S.layText(imgs[n].lay) : ex.pages[n] || "", imgs ? await SH.store(imgs[n].preview, shard) : null, imgs ? await SH.store(imgs[n].full, shard) : null, imgs ? await S.pageBg(imgs[n].full) : null, imgs && imgs[n].lay ? JSON.stringify(imgs[n].lay) : null, imgs && imgs[n].bgimg ? await SH.store(imgs[n].bgimg, shard) : null]);
    for (let i = 0; i < pageRows.length; i += 4) await Promise.all(pageRows.slice(i, i + 4).map(writePage));
    S.classify(d.id).catch((e) => console.warn("[DOCS] classify:", e.message));           /* decides whether the page may be indexed */
    if (imgs) S.ocrDoc(d.id).catch((e) => console.warn("[DOCS] OCR:", e.message));   /* background: scanned pages become real text */
    if (NOCREDIT) noCredit.push({ name: f.originalname, pages: ex.count, message: `"${f.originalname}" was uploaded, but it has only ${ex.count} page${ex.count > 1 ? "s" : ""}. Upload minimum ${S.MIN_PAGES()} pages in order to get unlock.` });
    out.push({ id: d.id, title, pages: ex.count, credit: !NOCREDIT, url: S.urlFor({ id: d.id, slug }) });
}

router.post("/upload", uploadRateLimit, optionalUser, upload.array("files", MAX_FILES), oneAtATime, wrap(async (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ success: false, message: "Choose at least one file." });
  const titles = [].concat(req.body.titles || []), out = [], rejected = [], noCredit = [];
  let gid = ""; if (!req.user) { gid = guestOf(req) || crypto.randomBytes(12).toString("hex"); guestCookie(req, res, gid); }
  const reject = (f, message) => rejected.push({ name: f.originalname, message });
  const ctx = ctxOf(req, gid);
  for (let i = 0; i < req.files.length; i++) await processFile(req.files[i], titles[i], ctx, out, rejected, noCredit, (fn) => res.once("close", fn));
  if (!out.length) return res.status(422).json({ success: false, message: rejected.map((r) => r.message).join(" "), rejected });
  res.json({ success: true, docs: out, rejected, noCredit });
}));

/* ---------- Resumable background uploads ----------
   The browser sends a file in 1 MB pieces (POST /upload/session, PUT /upload/session/:sid?offset=N, POST .../finish). The server keeps the
   pieces, and after "finish" it reads the pages and saves the document BY ITSELF, whether or not the browser is still open. If the visitor
   refreshes or opens another page, the next page asks GET /upload/session/:sid how many bytes arrived and carries on from there. */
const fs = require("fs"), os = require("os"), pathMod = require("path");
const UP_DIR = pathMod.join(os.tmpdir(), "ah-upl");
try { fs.mkdirSync(UP_DIR, { recursive: true }); } catch (e) {}
const UP_MAX = Number(process.env.MAX_FILE_SIZE_MB || 20) * 1048576, UP_CHUNK = 1048576;
const SESS = new Map();   /* sid -> { owner, name, size, type, title, received, state: uploading|processing|done|error, result, error, at } */
const sessFile = (sid) => pathMod.join(UP_DIR, sid);
const dropSess = (sid) => { SESS.delete(sid); fs.unlink(sessFile(sid), () => {}); };
setInterval(() => { const now = Date.now(); for (const [sid, v] of SESS) if (now - v.at > (v.state === "done" || v.state === "error" ? 3600e3 : 6 * 3600e3)) dropSess(sid); }, 600e3).unref();
const slot = () => new Promise((ok) => { const go = () => { activeUploads++; ok(); }; activeUploads < UPLOAD_CONCURRENCY ? go() : uploadWaiters.push(go); });
const freeSlot = () => { activeUploads--; const w = uploadWaiters.shift(); if (w) w(); };
const mySess = (req, res) => {
  const v = SESS.get(String(req.params.sid || ""));
  const me = req.user ? "u" + req.user.id : "g" + guestOf(req);
  if (!v || v.owner !== me) { res.status(404).json({ success: false, message: "Upload session not found. It will be restarted." }); return null; }
  v.at = Date.now(); return v;
};
const sessInfo = (v) => ({ success: true, received: v.received, size: v.size, state: v.state, result: v.state === "done" ? v.result : undefined, error: v.state === "error" ? v.error : undefined });

/* Quick check used by the upload page before any bytes are sent: is a file with this exact SHA-256 already in the library? */
router.post("/upload/check", uploadRateLimit, optionalUser, wrap(async (req, res) => {
  const sha = String(req.body.sha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) return res.status(400).json({ success: false, message: "Bad fingerprint." });
  let r = (await query("SELECT title FROM docs WHERE fsha=$1 AND removed=false LIMIT 1", [sha])).rows[0];
  if (!r) r = (await query("SELECT d.title FROM doc_upload_log l JOIN docs d ON d.id=l.doc_id WHERE l.sha256=$1 AND d.removed=false LIMIT 1", [sha])).rows[0];
  res.json({ success: true, duplicate: !!r, title: r ? r.title : "", similarity: r ? 100 : 0 });
}));

router.post("/upload/session", uploadRateLimit, optionalUser, wrap(async (req, res) => {
  const name = String(req.body.name || "").slice(0, 300), size = Number(req.body.size);
  if (!name || !Number.isFinite(size) || size <= 0) return res.status(400).json({ success: false, message: "Choose a file." });
  if (size > UP_MAX) return res.status(413).json({ success: false, message: `"${name}" is larger than ${Math.round(UP_MAX / 1048576)} MB.` });
  let owner;
  if (req.user) owner = "u" + req.user.id;
  else { const gid = guestOf(req) || crypto.randomBytes(12).toString("hex"); guestCookie(req, res, gid); owner = "g" + gid; }
  const sid = crypto.randomBytes(16).toString("hex");
  SESS.set(sid, { owner, name, size, type: String(req.body.type || "application/octet-stream").slice(0, 120), title: String(req.body.title || "").slice(0, 300), received: 0, state: "uploading", at: Date.now() });
  await fs.promises.writeFile(sessFile(sid), Buffer.alloc(0));
  res.json({ success: true, id: sid, chunk: UP_CHUNK, received: 0 });
}));

router.put("/upload/session/:sid", optionalUser, express.raw({ type: () => true, limit: UP_CHUNK + 65536 }), wrap(async (req, res) => {
  const v = mySess(req, res); if (!v) return;
  if (v.state !== "uploading") return res.status(409).json({ ...sessInfo(v), message: "This upload is already complete." });
  const off = Number(req.query.offset), buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!Number.isInteger(off) || off < 0 || !buf.length) return res.status(400).json({ success: false, message: "Bad upload piece." });
  if (off + buf.length <= v.received) return res.json({ success: true, received: v.received });          /* a piece that was already stored (retry) */
  if (off !== v.received) return res.status(409).json({ success: false, received: v.received, message: "Upload out of step." });   /* the browser re-syncs from "received" */
  if (v.received + buf.length > v.size) return res.status(400).json({ success: false, message: "Upload is larger than announced." });
  await fs.promises.appendFile(sessFile(req.params.sid), buf);
  v.received += buf.length;
  res.json({ success: true, received: v.received });
}));

router.get("/upload/session/:sid", optionalUser, (req, res) => { const v = mySess(req, res); if (v) res.json(sessInfo(v)); });
router.delete("/upload/session/:sid", optionalUser, (req, res) => { const v = mySess(req, res); if (!v) return; if (v.state === "processing") return res.json({ success: true, state: v.state }); dropSess(req.params.sid); res.json({ success: true }); });

router.post("/upload/session/:sid/finish", optionalUser, wrap(async (req, res) => {
  const v = mySess(req, res); if (!v) return;
  if (v.state !== "uploading") return res.json(sessInfo(v));
  if (v.received !== v.size) return res.status(409).json({ success: false, received: v.received, message: "Not all of the file has arrived yet." });
  v.state = "processing";
  const sid = req.params.sid, gid = req.user ? "" : guestOf(req), ctx = ctxOf(req, gid);
  res.json(sessInfo(v));
  /* from here on nothing depends on the browser: the document is read, checked and saved on the server */
  (async () => {
    const out = [], rejected = [], noCredit = [], releases = [];
    await slot();
    try {
      const buffer = await fs.promises.readFile(sessFile(sid));
      await processFile({ originalname: v.name, mimetype: v.type, buffer, size: buffer.length }, v.title, ctx, out, rejected, noCredit, (fn) => releases.push(fn));
      v.result = { docs: out, rejected, noCredit }; v.state = "done";
    } catch (e) {
      console.error("[DOCS] background upload failed:", e && e.stack || e);
      v.error = "The server could not read this file. Please upload it again."; v.state = "error";
    } finally {
      releases.forEach((fn) => { try { fn(); } catch (e) {} });
      freeSlot(); v.at = Date.now(); fs.unlink(sessFile(sid), () => {});
    }
  })();
}));

/* The logged-in user's own uploads, shown in their account. */
router.get("/mine", requireUser, wrap(async (req, res) => {
  const { rows } = await query("SELECT * FROM docs WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 200", [req.user.id]);
  res.json({ success: true, docs: rows.map((r) => ({ id: r.id, title: r.title, school: r.school, course: r.course, pages: r.page_count, views: r.views, created: r.created_at, status: r.removed ? "denied" : "accepted", url: r.removed ? null : S.urlFor(r) })) });
}));
/* Uploaded documents cannot be deleted by their owner. Removal is admin-only: DELETE /api/admin/docs/:id */

/* Search / similar. Left-hand "Students also studied" list. */
router.get("/", optionalUser, wrap(async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 120), like = String(req.query.similar || "");
  const kinds = { pdf: ["pdf"], doc: ["doc", "text"], sheet: ["sheet"], image: ["image"] }, kind = kinds[String(req.query.kind || "")] || null;
  const popular = req.query.sort === "popular", off = Math.max(0, Math.min(5000, parseInt(req.query.offset, 10) || 0)), LIM = 24;
  let rows, more = false;
  if (like) {
    const d = (await query("SELECT title,course FROM docs WHERE id=$1", [like])).rows[0];
    const words = d ? (d.title + " " + (d.course || "")).toLowerCase().match(/[a-z0-9]{3,}/g) || [] : [];
    rows = words.length ? (await query(`SELECT * FROM docs WHERE removed=false AND id<>$1 AND to_tsvector('english', title||' '||coalesce(course,'')) @@ to_tsquery('english',$2)
      ORDER BY ts_rank(to_tsvector('english', title||' '||coalesce(course,'')), to_tsquery('english',$2)) DESC, created_at DESC LIMIT 8`, [like, [...new Set(words)].slice(0, 8).join(" | ")])).rows : [];
    if (!rows.length) rows = (await query("SELECT * FROM docs WHERE removed=false AND id<>$1 ORDER BY views DESC LIMIT 8", [like])).rows;
  } else {
    const args = [], where = ["removed=false"];
    if (q) { args.push(q); const a = args.length; args.push("%" + q + "%"); where.push(`(to_tsvector('english', title||' '||coalesce(course,'')) @@ plainto_tsquery('english',$${a}) OR title ILIKE $${a + 1})`); }
    /* Study Resources menu: School / Textbook Solutions / Literature / Study Guides are keyword views over the same library. */
    const CATS = S.LIB_CATS, cat = CATS[String(req.query.cat || "")];
    if (cat) { args.push("\\m(?:" + cat + ")"); const c = args.length; where.push(`(title ~* $${c} OR coalesce(course,'') ~* $${c} OR coalesce(school,'') ~* $${c}${req.query.cat === "school" ? " OR coalesce(school,'') <> ''" : ""})`); }
    if (kind) { args.push(kind); where.push(`kind = ANY($${args.length})`); }
    args.push(LIM + 1, off);
    rows = (await query(`SELECT * FROM docs WHERE ${where.join(" AND ")} ORDER BY ${popular ? "views DESC, created_at DESC" : "created_at DESC"} LIMIT $${args.length - 1} OFFSET $${args.length}`, args)).rows;
    if (rows.length > LIM) { more = true; rows = rows.slice(0, LIM); }
  }
  for (const r of rows) { const p = (await query("SELECT body, bg FROM doc_pages WHERE doc_id=$1 AND page_no=1", [r.id])).rows[0]; r.thumb = p ? S.thumbText(r, p.body) : ""; r.bg = p && p.bg || ""; }
  res.json({ success: true, more, docs: rows.map((r) => ({ ...card(r), views: r.views })) });
}));

router.get("/plan", requireUser, wrap(async (req, res) => res.json({ success: true, plan: await S.planStatus(req.user.id), pagePrice: S.PAGE_CENTS() / 100, planPrice: S.PLAN_CENTS() / 100 })));

/* Navbar balance: earned upload unlocks + unlocks left in the paid pack. */
router.get("/balance", optionalUser, wrap(async (req, res) => {
  if (req.user) return res.json({ success: true, ...(await S.balance(req.user.id)) });
  const c = await S.guestCredits(guestOf(req));
  res.json({ success: true, guest: true, upload: c.available, pack: 0, packExpires: null, total: c.available, uploads: c.uploads, per: c.per, reward: c.reward });
}));
/* Documents this member unlocked (they stay unlocked while the account exists) with the downloads made from each. */
router.get("/unlocked", requireUser, wrap(async (req, res) => res.json({ success: true, balance: await S.balance(req.user.id),
  docs: (await S.unlockedList(req.user.id)).map((r) => ({ id: r.id, title: r.title, pages: r.pages, source: r.source, unlocked: r.unlocked, downloads: r.downloads, lastDownload: r.last_download, url: S.urlFor(r) })) })));

/* $30 pack = 30 unlocks valid for 1 month. */
router.get("/pack", requireUser, wrap(async (req, res) => res.json({ success: true, pack: await S.packStatus(req.user.id), price: S.PACK_CENTS() / 100 })));
router.post("/pack/checkout", chatRateLimit, requireUser, wrap(async (req, res) => {
  let back = "/doc";
  const did = String(req.body && req.body.doc_id || "");
  if (/^\d{1,18}$/.test(did)) { const d = (await query("SELECT * FROM docs WHERE id=$1 AND removed=false", [did])).rows[0]; if (d) back = S.urlFor(d); }
  const s = await S.stripe("POST", "/v1/checkout/sessions", { mode: "payment", customer_email: req.user.email, "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd", "line_items[0][price_data][unit_amount]": String(S.PACK_CENTS()),
    "line_items[0][price_data][product_data][name]": `${S.PACK_UNLOCKS()} document unlocks (valid ${S.PACK_DAYS()} days)`, "metadata[user_id]": String(req.user.id), "metadata[kind]": "pack",
    success_url: `${base(req)}${back}?pack={CHECKOUT_SESSION_ID}`, cancel_url: `${base(req)}${back}` });
  res.json({ success: true, url: s.url });
}));

/* Viewer data. Unpaid viewers only ever receive the scrambled preview. */
async function sendDoc(req, res, doc) {
  if (!doc) return res.status(404).json({ success: false, message: "Document not found." });
  if (!req.query.rv) query("UPDATE docs SET views=views+1 WHERE id=$1", [doc.id]).catch(() => {});   /* ?rv=1 = the page re-reading itself after an unlock */
  const vw = await viewerOf(req), full = await S.canView(doc, vw), canDownload = await S.canRead(doc, vw), crawl = S.isIndexable(doc);
  const terms = crawl && !full && process.env.DOC_SEARCH_WINDOW !== "0" ? S.queryTerms(req.query.q || "") : [];   /* the clear window may move to what the visitor searched for (chosen on the server) */
  await S.ensureBg(doc.id);
  await S.ensureLayout(doc);
  const pages = (await query("SELECT page_no, body, bg, lay, (bgimg IS NOT NULL) AS hasbg, (preview IS NOT NULL) AS has FROM doc_pages WHERE doc_id=$1 ORDER BY page_no", [doc.id])).rows
    .map((p) => {
      /* PDF / Word / Excel pages with real text: drawn as HTML (text-free original background + every line placed by CSS), like Course Hero */
      if (doc.img && p.has && p.hasbg) {
        const vr0 = S.visibleRatio(p.page_no, doc.page_count, p.lay), lay = S.layFor(p.lay, vr0, crawl || full, full, false, terms);
        if (lay) {
          const a = lay.t.filter((r) => full ? r[1] < lay.h * vr0 : (r[1] >= lay.w0 && r[1] < lay.w1)).map((r) => r[5].replace(/<[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")).join(" ").replace(/\s+/g, " ").trim();   /* plain text of the readable part: feeds the Snippet box */
          return { n: p.page_no, bg: p.bg || "#ffffff", bgimg: `/api/docs/${doc.id}/bg/${p.page_no}`, lay, a, locked: !full, clear: full ? 1 : vr0 };
        }
      }
      /* Documents that have page images are shown as the ORIGINAL pages (image / PDF / Word / Excel look); the server blurs the hidden part.
         The page text rides along only so it can stay readable for search engines and screen readers. */
      if (doc.img && p.has) {
        const has = String(p.body || "").trim(), vr = S.visibleRatio(p.page_no, doc.page_count), t = has ? S.pageParts(p.body, full, crawl, vr) : {};
        return { n: p.page_no, bg: p.bg || "#ffffff", img: `/api/docs/${doc.id}/page/${p.page_no}`, locked: !full, clear: full ? 1 : vr, ...(crawl || full ? { a: t.a, b: t.b } : {}) };
      }
      const vr = S.visibleRatio(p.page_no, doc.page_count);
      return { n: p.page_no, bg: p.bg || "#ffffff", ...S.pageParts(p.body, full, crawl, vr), locked: !full, clear: full ? 1 : vr };
    });
  const owner = !!(req.user && doc.owner_id && String(doc.owner_id) === String(req.user.id));
  const meta = await S.docMeta(doc, req.user && req.user.id);
  res.json({ success: true, doc: { ...card(doc), meta, created: doc.created_at, indexable: crawl, why: crawl ? "" : (req.user && req.user.id === doc.owner_id ? (doc.noindex ? "blocked by an admin" : doc.idx_note || (doc.idx == null ? "not checked yet (a scan waits for OCR, or restart the server once)" : "")) : ""), clear: crawl ? S.clearRatio() : 0, locked: !full, canDownload, owner, costsUnlock: !!vw && canDownload && await S.downloadCost(doc, vw), price: S.PAGE_CENTS() / 100, planPrice: S.PLAN_CENTS() / 100, packPrice: S.PACK_CENTS() / 100, packUnlocks: S.PACK_UNLOCKS(), packDays: S.PACK_DAYS() }, pages, loggedIn: !!vw, subscribed: !!(vw && !vw.isAdmin && vw.id && await require("../services/quotaService").isActive(vw.id)), admin: !!(vw && vw.isAdmin) });
}
/* Public link: /doc/<slug>. A bare number is still accepted so old /doc/7 links keep working. */
router.get("/by-slug/:slug", optionalUser, wrap(async (req, res) => {
  const s = String(req.params.slug || "").trim().toLowerCase().slice(0, 220);
  let doc = (await query("SELECT * FROM docs WHERE slug=$1 AND removed=false", [s])).rows[0];
  if (!doc && /^\d{1,18}$/.test(s)) doc = (await query("SELECT * FROM docs WHERE id=$1 AND removed=false", [s])).rows[0];
  await sendDoc(req, res, doc);
}));
router.get("/:id", optionalUser, wrap(async (req, res) => {
  await sendDoc(req, res, (await query("SELECT * FROM docs WHERE id=$1 AND removed=false", [req.params.id])).rows[0]);
}));

/* Page image. Unpaid viewers only ever get the pre-blurred preview; the full-resolution page needs access. */
/* Text-free background of an original page (logo, banners, table lines): it holds no text, so it is public and cacheable. */
router.get("/:id/bg/:n", wrap(async (req, res) => {
  const row = (await query("SELECT p.bgimg AS img FROM doc_pages p JOIN docs d ON d.id=p.doc_id WHERE p.doc_id=$1 AND p.page_no=$2 AND d.removed=false", [req.params.id, parseInt(req.params.n, 10) || 0])).rows[0];
  if (!row || !row.img) return res.status(404).end();
  res.set({ "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" });
  res.send(await SH.resolve(row.img));
}));
router.get("/:id/page/:n", optionalUser, wrap(async (req, res) => {
  const doc = (await query("SELECT * FROM docs WHERE id=$1 AND removed=false", [req.params.id])).rows[0];
  if (!doc || !doc.img) return res.status(404).end();
  const thumb = req.query.p === "1", full = !thumb && (await S.canView(doc, await viewerOf(req))), n = parseInt(req.params.n, 10) || 0;
  const img = full ? await SH.resolve(((await query('SELECT "full" AS img FROM doc_pages WHERE doc_id=$1 AND page_no=$2', [doc.id, n])).rows[0] || {}).img) : (thumb ? await S.thumbImage(doc, n) : await S.previewImage(doc, n));
  if (!img) return res.status(404).end();
  res.set({ "Content-Type": "image/jpeg", "Cache-Control": thumb ? "public, max-age=3600, s-maxage=86400" : "private, no-store", "X-Content-Type-Options": "nosniff" });
  res.send(img);
}));

router.get("/:id/download", optionalUser, wrap(async (req, res) => {
  const adm = await isDocAdmin(req);
  if (!req.user && !adm) return res.status(401).json({ success: false, message: "Log in to download." });
  const doc = (await query("SELECT * FROM docs WHERE id=$1 AND removed=false", [req.params.id])).rows[0];
  if (!doc || !(adm || await S.canRead(doc, req.user))) return res.status(402).json({ success: false, message: "Unlock this document to download it." });
  /* the first download of a document uses one unlock (see S.downloadCost); backend admins download any document for free */
  const ch = adm ? { ok: true, charged: false } : await S.chargeDownload(doc, req.user);
  if (!ch.ok) return res.status(402).json({ success: false, message: "You have no unlocks left. Upload 5 documents of 3+ pages to get 5 unlocks, subscribe, or top up." });
  const f = (await query("SELECT data FROM doc_files WHERE doc_id=$1", [doc.id])).rows[0];
  const fileData = f && f.data ? await SH.resolve(f.data) : null;
  if (!fileData) return res.status(404).json({ success: false, message: "The file is not available right now. Please try again in a moment." });
  if (req.user && !adm) query("INSERT INTO doc_downloads(doc_id,user_id) VALUES($1,$2)", [doc.id, req.user.id]).catch(() => {});
  res.setHeader("Content-Type", doc.mime || "application/octet-stream");
  res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(doc.filename || "document"));
  res.send(fileData);
}));

/* Pay $5/page for one document (Stripe Checkout, verified server-side on return). */
router.post("/:id/checkout", chatRateLimit, requireUser, wrap(async (req, res) => {
  const doc = (await query("SELECT * FROM docs WHERE id=$1 AND removed=false", [req.params.id])).rows[0];
  if (!doc) return res.status(404).json({ success: false, message: "Document not found." });
  const s = await S.stripe("POST", "/v1/checkout/sessions", { mode: "payment", customer_email: req.user.email,
    "line_items[0][quantity]": "1", "line_items[0][price_data][currency]": "usd", "line_items[0][price_data][unit_amount]": String(S.PAGE_CENTS()),
    "line_items[0][price_data][product_data][name]": `Unlock: ${doc.title}`.slice(0, 120), "metadata[doc_id]": String(doc.id), "metadata[user_id]": String(req.user.id),
    success_url: `${base(req)}${S.urlFor(doc)}?paid={CHECKOUT_SESSION_ID}`, cancel_url: `${base(req)}${S.urlFor(doc)}` });
  res.json({ success: true, url: s.url });
}));

router.post("/plan/checkout", chatRateLimit, requireUser, wrap(async (req, res) => {
  const s = await S.stripe("POST", "/v1/checkout/sessions", { mode: "subscription", customer_email: req.user.email, "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd", "line_items[0][price_data][unit_amount]": String(S.PLAN_CENTS()), "line_items[0][price_data][recurring][interval]": "month",
    "line_items[0][price_data][product_data][name]": `Document plan - all documents and all services / month`, "metadata[user_id]": String(req.user.id), "metadata[kind]": "docplan",
    success_url: `${base(req)}/doc?plan={CHECKOUT_SESSION_ID}`, cancel_url: `${base(req)}/doc` });
  res.json({ success: true, url: s.url });
}));

/* Called by the page after Stripe redirects back. Never trusts the client: re-reads the session from Stripe. */
router.post("/confirm", requireUser, wrap(async (req, res) => {
  const id = String(req.body.session_id || "");
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ success: false, message: "Bad session." });
  const s = await S.stripe("GET", "/v1/checkout/sessions/" + id);
  const m = s.metadata || {};
  if (String(m.user_id) !== String(req.user.id) || s.status !== "complete") return res.status(403).json({ success: false, message: "Payment not confirmed." });
  if (s.mode === "payment" && s.payment_status === "paid" && m.kind === "pack") await S.addPack(req.user.id, id);
  else if (s.mode === "payment" && s.payment_status === "paid")
    await query("INSERT INTO doc_unlocks(doc_id,user_id,source,stripe_ref) VALUES($1,$2,'paid',$3) ON CONFLICT DO NOTHING", [m.doc_id, req.user.id, id]);
  else if (s.mode === "subscription" && s.subscription)
    await query("INSERT INTO doc_plans(user_id,stripe_sub_id) VALUES($1,$2) ON CONFLICT (user_id) DO UPDATE SET stripe_sub_id=$2", [req.user.id, s.subscription]);
  else return res.status(402).json({ success: false, message: "Payment not completed." });
  S.forgetPlan(req.user.id);
  res.json({ success: true });
}));

/* Subscribers spend one of their 30 monthly plan unlocks on this document; it then stays unlocked for good (view + download). */
router.post("/:id/unlock", requireUser, wrap(async (req, res) => {
  const Q = require("../services/quotaService");
  if (!(await Q.isActive(req.user.id))) return res.status(402).json({ success: false, message: "No active plan." });
  const doc = (await query("SELECT * FROM docs WHERE id=$1 AND removed=false", [req.params.id])).rows[0];
  if (!doc) return res.status(404).json({ success: false, message: "Document not found." });
  if (await S.canRead(doc, req.user)) return res.json({ success: true, already: true });
  if (!(await Q.consume(req.user.id, "unlock"))) return res.status(402).json({ success: false, needsTopup: true, message: Q.emptyMessage("unlock") });
  await query("INSERT INTO doc_unlocks(doc_id,user_id,source) VALUES($1,$2,'plan') ON CONFLICT DO NOTHING", [doc.id, req.user.id]);
  res.json({ success: true });
}));

/* How close the member is to a free unlock: every 5 uploads = 1 free document. */
/* Helpful / not helpful (thumbs). One vote per member; pressing the same button again removes it. */
router.post("/:id/vote", requireUser, wrap(async (req, res) => {
  const doc = (await query("SELECT * FROM docs WHERE id=$1 AND removed=false", [req.params.id])).rows[0];
  if (!doc) return res.status(404).json({ success: false, message: "Document not found." });
  res.json({ success: true, meta: await S.castVote(doc, req.user.id, req.body.vote) });
}));

router.get("/credits", optionalUser, wrap(async (req, res) => res.json({ success: true, ...(await creditsOf(req)) })));

/* Spend one earned upload credit to unlock this document. */
router.post("/:id/unlock-upload", requireUser, wrap(async (req, res) => {
  const doc = (await query("SELECT * FROM docs WHERE id=$1 AND removed=false", [req.params.id])).rows[0];
  if (!doc) return res.status(404).json({ success: false, message: "Document not found." });
  /* Already readable (owner, earlier unlock, paid, or an active plan): nothing is spent. One unlock = one document, opened for reading AND download. */
  if (await S.canRead(doc, req.user)) return res.json({ success: true, already: true });
  const c = await S.uploadCredits(req.user.id);
  if (c.available < 1) return res.status(402).json({ success: false, message: `Upload ${c.toNext} more document${c.toNext > 1 ? "s" : ""} of 3 or more pages to earn free unlocks.`, ...c });
  await query("INSERT INTO doc_unlocks(doc_id,user_id,source) VALUES($1,$2,'upload') ON CONFLICT DO NOTHING", [doc.id, req.user.id]);
  res.json({ success: true });
}));

/* Automatic debit: uses an earned upload unlock first, then the paid pack. Nothing is spent when the document is already readable. */
router.post("/:id/unlock-auto", requireUser, wrap(async (req, res) => {
  const doc = (await query("SELECT * FROM docs WHERE id=$1 AND removed=false", [req.params.id])).rows[0];
  if (!doc) return res.status(404).json({ success: false, message: "Document not found." });
  if (await S.canRead(doc, req.user)) return res.json({ success: true, already: true, balance: await S.balance(req.user.id) });
  const used = await S.spendAuto(req.user.id, doc.id);
  if (!used) return res.status(402).json({ success: false, message: "You have no unlocks left." });
  res.json({ success: true, used, balance: await S.balance(req.user.id) });
}));

/* Spend one unlock from the $30 pack on this document (opens it for reading AND download). */
router.post("/:id/unlock-pack", requireUser, wrap(async (req, res) => {
  const doc = (await query("SELECT * FROM docs WHERE id=$1 AND removed=false", [req.params.id])).rows[0];
  if (!doc) return res.status(404).json({ success: false, message: "Document not found." });
  if (await S.canRead(doc, req.user)) return res.json({ success: true, already: true });
  if (!(await S.spendPack(req.user.id, doc.id))) return res.status(402).json({ success: false, message: "You have no unlocks left. Buy a new pack of " + S.PACK_UNLOCKS() + " unlocks." });
  res.json({ success: true });
}));

module.exports = router;
