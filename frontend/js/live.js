/* Live updates: one Server-Sent Events connection per signed-in page (GET /api/live).
   When the server says something changed (admin added unlocks or wallet money, a payment landed, an unlock / citation /
   AI detection / Ask AI question was used, the plan changed) every page refreshes its numbers at once, no reload.
   Pages listen with:  window.addEventListener("ah:live", function (e) { e.detail.type, e.detail.data })
   Types: wallet | unlocks | quota | account | resync (after a dropped connection or when the tab becomes visible). */
(function () {
  if (window.AHLive) return;
  var es = null, tries = 0, timer = null, wasDown = false;
  function signedIn() { return /(?:^|;\s*)ah_in=1/.test(document.cookie); }
  function toast(msg) {
    var t = document.createElement("div");
    t.setAttribute("role", "status");
    t.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483000;max-width:min(92vw,360px);background:#111827;color:#fff;font:600 14px/1.4 system-ui,sans-serif;padding:12px 16px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.3);opacity:0;transform:translateY(8px);transition:opacity .25s,transform .25s";
    t.textContent = msg; document.body.appendChild(t);
    requestAnimationFrame(function () { t.style.opacity = "1"; t.style.transform = "none"; });
    setTimeout(function () { t.style.opacity = "0"; setTimeout(function () { t.remove(); }, 300); }, 5000);
  }
  function fire(type, data) {
    if (window.AHUnlocks) window.AHUnlocks.refresh();          /* navbar unlock chip */
    try { window.dispatchEvent(new CustomEvent("ah:live", { detail: { type: type, data: data || {} } })); } catch (e) { /* old browser */ }
    if (data && data.msg && document.body) toast(data.msg);
  }
  function open() {
    if (es || !window.EventSource || !signedIn()) return;
    es = new EventSource("/api/live", { withCredentials: true });
    ["wallet", "unlocks", "quota", "account"].forEach(function (t) {
      es.addEventListener(t, function (e) { var d = {}; try { d = JSON.parse(e.data); } catch (x) { /* ignore */ } fire(t, d); });
    });
    es.addEventListener("hello", function () { tries = 0; if (wasDown) { wasDown = false; fire("resync"); } });
    es.onerror = function () {
      wasDown = true;
      if (es && es.readyState === 2) {                          /* closed for good (e.g. logged out): try again later */
        es = null; clearTimeout(timer);
        if (signedIn()) timer = setTimeout(open, Math.min(30000, 2000 * (++tries)));
      }
    };
  }
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) return;
    if (!es) open();
    fire("resync");                                             /* catches anything missed while the tab slept */
  });
  window.addEventListener("online", function () { if (!es) open(); fire("resync"); });
  window.AHLive = { open: open };
  open();
})();
