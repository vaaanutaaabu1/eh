"use strict";
/*
 * /api/writing : the Plagiarism & Grammar page.
 *   GET  /status        what the signed-in member can do (free or $10 plan) and what is left
 *   POST /plagiarism    { text, excludeQuotes }  -> similarity report
 *   POST /grammar       { text }                 -> grammar / spelling / punctuation / style report
 *   POST /extract       multipart file (.txt .md .docx .pdf) -> plain text
 *
 * Two plans only:
 *   FREE        a check gives the headline numbers (similarity %, issue counts, score, readability) and a small preview.
 *               FREE_WRITING_PER_DAY checks of each kind per day (default 3).
 *   $10 / month the full report: every matched passage with its source link, every grammar fix with one-click apply,
 *               downloadable report. 30 plagiarism checks per month (the plan's shared allowance), grammar checks unlimited.
 * The locked parts are withheld by THIS server, not just blurred in the page.
 */
const express = require("express");
const multer = require("multer");
const { query } = require("../config/database");
const { requireUser } = require("../middleware/userAuth");
const Q = require("../services/quotaService");
const plag = require("../services/plagiarismService");
const gram = require("../services/grammarService");

const router = express.Router();
router.use(express.json({ limit: "200kb" }));

const FREE_PER_DAY = () => Math.max(0, Number(process.env.FREE_WRITING_PER_DAY == null ? 3 : process.env.FREE_WRITING_PER_DAY));
const FREE_GRAMMAR_FIXES = 3, FREE_PLAG_PASSAGES = 2;

/* per-IP limiter (every check can cost a web search or a grammar request) */
const makeLimit = (max, minutes) => {
  const hits = new Map();
  setInterval(() => hits.clear(), 3600 * 1000).unref();
  return (req, res, next) => {
    const now = Date.now(), arr = (hits.get(req.ip) || []).filter((t) => now - t < minutes * 60 * 1000);
    if (arr.length >= max) return res.status(429).json({ success: false, message: "Too many checks. Please wait a few minutes and try again." });
    arr.push(now); hits.set(req.ip, arr); next();
  };
};
const limitPlag = makeLimit(10, 10), limitGram = makeLimit(30, 10), limitFile = makeLimit(20, 10);

/* free daily counter */
let ready = null;
const ensure = () => ready || (ready = query("CREATE TABLE IF NOT EXISTS writing_free_uses (user_id BIGINT NOT NULL, day DATE NOT NULL, kind VARCHAR(12) NOT NULL, n INT NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day, kind))").catch((e) => { ready = null; throw e; }));
async function freeUsed(uid, kind) { await ensure(); const r = await query("SELECT n FROM writing_free_uses WHERE user_id=$1 AND day=CURRENT_DATE AND kind=$2", [uid, kind]); return r.rows[0] ? r.rows[0].n : 0; }
async function freeTake(uid, kind) {   // atomic: only counts while under the limit
  await ensure();
  const r = await query("INSERT INTO writing_free_uses(user_id,day,kind,n) VALUES($1,CURRENT_DATE,$2,1) ON CONFLICT (user_id,day,kind) DO UPDATE SET n=writing_free_uses.n+1 WHERE writing_free_uses.n<$3 RETURNING n", [uid, kind, FREE_PER_DAY()]);
  return r.rowCount > 0;
}
const freeGive = (uid, kind) => query("UPDATE writing_free_uses SET n=GREATEST(n-1,0) WHERE user_id=$1 AND day=CURRENT_DATE AND kind=$2", [uid, kind]).catch(() => {});

const wrap = (fn) => (req, res) => { res.set("Cache-Control", "no-store"); fn(req, res).catch((e) => {
  if (!e.status) console.error("[WRITING]", e);
  res.status(e.status || 500).json({ success: false, message: e.status ? e.message : "The checker is unavailable right now. Please try again." });
}); };

const PLANS = { free: { name: "Free", price: 0 }, pro: { name: "Subscribe", price: 10, interval: "month" } };

router.get("/status", requireUser, wrap(async (req, res) => {
  const pro = await Q.isActive(req.user.id), st = pro ? await Q.status(req.user.id) : null;
  const pl = st && st.services.find((x) => x.key === "plagiarism");
  res.json({ success: true, plan: pro ? "pro" : "free", plans: PLANS, plagiarismReady: plag.configured(),
    free: { perDay: FREE_PER_DAY(), plagiarismLeft: pro ? null : Math.max(0, FREE_PER_DAY() - (await freeUsed(req.user.id, "plag"))), grammarLeft: pro ? null : Math.max(0, FREE_PER_DAY() - (await freeUsed(req.user.id, "gram"))) },
    pro: pro ? { plagiarismLeft: pl ? pl.left : null, renews: st.renews } : null });
}));

