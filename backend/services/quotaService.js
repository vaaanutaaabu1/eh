"use strict";
/*
 * Subscriber allowance: one paid month (the $10 plan) gives PLAN_QUOTA_EACH (30) uses of EACH service:
 *   unlock    document unlocks (one unlock = one library document, view + download; the document then stays unlocked for good)
 *   chat      Ask AI questions (every answered question counts as one)
 *   aidetect  AI detections
 *   citation  citations
 * The allowance starts again on every renewal date. When a service runs out the member can top it up
 * (TOPUP_PRICE_CENTS, default $5, adds TOPUP_UNITS = 30 uses of that service for the rest of the month).
 * "Active" = a running subscription on the account (Subscription tab) OR the library plan bought from a document page.
 */
const { query } = require("../config/database");
const S = require("./docService");
const store = require("./userStore");

const EACH = () => Math.max(1, Number(process.env.PLAN_QUOTA_EACH || 30));
const TOPUP_CENTS = () => Math.max(100, Number(process.env.TOPUP_PRICE_CENTS || 500));
const TOPUP_UNITS = () => Math.max(1, Number(process.env.TOPUP_UNITS || 30));
const live = require("./liveEvents");
const SERVICES = {
  unlock: { label: "Document unlocks (view or download)", short: "unlocks" },
  chat: { label: "Ask AI questions", short: "Ask AI questions" },
  aidetect: { label: "AI detections", short: "AI detections" },
  citation: { label: "Citations", short: "citations" },
  plagiarism: { label: "Plagiarism checks", short: "plagiarism checks" }
};
const KEYS = Object.keys(SERVICES);

