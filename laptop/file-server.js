"use strict";
/* The file server that runs on your laptop. The website (on Render / Railway / GoDaddy) stores and reads every uploaded file here.
   It listens on 127.0.0.1 only; the internet reaches it through a Cloudflare Tunnel or Tailscale Funnel (see README).
     POST   /files        body = file bytes  ->  {"id": "...", "size": n}        (header X-Content-SHA256 is verified when sent)
     GET    /files/<id>   -> file bytes
     DELETE /files/<id>   -> removes it (the backup copy is kept)
     GET    /health       -> {"ok":true}
   Every request except /health needs   Authorization: Bearer <FILE_STORE_TOKEN>. */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const L = require("./lib");
const S = L.S;

if (S.token.length < 24) { console.error("Set FILE_STORE_TOKEN (at least 24 characters) in laptop/laptop.env"); process.exit(1); }
fs.mkdirSync(path.join(S.filesDir, ".tmp"), { recursive: true });
fs.mkdirSync(S.dataDir, { recursive: true });

const tokenBuf = Buffer.from(S.token);
const authorized = (req) => {
  const h = String(req.headers.authorization || "");
  if (!h.startsWith("Bearer ")) return false;
  const b = Buffer.from(h.slice(7));
  return b.length === tokenBuf.length && crypto.timingSafeEqual(b, tokenBuf);
};
const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(b) }); res.end(b); };

let last = 0;
function newId() {
  let id = Math.max(Date.now() * 1000, last + 1);
  while (fs.existsSync(L.filePath(S.filesDir, id))) id++;
  last = id; return id;
}

function upload(req, res) {
  const tmp = path.join(S.filesDir, ".tmp", crypto.randomBytes(8).toString("hex"));
  const out = fs.createWriteStream(tmp), hash = crypto.createHash("sha256");
  let size = 0, dead = false;
  const fail = (code, msg) => { if (dead) return; dead = true; out.destroy(); fs.rm(tmp, { force: true }, () => {}); send(res, code, { error: msg }); };
  req.on("data", (c) => { size += c.length; hash.update(c); if (size > S.maxMB * 1048576) { fail(413, "file too large"); req.destroy(); } });
  req.on("error", () => fail(400, "upload interrupted"));
  req.pipe(out);
  out.on("error", (e) => fail(500, "disk error: " + e.message));
  out.on("finish", () => {
    if (dead) return;
    const want = String(req.headers["x-content-sha256"] || "").toLowerCase();
    if (want && want !== hash.digest("hex")) return fail(422, "checksum mismatch");
    if (!size) return fail(400, "empty file");
    const id = newId(), dest = L.filePath(S.filesDir, id);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(tmp, dest);
      fs.appendFileSync(S.journal, id + "\t" + size + "\n");
    } catch (e) { return fail(500, "could not save: " + e.message); }
    send(res, 201, { id: String(id), size });
  });
}

function download(id, res) {
  let p = L.filePath(S.filesDir, id);
  if (!fs.existsSync(p)) {                                   // self-heal: the backup copy still has it
    const m = L.filePath(S.mirrorDir, id);
    if (!fs.existsSync(m)) return send(res, 404, { error: "not found" });
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.copyFileSync(m, p); console.log("restored " + id + " from the backup copy"); } catch (e) { p = m; }
  }
  const st = fs.statSync(p);
  res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": st.size });
  fs.createReadStream(p).on("error", () => res.destroy()).pipe(res);
}

http.createServer((req, res) => {
  try {
    const u = new URL(req.url, "http://x");
    if (req.method === "GET" && u.pathname === "/health") return send(res, 200, { ok: true });
    if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
    if (req.method === "POST" && u.pathname === "/files") return upload(req, res);
    const m = u.pathname.match(/^\/files\/(\d+)$/);
    if (m && L.validId(m[1])) {
      if (req.method === "GET") return download(m[1], res);
      if (req.method === "DELETE") { try { fs.rmSync(L.filePath(S.filesDir, m[1]), { force: true }); } catch (e) { /* ignore */ } return send(res, 200, { ok: true }); }
    }
    send(res, 404, { error: "not found" });
  } catch (e) { send(res, 500, { error: e.message }); }
}).listen(S.port, "127.0.0.1", () => console.log("[" + new Date().toISOString() + "] file server on 127.0.0.1:" + S.port + "  files in " + S.filesDir));
