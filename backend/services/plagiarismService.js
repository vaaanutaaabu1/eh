"use strict";
/*
 * Plagiarism checker (the "Turnitin-style" half of the Plagiarism & Grammar page).
 *
 * How it works (the same idea as every web-based similarity checker):
 *   1. The text is split into sentences. Spread across the whole document, up to MAX_QUERIES distinctive 8-14 word phrases are searched
 *      on the live web as exact-phrase queries.
 *   2. The pages that come back most often are downloaded (SSRF-safe, size and time limited) and turned into plain text.
 *   3. EVERY sentence of the document is compared with the text of every downloaded page by 4-word sequences (shingles). The share of a
 *      sentence's sequences found in a page is its similarity (>= 45% = matched, 25-45% = partly matched, i.e. light paraphrase).
 *   4. The report gives the overall similarity %, the uniqueness %, every matched sentence with its best source, and a ranked source list.
 *
 * Search provider (set ONE of these environment variables; the first one present is used):
 *   BRAVE_API_KEY               https://brave.com/search/api  (free tier available)
 *   SERPER_API_KEY              https://serper.dev            (Google results, free credits)
 *   GOOGLE_CSE_KEY + GOOGLE_CSE_CX   Google Programmable Search
 *   PLAGIARISM_DDG_FALLBACK=1   best-effort DuckDuckGo HTML results, no key (fragile, rate-limited; for testing only)
 * Tuning: PLAGIARISM_MAX_QUERIES (default 24), PLAGIARISM_MAX_PAGES (default 12).
 *
 * Honest limits: this checks the OPEN WEB. It cannot see paywalled journals, other students' private submissions or books that are
 * not online, which is where a licensed service such as Turnitin has its own database. A low score means "nothing found online".
 */
const dns = require("dns");
const net = require("net");
const http = require("http");
const https = require("https");