let ready = null;
const ensure = () => ready || (ready = (async () => {
  await query(`CREATE TABLE IF NOT EXISTS plan_quota (user_id BIGINT NOT NULL, service VARCHAR(20) NOT NULL, granted INT NOT NULL DEFAULT 0, used INT NOT NULL DEFAULT 0,
    period_key VARCHAR(40) NOT NULL DEFAULT '', period_end TIMESTAMPTZ, topups INT NOT NULL DEFAULT 0, PRIMARY KEY (user_id, service))`);
  await query("CREATE TABLE IF NOT EXISTS plan_topups (ref VARCHAR(120) PRIMARY KEY, user_id BIGINT NOT NULL, service VARCHAR(20) NOT NULL, units INT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
})().catch((e) => { ready = null; throw e; }));

/* Is the member subscribed, and until when? Cached for a minute (Stripe is asked at most once a minute per member). */
const CACHE = new Map();
async function period(userId) {
  const hit = CACHE.get(String(userId));
  if (hit && hit.t > Date.now()) return hit.v;
  let v = { active: false };
  try {
    const row = await store.getSubscription(userId);
    if (row && (row.status === "active" || row.status === "trialing") && row.current_period_end) {
      v = { active: true, end: new Date(row.current_period_end), cancel: !!row.cancel_at_period_end, source: "account" };
    } else {
      const r = (await query("SELECT stripe_sub_id FROM doc_plans WHERE user_id=$1", [userId])).rows[0];
      if (r && r.stripe_sub_id) {
        const sub = await S.stripe("GET", "/v1/subscriptions/" + r.stripe_sub_id);
        if (["active", "trialing"].includes(sub.status)) {
          const e = sub.current_period_end || (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end);
          v = { active: true, end: new Date((e || Math.floor(Date.now() / 1000) + 30 * 86400) * 1000), cancel: !!sub.cancel_at_period_end, source: "library" };
        }
      }
    }
  } catch (e) { console.warn("[QUOTA] period:", e.message); }
  CACHE.set(String(userId), { v, t: Date.now() + 60000 });
  return v;
}
const forget = (userId) => CACHE.delete(String(userId));
const isActive = async (userId) => !!userId && (await period(userId)).active;

/* Creates / renews the member's allowance rows (a new renewal date = fresh 30 of everything). */
async function sync(userId) {
  const p = await period(userId);
  if (!p.active) return null;
  await ensure();
  const key = String(Math.floor(p.end.getTime() / 1000));
  for (const s of KEYS)
    await query(`INSERT INTO plan_quota(user_id,service,granted,used,period_key,period_end) VALUES($1,$2,$3,0,$4,$5)
      ON CONFLICT (user_id,service) DO UPDATE SET granted=$3, used=0, topups=0, period_key=$4, period_end=$5 WHERE plan_quota.period_key<>$4`, [userId, s, EACH(), key, p.end]);
  return p;
}
async function status(userId) {
  const p = await sync(userId);
  if (!p) return { active: false, services: [] };
  const rows = (await query("SELECT service,granted,used,topups FROM plan_quota WHERE user_id=$1", [userId])).rows;
  return {
    active: true, renews: p.end, cancelAtPeriodEnd: !!p.cancel, source: p.source, topupPrice: TOPUP_CENTS() / 100, topupUnits: TOPUP_UNITS(),
    services: KEYS.map((k) => { const r = rows.find((x) => x.service === k) || { granted: EACH(), used: 0, topups: 0 };
      return { key: k, label: SERVICES[k].label, unit: SERVICES[k].short, granted: r.granted, used: r.used, left: Math.max(0, r.granted - r.used), topups: r.topups }; })
  };
}
const left = async (userId, service) => {
  if (!(await sync(userId))) return 0;
  const r = (await query("SELECT granted-used AS n FROM plan_quota WHERE user_id=$1 AND service=$2", [userId, service])).rows[0];
  return r ? Math.max(0, r.n) : 0;
};
/* Takes one use. Returns true when it was taken. */
async function consume(userId, service) {
  if (!(await sync(userId))) return false;
  const ok = (await query("UPDATE plan_quota SET used=used+1 WHERE user_id=$1 AND service=$2 AND used<granted AND (period_end IS NULL OR period_end>NOW())", [userId, service])).rowCount > 0;
  if (ok) live.emit(userId, "quota", { service });
  return ok;
}
async function refund(userId, service) {
  try { await query("UPDATE plan_quota SET used=GREATEST(used-1,0) WHERE user_id=$1 AND service=$2", [userId, service]); live.emit(userId, "quota", { service }); } catch (e) { console.warn("[QUOTA] refund:", e.message); }
}
/* A paid top-up (verified with Stripe by the route). The reference makes it safe to confirm twice. */
async function addTopup(userId, service, ref) {
  if (!SERVICES[service]) return false;
  await sync(userId); await ensure();
  const ins = await query("INSERT INTO plan_topups(ref,user_id,service,units) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [ref, userId, service, TOPUP_UNITS()]);
  if (!ins.rowCount) return true;
  await query("UPDATE plan_quota SET granted=granted+$3, topups=topups+$3 WHERE user_id=$1 AND service=$2", [userId, service, TOPUP_UNITS()]);
  live.emit(userId, "quota", { service, msg: TOPUP_UNITS() + " more " + SERVICES[service].short + " added." });
  return true;
}
const emptyMessage = (service) => `You have used all ${EACH()} ${SERVICES[service].short} of this month's plan. Top up ${TOPUP_UNITS()} more for $${(TOPUP_CENTS() / 100).toFixed(0)} from your account page.`;

/* Express middleware for a service route that already has req.user: subscribers spend one use (given back when the request fails);
   everybody else passes through unchanged. */
const meter = (service) => async (req, res, next) => {
  try {
    if (!req.user || !(await isActive(req.user.id))) return next();
    if (!(await consume(req.user.id, service)))
      return res.status(402).json({ success: false, code: "QUOTA_EMPTY", needsTopup: true, service, message: emptyMessage(service) });
    let done = false; const back = () => { if (!done) { done = true; refund(req.user.id, service); } };
    const send = res.json.bind(res);
    res.json = (body) => { if (res.statusCode >= 400 || !body || body.success === false) back(); else done = true; return send(body); };
    res.on("close", () => { if (!res.writableFinished) back(); });
    next();
  } catch (e) { console.error("[QUOTA]", e.message); next(); }
};
module.exports = { SERVICES, KEYS, EACH, TOPUP_CENTS, TOPUP_UNITS, isActive, forget, status, left, consume, refund, addTopup, emptyMessage, meter, period };
