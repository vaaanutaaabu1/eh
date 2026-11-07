/* Plagiarism & Grammar page. Left: your text. Right: results.
 * Flow: Check -> "Your results are ready!" (number blurred) -> "See Results":
 *   - subscribers go straight to the full report;
 *   - everyone else picks ONE of two options: Free (headline numbers + small preview) or Subscribe $10/month (full report).
 * The server withholds the locked data for Free accounts; nothing here is only "hidden". */
(function () {
  "use strict";
  var API = "/api/writing", PAGE = "/tools/plagiarism-grammar-checker", MAXC = 30000, MAXW = 5000, MINW = { plag: 40, gram: 3 };
  var $ = function (id) { return document.getElementById(id); };
  var S = { tab: "plag", res: null, resTab: "", status: null, shown: false, busy: false };
  var ta = $("ta"), view = $("view"), left = $("left"), rp = $("rp"), go = $("go"), err = $("err");
  var ICON = {
    ok: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
    no: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    doc: '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><circle cx="11" cy="14" r="2.6"/><path d="M13 16l2.5 2.5"/></svg>',
    gr: '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l4-12 4 12M5.5 16h5"/><path d="M15 14l3 3 5-6"/></svg>'
  };
  var CATL = { grammar: "Grammar", spelling: "Spelling", punctuation: "Punctuation", style: "Style", clarity: "Clarity" };
  var SAMPLE = {
    plag: "The industrial revolution transformed the way people lived and worked across Europe. Factories replaced small workshops, and cities grew at an extraordinary pace during the nineteenth century. Many historians argue that this period laid the foundation for modern economic growth. Steam power allowed manufacturers to build mills away from rivers, which changed where towns could appear. Working conditions in the early factories were often harsh, and reformers pressed Parliament to pass laws limiting child labour.",
    gram: "Their are many reasons why students dont finish there essays on time. First, they often starts writing to late, and then they realy struggle to find a good ending. Its important to make a plan and stick to it, in order to avoid the the last minute rush. Me and my friends have learned this lesson the hard way."
  };
  var h = function (t) { return String(t).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  var words = function (s) { return (s.match(/[A-Za-z0-9À-ɏ][A-Za-z0-9À-ɏ'’-]*/g) || []).length; };
  var el = function (tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  var isPro = function () { return !!(S.res && S.res.plan === "pro") || !!(S.status && S.status.plan === "pro"); };

  /* ---------- plan info ---------- */
  function loadStatus() {
    return fetch(API + "/status", { credentials: "same-origin" }).then(function (r) { if (r.status === 401) { toLogin(); throw 0; } return r.json(); }).then(function (j) { if (j && j.success) S.status = j; return j; }).catch(function () {});
  }
  function toLogin() { location.assign("/login?next=" + encodeURIComponent(location.pathname + location.search) + "&tool=tools"); }

  /* ---------- tabs / editor ---------- */
  function setTab(t) {
    S.tab = t; $("tb-plag").className = t === "plag" ? "on" : ""; $("tb-gram").className = t === "gram" ? "on" : "";
    $("tb-plag").setAttribute("aria-selected", t === "plag"); $("tb-gram").setAttribute("aria-selected", t === "gram");
    $("optq").classList.toggle("hide", t !== "plag");
    go.textContent = t === "plag" ? "Check plagiarism" : "Check grammar";
    $("hsub").textContent = t === "plag" ? "Compare your text with the live web and see exactly which passages match which source." : "Fix grammar, spelling, punctuation and style with one-click suggestions.";
    if (S.res && S.resTab === t && S.shown) { showView(); renderReport(); } else { toEdit(true); idle(); }
    count();
  }
  function count() {
    var n = words(ta.value), c = $("cnt"), min = MINW[S.tab];
    c.innerHTML = "<b>" + n.toLocaleString() + "</b>/" + MAXW.toLocaleString() + " words" + (n && n < min ? " (minimum " + min + ")" : "");
    c.className = "cnt" + (n > MAXW ? " warn" : "");
    go.disabled = S.busy || n < min || n > MAXW;
  }
  function toEdit(keep) { left.dataset.mode = "edit"; $("edit").classList.add("hide"); $("leg").classList.add("hide"); go.classList.remove("hide"); $("cnt").classList.remove("hide"); if (!keep) { S.res = null; S.shown = false; idle(); } }
  function showView() { left.dataset.mode = "view"; $("edit").classList.remove("hide"); }
  ta.addEventListener("input", function () { if (ta.value.length > MAXC) ta.value = ta.value.slice(0, MAXC); err.textContent = ""; if (S.res) { S.res = null; S.shown = false; idle(); } count(); });
  $("edit").onclick = function () { toEdit(false); ta.focus(); count(); };
  $("clear").onclick = function () { ta.value = ""; S.res = null; S.shown = false; err.textContent = ""; toEdit(true); idle(); count(); ta.focus(); };
  $("sample").onclick = function () { ta.value = SAMPLE[S.tab]; S.res = null; S.shown = false; toEdit(true); idle(); count(); };
  $("paste").onclick = function () { if (navigator.clipboard && navigator.clipboard.readText) navigator.clipboard.readText().then(function (t) { ta.value = t.slice(0, MAXC); S.res = null; S.shown = false; toEdit(true); idle(); count(); }).catch(function () { ta.focus(); err.textContent = "Press Ctrl+V (or Cmd+V) to paste."; }); else { ta.focus(); err.textContent = "Press Ctrl+V (or Cmd+V) to paste."; } };
  $("tb-plag").onclick = function () { setTab("plag"); }; $("tb-gram").onclick = function () { setTab("gram"); };

  /* file upload / drop */
  function readFile(f) {
    if (!f) return;
    if (!/\.(txt|md|docx|pdf)$/i.test(f.name)) { err.textContent = "Please upload a .txt, .docx or .pdf file."; return; }
    if (f.size > 10 * 1048576) { err.textContent = "That file is over 10 MB."; return; }
    err.textContent = "Reading " + f.name + "…";
    var fd = new FormData(); fd.append("file", f, f.name);
    fetch(API + "/extract", { method: "POST", body: fd, credentials: "same-origin" }).then(function (r) { if (r.status === 401) { toLogin(); throw 0; } return r.json().catch(function () { return {}; }); })
      .then(function (j) { if (!j.success) throw new Error(j.message || "Couldn't read that file."); ta.value = j.text.slice(0, MAXC); S.res = null; S.shown = false; toEdit(true); idle(); count(); err.textContent = j.truncated ? "Only the first " + MAXW.toLocaleString() + " words are used." : ""; })
      .catch(function (e) { if (e) err.textContent = e.message || "Connection problem. Please try again."; });
  }
  $("pick").onclick = function () { $("file").click(); };
  $("file").onchange = function () { readFile(this.files && this.files[0]); this.value = ""; };
  ["dragover", "drop"].forEach(function (ev) { left.addEventListener(ev, function (e) {
    if (!e.dataTransfer || [].indexOf.call(e.dataTransfer.types || [], "Files") < 0) return; e.preventDefault();
    if (ev === "drop") { left.classList.remove("drag"); readFile(e.dataTransfer.files[0]); } else left.classList.add("drag"); }); });
  left.addEventListener("dragleave", function () { left.classList.remove("drag"); });

  /* ---------- right panel states ---------- */
  function feat(list) { var u = el("ul", "feat"); list.forEach(function (x) { var li = el("li", x[1] ? "lk" : ""); li.innerHTML = (x[1] ? ICON.no : ICON.ok) + "<span></span>"; li.lastChild.textContent = x[0]; u.appendChild(li); }); return u; }
  function reset() { rp.textContent = ""; rp.scrollTop = 0; }
  function idle() {
    reset(); var ill = el("div", "ill"); ill.innerHTML = S.tab === "plag" ? ICON.doc : ICON.gr; rp.appendChild(ill);
    rp.appendChild(el("h2", "", S.tab === "plag" ? "Check for plagiarism" : "Check your writing"));
    rp.appendChild(el("p", "hint", S.tab === "plag" ? "Paste at least 40 words. Your text is compared with pages on the live web." : "Paste your text to find grammar, spelling, punctuation and style problems."));
    rp.appendChild(feat(S.tab === "plag"
      ? [["Searches the live web", 0], ["Sentence-by-sentence matching", 0], ["Linked sources for every match", 0], ["Upload .txt, .docx or .pdf", 0]]
      : [["Grammar, spelling & punctuation", 0], ["Style and clarity suggestions", 0], ["One-click fixes", 0], ["Readability score", 0]]));
  }
  function busy(msgs) {
    reset(); rp.appendChild(el("div", "spin")); rp.appendChild(el("h2", "", "Checking your text…"));
    var st = el("div", "steps", msgs[0]); rp.appendChild(st); var i = 0;
    S.tick = setInterval(function () { i = Math.min(msgs.length - 1, i + 1); st.textContent = msgs[i]; }, 3500);
  }
  function stopBusy() { clearInterval(S.tick); S.busy = false; count(); }

  /* ---------- run a check ---------- */
  function run() {
    var text = ta.value.trim(), tab = S.tab, n = words(text);
    if (n < MINW[tab]) return;
    err.textContent = ""; S.busy = true; S.res = null; S.shown = false; count();
    busy(tab === "plag" ? ["Searching the web for matching phrases…", "Reading the pages that were found…", "Comparing every sentence…", "Building your report…"] : ["Checking grammar and spelling…", "Looking at punctuation and style…", "Scoring readability…"]);
    fetch(API + (tab === "plag" ? "/plagiarism" : "/grammar"), { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: text, excludeQuotes: $("exq").checked }) })
      .then(function (r) { return r.json().catch(function () { return { success: false, message: "Something went wrong." }; }).then(function (j) { j._s = r.status; return j; }); })
      .then(function (j) {
        stopBusy();
        if (j._s === 401) return toLogin();
        if (!j.success) {
          idle();
          if (j.needsPlan || j.needsTopup) { S.limit = j.message; openPlans(j.message, true); return; }
          err.textContent = j.message || "Something went wrong. Please try again."; return;
        }
        S.res = j; S.resTab = tab; S.text = (tab === "gram" && j.text) ? j.text : text; S.shown = false; loadStatus();
        if (j.plan === "pro") { S.shown = true; if (tab === "gram") ta.value = S.text; showView(); renderReport(); } else ready();
      })
      .catch(function () { stopBusy(); idle(); err.textContent = "Connection problem. Please try again."; });
  }
  go.onclick = run;

  /* "Your results are ready!" with the number blurred (Free accounts) */
  function ready() {
    var j = S.res, plag = S.resTab === "plag"; reset();
    rp.appendChild(el("h2", "", "Your results are ready!"));
    var n = el("div", "big-n blur"); n.innerHTML = (plag ? j.similarity : j.score) + "<small>%</small>"; n.setAttribute("aria-hidden", "true"); rp.appendChild(n);
    rp.appendChild(el("div", "lbl", plag ? "Plagiarism" : "Writing score"));
    var b = el("button", "b big", "See Results"); b.type = "button"; b.onclick = seeResults; rp.appendChild(b);
    rp.appendChild(feat(plag
      ? [["Similarity % and uniqueness", 0], ["Every matched passage highlighted", 0], ["Links to the source pages", 0]]
      : [["Writing score and issue counts", 0], ["Every fix, one click to accept", 0], ["Readability analysis", 0]]));
  }
  function seeResults() {
    if (isPro()) { S.shown = true; showView(); renderReport(); return; }
    openPlans();
  }

  /* ---------- the two options ---------- */
  function li(ul, t, no) { var l = el("li", no ? "no" : ""); l.innerHTML = (no ? ICON.no : ICON.ok) + "<span></span>"; l.lastChild.textContent = t; ul.appendChild(l); }
  function openPlans(msg, limitHit) {
    var plag = S.tab === "plag", fl = $("fl"), pl = $("pl"); fl.textContent = ""; pl.textContent = ""; $("merr").textContent = "";
    var per = (S.status && S.status.free && S.status.free.perDay) || 3;
    if (plag) {
      li(fl, "Similarity % and uniqueness score"); li(fl, "A preview of 2 matched passages"); li(fl, per + " free checks a day"); li(fl, "Source links and full highlighting", 1); li(fl, "Downloadable report", 1);
      li(pl, "Every matched passage highlighted"); li(pl, "Links to every source page"); li(pl, "Downloadable report"); li(pl, "30 plagiarism checks a month"); li(pl, "Unlimited grammar checks with one-click fixes"); li(pl, "Plus 30 unlocks, 30 citations, 30 AI detections, 30 Ask AI questions");
    } else {
      li(fl, "Writing score, issue counts and readability"); li(fl, "The first 3 fixes, one click to accept"); li(fl, per + " free checks a day"); li(fl, "All remaining fixes and Accept all", 1); li(fl, "Plagiarism source links", 1);
      li(pl, "Every grammar, spelling, punctuation and style fix"); li(pl, "Accept all with one click"); li(pl, "Unlimited grammar checks"); li(pl, "30 plagiarism checks with source links"); li(pl, "Plus 30 unlocks, 30 citations, 30 AI detections, 30 Ask AI questions");
    }
    $("mh").textContent = limitHit ? "You've reached today's free limit" : "See your results";
    $("ms").textContent = msg || "Choose how you want to view them.";
    $("pf").classList.toggle("hide", !!limitHit);
    $("ovl").classList.add("on"); setTimeout(function () { (limitHit ? $("ps") : $("pf")).focus(); }, 30);
  }
  function closePlans() { $("ovl").classList.remove("on"); }
  $("mx").onclick = closePlans; $("ovl").addEventListener("mousedown", function (e) { if (e.target === $("ovl")) closePlans(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closePlans(); });
  $("pf").onclick = function () { closePlans(); S.shown = true; showView(); renderReport(); };
  $("ps").onclick = function () {
    var b = this, old = b.textContent; b.disabled = true; b.textContent = "Opening secure checkout…"; $("merr").textContent = "";
    try { sessionStorage.setItem("wc_draft", JSON.stringify({ text: ta.value, tab: S.tab, t: Date.now() })); } catch (e) {}
    fetch("/api/billing/checkout", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returnTo: PAGE }) })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (d) { if (d && d.url) { location.href = d.url; return; } throw new Error((d && d.message) || ""); })
      .catch(function (e) { b.disabled = false; b.textContent = old; $("merr").textContent = (e && e.message) || "Checkout isn't available right now. Please try again in a moment."; });
  };
  /* back from Stripe: confirm, then re-run the saved text with the full report */
  function afterCheckout() {
    var q = new URLSearchParams(location.search), sid = q.get("session_id");
    if (q.get("checkout") !== "success" || !/^cs_[A-Za-z0-9_]+$/.test(sid || "")) return false;
    history.replaceState(null, "", PAGE);
    reset(); rp.appendChild(el("div", "spin")); rp.appendChild(el("h2", "", "Activating your plan…"));
    fetch("/api/billing/confirm?session_id=" + encodeURIComponent(sid), { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function () { return loadStatus(); }).then(function () {
      var d = null; try { d = JSON.parse(sessionStorage.getItem("wc_draft") || "null"); sessionStorage.removeItem("wc_draft"); } catch (e) {}
      idle();
      if (d && d.text) { ta.value = d.text; setTab(d.tab === "gram" ? "gram" : "plag"); count(); if (!go.disabled) run(); }
    }).catch(function () { idle(); err.textContent = "We couldn't confirm the payment yet. Refresh in a minute or contact support."; });
    return true;
  }

  /* ---------- report ---------- */
  function renderReport() { reset(); if (S.resTab === "plag") plagReport(); else gramReport(); }

  function gauge(pct, color, label) {
    var r = 80, c = Math.PI * r, d = c * Math.max(0, Math.min(100, pct)) / 100;
    var s = '<svg class="gauge" viewBox="0 0 200 120" role="img" aria-label="' + h(label + " " + pct + "%") + '"><path d="M20 100a80 80 0 0 1 160 0" fill="none" stroke="#e5e7ef" stroke-width="16" stroke-linecap="round"/><path d="M20 100a80 80 0 0 1 160 0" fill="none" stroke="' + color + '" stroke-width="16" stroke-linecap="round" stroke-dasharray="' + d + ' ' + c + '"/><text x="100" y="88" text-anchor="middle" font-size="38" font-weight="800" fill="#1c2233">' + pct + '%</text><text x="100" y="112" text-anchor="middle" font-size="13" fill="#667085">' + h(label) + '</text></svg>';
    var w = el("div"); w.innerHTML = s; return w.firstChild;
  }
  function upsell(txt) { var b = el("div", "lockbox"); b.appendChild(el("b", "", "Unlock the full report")); b.appendChild(el("span", "", txt)); var bt = el("button", "b", "Subscribe – $10/month"); bt.type = "button"; bt.onclick = function () { openPlans(); }; b.appendChild(bt); return b; }

  function plagReport() {
    var j = S.res, pro = j.plan === "pro", hi = j.similarity >= 40, mid = j.similarity >= 15;
    rp.appendChild(gauge(j.similarity, hi ? "#dc2626" : mid ? "#d97706" : "#16a34a", "Similarity"));
    rp.appendChild(el("span", "verdict " + (hi ? "v-hi" : mid ? "v-mid" : "v-lo"), j.verdict));
    var st = el("div", "stats"); [[j.uniqueness + "%", "Unique"], [j.flagged, "Matched sentences"], [j.words.toLocaleString(), "Words"]].forEach(function (x) { var d = el("div"); d.appendChild(el("b", "", String(x[0]))); d.appendChild(document.createTextNode(x[1])); st.appendChild(d); }); rp.appendChild(st);
    /* the text, highlighted */
    view.textContent = ""; var spans = {};
    j.sentences.forEach(function (s) {
      if (!s.kind || s.kind === "quote") { view.appendChild(document.createTextNode(s.t)); return; }
      var sp = el("span", "sent " + (s.kind === "locked" ? "k" : s.kind === "match" ? "m" : "p"), s.t);
      if (s.kind === "locked") sp.title = "Matched passage (subscribe to see it)"; else { sp.title = Math.round(s.sim * 100) + "% match"; sp.dataset.src = s.src; }
      sp.onclick = function () { pick(s.src); }; view.appendChild(sp);
    });
    var leg = $("leg"); leg.classList.remove("hide"); leg.innerHTML = '<span><i style="background:#fecaca"></i>Matched</span><span><i style="background:#fde68a"></i>Partly matched</span>' + (pro ? "" : '<span><i style="background:repeating-linear-gradient(45deg,#e0e7ff,#e0e7ff 3px,#eef2ff 3px,#eef2ff 6px)"></i>Locked</span>');
    go.classList.add("hide"); $("cnt").classList.add("hide");
    var box = el("div", "src");
    if (pro) {
      box.appendChild(el("h3", "", j.sources.length ? "Sources (" + j.sources.length + ")" : "No matching sources found"));
      j.sources.forEach(function (s) {
        var a = el("a", "si"); a.href = s.url; a.target = "_blank"; a.rel = "noopener nofollow noreferrer"; a.dataset.id = s.id;
        var pc = el("span", "pc", s.percent + "%"); a.appendChild(pc); a.appendChild(el("b", "", s.title)); a.appendChild(el("small", "", s.domain + " · " + s.words + " words")); box.appendChild(a);
      });
      if (!j.sources.length) box.appendChild(el("p", "hint", "Nothing in this text matched pages we could find online. " + j.pagesRead + " pages were compared."));
      var d = el("button", "b g", "⬇ Download report"); d.type = "button"; d.style.width = "100%"; d.onclick = download; box.appendChild(d);
    } else {
      box.appendChild(el("h3", "", "Preview"));
      box.appendChild(el("p", "hint", j.flagged ? "Showing " + Math.min(2, j.flagged) + " of " + j.flagged + " matched passages." : "No matching passages were found."));
      if (j.sourcesHidden || j.passagesHidden) box.appendChild(upsell((j.sourcesHidden ? j.sourcesHidden + " source" + (j.sourcesHidden === 1 ? "" : "s") + " with links" : "") + (j.sourcesHidden && j.passagesHidden ? " and " : "") + (j.passagesHidden ? j.passagesHidden + " more matched passage" + (j.passagesHidden === 1 ? "" : "s") : "") + " are hidden on the Free plan."));
      else if (j.flagged) box.appendChild(upsell("Source links and the downloadable report are part of the $10/month plan."));
    }
    rp.appendChild(box);
    function pick(id) { [].forEach.call(rp.querySelectorAll(".si"), function (x) { x.classList.toggle("on", String(x.dataset.id) === String(id)); }); [].forEach.call(view.querySelectorAll(".sent"), function (x) { x.classList.toggle("on", String(x.dataset.src) === String(id) && id); }); var t = rp.querySelector(".si.on"); if (t) t.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  }

  function gramReport() {
    var j = S.res, pro = j.plan === "pro", good = j.score >= 85, mid = j.score >= 60;
    rp.appendChild(gauge(j.score, good ? "#16a34a" : mid ? "#d97706" : "#dc2626", "Writing score"));
    var total = j.issues.length, c = {}; j.issues.forEach(function (i) { c[i.category] = (c[i.category] || 0) + 1; });
    var cats = el("div", "cats"); Object.keys(CATL).forEach(function (k) { if (c[k]) cats.appendChild(el("span", "cat " + k, c[k] + " " + CATL[k])); }); if (!total) cats.appendChild(el("span", "cat", "No issues found")); rp.appendChild(cats);
    var s = j.stats, rd = el("div", "rd"); [[s.readingLabel, "Readability"], ["Grade " + s.gradeLevel, "Reading level"], [s.words.toLocaleString(), "Words"], [s.readingMinutes + " min", "Reading time"]].forEach(function (x) { var d = el("div"); d.appendChild(el("b", "", String(x[0]))); d.appendChild(document.createTextNode(x[1])); rd.appendChild(d); }); rp.appendChild(rd);
    if (j.engine === "basic") rp.appendChild(el("p", "hint", "Advanced grammar engine is offline, so basic checks were used."));
    var leg = $("leg"); leg.classList.remove("hide"); leg.innerHTML = '<span><i style="background:#dc2626"></i>Grammar / spelling</span><span><i style="background:#d97706"></i>Punctuation</span><span><i style="background:#2563eb"></i>Style</span><span><i style="background:#7c3aed"></i>Clarity</span>';
    go.classList.add("hide"); $("cnt").classList.add("hide");
    if (pro && total > 1) { var all = el("button", "b ok", "Accept all (" + total + ")"); all.type = "button"; all.style.cssText = "width:100%;margin:6px 0 10px"; all.onclick = acceptAll; rp.appendChild(all); }
    var list = el("div", "src"); list.id = "ilist"; rp.appendChild(list);
    if (!pro && j.issuesHidden) rp.appendChild(upsell(j.issuesHidden + " more fix" + (j.issuesHidden === 1 ? " is" : "es are") + " locked on the Free plan, plus Accept all."));
    paint();
  }
  function paint() {
    var j = S.res, text = S.text, pos = 0, issues = j.issues.slice().sort(function (a, b) { return a.offset - b.offset; });
    view.textContent = "";
    issues.forEach(function (i) {
      if (i.offset > pos) view.appendChild(document.createTextNode(text.slice(pos, i.offset)));
      var sp = el("span", "gi " + (i.locked ? "locked" : i.category), text.slice(i.offset, i.offset + i.length)); sp.dataset.id = i.id;
      sp.onclick = function () { focusIssue(i.id); }; view.appendChild(sp); pos = i.offset + i.length;
    });
    if (pos < text.length) view.appendChild(document.createTextNode(text.slice(pos)));
    var list = $("ilist"); if (!list) return; list.textContent = "";
    var open = issues.filter(function (i) { return !i.locked; });
    if (!issues.length) list.appendChild(el("p", "hint", "Nothing to fix. Your text reads cleanly."));
    else list.appendChild(el("h3", "", issues.length + " suggestion" + (issues.length === 1 ? "" : "s")));
    issues.forEach(function (i) {
      var c = el("div", "ic" + (i.locked ? " lk" : "")); c.dataset.id = i.id;
      if (i.locked) { c.appendChild(el("div", "t " + i.category, CATL[i.category] || "Issue")); c.appendChild(el("div", "m", "🔒 Subscribe to see this fix")); list.appendChild(c); return; }
      c.appendChild(el("div", "t " + i.category, CATL[i.category] || "Issue"));
      var m = el("div", "m"); var del = el("del", "", i.original.trim() || "␣"); m.appendChild(del);
      if (i.replacements[0] != null) { m.appendChild(document.createTextNode(" → ")); m.appendChild(el("ins", "", i.replacements[0] === "" ? "(remove)" : i.replacements[0])); }
      c.appendChild(m); if (i.message) c.appendChild(el("div", "m", i.message));
      var a = el("div", "a");
      i.replacements.slice(0, 3).forEach(function (r, k) { var b = el("button", "pill" + (k === 0 ? " ok" : ""), r === "" ? "Remove" : (k === 0 ? "Accept: " : "") + r); b.type = "button"; b.onclick = function (e) { e.stopPropagation(); apply(i, r); }; a.appendChild(b); });
      var x = el("button", "pill x", "Dismiss"); x.type = "button"; x.onclick = function (e) { e.stopPropagation(); drop(i); }; a.appendChild(x); c.appendChild(a);
      c.onclick = function () { focusIssue(i.id); }; list.appendChild(c);
    });
    ta.value = text;
  }
  function focusIssue(id) {
    [].forEach.call(document.querySelectorAll(".gi,.ic"), function (x) { x.classList.toggle("on", String(x.dataset.id) === String(id)); });
    var c = document.querySelector('.ic[data-id="' + id + '"]'); if (c) c.scrollIntoView({ block: "nearest", behavior: "smooth" });
    var g = view.querySelector('.gi[data-id="' + id + '"]'); if (g) g.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function drop(i) { S.res.issues = S.res.issues.filter(function (x) { return x !== i; }); paint(); }
  function apply(i, rep) {
    var t = S.text, d = rep.length - i.length;
    S.text = t.slice(0, i.offset) + rep + t.slice(i.offset + i.length);
    S.res.issues = S.res.issues.filter(function (x) { return x !== i; }); S.res.issues.forEach(function (x) { if (x.offset > i.offset) x.offset += d; });
    var w = { spelling: 1.6, grammar: 1.6, punctuation: 1, clarity: .8, style: .5 }[i.category] || 1;
    S.res.score = Math.min(100, Math.round(S.res.score + (w / Math.max(40, S.res.stats.words)) * 140));
    renderReport();
  }
  function acceptAll() {
    var list = S.res.issues.filter(function (i) { return !i.locked && i.replacements[0] != null; }).sort(function (a, b) { return b.offset - a.offset; }), t = S.text;
    list.forEach(function (i) { t = t.slice(0, i.offset) + i.replacements[0] + t.slice(i.offset + i.length); });
    S.text = t; S.res.issues = S.res.issues.filter(function (i) { return i.locked || i.replacements[0] == null; }); S.res.score = Math.max(S.res.score, 97);
    S.res.issues = []; renderReport();
  }

  /* downloadable report (subscribers) */
  function download() {
    var j = S.res, rows = j.sources.map(function (s) { return "<tr><td>" + h(s.title) + '<br><a href="' + h(s.url) + '">' + h(s.url) + "</a></td><td>" + s.percent + "%</td><td>" + s.words + "</td></tr>"; }).join("");
    var body = j.sentences.map(function (s) { return s.kind && s.kind !== "quote" ? '<mark style="background:' + (s.kind === "match" ? "#fecaca" : "#fde68a") + '">' + h(s.t) + "</mark>" : h(s.t); }).join("").replace(/\n/g, "<br>");
    var html = '<!doctype html><meta charset="utf-8"><title>Plagiarism report</title><body style="font:15px/1.7 system-ui;max-width:820px;margin:30px auto;padding:0 16px"><h1>Plagiarism report</h1><p><b>Similarity: ' + j.similarity + "%</b> &middot; Unique: " + j.uniqueness + "% &middot; " + j.words + " words &middot; " + new Date().toLocaleString() + "</p><h2>Sources</h2><table border=1 cellpadding=6 style='border-collapse:collapse;width:100%'><tr><th>Source</th><th>Share</th><th>Words</th></tr>" + (rows || "<tr><td colspan=3>No matching sources found</td></tr>") + "</table><h2>Text</h2><p>" + body + '</p><p style="color:#666;font-size:12px">Checks the open web only. A low score does not guarantee the result of another provider\'s checker.</p>';
    var a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([html], { type: "text/html" })); a.download = "plagiarism-report.html"; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* ---------- start ---------- */
  idle(); count(); loadStatus();
  var q = new URLSearchParams(location.search); if (q.get("tab") === "grammar") setTab("gram");
  afterCheckout();
})();
