"use strict";

/*
 * Wallet: a prepaid USD balance on every customer account.
 *
 * Ways to add money
 *   card      Stripe Checkout limited to cards (credit / debit)
 *   stripe    Stripe Checkout with every payment method switched on in your Stripe dashboard
 *   razorpay  Razorpay Orders + checkout.js (signature checked, payment re-read from Razorpay's API)
 *   admin     the universal (main) admin can top up any account by up to WALLET_ADMIN_MAX_CENTS ($100) per top-up
 *
 * Safety rules
 *   - The amount credited is the amount stored on OUR order row, never a number sent by the browser.
 *   - A payment is credited at most once: wallet_ledger.ref is UNIQUE (stripe:<session>, rzp:<payment>, admin:<request id>).
 *   - Balance and ledger change in ONE SQL statement, so they can never disagree.
 *   - The balance can never go below zero (CHECK constraint + guarded UPDATE).
 *
 * Env
 *   STRIPE_SECRET_KEY                 (same key as the plan / unlock payments)
 *   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
 *   RAZORPAY_CURRENCY=INR             INR (default) or USD when your Razorpay account has international payments on
 *   WALLET_INR_PER_USD=85             used only when RAZORPAY_CURRENCY=INR: rupees charged per 1 USD of wallet credit. KEEP IT CURRENT.
 *   WALLET_MIN_CENTS=500              smallest self top-up ($5)
 *   WALLET_MAX_CENTS=50000            largest self top-up ($500)
 *   WALLET_ADMIN_MAX_CENTS=10000      largest admin top-up ($100)
 */

const crypto = require("crypto");
const { query } = require("../config/database");

const env = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? Math.floor(v) : d; };
const MIN_CENTS = () => env("WALLET_MIN_CENTS", 500);
const MAX_CENTS = () => env("WALLET_MAX_CENTS", 50000);
const ADMIN_MAX_CENTS = () => env("WALLET_ADMIN_MAX_CENTS", 10000);
const STRIPE_KEY = () => String(process.env.STRIPE_SECRET_KEY || "").trim();
const RZP_ID = () => String(process.env.RAZORPAY_KEY_ID || "").trim();
const RZP_SECRET = () => String(process.env.RAZORPAY_KEY_SECRET || "").trim();
const RZP_CUR = () => (String(process.env.RAZORPAY_CURRENCY || "INR").trim().toUpperCase() === "USD" ? "USD" : "INR");
const INR_PER_USD = () => { const v = Number(process.env.WALLET_INR_PER_USD); return Number.isFinite(v) && v > 0 ? v : 85; };

const fail = (status, message) => { const e = new Error(message); e.status = status; return e; };