const MIN_WORDS = 40, MAX_CHARS = 30000;
const MAX_QUERIES = () => Math.max(4, Math.min(60, Number(process.env.PLAGIARISM_MAX_QUERIES || 24)));
const MAX_PAGES = () => Math.max(2, Math.min(30, Number(process.env.PLAGIARISM_MAX_PAGES || 12)));
const SH = 4;                                            // shingle size (words)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tokens = (s) => (String(s).toLowerCase().replace(/[’‘]/g, "'").match(/[a-z0-9À-ɏ]+(?:'[a-z]+)?/g) || []);
const wordCount = (s) => (String(s).match(/[A-Za-z0-9À-ɏ][A-Za-z0-9À-ɏ'’-]*/g) || []).length;
const ABBR = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|e\.g|i\.e|cf|al|Fig|No|St|Inc|Ltd|U\.S|U\.K)\.$/i;

/* sentences keep their trailing whitespace, so re-joining them gives back the original text exactly */
function splitSentences(text) {
  const out = [], re = /([.!?]+["')\]”’]*)(\s+)|(\n+)/g;
  let start = 0, m;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    if (m[3] === undefined) {
      const next = text[end];
      if (!/\n/.test(m[2]) && next && !/[A-Z0-9"'“‘(\[]/.test(next)) continue;
      if (ABBR.test(text.slice(start, m.index + m[1].length))) continue;
    }
    out.push(text.slice(start, end)); start = end;
  }
  if (start < text.length) out.push(text.slice(start));
  return out.filter((s) => s.length);
}

/* ---------- search providers ---------- */
async function getJson(url, headers) {
  const r = await fetch(url, { headers: { Accept: "application/json", ...(headers || {}) }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) { const e = new Error("search HTTP " + r.status); e.status = r.status; throw e; }
  return r.json();
}
const providers = {
  brave: async (q) => {
    const j = await getJson("https://api.search.brave.com/res/v1/web/search?count=8&q=" + encodeURIComponent(q), { "X-Subscription-Token": process.env.BRAVE_API_KEY });
    return ((j.web && j.web.results) || []).map((x) => ({ title: x.title, url: x.url, snippet: [x.description].concat(x.extra_snippets || []).filter(Boolean).join(" ") }));
  },
  serper: async (q) => {
    const r = await fetch("https://google.serper.dev/search", { method: "POST", headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ q, num: 8 }), signal: AbortSignal.timeout(12000) });
    if (!r.ok) { const e = new Error("search HTTP " + r.status); e.status = r.status; throw e; }
    const j = await r.json();
    return (j.organic || []).map((x) => ({ title: x.title, url: x.link, snippet: x.snippet || "" }));
  },
  google: async (q) => {
    const j = await getJson("https://www.googleapis.com/customsearch/v1?num=8&key=" + encodeURIComponent(process.env.GOOGLE_CSE_KEY) + "&cx=" + encodeURIComponent(process.env.GOOGLE_CSE_CX) + "&q=" + encodeURIComponent(q));
    return (j.items || []).map((x) => ({ title: x.title, url: x.link, snippet: x.snippet || "" }));
  },
  ddg: async (q) => {
    const r = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), { headers: { "User-Agent": "Mozilla/5.0 (compatible; ExpertHelpSimilarity/1.0)" }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) { const e = new Error("search HTTP " + r.status); e.status = r.status; throw e; }
    const html = await r.text(), out = [], re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
    let m;
    while ((m = re.exec(html)) && out.length < 8) {
      let u = m[1].replace(/&amp;/g, "&"); const d = u.match(/[?&]uddg=([^&]+)/); if (d) u = decodeURIComponent(d[1]); if (u.startsWith("//")) u = "https:" + u;
      out.push({ title: strip(m[2]), url: u, snippet: strip(m[3] || "") });
    }
    return out;
  }
};
function providerName() {
  if (process.env.BRAVE_API_KEY) return "brave";
  if (process.env.SERPER_API_KEY) return "serper";
  if (process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_CX) return "google";
  if (/^(1|true|yes)$/i.test(String(process.env.PLAGIARISM_DDG_FALLBACK || ""))) return "ddg";
  return null;
}
const configured = () => !!providerName();

/* ---------- safe page download ---------- */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb");
}
/* the address is checked at connect time (not before), so DNS tricks cannot point us at an internal host */
const safeLookup = (host, opts, cb) => dns.lookup(host, { ...opts, all: false }, (err, addr, fam) => {
  if (err) return cb(err);
  if (isPrivateIp(addr)) return cb(Object.assign(new Error("blocked address"), { code: "EBLOCKED" }));
  cb(null, addr, fam);
});
const strip = (h) => String(h || "").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#8217;|&rsquo;/g, "'").replace(/&#?\w+;/g, " ").replace(/\s+/g, " ").trim();

function fetchPage(url, hops) {
  hops = hops == null ? 3 : hops;
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch (e) { return resolve(""); }
    if (!/^https?:$/.test(u.protocol) || (u.port && !["80", "443", ""].includes(u.port)) || net.isIP(u.hostname.replace(/^\[|\]$/g, "")) && isPrivateIp(u.hostname.replace(/^\[|\]$/g, ""))) return resolve("");
    if (/\.(pdf|docx?|pptx?|xlsx?|zip|jpe?g|png|gif|mp[34]|webp)(\?|$)/i.test(u.pathname)) return resolve("");
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request({ protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: "GET", lookup: safeLookup, timeout: 7000,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ExpertHelpSimilarity/1.0)", Accept: "text/html,text/plain;q=0.9", "Accept-Encoding": "identity" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) { res.resume(); let n; try { n = new URL(res.headers.location, u).href; } catch (e) { return resolve(""); } return resolve(fetchPage(n, hops - 1)); }
      if (res.statusCode !== 200 || !/text\/(html|plain)|xml/i.test(String(res.headers["content-type"] || ""))) { res.resume(); return resolve(""); }
      const chunks = []; let n = 0;
      res.on("data", (c) => { n += c.length; if (n > 1500000) { req.destroy(); resolve(strip(Buffer.concat(chunks).toString("utf8"))); } else chunks.push(c); });
      res.on("end", () => resolve(strip(Buffer.concat(chunks).toString("utf8"))));
      res.on("error", () => resolve(""));
    });
    req.on("timeout", () => req.destroy()); req.on("error", () => resolve("")); req.end();
  });
}

/* ---------- helpers ---------- */
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; } } }));
  return out;
}
const grams = (tk) => { const s = new Set(); for (let i = 0; i + SH <= tk.length; i++) s.add(tk.slice(i, i + SH).join(" ")); return s; };
const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return u; } };

