"use strict";

/*
 * Self-hosted "I am not Robot" check - checkbox only, no puzzle, no Google, no third-party scripts.
 *
 * Flow: the customer ticks the box -> GET /api/auth/captcha returns a signed challenge (a nonce + difficulty) ->
 * the browser spends a moment on a small proof-of-work (finding a counter whose SHA-256 hash starts with N zero bits;
 * cheap for one person, expensive for a bot opening thousands of sign-ups) and sends it back with a few
 * browser signals -> POST /api/auth/captcha/verify checks everything and returns a short-lived, single-use "pass" ->
 * sign-up sends the pass and the server consumes it before creating the account.
 *
 * Also: sign-up has a hidden trap field that humans never see; anything that fills it is refused.
 *
 * Stateless except two small in-memory "already used" maps (fine for one instance; use Redis if you scale out).
 * The signing key comes from CAPTCHA_SECRET, else USER_JWT_SECRET / JWT_SECRET, else a random key per boot.
 */

const crypto = require("crypto");

const CHALLENGE_MS = 10 * 60 * 1000;   // time allowed to solve one challenge (the page prepares it in the background and refreshes it after 4 minutes)
const PASS_MS = 30 * 60 * 1000;        // time allowed to use the pass for sign-up
// Speed: no artificial waiting any more. (They used to refuse a tick that came within 0.7 s of the challenge or 1.5 s of opening the form,
// which made quick, real visitors fail.) Set CAPTCHA_MIN_SOLVE_MS / CAPTCHA_MIN_FORM_MS in the environment to bring a delay back.
const MIN_SOLVE_MS = Math.max(0, Number(process.env.CAPTCHA_MIN_SOLVE_MS) || 0);
const MIN_FORM_MS = Math.max(0, Number(process.env.CAPTCHA_MIN_FORM_MS) || 0);
const BITS = Math.min(22, Math.max(10, Number(process.env.CAPTCHA_BITS) || 16));   // ~65k hashes on average at 16

const KEY = (() => {
  const k = String(process.env.CAPTCHA_SECRET || process.env.USER_JWT_SECRET || process.env.JWT_SECRET || "").trim();
  return k ? crypto.createHash("sha256").update("captcha|" + k).digest() : crypto.randomBytes(32);
})();

const hmac = (s) => crypto.createHmac("sha256", KEY).update(s).digest("base64url");
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

const used = new Map();   // nonce -> expiry (challenges already attempted, passes already spent)
function burn(key, until) {
  const now = Date.now();
  if (used.size > 5000) for (const [k, e] of used) if (e < now) used.delete(k);
  used.set(key, until);
}
const isBurnt = (key) => { const e = used.get(key); return !!e && e > Date.now(); };

function leadingZeroBits(buf) {
  let n = 0;
  for (const byte of buf) {
    if (byte === 0) { n += 8; continue; }
    n += Math.clz32(byte) - 24;
    break;
  }
  return n;
}

/* -> { id, nonce, bits } */
function newChallenge() {
  const nonce = crypto.randomBytes(9).toString("base64url");
  const body = `c.${nonce}.${Date.now()}.${BITS}`;
  return { id: `${body}.${hmac(body)}`, nonce, bits: BITS };
}

/* (id, counter, signals) -> { ok, pass } | { ok:false, status, message, refresh } */
function solve(id, counter, signals) {
  const bad = (message, refresh = true) => ({ ok: false, status: 400, message, refresh });
  const parts = String(id || "").split(".");
  if (parts.length !== 5 || parts[0] !== "c") return bad("This check is invalid. Please try again.");
  const [, nonce, issued, bits, sig] = parts;
  if (!safeEq(sig, hmac(`c.${nonce}.${issued}.${bits}`))) return bad("This check is invalid. Please try again.");
  const age = Date.now() - Number(issued);
  if (!(age >= 0) || age > CHALLENGE_MS) return bad("The check expired. Please tick the box again.");
  if (isBurnt("c:" + nonce)) return bad("The check was already used. Please tick the box again.");
  burn("c:" + nonce, Number(issued) + CHALLENGE_MS);               // one attempt per challenge
  if (MIN_SOLVE_MS > 0 && age < MIN_SOLVE_MS) return bad("That was too fast. Please tick the box again.");

  const n = Number(counter);
  if (!Number.isInteger(n) || n < 0 || n > 1e9) return bad("The check failed. Please tick the box again.");
  const hash = crypto.createHash("sha256").update(`${nonce}:${n}`).digest();
  if (leadingZeroBits(hash) < Number(bits)) return bad("The check failed. Please tick the box again.");

  const s = signals && typeof signals === "object" ? signals : {};
  if (s.trusted !== true) return bad("The check couldn't confirm a real click. Please tick the box yourself.");
  if (MIN_FORM_MS > 0 && !(Number(s.formMs) >= MIN_FORM_MS)) return bad("That was too fast. Please fill in the form and tick the box.");

  const exp = Date.now() + PASS_MS;
  const body = `p.${crypto.randomBytes(9).toString("base64url")}.${exp}`;
  return { ok: true, pass: `${body}.${hmac(body)}` };
}

/* sign-up calls this: { ok:true } | { ok:false, status, field, message } */
async function verify(token, trap) {
  const fail = (message) => ({ ok: false, status: 400, field: "captcha", message });
  if (trap) return fail("The \"I am not Robot\" check failed. Please reload the page and try again.");   // hidden field was filled in
  const parts = String(token || "").split(".");
  if (parts.length !== 4 || parts[0] !== "p") return fail("Please tick \"I am not Robot\".");
  const body = parts.slice(0, 3).join(".");
  if (!safeEq(parts[3], hmac(body))) return fail("The \"I am not Robot\" check is invalid. Please tick it again.");
  const exp = Number(parts[2]);
  if (!(exp > Date.now())) return fail("The \"I am not Robot\" check expired. Please tick it again.");
  if (isBurnt("p:" + parts[1])) return fail("The \"I am not Robot\" check was already used. Please tick it again.");
  burn("p:" + parts[1], exp);
  return { ok: true };
}

const isConfigured = () => true;

module.exports = { newChallenge, solve, verify, isConfigured };