async function initTables() {
  await query(`CREATE TABLE IF NOT EXISTS wallet_accounts (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance_cents BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS wallet_ledger (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind VARCHAR(20) NOT NULL,
    provider VARCHAR(20) NOT NULL,
    amount_cents BIGINT NOT NULL,
    ref VARCHAR(140) UNIQUE,
    note VARCHAR(300),
    admin_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query("CREATE INDEX IF NOT EXISTS wallet_ledger_user_idx ON wallet_ledger(user_id, id DESC)");
  await query(`CREATE TABLE IF NOT EXISTS wallet_orders (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(20) NOT NULL,
    amount_cents BIGINT NOT NULL,
    charge_amount BIGINT,
    charge_currency VARCHAR(8),
    provider_ref VARCHAR(120) UNIQUE,
    status VARCHAR(12) NOT NULL DEFAULT 'created',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at TIMESTAMPTZ)`);
  await query("CREATE INDEX IF NOT EXISTS wallet_orders_user_idx ON wallet_orders(user_id, status, created_at DESC)");
}

/* ---------- which payment options are switched on ---------- */
function methods() {
  const stripe = !!STRIPE_KEY(), razorpay = !!(RZP_ID() && RZP_SECRET());
  return { card: stripe, stripe, razorpay };
}
function limits() {
  return { minCents: MIN_CENTS(), maxCents: MAX_CENTS(), adminMaxCents: ADMIN_MAX_CENTS(),
    razorpayCurrency: RZP_CUR(), inrPerUsd: RZP_CUR() === "INR" ? INR_PER_USD() : null };
}

/* "25", "25.5", 25.50 -> 2550. Rejects anything that is not a plain amount with at most 2 decimals. */
function toCents(v) {
  const s = String(v == null ? "" : v).trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/* ---------- balance and ledger ---------- */
async function balance(userId) {
  const r = await query("SELECT balance_cents FROM wallet_accounts WHERE user_id=$1", [userId]);
  return r.rows[0] ? Number(r.rows[0].balance_cents) : 0;
}
async function ledger(userId, limit, offset) {
  const r = await query("SELECT id,kind,provider,amount_cents,note,created_at FROM wallet_ledger WHERE user_id=$1 ORDER BY id DESC LIMIT $2 OFFSET $3", [userId, limit || 20, offset || 0]);
  return r.rows.map((x) => ({ id: Number(x.id), kind: x.kind, provider: x.provider, amountCents: Number(x.amount_cents), note: x.note || "", at: x.created_at }));
}

/* Adds money. ONE statement: the ledger row and the balance change succeed or fail together.
   A repeated `ref` inserts nothing and returns credited:false, so a payment is never counted twice. */
async function credit(userId, cents, o) {
  o = o || {};
  if (!Number.isInteger(cents) || cents <= 0) throw fail(400, "Bad amount.");
  const r = await query(
    `WITH ins AS (
       INSERT INTO wallet_ledger(user_id,kind,provider,amount_cents,ref,note,admin_id) VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (ref) DO NOTHING RETURNING amount_cents)
     INSERT INTO wallet_accounts(user_id,balance_cents) SELECT $1::bigint, amount_cents FROM ins
     ON CONFLICT (user_id) DO UPDATE SET balance_cents = wallet_accounts.balance_cents + EXCLUDED.balance_cents, updated_at = NOW()
     RETURNING balance_cents`,
    [userId, o.kind || "topup", o.provider || "stripe", cents, o.ref || null, o.note ? String(o.note).slice(0, 300) : null, o.adminId || null]);
  if (!r.rows.length) return { credited: false, balanceCents: await balance(userId) };
  const nb = Number(r.rows[0].balance_cents);
  require("./liveEvents").emit(userId, "wallet", { balanceCents: nb, msg: o.kind === "admin" ? "Support added $" + (cents / 100).toFixed(2) + " to your wallet." : "$" + (cents / 100).toFixed(2) + " was added to your wallet." });
  return { credited: true, balanceCents: nb };
}

/* For the rest of the site (not wired to any page yet): takes money from the wallet, only if enough is there. */
async function spend(userId, cents, note) {
  if (!Number.isInteger(cents) || cents <= 0) throw fail(400, "Bad amount.");
  const r = await query(
    `WITH upd AS (UPDATE wallet_accounts SET balance_cents = balance_cents - $2::bigint, updated_at = NOW() WHERE user_id=$1 AND balance_cents >= $2::bigint RETURNING balance_cents)
     INSERT INTO wallet_ledger(user_id,kind,provider,amount_cents,note) SELECT $1::bigint,'spend','wallet',-$2::bigint,$3::varchar FROM upd RETURNING id`,
    [userId, cents, note ? String(note).slice(0, 300) : null]);
  const nb = await balance(userId);
  if (r.rows.length) require("./liveEvents").emit(userId, "wallet", { balanceCents: nb });
  return { ok: r.rows.length > 0, balanceCents: nb };
}

/* ---------- a little abuse protection: at most 12 checkout starts per user per hour ---------- */
const starts = new Map();
function throttle(userId) {
  const now = Date.now(), k = String(userId), a = (starts.get(k) || []).filter((t) => now - t < 3600000);
  if (a.length >= 12) throw fail(429, "Too many top-up attempts. Please try again in a while.");
  a.push(now); starts.set(k, a);
  if (starts.size > 5000) for (const [key, v] of starts) if (!v.some((t) => now - t < 3600000)) starts.delete(key);
}

/* ---------- Stripe ---------- */
async function stripe(method, path, form) {
  if (!STRIPE_KEY()) throw fail(503, "Stripe payments aren't switched on for this site yet.");
  let r;
  try {
    r = await fetch("https://api.stripe.com" + path, { method, signal: AbortSignal.timeout(20000),
      headers: { Authorization: "Bearer " + STRIPE_KEY(), "Content-Type": "application/x-www-form-urlencoded" },
      body: form ? new URLSearchParams(form).toString() : undefined });
  } catch (e) { console.error("[WALLET] Stripe unreachable:", e.message); throw fail(502, "Payments are temporarily unavailable."); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { console.error("[WALLET] Stripe:", r.status, d && d.error && d.error.message); throw fail(502, "Payments are temporarily unavailable."); }
  return d;
}

async function startStripe(user, cents, kind, baseUrl) {
  throttle(user.id);
  const prov = kind === "card" ? "stripe_card" : "stripe";
  const o = (await query("INSERT INTO wallet_orders(user_id,provider,amount_cents,charge_amount,charge_currency) VALUES($1,$2,$3,$3,'USD') RETURNING id", [user.id, prov, cents])).rows[0];
  const form = {
    mode: "payment",
    success_url: `${baseUrl}/account?wallet=stripe&session_id={CHECKOUT_SESSION_ID}#wallet`,
    cancel_url: `${baseUrl}/account?wallet=cancel#wallet`,
    client_reference_id: String(user.id),
    customer_email: user.email,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(cents),
    "line_items[0][price_data][product_data][name]": "Wallet top-up",
    "metadata[kind]": "wallet", "metadata[user_id]": String(user.id), "metadata[order_id]": String(o.id)
  };
  if (kind === "card") form["payment_method_types[0]"] = "card";
  const s = await stripe("POST", "/v1/checkout/sessions", form);
  await query("UPDATE wallet_orders SET provider_ref=$2 WHERE id=$1", [o.id, s.id]);
  return s.url;
}