/* runs `work` under the member's plan: pro spends the monthly allowance (plagiarism only), free spends the daily free check */
async function gate(req, res, kind, work) {
  const pro = await Q.isActive(req.user.id);
  if (pro) {
    if (kind === "plag") {
      if (!(await Q.consume(req.user.id, "plagiarism"))) return res.status(402).json({ success: false, code: "QUOTA_EMPTY", needsTopup: true, message: Q.emptyMessage("plagiarism") });
      try { const out = await work(true); return res.json({ success: true, plan: "pro", locked: false, ...out }); }
      catch (e) { await Q.refund(req.user.id, "plagiarism"); throw e; }
    }
    const out = await work(true); return res.json({ success: true, plan: "pro", locked: false, ...out });
  }
  if (!(await freeTake(req.user.id, kind)))
    return res.status(402).json({ success: false, needsPlan: true, code: "FREE_LIMIT", message: `You've used your ${FREE_PER_DAY()} free ${kind === "plag" ? "plagiarism" : "grammar"} checks for today. Subscribe for $10/month for more.` });
  try { const out = await work(false); return res.json({ success: true, plan: "free", locked: true, ...out }); }
  catch (e) { await freeGive(req.user.id, kind); throw e; }
}

/* ---- plagiarism ---- */
router.post("/plagiarism", requireUser, limitPlag, wrap(async (req, res) => {
  const body = req.body || {};
  await gate(req, res, "plag", async (full) => {
    const r = await plag.analyze(body.text, { excludeQuotes: !!body.excludeQuotes });
    if (full) return r;
    /* FREE: headline numbers + a small preview. Everything else is removed here, on the server. */
    let shown = 0;
    const sentences = r.sentences.map((s) => {
      if (s.sim >= 0.25 && s.kind !== "quote" && shown < FREE_PLAG_PASSAGES) { shown++; return { t: s.t, sim: s.sim, src: 0, kind: s.kind }; }
      return { t: s.t, sim: 0, src: 0, kind: s.sim >= 0.25 && s.kind !== "quote" ? "locked" : "" };
    });
    return { ...r, sentences, sources: [], sourcesHidden: r.sources.length, passagesHidden: Math.max(0, r.flagged - shown) };
  });
}));

/* ---- grammar ---- */
router.post("/grammar", requireUser, limitGram, wrap(async (req, res) => {
  const body = req.body || {};
  await gate(req, res, "gram", async (full) => {
    const r = await gram.analyze(body.text, { level: body.picky ? "picky" : "default" });
    if (full) return r;
    /* FREE: score, counts, readability and the first few fixes. The rest keep only their position and type so the page can show them as locked. */
    const issues = r.issues.map((i, n) => n < FREE_GRAMMAR_FIXES ? i : { id: i.id, offset: i.offset, length: i.length, category: i.category, locked: true });
    return { ...r, issues, issuesHidden: Math.max(0, r.issues.length - FREE_GRAMMAR_FIXES) };
  });
}));

/* ---- upload a file instead of pasting ---- */
const fileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1048576, files: 1 } });
const tidy = (t) => String(t || "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
router.post("/extract", requireUser, limitFile, (req, res) => {
  fileUpload.single("file")(req, res, async (err) => {
    res.set("Cache-Control", "no-store");
    if (err) return res.status(400).json({ success: false, message: err.code === "LIMIT_FILE_SIZE" ? "That file is over 10 MB." : "Couldn't read that file." });
    const f = req.file; if (!f) return res.status(400).json({ success: false, message: "Choose a file first." });
    const name = String(f.originalname || "file"), ext = String((name.match(/\.([a-z0-9]+)$/i) || [])[1] || "").toLowerCase();
    try {
      let text = "";
      if (["txt", "md", "markdown", "text"].includes(ext)) text = f.buffer.toString("utf8");
      else if (ext === "docx") text = (await require("mammoth").extractRawText({ buffer: f.buffer })).value;
      else if (ext === "pdf") text = (await require("pdf-parse")(f.buffer)).text;
      else return res.status(400).json({ success: false, message: "Please upload a .txt, .docx or .pdf file." });
      text = tidy(text);
      if (!text) return res.status(422).json({ success: false, message: "No readable text was found in that file. Paste the text instead." });
      res.json({ success: true, name, text: text.slice(0, plag.MAX_CHARS), truncated: text.length > plag.MAX_CHARS });
    } catch (e) { console.warn("[WRITING] extract:", e.message); res.status(422).json({ success: false, message: "That file couldn't be read. Try another file or paste the text." }); }
  });
});

module.exports = router;
