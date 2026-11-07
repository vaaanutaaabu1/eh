"use strict";
/* Lets a logged-in backend admin open and download EVERY library document.
   The admin login also sets an httpOnly cookie (ah_admin, same signed token); the document routes check it here. */
const jwt = require("jsonwebtoken");
const { adminState } = require("./auth");
const COOKIE = "ah_admin";
const secure = (req) => (req.secure || process.env.NODE_ENV === "production" ? "; Secure" : "");
function setAdminCookie(req, res, token) {
  res.append("Set-Cookie", `${COOKIE}=${token}; Path=/; Max-Age=${12 * 3600}; HttpOnly; SameSite=Lax${secure(req)}`);
}
function clearAdminCookie(req, res) { res.append("Set-Cookie", `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure(req)}`); }
async function isDocAdmin(req) {
  if (req._docAdmin !== undefined) return req._docAdmin;
  req._docAdmin = false;
  try {
    const m = new RegExp("(?:^|;\\s*)" + COOKIE + "=([^;]+)").exec(req.headers.cookie || "");
    if (!m || !process.env.JWT_SECRET) return false;
    const c = jwt.verify(decodeURIComponent(m[1]), process.env.JWT_SECRET);
    if (!c || c.role !== "admin") return false;
    const row = await adminState(c.id);
    req._docAdmin = !!(row && row.is_active);
  } catch { req._docAdmin = false; }
  return req._docAdmin;
}
/* the person looking at a document: the member (if any), flagged isAdmin when a backend admin is logged in */
async function viewerOf(req) {
  const adm = await isDocAdmin(req);
  if (!adm) return req.user || null;
  return Object.assign({}, req.user || { id: 0 }, { isAdmin: true });
}
module.exports = { setAdminCookie, clearAdminCookie, isDocAdmin, viewerOf };