/* Re-reads the Checkout Session from Stripe and credits the wallet if (and only if) it was paid. Safe to call many times. */
async function confirmStripe(userId, sessionId) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(String(sessionId || ""))) throw fail(400, "Invalid payment reference.");
  const o = (await query("SELECT * FROM wallet_orders WHERE provider_ref=$1 AND user_id=$2 AND provider IN ('stripe','stripe_card')", [sessionId, userId])).rows[0];
  if (!o) throw fail(404, "We could not find that top-up on your account.");
  const s = await stripe("GET", "/v1/checkout/sessions/" + sessionId);
  const m = s.metadata || {};
  if (m.kind !== "wallet" || String(m.user_id) !== String(userId) || String(m.order_id) !== String(o.id)) throw fail(403, "That payment does not belong to this account.");
  if (s.payment_status !== "paid") throw fail(402, "The payment has not been completed yet.");
  if (String(s.currency).toLowerCase() !== "usd" || Number(s.amount_total) !== Number(o.amount_cents)) { console.error("[WALLET] amount mismatch on", sessionId); throw fail(409, "The payment amount did not match. Please contact support."); }
  const res = await credit(userId, Number(o.amount_cents), { kind: "topup", provider: o.provider, ref: "stripe:" + s.id, note: o.provider === "stripe_card" ? "Card top-up" : "Stripe top-up" });
  await query("UPDATE wallet_orders SET status='paid', paid_at=COALESCE(paid_at,NOW()) WHERE id=$1", [o.id]);
  return { ...res, amountCents: Number(o.amount_cents) };
}

