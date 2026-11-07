"use strict";
const express = require("express");
const Q = require("../services/quotaService");
const S = require("../services/docService");
const { requireUser } = require("../middleware/userAuth");
const { chatRateLimit } = require("../middleware/chatRateLimit");
const router = express.Router();
router.use(express.json({ limit: "20kb" }));
const base = (req) => String(process.env.WEBSITE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error("[QUOTA]", e.message); res.status(500).json({ success: false, message: "Something went wrong. Please try again." }); });

/* The member's monthly allowance and what is left of each service. */
router.get("/", requireUser, wrap(async (req, res) => { res.set("Cache-Control", "no-store"); res.json({ success: true, ...(await Q.status(req.user.id)) }); }));

/* Top up ONE service (default $5 = 30 more uses for the rest of the month). */
router.post("/topup", chatRateLimit, requireUser, wrap(async (req, res) => {
  const service = String((req.body || {}).service || "");
  if (!Q.SERVICES[service]) return res.status(400).json({ success: false, message: "Unknown service." });
  if (!(await Q.isActive(req.user.id))) return res.status(402).json({ success: false, message: "Top-ups are for subscribers. Subscribe first." });
  const s = await S.stripe("POST", "/v1/checkout/sessions", { mode: "payment", customer_email: req.user.email, "line_items[0][quantity]": "1", "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(Q.TOPUP_CENTS()), "line_items[0][price_data][product_data][name]": `Top up: ${Q.TOPUP_UNITS()} more ${Q.SERVICES[service].short}`,
    "metadata[user_id]": String(req.user.id), "metadata[kind]": "quota_topup", "metadata[service]": service,
    success_url: `${base(req)}/account?topup={CHECKOUT_SESSION_ID}`, cancel_url: `${base(req)}/account` });
  res.json({ success: true, url: s.url });
}));
router.post("/confirm", requireUser, wrap(async (req, res) => {
  const id = String((req.body || {}).session_id || "");
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ success: false, message: "Bad session." });
  const s = await S.stripe("GET", "/v1/checkout/sessions/" + id), m = s.metadata || {};
  if (String(m.user_id) !== String(req.user.id) || m.kind !== "quota_topup" || s.status !== "complete" || s.payment_status !== "paid")
    return res.status(403).json({ success: false, message: "Payment not confirmed." });
  await Q.addTopup(req.user.id, m.service, id);
  res.json({ success: true, service: m.service, ...(await Q.status(req.user.id)) });
}));
module.exports = router;
