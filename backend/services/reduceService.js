"use strict";
/*
 * Every uploaded file is made as small as possible BEFORE it is saved to the database, so only the reduced file is stored.
 *
 *   Step 1 - lossless, for EVERY file (also a 2 MB one): nothing is resampled or re-compressed lossily, so the quality is identical.
 *            PDF : streams re-compressed, duplicate fonts / images merged (qpdf and / or Ghostscript, whichever is installed).
 *            Image: lossless WebP (sharp), kept only when it is really smaller.
 *            The smaller result is stored; if nothing gets smaller, the file is stored as uploaded.
 *   Step 2 - only when the file is STILL over STORE_LIMIT_MB (default 5 MB): quality is lowered step by step, just far enough to fit.
 *            PDF : 1) Ghostscript downsamples the pictures only, the text stays real vector text (best quality).
 *                  2) otherwise poppler: every page becomes a JPEG (starting at 170 dpi, never below 100 dpi) rebuilt as a PDF with an
 *                     invisible text layer, so the text can still be selected and searched.
 *            Word / Excel / text: the LibreOffice PDF is reduced the same way and stored as a PDF.
 *            Image: re-encoded as WebP with lower width and quality.
 *
 * It never throws: when a file cannot be reduced the original is returned and the reason is in `note`.
 * Needs what the server already has (poppler-utils, sharp); qpdf and Ghostscript are optional (see Dockerfile).
 */
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const LIMIT = () => Math.max(1, Number(process.env.STORE_LIMIT_MB || 5)) * 1048576;
const TIMEOUT = () => Number(process.env.REDUCE_TIMEOUT_MS || 240000);
const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { timeout: TIMEOUT(), maxBuffer: 1 << 26 }, (e, out) => (e ? rej(e) : res(String(out)))));
const mb = (n) => (n / 1048576).toFixed(1) + " MB";
let sharp = null; try { sharp = require("sharp"); } catch { /* images are then stored as uploaded */ }

/* ---------- small PDF writer: one JPEG per page + invisible text ---------- */
function jpegInfo(b) {   /* width, height, colour components from the JPEG header */
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7), c: b[i + 9] };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}
const pdfStr = (t) => Buffer.from(String(t).replace(/[\\()]/g, "\\$&").replace(/[^\x20-\x7e\xa0-\xff]/g, " "), "latin1");