/* ---------- Razorpay ---------- */
async function rzp(method, path, body) {
  if (!(RZP_ID() && RZP_SECRET())) throw fail(503, "Razorpay payments aren't switched on for this site yet.");
  let r;
  try {
    r = await fetch("https://api.razorpay.com" + path, { method, signal: AbortSignal.timeout(20000),
      headers: { Authorization: "Basic " + Buffer.from(RZP_ID() + ":" + RZP_SECRET()).toString("base64"), "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined });
  } catch (e) { console.error("[WALLET] Razorpay unreachable:", e.message); throw fail(502, "Payments are temporarily unavailable."); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { console.error("[WALLET] Razorpay:", r.status, d && d.error && d.error.description); throw fail(502, "Payments are temporarily unavailable."); }
  return d;
}

/* Wallet credit stays in USD. With RAZORPAY_CURRENCY=INR the customer is charged cents x WALLET_INR_PER_USD paise. */
async function startRazorpay(user, cents) {
  throttle(user.id);
  const cur = RZP_CUR(), charge = cur === "USD" ? cents : Math.round(cents * INR_PER_USD());
  if (charge < 100) throw fail(400, "That amount is too small for Razorpay.");
  const o = (await query("INSERT INTO wallet_orders(user_id,provider,amount_cents,charge_amount,charge_currency) VALUES($1,'razorpay',$2,$3,$4) RETURNING id", [user.id, cents, charge, cur])).rows[0];
  const ord = await rzp("POST", "/v1/orders", { amount: charge, currency: cur, receipt: "wallet_" + o.id, notes: { kind: "wallet", user_id: String(user.id), order_id: String(o.id), usd_cents: String(cents) } });
  await query("UPDATE wallet_orders SET provider_ref=$2 WHERE id=$1", [o.id, ord.id]);
  return { keyId: RZP_ID(), orderId: ord.id, amount: charge, currency: cur, usdCents: cents, name: user.name || "", email: user.email || "", contact: user.phone || "" };
}

async function creditRazorpay(o, payment) {
  const res = await credit(o.user_id, Number(o.amount_cents), { kind: "topup", provider: "razorpay", ref: "rzp:" + payment.id, note: "Razorpay top-up" });
  await query("UPDATE wallet_orders SET status='paid', paid_at=COALESCE(paid_at,NOW()) WHERE id=$1", [o.id]);
  return { ...res, amountCents: Number(o.amount_cents) };
}

/* Called by the browser after Razorpay's checkout succeeds: signature first, then the payment itself is read from Razorpay. */
async function verifyRazorpay(userId, p) {
  const oid = String(p.razorpay_order_id || ""), pid = String(p.razorpay_payment_id || ""), sig = String(p.razorpay_signature || "");
  if (!/^order_[A-Za-z0-9]+$/.test(oid) || !/^pay_[A-Za-z0-9]+$/.test(pid) || !/^[0-9a-f]{64}$/i.test(sig)) throw fail(400, "Invalid payment details.");
  const o = (await query("SELECT * FROM wallet_orders WHERE provider_ref=$1 AND user_id=$2 AND provider='razorpay'", [oid, userId])).rows[0];
  if (!o) throw fail(404, "We could not find that top-up on your account.");
  const want = crypto.createHmac("sha256", RZP_SECRET()).update(oid + "|" + pid).digest();
  const got = Buffer.from(sig, "hex");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw fail(400, "Payment signature check failed.");
  let pay = await rzp("GET", "/v1/payments/" + pid);
  if (pay.order_id !== oid || Number(pay.amount) !== Number(o.charge_amount) || String(pay.currency).toUpperCase() !== o.charge_currency) { console.error("[WALLET] Razorpay mismatch", pid); throw fail(409, "The payment did not match the order. Please contact support."); }
  if (pay.status === "authorized") pay = await rzp("POST", "/v1/payments/" + pid + "/capture", { amount: Number(o.charge_amount), currency: o.charge_currency });
  if (pay.status !== "captured") throw fail(402, "The payment has not been completed yet.");
  return creditRazorpay(o, pay);
}

/* Browser closed before we heard back? Look at this user's open orders from the last 24 hours and credit any that were really paid. */
async function reconcile(userId) {
  await query("UPDATE wallet_orders SET status='expired' WHERE user_id=$1 AND status='created' AND created_at < NOW() - INTERVAL '24 hours'", [userId]);
  const open = (await query("SELECT * FROM wallet_orders WHERE user_id=$1 AND status='created' AND provider_ref IS NOT NULL ORDER BY id DESC LIMIT 5", [userId])).rows;
  let added = 0;
  for (const o of open) {
    try {
      if (o.provider === "razorpay") {
        const list = await rzp("GET", "/v1/orders/" + o.provider_ref + "/payments");
        const pay = (list.items || []).find((x) => x.status === "captured" && Number(x.amount) === Number(o.charge_amount));
        if (pay) { const r = await creditRazorpay(o, pay); if (r.credited) added += r.amountCents; }
      } else {
        const r = await confirmStripe(userId, o.provider_ref).catch((e) => (e.status === 402 ? null : Promise.reject(e)));
        if (r && r.credited) added += r.amountCents;
      }
    } catch (e) { console.warn("[WALLET] reconcile", o.id, e.message); }
  }
  return { addedCents: added, balanceCents: await balance(userId) };
}

/* ---------- the universal (main) admin tops up any account ---------- */
async function adminTopup(admin, userId, cents, note, requestId) {
  if (!Number.isInteger(cents) || cents < 1) throw fail(400, "Enter an amount greater than zero.");
  if (cents > ADMIN_MAX_CENTS()) throw fail(400, `An admin top-up can be at most $${(ADMIN_MAX_CENTS() / 100).toFixed(2)}.`);
  const u = (await query("SELECT id,name,email FROM users WHERE id=$1", [userId])).rows[0];
  if (!u) throw fail(404, "User not found.");
  const rid = String(requestId || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 60);
  const res = await credit(u.id, cents, { kind: "admin_topup", provider: "admin", ref: rid ? "admin:" + rid : null, note: (note ? String(note).trim().slice(0, 200) : "") || "Added by support", adminId: admin.id });
  console.log("[WALLET]", admin.username || admin.id, "topped up user", u.id, "by", cents, "cents", res.credited ? "" : "(duplicate request ignored)");
  return { ...res, user: { id: Number(u.id), name: u.name, email: u.email } };
}

module.exports = { initTables, methods, limits, toCents, balance, ledger, credit, spend, startStripe, confirmStripe, startRazorpay, verifyRazorpay, reconcile, adminTopup, MIN_CENTS, MAX_CENTS, ADMIN_MAX_CENTS };
