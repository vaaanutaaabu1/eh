"use strict";

const express = require("express");
const W = require("../services/walletService");
const { requireUser } = require("../middleware/userAuth");

const router = express.Router();
router.use(requireUser);
router.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    if (!e.status) console.error("[WALLET]", e.message);
    res.status(e.status || 500).json({ success: false, message: e.status ? e.message : "Something went wrong. Please try again." });
  }
};
const baseUrl = (req) => String(process.env.WEBSITE_URL || "").trim().replace(/\/+$/, "") || `${req.protocol}://${req.get("host")}`;
const money = (c) => "$" + (c / 100).toFixed(2);

/* balance (+ history and what is switched on) */
router.get("/", wrap(async (req, res) => {
  const out = { success: true, balanceCents: await W.balance(req.user.id), currency: "USD" };
  if (!req.query.lite) Object.assign(out, { methods: W.methods(), limits: W.limits(), ledger: await W.ledger(req.user.id, 20, 0) });
  res.json(out);
}));
router.get("/ledger", wrap(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  res.json({ success: true, page, items: await W.ledger(req.user.id, 20, (page - 1) * 20) });
}));

/* start a top-up: { method: "card" | "stripe" | "razorpay", amount: 25 }  (amount in USD) */
router.post("/topup", wrap(async (req, res) => {
  const b = req.body || {}, method = String(b.method || ""), cents = W.toCents(b.amount);
  if (!["card", "stripe", "razorpay"].includes(method)) return res.status(400).json({ success: false, message: "Choose a payment method." });
  if (cents == null) return res.status(400).json({ success: false, message: "Enter an amount in dollars, for example 25 or 25.50." });
  if (cents < W.MIN_CENTS()) return res.status(400).json({ success: false, message: `The smallest top-up is ${money(W.MIN_CENTS())}.` });
  if (cents > W.MAX_CENTS()) return res.status(400).json({ success: false, message: `The largest top-up is ${money(W.MAX_CENTS())}.` });
  if (!W.methods()[method]) return res.status(503).json({ success: false, message: "This payment option isn't switched on yet." });
  if (method === "razorpay") return res.json({ success: true, razorpay: await W.startRazorpay(req.user, cents) });
  res.json({ success: true, url: await W.startStripe(req.user, cents, method, baseUrl(req)) });
}));

/* the browser came back from Stripe */
router.get("/confirm/stripe", wrap(async (req, res) => {
  const r = await W.confirmStripe(req.user.id, String(req.query.session_id || ""));
  res.json({ success: true, credited: r.credited, amountCents: r.amountCents, balanceCents: r.balanceCents });
}));

/* Razorpay checkout finished in the browser */
router.post("/razorpay/verify", wrap(async (req, res) => {
  const r = await W.verifyRazorpay(req.user.id, req.body || {});
  res.json({ success: true, credited: r.credited, amountCents: r.amountCents, balanceCents: r.balanceCents });
}));

/* credits payments that finished while the browser was closed */
router.post("/reconcile", wrap(async (req, res) => {
  const r = await W.reconcile(req.user.id);
  res.json({ success: true, addedCents: r.addedCents, balanceCents: r.balanceCents });
}));

module.exports = router;