function buildPdf(pages, title) {   /* pages: [{ jpeg, wpt, hpt, lines: [{ x, y, w, h, t }] }] (points, y from the top) */
  const parts = []; const offs = []; let pos = 0;
  const push = (x) => { const b = Buffer.isBuffer(x) ? x : Buffer.from(x, "latin1"); parts.push(b); pos += b.length; };
  const obj = (n, body) => { offs[n] = pos; push(n + " 0 obj\n"); if (typeof body === "function") body(); else push(body); push("\nendobj\n"); };
  const N = pages.length, F = 3 + N * 3;   /* objects: 1 catalog, 2 pages, (image, content, page) x N, then the font, then the info */
  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Count " + N + " /Kids [" + pages.map((p, k) => (5 + k * 3) + " 0 R").join(" ") + "] >>");
  pages.forEach((p, k) => {
    const img = 3 + k * 3, cnt = 4 + k * 3, pg = 5 + k * 3, ji = jpegInfo(p.jpeg);
    obj(img, () => {
      push("<< /Type /XObject /Subtype /Image /Width " + ji.w + " /Height " + ji.h + " /ColorSpace " + (ji.c === 1 ? "/DeviceGray" : "/DeviceRGB") + " /BitsPerComponent 8 /Filter /DCTDecode /Length " + p.jpeg.length + " >>\nstream\n");
      push(p.jpeg); push("\nendstream");
    });
    const c = [Buffer.from("q " + p.wpt.toFixed(2) + " 0 0 " + p.hpt.toFixed(2) + " 0 0 cm /Im0 Do Q\n", "latin1")];
    if (p.lines && p.lines.length) {   /* text render mode 3 = invisible: it can be selected / searched but is not drawn */
      c.push(Buffer.from("BT 3 Tr\n", "latin1"));
      for (const l of p.lines) {
        const fs_ = Math.max(1, l.h * 0.85), n = Math.max(1, l.t.length), tz = Math.max(10, Math.min(400, (l.w / (n * fs_ * 0.5)) * 100));
        c.push(Buffer.from("/F1 " + fs_.toFixed(2) + " Tf " + tz.toFixed(0) + " Tz 1 0 0 1 " + l.x.toFixed(2) + " " + (p.hpt - l.y - l.h * 0.8).toFixed(2) + " Tm (", "latin1"), pdfStr(l.t), Buffer.from(") Tj\n", "latin1"));
      }
      c.push(Buffer.from("ET\n", "latin1"));
    }
    const cb = Buffer.concat(c);
    obj(cnt, () => { push("<< /Length " + cb.length + " >>\nstream\n"); push(cb); push("endstream"); });
    obj(pg, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + p.wpt.toFixed(2) + " " + p.hpt.toFixed(2) + "] /Resources << /XObject << /Im0 " + img + " 0 R >> /Font << /F1 " + F + " 0 R >> >> /Contents " + cnt + " 0 R >>");
  });
  obj(F, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const info = F + 1;
  obj(info, "<< /Title (" + pdfStr(String(title || "Document").slice(0, 200)).toString("latin1") + ") /Producer (Doc Library) >>");
  const xref = pos, n = info + 1;
  push("xref\n0 " + n + "\n0000000000 65535 f \n");
  for (let j = 1; j < n; j++) push(("0000000000" + offs[j]).slice(-10) + " 00000 n \n");
  push("trailer\n<< /Size " + n + " /Root 1 0 R /Info " + info + " 0 R >>\nstartxref\n" + xref + "\n%%EOF\n");
  return Buffer.concat(parts);
}

/* text lines with their position, per page (pdftotext -bbox-layout), in PDF points measured from the top */
const unesc = (s) => String(s).replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
async function textLines(pdfPath, dir) {
  try {
    const out = path.join(dir, "bbox.html");
    await run("pdftotext", ["-bbox-layout", pdfPath, out]);
    const html = await fs.readFile(out, "utf8"), pages = [];
    for (const pm of html.matchAll(/<page width="[\d.]+" height="[\d.]+">([\s\S]*?)<\/page>/g)) {
      const lines = [];
      for (const lm of pm[1].matchAll(/<line xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/line>/g)) {
        const t = unesc([...lm[5].matchAll(/<word[^>]*>([\s\S]*?)<\/word>/g)].map((w) => w[1]).join(" ")).trim();
        if (t) lines.push({ x: +lm[1], y: +lm[2], w: +lm[3] - +lm[1], h: +lm[4] - +lm[2], t });
      }
      pages.push(lines);
    }
    return pages;
  } catch { return []; }
}

const pageCount = async (p) => { try { const m = /Pages:\s+(\d+)/.exec(await run("pdfinfo", [p])); return m ? +m[1] : 0; } catch { return 0; } };
const sizeOf = async (p) => (await fs.stat(p)).size;

/* ---------- 1) Ghostscript: text stays vector, only pictures are downsampled ---------- */
const GS_STEPS = [[200, 0.3], [150, 0.4], [120, 0.5], [100, 0.6]];   /* [image dpi, JPEG QFactor (higher = smaller)] */
async function viaGhostscript(src, dir, limit, pages) {
  const bin = process.env.GS_BIN || "gs";
  let best = null;
  for (const [dpi, q] of GS_STEPS) {
    const out = path.join(dir, "gs-" + dpi + ".pdf");
    const dict = "<< /ColorImageDict << /QFactor " + q + " /Blend 1 /HSamples [2 1 1 2] /VSamples [2 1 1 2] >> /GrayImageDict << /QFactor " + q + " /Blend 1 /HSamples [1 1 1 1] /VSamples [1 1 1 1] >> >> setdistillerparams";
    try {
      await run(bin, ["-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.5", "-dDetectDuplicateImages=true", "-dSubsetFonts=true", "-dCompressFonts=true",
        "-dDownsampleColorImages=true", "-dDownsampleGrayImages=true", "-dDownsampleMonoImages=true", "-dColorImageDownsampleType=/Bicubic", "-dGrayImageDownsampleType=/Bicubic",
        "-dColorImageResolution=" + dpi, "-dGrayImageResolution=" + dpi, "-dMonoImageResolution=300", "-dColorImageDownsampleThreshold=1.0", "-dGrayImageDownsampleThreshold=1.0",
        "-dAutoFilterColorImages=false", "-dAutoFilterGrayImages=false", "-dColorImageFilter=/DCTEncode", "-dGrayImageFilter=/DCTEncode",
        "-sOutputFile=" + out, "-c", dict, "-f", src]);
    } catch (e) { if (e && e.code === "ENOENT") return null; continue; }   /* gs missing, or this step failed */
    const n = await pageCount(out), sz = await sizeOf(out).catch(() => 0);
    if (!sz || (pages && n !== pages)) continue;                               /* never accept a file that lost pages */
    if (!best || sz < best.size) best = { path: out, size: sz, method: "ghostscript " + dpi + " dpi" };
    if (sz <= limit) break;
  }
  return best;
}

/* ---------- 2) poppler: every page as a JPEG, rebuilt as a PDF with invisible text ---------- */
const RASTER_STEPS = [[170, 80], [145, 75], [125, 70], [100, 62]];   /* [dpi, JPEG quality], best first: the first one that fits the limit is used; 100 dpi is the floor so small text stays readable */
async function viaPoppler(src, dir, limit, pages) {
  const lines = await textLines(src, dir);
  let best = null;
  for (const [dpi, q] of RASTER_STEPS) {
    const d = path.join(dir, "r" + dpi); await fs.mkdir(d, { recursive: true });
    try { await run("pdftoppm", ["-jpeg", "-jpegopt", "quality=" + q, "-r", String(dpi), src, path.join(d, "p")]); } catch { continue; }
    const files = (await fs.readdir(d)).filter((f) => /^p-\d+\.jpg$/.test(f)).sort((a, b) => parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10));
    if (!files.length || (pages && files.length !== pages)) continue;
    const pgs = []; let total = 0;
    for (let i = 0; i < files.length; i++) {
      const jpeg = await fs.readFile(path.join(d, files[i])), ji = jpegInfo(jpeg);
      if (!ji) { pgs.length = 0; break; }
      total += jpeg.length; pgs.push({ jpeg, wpt: ji.w * 72 / dpi, hpt: ji.h * 72 / dpi, lines: lines[i] || [] });
      if (total > limit * 1.6) break;   /* far too big at this step: stop reading, try the next one (keeps RAM low) */
    }
    if (pgs.length !== files.length) { await fs.rm(d, { recursive: true, force: true }).catch(() => {}); continue; }
    const out = path.join(dir, "ras-" + dpi + ".pdf"); await fs.writeFile(out, buildPdf(pgs, "Document"));
    await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    const sz = await sizeOf(out);
    if (!best || sz < best.size) best = { path: out, size: sz, method: "pages " + dpi + " dpi" };
    if (sz <= limit) break;
  }
  return best;
}

