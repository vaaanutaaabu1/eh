/* Navbar unlock balance: "N unlocks" next to the account button (members and visitors; a visitor sees the unlocks earned by uploads and uses them after signing up).
   Counts earned upload unlocks + unlocks left in the paid 30-pack. Every unlock that is spent is debited automatically on the server,
   so the number is simply read again. Clicking it opens My documents in the account. window.AHUnlocks.refresh() re-reads it. */
(function () {
  if (window.AHUnlocks) return;
  /* One fixed colour in every browser: solid fallback + static gradient, no animation (an animated background shows a different frame per browser). */
  var css = '.ukc{display:inline-flex;align-items:center;gap:5px;flex:none;white-space:nowrap;text-decoration:none;font:700 12.5px system-ui,sans-serif;color:#fff!important;background-color:#e11d74!important;background-image:-webkit-linear-gradient(left,#a21caf,#e11d74,#f97316)!important;background-image:linear-gradient(90deg,#a21caf,#e11d74,#f97316)!important;border-radius:999px;padding:5px 8px;box-shadow:0 4px 12px #a21caf40;transition:transform .2s}'
    + '.ukc:hover{transform:translateY(-2px)}.ukc b{background:#fff;color:#a21caf;border-radius:999px;min-width:20px;height:20px;display:inline-grid;place-items:center;padding:0 5px;font-size:12px}.ukc.bump b{animation:ukb .6s ease}'
    + '@keyframes ukb{40%{transform:scale(1.5)}}@media(prefers-reduced-motion:reduce){.ukc b{animation:none!important}}';
  var ucss = 'a.utu.utb,html .nv a.nl.utu,html .sh .nv a.nl.utu{display:inline-flex;align-items:center;justify-content:center;gap:6px;text-decoration:none;font:700 13.5px system-ui,sans-serif;white-space:nowrap;color:#fff!important;border-radius:999px;padding:8px 12px;background-color:#e11d74!important;background-image:-webkit-linear-gradient(left,#a21caf,#e11d74,#f97316)!important;background-image:linear-gradient(90deg,#a21caf,#e11d74,#f97316)!important;box-shadow:0 5px 14px #a21caf40;animation:none!important;transition:transform .2s}'
    + 'a.utu.utb:hover,html .nv a.nl.utu:hover{transform:translateY(-2px);background-image:linear-gradient(90deg,#a21caf,#e11d74,#f97316)!important}a.utu::after{display:none!important}';
  (function () { var st = document.createElement("style"); st.textContent = ucss; document.head.appendChild(st); })();
  var chip = null, last = null;
  function host() { return document.getElementById("acc") || document.getElementById("shacc") || document.querySelector("[data-unlock-host]"); }
  function paint(b) {
    var h = host(); if (!h || !b) return;
    if (b.guest) { if (chip) { chip.remove(); chip = null; } return; } /* the unlocks balance is shown only inside a signed-in account */
    if (!chip) {
      var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
      chip = document.createElement("a"); chip.className = "ukc"; chip.href = b.guest ? "/signup?next=/doc" : "/account#docs";
      h.parentNode.insertBefore(chip, h);
    }
    var n = b.total || 0;
    chip.removeAttribute("title"); chip.setAttribute("aria-label", "Balance: " + n);
    chip.className = "ukc" + (last !== null && last !== n ? " bump" : "");
    chip.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 11V8a5 5 0 0 1 9.6-2"/><rect x="4" y="11" width="16" height="10" rx="2"/></svg><b>' + n + '</b>';
    last = n;
  }
  function refresh() {
    return fetch("/api/docs/balance", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { if (d && d.success) paint(d); }).catch(function () {});
  }
  window.AHUnlocks = { refresh: refresh };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", refresh); else refresh();
})();