/* the share of the sentence's shingles that also appear in the source */
function similarity(sentTk, srcGrams) {
  if (sentTk.length < SH + 1) return 0;
  let hit = 0, tot = 0;
  for (let i = 0; i + SH <= sentTk.length; i++) { tot++; if (srcGrams.has(sentTk.slice(i, i + SH).join(" "))) hit++; }
  return tot ? hit / tot : 0;
}
const quotedShare = (s) => { const q = (s.match(/["“][^"”]{12,}["”]/g) || []).join(" "); return q ? wordCount(q) / Math.max(1, wordCount(s)) : 0; };

/* ---------- main ---------- */
async function analyze(rawText, opts, deps) {
  opts = opts || {}; deps = deps || {};
  const text = String(rawText || "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").slice(0, MAX_CHARS);
  const total = wordCount(text);
  if (total < MIN_WORDS) throw Object.assign(new Error(`Please enter at least ${MIN_WORDS} words for a reliable plagiarism check (you have ${total}).`), { status: 400 });
  const search = deps.search || (providerName() ? providers[providerName()] : null);
  if (!search) throw Object.assign(new Error("The plagiarism checker isn't switched on yet: the site owner needs to add a search key (BRAVE_API_KEY, SERPER_API_KEY or GOOGLE_CSE_KEY + GOOGLE_CSE_CX). See PLAGIARISM_SETUP.md."), { status: 503 });
  const getPage = deps.fetchPage || fetchPage;

  const sents = splitSentences(text).map((t) => ({ t, tk: tokens(t), w: wordCount(t) }));
  sents.forEach((s) => { s.quoted = quotedShare(s.t); });

  // 1. choose the phrases to search, spread across the whole text
  const cands = sents.map((s, i) => ({ s, i })).filter((x) => x.s.tk.length >= 9 && !/^[A-Z0-9 ,:;-]{0,60}$/.test(x.s.t.trim()) && x.s.quoted < 0.7);
  const maxQ = MAX_QUERIES(), step = cands.length > maxQ ? cands.length / maxQ : 1, picked = [];
  for (let k = 0; k < Math.min(maxQ, cands.length); k++) picked.push(cands[Math.floor(k * step)]);
  const queries = picked.map(({ s }) => { const w = s.t.replace(/["“”()\[\]]/g, " ").trim().split(/\s+/).filter(Boolean); const a = w.length > 14 ? 2 : 0; return '"' + w.slice(a, a + 12).join(" ") + '"'; });

  let failed = 0;
  const results = await pool(queries, 4, async (q) => { try { return await search(q); } catch (e) { failed++; if (e && (e.status === 401 || e.status === 403)) throw e; return []; } });
  if (queries.length && failed === queries.length) throw Object.assign(new Error("The web search is busy right now. Please try again in a minute."), { status: 503 });

  // 2. rank the pages that came back
  const bank = new Map();
  results.forEach((list) => (list || []).forEach((r, rank) => {
    if (!r || !r.url || !/^https?:/i.test(r.url)) return;
    const k = r.url.replace(/#.*$/, "");
    const e = bank.get(k) || { url: k, title: r.title || domainOf(k), hits: 0, rankSum: 0, snippets: [] };
    e.hits++; e.rankSum += rank; if (r.snippet) e.snippets.push(r.snippet); bank.set(k, e);
  }));
  const ranked = [...bank.values()].sort((a, b) => b.hits - a.hits || a.rankSum - b.rankSum).slice(0, MAX_PAGES());
  const pages = await pool(ranked, 4, async (c) => ({ c, body: await getPage(c.url) }));
  const sources = ranked.map((c, i) => {
    const body = (pages[i] && pages[i].body) || "";
    const g = grams(tokens(body + " " + c.snippets.join(" ")));
    return { id: i + 1, url: c.url, title: String(c.title || domainOf(c.url)).slice(0, 140), domain: domainOf(c.url), grams: g, full: body.length > 400 };
  });

  // 3. compare every sentence with every source
  const own = (opts.ownDomain || "").toLowerCase();
  const perSrc = new Map();
  for (const s of sents) {
    s.sim = 0; s.src = 0;
    if (s.tk.length < SH + 2) continue;
    for (const src of sources) {
      if (own && src.domain.endsWith(own)) continue;
      const v = similarity(s.tk, src.grams);
      if (v > s.sim) { s.sim = v; s.src = src.id; }
    }
    if (s.sim < 0.25) { s.sim = 0; s.src = 0; continue; }
    const excluded = opts.excludeQuotes && s.quoted >= 0.6;
    s.kind = excluded ? "quote" : s.sim >= 0.45 ? "match" : "partial";
    if (excluded) continue;
    const mw = s.w * (s.sim >= 0.8 ? 1 : s.sim);
    perSrc.set(s.src, (perSrc.get(s.src) || 0) + mw);
  }
  const matchedWords = [...perSrc.values()].reduce((a, b) => a + b, 0);
  const similarityPct = Math.min(100, Math.round((matchedWords / Math.max(1, total)) * 100));
  const outSources = sources.filter((s) => perSrc.has(s.id)).map((s) => ({ id: s.id, title: s.title, url: s.url, domain: s.domain, words: Math.round(perSrc.get(s.id)), percent: Math.max(1, Math.round((perSrc.get(s.id) / Math.max(1, total)) * 100)) }))
    .sort((a, b) => b.words - a.words).slice(0, 15);
  const flagged = sents.filter((s) => s.sim >= 0.25 && s.kind !== "quote");
  return {
    provider: deps.search ? "custom" : providerName(), words: total, similarity: similarityPct, uniqueness: 100 - similarityPct,
    verdict: similarityPct >= 40 ? "High similarity" : similarityPct >= 15 ? "Moderate similarity" : similarityPct >= 5 ? "Low similarity" : "Mostly original",
    checkedPhrases: queries.length, pagesRead: sources.filter((s) => s.full).length, sourcesFound: outSources.length, flagged: flagged.length,
    sentences: sents.map((s) => ({ t: s.t, sim: s.sim ? Math.round(s.sim * 100) / 100 : 0, src: s.src || 0, kind: s.kind || "" })),
    sources: outSources
  };
}

module.exports = { analyze, configured, providerName, splitSentences, tokens, similarity, grams, isPrivateIp, MIN_WORDS, MAX_CHARS };