/* ---------- lossless: same pictures, same text, just packed better ---------- */
async function losslessPdf(src, dir, pages) {
  const cands = [];
  const keep = async (file, method) => { const sz = await sizeOf(file).catch(() => 0); if (sz && (!pages || (await pageCount(file)) === pages)) cands.push({ path: file, size: sz, method }); };
  const q = path.join(dir, "ll-qpdf.pdf");
  try { await run(process.env.QPDF_BIN || "qpdf", ["--object-streams=generate", "--recompress-flate", "--compression-level=9", "--stream-data=compress", "--remove-unreferenced-resources=yes", src, q]); await keep(q, "qpdf"); }
  catch (e) { if (e && e.code === 3) await keep(q, "qpdf"); }   /* exit code 3 = finished with warnings: the file is still written */
  const g = path.join(dir, "ll-gs.pdf");   /* merges duplicate fonts and images; no resampling, pictures stay lossless */
  try {
    await run(process.env.GS_BIN || "gs", ["-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.5", "-dDetectDuplicateImages=true", "-dSubsetFonts=true", "-dCompressFonts=true",
      "-dDownsampleColorImages=false", "-dDownsampleGrayImages=false", "-dDownsampleMonoImages=false", "-dPassThroughJPEGImages=true",
      "-dAutoFilterColorImages=false", "-dAutoFilterGrayImages=false", "-dColorImageFilter=/FlateEncode", "-dGrayImageFilter=/FlateEncode", "-sOutputFile=" + g, "-f", src]);
    await keep(g, "ghostscript lossless");
  } catch (e) { /* gs missing or failed: qpdf result (if any) is used */ }
  if (!cands.length) return null;
  cands.sort((a, b) => a.size - b.size);
  return cands[0];
}

