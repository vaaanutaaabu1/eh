"use strict";
/*
 * Live updates (Server-Sent Events). Every signed-in page keeps one small connection open to GET /api/live.
 * When something changes for a customer (admin adds unlocks or wallet money, a payment is credited, an unlock / citation /
 * AI detection / Ask AI question is spent, the subscription changes) the server calls emit(userId, type, data) and the
 * customer's open pages refresh their numbers at once, with no browser refresh.
 *
 * Types: "wallet" | "unlocks" | "quota" | "account". `data.msg` (optional) is shown to the customer as a small notice.
 * Connections live in this process's memory: with more than one server instance, run one instance, or the page's
 * 60 second background refresh (and refresh on tab focus) catches up for events raised on another instance.
 */
const clients = new Map();                 // userId -> Set<res>
const MAX_PER_USER = 12;                    // tabs

function add(userId, res) {
  const k = String(userId);
  let set = clients.get(k);
  if (!set) clients.set(k, (set = new Set()));
  if (set.size >= MAX_PER_USER) { const old = set.values().next().value; try { old.end(); } catch (e) { /* closed */ } set.delete(old); }
  set.add(res);
  res.on("close", () => { set.delete(res); if (!set.size) clients.delete(k); });
}

function send(res, type, data) {
  try { res.write("event: " + type + "\ndata: " + JSON.stringify(data || {}) + "\n\n"); } catch (e) { /* connection already gone */ }
}

function emit(userId, type, data) {
  try {
    const set = clients.get(String(userId));
    if (!set) return;
    const payload = Object.assign({ t: Date.now() }, data || {});
    for (const res of set) send(res, type, payload);
  } catch (e) { console.warn("[LIVE] emit:", e.message); }
}

/* keeps proxies from closing idle connections */
setInterval(() => { for (const set of clients.values()) for (const res of set) { try { res.write(": ping\n\n"); } catch (e) { /* ignore */ } } }, 25000).unref();

/* Express handler for GET /api/live (use after requireUser). */
function handler(req, res) {
  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  if (res.flushHeaders) res.flushHeaders();
  res.write("retry: 3000\n\n");
  add(req.user.id, res);
  send(res, "hello", {});
}

module.exports = { emit, handler, connections: () => [...clients.values()].reduce((n, s) => n + s.size, 0) };