async function reducePdf(buffer, limit) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "red-"));
  try {
    const orig = path.join(dir, "in.pdf"); await fs.writeFile(orig, buffer);
    const pages = await pageCount(orig);
    /* step 1: lossless, for every file */
    let ll = await losslessPdf(orig, dir, pages);
    if (ll && ll.size >= buffer.length * 0.99) ll = null;                       /* under 1% gain: not worth changing the file */
    const base = ll ? ll.path : orig, baseSize = ll ? ll.size : buffer.length;
    if (baseSize <= limit) return ll ? { buffer: await fs.readFile(ll.path), method: ll.method + " (lossless)" } : null;
    /* step 2: still over the limit: lower the quality only as far as needed */
    let best = await viaGhostscript(base, dir, limit, pages);
    if (!best || best.size > limit) {
      const r = await viaPoppler(base, dir, limit, pages);
      if (r && (!best || r.size < best.size)) best = r;
    }
    if (ll && (!best || ll.size < best.size)) best = ll;                          /* never end up bigger than the lossless result */
    if (!best || best.size >= buffer.length) return null;                         /* no gain: keep the original */
    return { buffer: await fs.readFile(best.path), method: best.method };
  } finally { fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

/* ---------- images -> WebP ---------- */
async function reduceImage(buffer, limit) {
  if (!sharp) return null;
  let best = null, method = "";
  try { const ll = await sharp(buffer).webp({ lossless: true, effort: 5 }).toBuffer(); if (ll.length < buffer.length * 0.99) { best = ll; method = "webp lossless"; } } catch { /* unsupported format: try the lossy steps */ }
  if (!best || best.length > limit) {                                            /* still over the limit: lower width and quality as far as needed */
    for (const [w, q] of [[2400, 85], [2000, 80], [1700, 76], [1500, 72]]) {
      const out = await sharp(buffer).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: q }).toBuffer();
      if (!best || out.length < best.length) { best = out; method = "webp"; }
      if (out.length <= limit) break;
    }
  }
  return best && best.length < buffer.length ? { buffer: best, method } : null;
}

/*
 * { buffer, name, mime, kind, pdf } -> { buffer, mime, filename, reduced, overLimit, originalBytes, storedBytes, method, note }
 * kind is the library kind (pdf / image / doc / text / sheet); `pdf` is the LibreOffice PDF of a Word / Excel / text file when there is one.
 */
async function reduceForStorage({ buffer, name, mime, kind, pdf }) {
  const limit = LIMIT(), originalBytes = buffer.length;
  const same = (note) => ({ buffer, mime, filename: name, reduced: false, overLimit: originalBytes > limit, originalBytes, storedBytes: originalBytes, method: "", note: note || "" });
  try {
    let r = null, outMime = mime, outName = name;
    if (kind === "pdf") { r = await reducePdf(buffer, limit); outMime = "application/pdf"; }
    else if (kind === "image") { r = await reduceImage(buffer, limit); outMime = "image/webp"; outName = String(name || "image").replace(/\.[a-z0-9]+$/i, "") + ".webp"; }
    else if (originalBytes <= limit) return same();                               /* small Word / Excel / text file: already compressed, stored as uploaded */
    else if (pdf && pdf.length) { r = await reducePdf(pdf, limit); outMime = "application/pdf"; outName = String(name || "document").replace(/\.[a-z0-9]+$/i, "") + ".pdf"; }
    else return same("could not be reduced: the converter for this file type is not available on the server");
    if (!r) return same(originalBytes > limit ? "could not be reduced any further" : "");
    const over = r.buffer.length > limit;
    console.log("[REDUCE] " + name + ": " + mb(originalBytes) + " -> " + mb(r.buffer.length) + " (" + r.method + ")" + (over ? " STILL ABOVE " + mb(limit) : ""));
    return { buffer: r.buffer, mime: outMime, filename: outName, reduced: true, overLimit: over, originalBytes, storedBytes: r.buffer.length, method: r.method, note: over ? "reduced as far as keeps the text readable, still above the limit" : "" };
  } catch (e) {
    console.warn("[REDUCE] " + name + " failed:", e && e.message);
    return same("reduction failed: " + String(e && e.message || e).slice(0, 120));
  }
}

module.exports = { reduceForStorage, buildPdf, LIMIT };
