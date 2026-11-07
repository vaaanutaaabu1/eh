/* Login, signup and account dashboard (vanilla JS, no dependencies). */
(function () {
"use strict";

var $ = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
var esc = function (v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };

/* ---------- icons (inline SVG, stroke = currentColor) ---------- */
var P = {
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.2 3.9M6.5 7.6A16 16 0 0 0 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'
};
function svg(name) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[name] || "") + "</svg>";
}
function paintIcons(root) {
  $$("[data-i]", root).forEach(function (el) {
    if (el.tagName === "SPAN" && el.className.indexOf("ic") === -1 && !el.classList.contains("tick")) { el.style.display = "inline-flex"; el.style.width = "18px"; }
    el.innerHTML = svg(el.getAttribute("data-i"));
  });
  $$("[data-eye]", root).forEach(function (b) { b.innerHTML = svg("eye"); });
}

/* ---------- helpers ---------- */
function toast(msg, kind) {
  var t = document.createElement("div");
  t.className = "toast " + (kind || "info");
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(function () { t.style.opacity = "0"; t.style.transition = "opacity .3s"; setTimeout(function () { t.remove(); }, 320); }, 4200);
}

function api(path, opts) {
  opts = opts || {};
  var init = { method: opts.method || "GET", credentials: "same-origin", headers: { Accept: "application/json" } };
  if (opts.body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opts.body); }
  var ctl = window.AbortController ? new AbortController() : null, timer = null;
  if (ctl) { init.signal = ctl.signal; timer = setTimeout(function () { ctl.abort(); }, opts.timeout || 30000); }   /* never spin forever */
  return fetch(path, init).then(function (r) {
    clearTimeout(timer);
    return r.json().catch(function () { return {}; }).then(function (d) { d.__status = r.status; d.__ok = r.ok; return d; });
  }).catch(function () { clearTimeout(timer); return { success: false, message: "Network problem. Please check your connection and try again.", __status: 0 }; });
}

function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spin"></span>' + (label ? "<span>" + esc(label) + "</span>" : ""); }
  else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
}

function fieldError(id, msg) {
  var input = $("#" + id), box = input && input.closest(".field"), m = $("#" + id + "Msg");
  if (box) box.classList.toggle("bad", !!msg);
  if (m) m.textContent = msg || "";
}
function clearErrors(form) { $$(".field.bad", form).forEach(function (f) { f.classList.remove("bad"); }); $$(".msg", form).forEach(function (m) { m.textContent = ""; }); }

function wireEyes(root) {
  $$("[data-eye]", root).forEach(function (b) {
    b.addEventListener("click", function () {
      var input = $("#" + b.getAttribute("data-eye"));
      var show = input.type === "password";
      input.type = show ? "text" : "password";
      b.innerHTML = svg(show ? "eyeoff" : "eye");
      b.setAttribute("aria-label", show ? "Hide password" : "Show password");
    });
  });
}

/* Where to go after logging in / signing up: the page the visitor came from (?next=/path?query), same site only. */
function explicitNext() {
  var n = new URLSearchParams(location.search).get("next") || "";
  if (!/^\/[A-Za-z0-9\-_/.~%?=&+:,#]*$/.test(n) || n.indexOf("//") === 0) return "";   // no scheme, no host, no backslash
  if (/^\/(?:login|signup)(?:[/?#]|$)/i.test(n)) return "";                          // never bounce back to the login page
  return n;
}
function safeNext() { return explicitNext() || "/account"; }

/* ---------- "log in to use X": keep the destination through login <-> signup, and say why the visitor is here ---------- */
var TOOL_NAMES = { ask: "Ask AI", detector: "the AI Detector", cite: "CiteMe", tools: "our study tools" };
function toolFromNext() {
  var t = new URLSearchParams(location.search).get("tool"), n = explicitNext();
  if (TOOL_NAMES[t]) return t;
  if (/^\/(?:ask-ai|ask)(?:[/?#]|$)/i.test(n)) return "ask";
  if (/^\/(?:ai-detector|tools\/ai-detector)(?:[/?#]|$)/i.test(n)) return "detector";
  if (/^\/(?:citation-generator|citegenie)(?:[/?#]|$)/i.test(n)) return "cite";
  if (/^\/tools(?:[/?#]|$)/i.test(n)) return "tools";
  return "";
}
function carryNext(card, signup) {
  $$('a[href="/login"],a[href="/signup"]').forEach(function (a) { a.setAttribute("href", a.getAttribute("href") + location.search); });
  var tool = toolFromNext();
  if (!tool || !card) return;
  var note = document.createElement("div");
  note.className = "gate-note"; note.setAttribute("role", "note");
  note.innerHTML = '<span class="gate-ic" data-i="lock"></span><span>' + (signup ? "Create a free account to use " : "Log in to use ") + "<b>" + esc(TOOL_NAMES[tool]) + "</b>. You'll go straight back when you're done.</span>";
  card.insertBefore(note, card.firstChild);
  paintIcons(note);
}

var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* ---------- Google sign-in ---------- */
var G_LOGO = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.5 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.4-4.1 7-10.1 7-17.6z"/><path fill="#FBBC05" d="M10.5 28.7A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.8l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.3 0-11.6-4.2-13.5-9.9l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>';

function googleFallback(holder, text) {
  holder.innerHTML = '<button type="button" class="gfallback">' + G_LOGO + "<span>Continue with Google</span></button>";
  holder.firstChild.addEventListener("click", function () { toast(text, "info"); });
}

/* Google "One Tap" card: lists the Google account(s) already signed in on this browser ("Continue as <name>") and signs in with one click.
   googlePrompt(true) shows it, googlePrompt(false) hides it (it only belongs on the start and sign-in screens). */
var GG = { ready: false, want: false };
function googlePrompt(on) {
  GG.want = !!on;
  if (!GG.ready) return;
  try { on ? google.accounts.id.prompt() : google.accounts.id.cancel(); } catch (e) {}
}

function initGoogle() {
  var wrap = $("#gWrap"), holder = $("#gbtn");
  if (!wrap || !holder) return;
  var isSignup = document.body.getAttribute("data-page") === "signup";
  var down = "Google sign-in isn't available right now. Please use your email instead.";
  var noAuto = false; try { noAuto = localStorage.getItem("ah_no_autog") === "1"; } catch (e) {}
  googleFallback(holder, down);            // always visible, so people can see the option exists
  var tries = 0;
  (function load() {
  api("/api/auth/config").then(function (cfg) {
    if (!cfg.google || !cfg.google.clientId) { googleFallback(holder, "Google sign-in is not switched on for this site yet. The site owner needs to set GOOGLE_CLIENT_ID. Please use your email for now."); return; }
    var s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onerror = function () { googleFallback(holder, "We couldn't reach Google. Check your connection or use your email instead."); };
    s.onload = function () {
      if (!window.google || !google.accounts) return;
      google.accounts.id.initialize({
        client_id: cfg.google.clientId,
        ux_mode: "popup",                       /* not signed in to Google: the button opens the Google sign-in pop-up */
        context: isSignup ? "signup" : "signin",
        auto_select: !isSignup && !noAuto,    /* sign-in page: the Google account already signed in on this browser is used automatically (not after a deliberate log out) */
        cancel_on_tap_outside: false,
        itp_support: true,
        use_fedcm_for_prompt: true,             /* Chrome / Edge: the browser shows the signed-in Google ID */
        use_fedcm_for_button: true,             /* the button itself shows the signed-in Google name, photo and e-mail */
        callback: function (resp) {
          if (!resp || !resp.credential) return toast("Google sign-in was cancelled.", "info");
          api("/api/auth/google", { method: "POST", body: { credential: resp.credential } }).then(function (d) {
            if (d.success) {
              try { localStorage.removeItem("ah_no_autog"); } catch (e) {}
              var first = String((d.user && d.user.name) || "").split(" ")[0];   /* the name comes from the Google account */
              toast(first ? (d.isNewUser ? "Welcome, " + first + "! Your account is ready." : "Welcome back, " + first + "!") : (d.message || "Signed in."), "ok");
              setTimeout(function () { location.href = safeNext(); }, d.isNewUser ? 1200 : 500);
            } else toast(d.message || "Google sign-in failed.", "err");
          });
        }
      });
      holder.innerHTML = "";
      google.accounts.id.renderButton(holder, { type: "standard", theme: "outline", size: "large", shape: "rectangular", text: "continue_with", logo_alignment: "left", width: Math.min(400, holder.parentNode.clientWidth || 360) });
      GG.ready = true;
      if (GG.want) googlePrompt(true);          /* show the signed-in Google ID straight away */
    };
    document.head.appendChild(s);
  }).catch(function () {
    if (++tries < 4) setTimeout(load, 1500 * tries);      /* the server may still be waking up: try again a few times */
    else googleFallback(holder, down);
  });
  })();
}

function strength(v) {
  var score = 0;
  if (v.length >= 8) score++; if (v.length >= 12) score++; if (/[A-Z]/.test(v) && /[a-z]/.test(v)) score++; if (/\d/.test(v)) score++; if (/[^A-Za-z0-9]/.test(v)) score++;
  return score;
}
function paintMeter(el, v) {
  var sc = strength(v);
  el.style.width = (sc * 20) + "%";
  el.style.background = sc < 3 ? "#ef4444" : sc < 4 ? "#f59e0b" : "#10b981";
}

/* ---------- pages ---------- */
/* ---------- Sign in / sign up: start screen (Google or e-mail) -> e-mail sign-up | sign-in | forgot password ---------- */
function authPage() {
  var isSignup = document.body.getAttribute("data-page") === "signup";
  carryNext($("#authCard"), isSignup);
  api("/api/account/me").then(function (d) { if (d.success) location.replace(safeNext()); });

  var VIEWS = { start: "#vStart", signup: "#signupForm", signin: "#loginForm", forgot: "#forgotForm" };
  var HASH = { "": "start", "#start": "start", "#email": "signup", "#signup": "signup", "#signin": "signin", "#login": "signin", "#forgot": "forgot" };
  var TO = { start: "#start", signup: "#email", signin: "#signin", forgot: "#forgot" };
  var cfg = null, cfgWait = api("/api/auth/config").then(function (c) { cfg = c || {}; return cfg; });
  var rc = { built: false, busy: false, pass: "", timer: null, t0: Date.now(), ch: null, verifying: null };

  /* ----- "I am not Robot" checkbox (our own check, no third parties; compulsory for e-mail sign-up and re-checked by the server).
     Ticking it makes the browser solve a tiny proof-of-work in the background (a fraction of a second for a person, costly for a bot). ----- */
  var K256 = [], H256 = [];
  (function () {
    var n = 2, c = 0;
    function prime(x) { for (var i = 2; i * i <= x; i++) if (x % i === 0) return false; return true; }
    while (c < 64) { if (prime(n)) { K256.push(Math.floor((Math.cbrt(n) % 1) * 4294967296)); if (c < 8) H256.push(Math.floor((Math.sqrt(n) % 1) * 4294967296)); c++; } n++; }
  })();
  function sha256Sync(bytes, K256, H256) {   /* self-contained: also copied into the Web Worker below */   /* fallback for browsers/pages without crypto.subtle */
    var l = bytes.length, total = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(total), i, j;
    m.set(bytes); m[l] = 0x80;
    var bits = l * 8; m[total - 4] = bits >>> 24; m[total - 3] = bits >>> 16; m[total - 2] = bits >>> 8; m[total - 1] = bits;
    var h = H256.slice(), w = new Array(64);
    function rr(x, n) { return (x >>> n) | (x << (32 - n)); }
    for (var off = 0; off < total; off += 64) {
      for (i = 0; i < 16; i++) w[i] = (m[off + 4 * i] << 24) | (m[off + 4 * i + 1] << 16) | (m[off + 4 * i + 2] << 8) | m[off + 4 * i + 3];
      for (i = 16; i < 64; i++) {
        var s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (i = 0; i < 64; i++) {
        var t1 = (hh + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
        var t2 = ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0; h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    var out = new Uint8Array(32);
    for (j = 0; j < 8; j++) { out[4 * j] = h[j] >>> 24; out[4 * j + 1] = h[j] >>> 16; out[4 * j + 2] = h[j] >>> 8; out[4 * j + 3] = h[j]; }
    return out;
  }
  function zeroBits(d) {
    var n = 0;
    for (var i = 0; i < d.length; i++) { if (d[i] === 0) { n += 8; continue; } n += Math.clz32(d[i]) - 24; break; }
    return n;
  }
  function solveMain(nonce, bits) {
    var enc = new TextEncoder(), subtle = window.crypto && crypto.subtle, n = 0;
    return new Promise(function (resolve, reject) {
      function stepSubtle() {
        var batch = [], base = n, i;
        for (i = 0; i < 256; i++) batch.push(subtle.digest("SHA-256", enc.encode(nonce + ":" + (base + i))));
        n += 256;
        Promise.all(batch).then(function (res) {
          for (var k = 0; k < res.length; k++) if (zeroBits(new Uint8Array(res[k])) >= bits) return resolve(base + k);
          if (n > 5e6) return reject(new Error("pow")); stepSubtle();
        }, reject);
      }
      function stepSync() {
        for (var i = 0; i < 1500; i++, n++) if (zeroBits(sha256Sync(enc.encode(nonce + ":" + n), K256, H256)) >= bits) return resolve(n);
        if (n > 5e6) return reject(new Error("pow")); setTimeout(stepSync, 0);
      }
      if (subtle) stepSubtle(); else stepSync();
    });
  }

  /* The proof-of-work runs in a Web Worker (its own thread) and STARTS WHEN THE FORM OPENS, so the answer is ready before the box is ticked. */
  /* Worker code is a plain string (so minifiers cannot rename anything in it): a single-block SHA-256 on reused typed arrays (about 20x faster than the
     generic function) that tries counters start, start+step, start+2*step ... Several workers run side by side and the first answer wins. */
  var WORKER_SRC = [
    "var K=new Int32Array(KJSON),W=new Int32Array(64),B=new Uint8Array(64),V=new DataView(B.buffer);",
    "function ror(x,n){return(x>>>n)|(x<<(32-n))}",
    "onmessage=function(e){var d=e.data,pre=d.nonce+':',pl=pre.length,bits=d.bits,n=d.start,step=d.step,i,t,l,s,a,b,c,dd,ee,f,g,h,t1,t2,h0,h1,lz;",
    "for(i=0;i<pl;i++)B[i]=pre.charCodeAt(i);",
    "for(;;n+=step){",
    " s=''+n;l=pl+s.length;if(l>55){postMessage(-1);return}",
    " for(i=0;i<s.length;i++)B[pl+i]=s.charCodeAt(i);B[l]=128;for(i=l+1;i<64;i++)B[i]=0;V.setUint32(60,l*8);",
    " for(i=0;i<16;i++)W[i]=V.getInt32(i*4);",
    " for(i=16;i<64;i++){a=W[i-15];b=W[i-2];W[i]=(W[i-16]+(ror(a,7)^ror(a,18)^(a>>>3))+W[i-7]+(ror(b,17)^ror(b,19)^(b>>>10)))|0}",
    " a=1779033703;b=-1150833019;c=1013904242;dd=-1521486534;ee=1359893119;f=-1694144372;g=528734635;h=1541459225;",
    " for(i=0;i<64;i++){t1=(h+(ror(ee,6)^ror(ee,11)^ror(ee,25))+((ee&f)^(~ee&g))+K[i]+W[i])|0;t2=((ror(a,2)^ror(a,13)^ror(a,22))+((a&b)^(a&c)^(b&c)))|0;h=g;g=f;f=ee;ee=(dd+t1)|0;dd=c;c=b;b=a;a=(t1+t2)|0}",
    " h0=(1779033703+a)|0;",
    " lz=h0!==0?Math.clz32(h0):32+Math.clz32((-1150833019+b)|0);",
    " if(lz>=bits){postMessage(n);return}",
    " if(n>3e7){postMessage(-1);return}",
    "}};"
  ].join("\n");
  function solvePow(nonce, bits) {
    return new Promise(function (resolve, reject) {
      var done = false, workers = [], url = null, failed = 0;
      var count = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 0));
      function stop() { workers.forEach(function (w) { try { w.terminate(); } catch (x) {} }); workers = []; try { URL.revokeObjectURL(url); } catch (x) {} }
      function fallback() { if (done) return; done = true; stop(); solveMain(nonce, bits).then(resolve, reject); }
      try {
        url = URL.createObjectURL(new Blob([WORKER_SRC.replace("KJSON", JSON.stringify(K256))], { type: "text/javascript" }));
        for (var i = 0; i < count; i++) {
          var w = new Worker(url);
          w.onmessage = function (e) {
            if (done) return;
            if (e.data >= 0) { done = true; stop(); resolve(e.data); }
            else if (++failed >= count) fallback();
          };
          w.onerror = function () { if (++failed >= count) fallback(); };
          workers.push(w);
          w.postMessage({ nonce: nonce, bits: bits, start: i, step: count });
        }
      } catch (err) { fallback(); }
    });
  }

  /* get a challenge and solve it in the background; a prepared one is reused for 4 minutes, then replaced */
  function warm() {
    if (rc.ch && !rc.ch.failed && Date.now() - rc.ch.at < 4 * 60 * 1000) return rc.ch;
    var ch = { at: Date.now(), failed: false, solved: false };
    ch.promise = api("/api/auth/captcha").then(function (d) {
      if (!d.id || !d.nonce) throw new Error(d.message || "start");
      return solvePow(d.nonce, d.bits).then(function (counter) { ch.solved = true; return { id: d.id, counter: counter }; });
    });
    ch.promise.catch(function () { ch.failed = true; });
    rc.ch = ch;
    return ch;
  }

  function ensureCaptcha() {
    var box = $("#rcBox");
    if (!box) return;
    if (!rc.built) {
      rc.built = true;
      box.innerHTML =
        '<div class="rcw"><button type="button" class="rcrow" id="rcTick" role="checkbox" aria-checked="false"><span class="rcbox" id="rcMark" aria-hidden="true"></span><span class="rclbl">I am not Robot</span>' +
        '<span class="rcbrand" aria-hidden="true"><svg viewBox="0 0 40 40" width="38" height="38" fill="none"><g id="rcArrows"><path d="M7 19A13 13 0 0 1 29.2 10.8" stroke="#3b82f6" stroke-width="5" stroke-linecap="round"/><path d="M34 15.5L32.9 6.9L25.5 14.7Z" fill="#3b82f6" stroke="#3b82f6" stroke-width="2" stroke-linejoin="round"/><g transform="rotate(180 20 20)"><path d="M7 19A13 13 0 0 1 29.2 10.8" stroke="#9ca3af" stroke-width="5" stroke-linecap="round"/><path d="M34 15.5L32.9 6.9L25.5 14.7Z" fill="#9ca3af" stroke="#9ca3af" stroke-width="2" stroke-linejoin="round"/></g></g></svg><small>reCAPTCHA</small></span></button></div>';
      $("#rcTick").addEventListener("click", runCaptcha);
    }
    if (!rc.pass) rc.t0 = Date.now();   /* how long the sign-up form has been open (robots tick instantly) */
    warm();                             /* start (or reuse) the background check right away */
  }
  function setMark(state) {
    var m = $("#rcMark"); if (!m) return;
    m.className = "rcbox" + (state ? " " + state : "");
    $("#rcTick").classList.toggle("busy", state === "load");
    $("#rcTick").setAttribute("aria-checked", state === "ok" ? "true" : "false");
  }
  function runCaptcha(ev) {
    if (rc.pass || rc.busy) return;
    var trusted = !!(ev && ev.isTrusted), msg = $("#captchaMsg");
    var tk = $("#rcTick"); if (tk) { tk.classList.remove("rcgo"); void tk.offsetWidth; tk.classList.add("rcgo"); setTimeout(function () { tk.classList.remove("rcgo"); }, 900); }   /* quick refresh-icon spin + box bounce on every click */
    rc.busy = true; msg.textContent = "";
    var first = warm();
    setMark(first.solved ? "ok" : "load");      /* answer already prepared: the tick shows at once */
    first.promise.then(function () { if (rc.busy && !rc.pass) setMark("ok"); }, function () {});
    function attempt(ch, retried) {
      return ch.promise.then(function (sol) {
        return api("/api/auth/captcha/verify", { method: "POST", body: { id: sol.id, counter: sol.counter, signals: { trusted: trusted, formMs: Date.now() - rc.t0 } } });
      }).then(function (r) {
        if (r && r.success && r.pass) return r;
        if (!retried) { rc.ch = null; return attempt(warm(), true); }   /* one silent retry with a fresh check */
        throw new Error((r && r.message) || "");
      }, function (err) {
        if (!retried) { rc.ch = null; return attempt(warm(), true); }
        throw err;
      });
    }
    rc.verifying = attempt(first, false).then(function (r) {
      rc.pass = r.pass; rc.busy = false; setMark("ok"); msg.textContent = "";
      clearTimeout(rc.timer);
      rc.timer = setTimeout(function () { resetCaptcha(); msg.textContent = "The check expired. Please tick the box again."; }, 29 * 60 * 1000);
      return rc.pass;
    }, function (err) {
      rc.busy = false; rc.verifying = null; setMark("");
      msg.textContent = (err && err.message) || "The check failed. Please tick the box again.";
      return "";
    });
  }
  /* resolves with the pass (waits for a check that is still finishing), or "" when the box was not ticked */
  function captchaToken() {
    if (rc.pass) return Promise.resolve(rc.pass);
    if (rc.busy && rc.verifying) return rc.verifying.then(function () { return rc.pass || ""; });
    return Promise.resolve("");
  }
  function resetCaptcha() {
    rc.pass = ""; rc.busy = false; rc.verifying = null; rc.t0 = Date.now(); clearTimeout(rc.timer); rc.ch = null;
    if ($("#rcMark")) { setMark(""); warm(); }
  }

  /* ----- which view is showing (the address hash keeps the back button working) ----- */
  function show(name) {
    Object.keys(VIEWS).forEach(function (k) { var el = $(VIEWS[k]); if (el) el.hidden = k !== name; });
    if (name === "signup") ensureCaptcha();
    googlePrompt(name === "start" || name === "signin");
    var first = name === "start" ? null : $("input", $(VIEWS[name]));
    if (first && !(window.matchMedia && matchMedia("(pointer:coarse)").matches)) setTimeout(function () { first.focus(); }, 30);
    if (name === "signin" || name === "forgot") { var e = $("#email").value.trim(); if (e && !$("#identifier").value) $("#identifier").value = e; }
    if (name === "forgot") $("#fIdent").value = $("#identifier").value;
  }
  function route() { show(HASH[location.hash] || "start"); }
  window.addEventListener("hashchange", route);
  $$("[data-go]").forEach(function (a) { a.addEventListener("click", function (e) { e.preventDefault(); location.hash = TO[a.getAttribute("data-go")]; }); });
  $("#goEmail").addEventListener("click", function () { location.hash = TO.signup; });
  route();
  if (isSignup) warm();   /* the robot check is prepared in the background from the moment the page opens */

  /* ----- sign up with e-mail: name, e-mail, password, robot check ----- */
  var sform = $("#signupForm");
  $("#password").addEventListener("input", function () { paintMeter($("#meter"), this.value); });
  sform.addEventListener("submit", function (e) {
    e.preventDefault(); clearErrors(sform); $("#captchaMsg").textContent = "";
    var name = $("#name").value.trim(), email = $("#email").value.trim(), pw = $("#password").value, bad = false;
    if (name.length < 2) { fieldError("name", "Please enter your name."); bad = true; }
    if (!EMAIL_RE.test(email)) { fieldError("email", "Please enter a valid email address."); bad = true; }
    if (pw.length < 8) { fieldError("password", "Use at least 8 characters."); bad = true; }
    else if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) { fieldError("password", "Include both letters and numbers."); bad = true; }
    if (!rc.pass && !rc.busy) { $("#captchaMsg").textContent = "Please tick \"I am not Robot\"."; bad = true; }
    if (bad) return;
    var btn = $("#signupBtn"); busy(btn, true, "Creating account…");
    captchaToken().then(function (tok) {
      if (!tok) { busy(btn, false); if (!$("#captchaMsg").textContent) $("#captchaMsg").textContent = "Please tick \"I am not Robot\"."; return; }
      return api("/api/auth/signup", { method: "POST", body: { name: name, email: email, password: pw, captcha: tok, website: ($("#website") || {}).value || "" } }).then(function (d) {
      busy(btn, false);
      if (d.success) { $("#doneMsg").textContent = d.message; $("#authCard").hidden = true; $("#doneCard").hidden = false; finishSignup(); return; }
      resetCaptcha();
      if (d.field === "captcha") $("#captchaMsg").textContent = d.message;
      else if (d.__status === 409) fieldError("email", d.message);
      else if (d.__status === 400 && /password/i.test(d.message || "")) fieldError("password", d.message);
      else if (d.__status === 0) {   /* no answer: the account may still have been created, check the session before asking to retry */
        api("/api/account/me").then(function (m) { if (m && m.user) { $("#doneMsg").textContent = "Account created."; $("#authCard").hidden = true; $("#doneCard").hidden = false; finishSignup(); } else toast(d.message, "err"); });
      }
      else toast(d.message || "Could not create your account.", "err");
      });
    });
  });

  /* ----- sign in ----- */
  var lform = $("#loginForm");
  lform.addEventListener("submit", function (e) {
    e.preventDefault(); clearErrors(lform);
    var ident = $("#identifier").value.trim(), pw = $("#lpassword").value, bad = false;
    if (!ident) { fieldError("identifier", "Enter your email address."); bad = true; }
    if (!pw) { fieldError("lpassword", "Enter your password."); bad = true; }
    if (bad) return;
    var btn = $("#loginBtn"); busy(btn, true, "Signing in…");
    api("/api/auth/login", { method: "POST", body: { identifier: ident, password: pw } }).then(function (d) {
      if (d.success) { toast("Welcome back, " + String(d.user.name || "").split(" ")[0] + "!", "ok"); setTimeout(function () { location.href = safeNext(); }, 450); }
      else { busy(btn, false); fieldError("lpassword", d.message || "Could not sign in."); $("#lpassword").focus(); $("#lpassword").select(); }
    });
  });

  /* ----- forgot password ----- */
  $("#forgotForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var v = $("#fIdent").value.trim(); if (!v) return toast("Enter your email address.", "err");
    var btn = $("#forgotBtn"); busy(btn, true, "Sending…");
    api("/api/auth/forgot", { method: "POST", body: { identifier: v } }).then(function (d) {
      busy(btn, false);
      toast(d.message || "If an account exists, a new password has been emailed.", d.__ok ? "ok" : "err");
      if (d.__ok) { $("#identifier").value = v; location.hash = TO.signin; }
    });
  });
  initGoogle();
}

/* After sign-up the session is already open: send the visitor on to the page they came for. */
function finishSignup() {
  var dest = explicitNext(), go = $("#doneGo"), note = $("#doneRedir");
  if (!dest) return;                                   // plain sign-up: keep the "Go to my account" button
  var tool = toolFromNext();
  go.setAttribute("href", dest);
  go.textContent = tool ? "Continue to " + TOOL_NAMES[tool].replace(/^the /, "") : "Continue";
  var left = 4;
  function tick() {
    if (!note) return;
    note.textContent = "Taking you back in " + left + "s…";
    if (left-- <= 0) { location.href = dest; return; }
    setTimeout(tick, 1000);
  }
  tick();
}

function accountPage() {
  var state = { user: null, sub: null, orders: [], page: 1, totalPages: 1, total: 0, timer: null, txns: [], txnPage: 1, txnPages: 1, txnTotal: 0 };

  function fmtDate(v, withTime) {
    if (!v) return "—";
    var d = new Date(v); if (isNaN(d)) return String(v);
    return d.toLocaleString(undefined, withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" });
  }
  function pillClass(s) {
    s = String(s || "").toLowerCase();
    if (/complete|deliver|done|closed/.test(s)) return "done";
    if (/progress|review|working|assign|process/.test(s)) return "prog";
    if (/cancel|reject|refund/.test(s)) return "bad";
    return "new";
  }
  function orderRow(o) {
    return '<button class="order" type="button" data-order="' + esc(o.orderId) + '">' +
      '<span class="t">' + esc(o.subject || "Expert") + "</span>" +
      '<span class="pill ' + pillClass(o.status) + '">' + esc(o.status) + "</span>" +
      '<span class="m"><span>Order #' + esc(o.orderId) + "</span><span>Deadline: " + esc(o.deadlineDate || "—") + (o.deadlineTime ? " " + esc(o.deadlineTime) : "") + "</span><span>Submitted " + esc(fmtDate(o.submittedAt)) + "</span>" + (o.attachmentCount ? "<span>" + o.attachmentCount + " file" + (o.attachmentCount > 1 ? "s" : "") + "</span>" : "") + "</span></button>";
  }
  var emptyOrders = '<div class="empty">' + svg("box") + "<div><b>No orders yet</b></div><div>Orders you submit with your email will appear here.</div><p><a class=\"btn sm\" style=\"text-decoration:none\" href=\"/#hero\">Place an order</a></p></div>";

  function renderProfile() {
    var u = state.user, initials = u.name.split(/\s+/).map(function (w) { return w[0]; }).slice(0, 2).join("").toUpperCase();
    $("#profile").innerHTML =
      '<div class="avatar">' + (u.avatarUrl ? '<img src="' + esc(u.avatarUrl) + '" alt="" referrerpolicy="no-referrer">' : esc(initials)) + "</div>" +
      '<div class="pmain"><h1>' + esc(u.name) + '</h1><div class="em">' + esc(u.email) + "</div></div>" +
      '<div class="chips">' +
      '<span class="chip">' + (u.provider === "google" ? "Google account" : "Email account") + "</span>" +
      '<span class="chip">Member since ' + esc(fmtDate(u.memberSince)) + "</span></div>";
    // Google accounts: the password button sits next to Log out and there is no reset form in Settings.
    var google = u.provider === "google";
    $("#setPwBtn").hidden = !google;
    $("#setPwBtn").textContent = u.hasPassword ? "Change password" : "Set password";
    $("#pwForm").hidden = google;
    $("#curPwField").hidden = !u.hasPassword;
    $("#pwTitle").textContent = u.hasPassword ? "Change password" : "Set a password";
    $("#pwBtn").textContent = u.hasPassword ? "Update password" : "Save password";
    $("#pName").value = u.name; $("#pEmail").value = u.email; $("#pPhone").value = u.phone || "";
  }

  /* the 30-of-each monthly allowance: unlocks, citations, AI detections, Ask AI questions */
  function quotaHtml(s) {
    var q = s.quota; if (!s.active || !q || !q.services || !q.services.length) return "";
    var rows = q.services.map(function (x) {
      var pct = x.granted ? Math.min(100, Math.round(x.used * 100 / x.granted)) : 0, low = x.left === 0;
      return '<div style="padding:12px 0;border-top:1px solid var(--line)"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center"><b>' + esc(x.label) + '</b><span style="color:' + (low ? "#b91c1c" : "var(--muted)") + ';font-size:.9rem"><b>' + x.left + "</b> of " + x.granted + " left</span></div>" +
        '<div style="height:7px;border-radius:99px;background:rgba(79,70,229,.12);margin:8px 0 0;overflow:hidden"><div style="height:100%;width:' + pct + '%;background:' + (low ? "#ef4444" : "#4f46e5") + '"></div></div>' +
        (low ? '<div style="margin-top:8px"><button class="btn sm" type="button" data-topup="' + esc(x.key) + '" style="width:auto;display:inline-flex;padding:0 14px">Top up ' + q.topupUnits + " more - $" + q.topupPrice + "</button></div>" : "") + "</div>";
    }).join("");
    return '<div style="margin-top:16px"><h4 style="margin:0 0 4px">This month\u2019s plan allowance</h4><p style="color:var(--muted);margin:0 0 4px;font-size:.88rem">30 of each, renewed on ' + esc(fmtDate(s.currentPeriodEnd)) + ". One unlock opens one document for viewing and downloading, and it stays unlocked for good.</p>" + rows + "</div>";
  }
  function wireTopups(root) {
    [].forEach.call(root.querySelectorAll("[data-topup]"), function (b) {
      b.addEventListener("click", function () {
        busy(b, true, "Opening checkout…");
        api("/api/quota/topup", { method: "POST", body: { service: b.getAttribute("data-topup") } }).then(function (d) {
          if (d.url) { location.href = d.url; return; }
          busy(b, false); toast(d.message || "Checkout isn't available right now.", "err");
        });
      });
    });
  }

  function renderSub() {
    var s = state.sub, el = $("#sub");
    if (!s.active && s.status === "none") {
      el.innerHTML = '<div class="plan"><h3>Free plan <span class="pill">No subscription</span></h3><p style="color:var(--muted)">' + esc(s.message) + '</p><button class="btn sm" id="upgradeBtn" type="button" style="width:auto;display:inline-flex;padding:0 18px">Subscribe - $10/month</button></div>';
      $("#upgradeBtn").addEventListener("click", function () {
        var b = $("#upgradeBtn"); busy(b, true, "Opening checkout…");
        api("/api/billing/checkout", { method: "POST", body: {} }).then(function (d) {
          if (d.url) { location.href = d.url; return; }
          busy(b, false); toast(d.message || "Checkout isn't available right now.", "err");
        });
      });
      return;
    }
    el.innerHTML = '<div class="plan ' + (s.active ? "on" : "") + '"><h3>' + esc(s.plan) + ' <span class="pill ' + (s.active ? "done" : "bad") + '">' + esc(s.status) + '</span></h3><p style="color:var(--muted);margin:6px 0 0">' + esc(s.message) + "</p>" +
      '<div class="kv"><div><small>Price</small><b>' + esc(s.price || "—") + (s.interval ? " / " + esc(s.interval) : "") + "</b></div>" +
      "<div><small>" + (s.cancelAtPeriodEnd ? "Ends on" : "Renews on") + "</small><b>" + esc(fmtDate(s.currentPeriodEnd)) + "</b></div>" +
      "<div><small>Started</small><b>" + esc(fmtDate(s.startedAt)) + "</b></div></div>" +
      (s.active ? '<div style="margin-top:14px"><button class="btn sm" id="renewBtn" type="button" style="width:auto;display:inline-flex;padding:0 18px' +
        (s.cancelAtPeriodEnd ? '">Resume automatic renewal' : ';background:#fff;color:#b91c1c;border:1px solid #fca5a5">Cancel subscription') +
        '</button><p style="color:var(--muted);margin:8px 0 0;font-size:.85rem">' +
        (s.cancelAtPeriodEnd ? "You will not be charged again. Resume any time before the end date to keep your plan." : "Charged automatically every month until you cancel. Cancel anytime; you keep access until the end of the period you paid for.") +
        "</p></div>" : "") + quotaHtml(s) + "</div>";
    wireTopups(el);
    var rb = $("#renewBtn");
    if (rb) rb.addEventListener("click", function () {
      var cancel = !s.cancelAtPeriodEnd;
      if (cancel && !window.confirm("Cancel your subscription? It will stop renewing, and you keep what is left of this month\u2019s unlocks, citations, AI detections and Ask AI questions until " + fmtDate(s.currentPeriodEnd) + ".")) return;
      busy(rb, true, cancel ? "Cancelling…" : "Resuming…");
      api("/api/account/subscription/" + (cancel ? "cancel" : "resume"), { method: "POST", body: {} }).then(function (d) {
        if (d.__status === 401) { location.replace("/login?next=/account"); return; }
        busy(rb, false);
        if (!d.success) { toast(d.message || "Could not update your subscription.", "err"); return; }
        toast(d.message || "Subscription updated.");
        loadOverview(true);
      });
    });
  }

  function money(c) { return "$" + (Number(c || 0) / 100).toFixed(2); }
  var W = { methods: {}, limits: {}, page: 1, done: false, rz: null };
  function ledgerRow(x) {
    var nm = { topup: "Top-up", admin_topup: "Added by support", spend: "Spent", refund: "Refund" }[x.kind] || x.kind;
    var via = { stripe_card: "card", stripe: "Stripe", razorpay: "Razorpay", admin: "support", wallet: "wallet" }[x.provider] || x.provider;
    return '<div class="wl"><div><div class="wt">' + esc(nm) + '</div><div class="wm">' + esc(via) + (x.note && x.note !== nm ? " · " + esc(x.note) : "") + " · " + esc(fmtDate(x.at, true)) + '</div></div><div class="wa ' + (x.amountCents < 0 ? "out" : "in") + '">' + (x.amountCents < 0 ? "-" : "+") + money(Math.abs(x.amountCents)) + "</div></div>";
  }
  function paintWallet(d) {
    state.wallet = d.balanceCents;
    var b = $("#wBal"); if (b) b.textContent = money(d.balanceCents);
    var t = $("#wTileV"); if (t) t.textContent = money(d.balanceCents);
  }
  function loadWallet(full) {
    return api("/api/wallet" + (full ? "" : "?lite=1")).then(function (d) {
      if (!d.success) { if (full) toast(d.message || "Could not load your wallet.", "err"); return; }
      paintWallet(d);
      if (!full) return;
      W.methods = d.methods || {}; W.limits = d.limits || {}; W.page = 1;
      $("#wLedger").innerHTML = d.ledger.length ? d.ledger.map(ledgerRow).join("") : '<div class="empty"><div><b>No wallet activity yet</b></div><div>Money you add will appear here.</div></div>';
      $("#wMore").hidden = d.ledger.length < 20;
      var lim = W.limits, pre = [10, 25, 50, 100].filter(function (v) { return v * 100 >= lim.minCents && v * 100 <= lim.maxCents; });
      $("#wPre").innerHTML = pre.map(function (v) { return '<button type="button" data-preset="' + v + '">$' + v + "</button>"; }).join("");
      $("#wNote").textContent = "Minimum " + money(lim.minCents) + ", maximum " + money(lim.maxCents) + " per top-up.";
      $$("#wPay [data-wm]").forEach(function (b) {
        var on = !!W.methods[b.dataset.wm]; b.disabled = !on; b.title = on ? "" : "Not switched on yet";
      });
      var rz = $("#wRzNote");
      if (lim.razorpayCurrency === "INR" && W.methods.razorpay) { rz.hidden = false; rz.textContent = "Razorpay charges in Indian rupees (about ₹" + lim.inrPerUsd + " per $1). The exact amount is shown at checkout."; }
      else rz.hidden = true;
    });
  }
  function loadScript(src) {
    return new Promise(function (ok, bad) {
      if (document.querySelector('script[src="' + src + '"]')) return ok();
      var s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = function () { bad(new Error("load")); }; document.head.appendChild(s);
    });
  }
  function afterPaid(d, label) {
    paintWallet(d); loadWallet(true);
    toast(d.credited === false ? "That payment was already added." : label + " " + money(d.amountCents) + " added to your wallet.", "ok");
  }
  function openRazorpay(o, btn) {
    loadScript("https://checkout.razorpay.com/v1/checkout.js").then(function () {
      var u = state.user || {}, done = false;
      var rz = new window.Razorpay({
        key: o.keyId, order_id: o.orderId, amount: o.amount, currency: o.currency, name: "Wallet top-up",
        description: "Add " + money(o.usdCents) + " to your wallet",
        prefill: { name: o.name || u.name || "", email: o.email || u.email || "", contact: o.contact || u.phone || "" },
        theme: { color: "#4f46e5" },
        handler: function (r) {
          done = true; toast("Confirming your payment…", "info");
          api("/api/wallet/razorpay/verify", { method: "POST", body: { razorpay_order_id: r.razorpay_order_id, razorpay_payment_id: r.razorpay_payment_id, razorpay_signature: r.razorpay_signature } }).then(function (d) {
            busy(btn, false);
            if (d.success) afterPaid(d, "Razorpay:"); else toast(d.message || "We could not confirm the payment. If money was taken it will be added automatically; check again in a minute.", "err");
          });
        },
        modal: { ondismiss: function () { if (!done) busy(btn, false); } }
      });
      rz.on("payment.failed", function (r) { busy(btn, false); toast((r && r.error && r.error.description) || "The payment failed.", "err"); });
      rz.open();
    }).catch(function () { busy(btn, false); toast("Could not load Razorpay. Check your connection and try again.", "err"); });
  }
  function startTopup(method, btn) {
    var raw = ($("#wAmt").value || "").replace(/[$,\s]/g, "");
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(raw) || Number(raw) <= 0) return toast("Enter an amount in dollars, for example 25 or 25.50.", "err");
    busy(btn, true, "Please wait…");
    api("/api/wallet/topup", { method: "POST", body: { method: method, amount: raw } }).then(function (d) {
      if (!d.success) { busy(btn, false); return toast(d.message || "Could not start the payment.", "err"); }
      if (d.url) { location.href = d.url; return; }
      if (d.razorpay) openRazorpay(d.razorpay, btn); else busy(btn, false);
    });
  }
  /* coming back from Stripe: ?wallet=stripe&session_id=cs_... (or ?wallet=cancel) */
  function handleStripeReturn() {
    var q = new URLSearchParams(location.search), tp = q.get("topup");
    if (/^cs_[A-Za-z0-9_]+$/.test(tp || "")) {   /* back from a plan top-up checkout */
      if (history.replaceState) history.replaceState(null, "", "/account#subscription");
      go("subscription"); toast("Confirming your top-up…", "info");
      api("/api/quota/confirm", { method: "POST", body: { session_id: tp } }).then(function (d) {
        if (d.success) { toast("Top-up added to this month\u2019s plan.", "ok"); loadOverview(true); }
        else toast(d.message || "We could not confirm the top-up yet. If you were charged it will appear shortly.", "err");
      });
      return true;
    }
    var w = q.get("wallet");
    if (!w) return false;
    var clean = function () { if (history.replaceState) history.replaceState(null, "", "/account#wallet"); };
    if (w === "stripe" && /^cs_[A-Za-z0-9_]+$/.test(q.get("session_id") || "")) {
      clean(); go("wallet"); toast("Confirming your payment…", "info");
      api("/api/wallet/confirm/stripe?session_id=" + encodeURIComponent(q.get("session_id"))).then(function (d) {
        if (d.success) afterPaid(d, "Stripe:"); else toast(d.message || "We could not confirm the payment yet. If money was taken it will be added automatically.", "err");
      });
      return true;
    }
    clean(); if (w === "cancel") { go("wallet"); toast("Payment cancelled. Nothing was charged.", "info"); return true; }
    return false;
  }
  function renderTiles() {
    var s = state.sub;
    $("#tiles").innerHTML =
      '<div class="tile"><div class="k">Current plan</div><div class="v">' + esc(s.active ? s.plan : "Free") + '</div><div class="s">' + (s.active ? (s.cancelAtPeriodEnd ? "Ends " : "Renews ") + esc(fmtDate(s.currentPeriodEnd)) : "No active subscription") + "</div></div>" +
      '<div class="tile"><div class="k">Wallet balance</div><div class="v" id="wTileV">' + (state.wallet == null ? "&mdash;" : money(state.wallet)) + '</div><div class="s"><a href="#wallet" data-go-wallet style="color:inherit">Add money</a></div></div>' +
      '<div class="tile"><div class="k">Orders submitted</div><div class="v">' + state.total + '</div><div class="s">All time</div></div>' +
      '<div class="tile"><div class="k">Last login</div><div class="v" style="font-size:1.05rem">' + esc(fmtDate(state.user.lastLogin, true)) + '</div><div class="s">Secure session</div></div>';
  }

  function renderOrders(reset) {
    $("#recent").innerHTML = state.orders.length ? state.orders.slice(0, 5).map(orderRow).join("") : emptyOrders;
    $("#orders").innerHTML = state.orders.length ? state.orders.map(orderRow).join("") : emptyOrders;
    $("#more").hidden = state.page >= state.totalPages;
  }

  function txnRow(t) {
    var receipt = t.receiptUrl && /^https:\/\//.test(t.receiptUrl) ? '<a href="' + esc(t.receiptUrl) + '" target="_blank" rel="noopener">Receipt</a>' : "";
    return '<div class="txn"><div class="tl"><b>' + esc(t.description) + "</b><small>Order ID: " + esc(t.orderId) +
      (t.invoiceNumber ? " · Invoice " + esc(t.invoiceNumber) : "") +
      (t.reference ? "<br>Subscription ref: " + esc(t.reference) : "") +
      "<br>" + esc(fmtDate(t.paidAt, true)) + '</small></div><div class="tr"><b>' + esc(t.amount || "—") + '</b><span class="pill ' + (t.status === "paid" ? "done" : "new") + '">' + esc(t.status) + "</span>" + receipt + "</div></div>";
  }
  function renderTxns() {
    $("#txns").innerHTML = state.txns.length ? state.txns.map(txnRow).join("") :
      '<div class="empty">' + svg("box") + "<div><b>No payments yet</b></div><div>Payments for your subscription will appear here with their order ID.</div></div>";
    $("#moreTxn").hidden = state.txnPage >= state.txnPages;
  }

  /* Set / change password from the button next to Log out (Google accounts). */
  function openPasswordModal() {
    var need = state.user && state.user.hasPassword;
    var eyeBtn = function (id) { return '<button class="eye" type="button" data-eye="' + id + '" aria-label="Show password"></button>'; };
    openModal('<h3 id="mTitle">' + (need ? "Change password" : "Set a password") + "</h3>" +
      '<p style="color:var(--muted);font-size:.88rem;margin:0 0 12px">' + (need ? "Choose a new password for logging in with your email." : "You signed up with Google, so a password is optional. Add one if you also want to log in with your email.") + "</p>" +
      '<form id="mPwForm" novalidate>' +
      (need ? '<div class="field"><label for="mCur">Current password</label><div class="box"><span class="ic" data-i="lock"></span><input id="mCur" type="password" autocomplete="current-password">' + eyeBtn("mCur") + "</div></div>" : "") +
      '<div class="field"><label for="mNew">New password</label><div class="box"><span class="ic" data-i="lock"></span><input id="mNew" type="password" autocomplete="new-password" placeholder="8+ characters, letters and numbers">' + eyeBtn("mNew") + '</div><div class="meter"><i id="mMeter"></i></div><div class="msg" id="mPwMsg"></div></div>' +
      '<button class="btn" type="submit" id="mPwBtn">' + (need ? "Update password" : "Save password") + "</button></form>");
    paintIcons($("#mBody")); wireEyes($("#mBody"));
    $("#mNew").addEventListener("input", function () { paintMeter($("#mMeter"), this.value); });
    $("#mPwForm").addEventListener("submit", function (e) {
      e.preventDefault(); $("#mPwMsg").textContent = "";
      var cur = need ? $("#mCur").value : "", next = $("#mNew").value;
      if ((need && !cur) || !next) { $("#mPwMsg").textContent = need ? "Fill in both fields." : "Enter a new password."; return; }
      var btn = $("#mPwBtn"); busy(btn, true, "Saving…");
      api("/api/auth/change-password", { method: "POST", body: { currentPassword: cur, newPassword: next } }).then(function (d) {
        busy(btn, false);
        if (d.success) { closeModal(); toast(need ? "Password updated." : "Password saved. You can now also log in with your email.", "ok"); loadOverview(true); }
        else $("#mPwMsg").textContent = d.message || "Could not save the password.";
      });
    });
    $("#mNew").focus();
  }

  function loadOverview(quiet) {
    return api("/api/account/overview").then(function (d) {
      if (d.__status === 401) { location.replace("/login?next=/account"); return; }
      if (!d.success) { if (!quiet) toast(d.message || "Could not load your account.", "err"); return; }
      state.user = d.user; state.sub = d.subscription;
      state.orders = d.orders.orders; state.page = 1; state.totalPages = d.orders.totalPages; state.total = d.orders.total;
      if (d.transactions) { state.txns = d.transactions.items; state.txnPage = 1; state.txnPages = d.transactions.totalPages; state.txnTotal = d.transactions.total; }
      renderProfile(); renderTiles(); renderSub(); renderOrders(); renderTxns(); loadWallet(false);
      $("#liveTxt").textContent = "Live · updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    });
  }

  function openModal(html) { $("#mBody").innerHTML = html; $("#modal").classList.add("open"); $("#mClose").focus(); }
  function closeModal() { $("#modal").classList.remove("open"); }
  function showOrder(id) {
    openModal('<div class="sk"></div>');
    api("/api/account/orders/" + encodeURIComponent(id)).then(function (d) {
      if (!d.success) { closeModal(); return toast(d.message || "Could not load this order.", "err"); }
      var o = d.order;
      openModal('<h3 id="mTitle">' + esc(o.subject || "Expert") + '</h3><p style="margin:0 0 10px"><span class="pill ' + pillClass(o.status) + '">' + esc(o.status) + '</span> &nbsp;<span style="color:var(--muted);font-size:.85rem">Order #' + esc(o.orderId) + "</span></p>" +
        '<div class="kv"><div><small>Submitted</small><b>' + esc(fmtDate(o.submittedAt, true)) + "</b></div><div><small>Deadline</small><b>" + esc(o.deadlineDate || "—") + " " + esc(o.deadlineTime || "") + "</b></div><div><small>Contact</small><b style=\"font-size:.85rem;word-break:break-all\">" + esc(o.email) + "</b></div></div>" +
        "<b>Your requirements</b><div class=\"desc\">" + esc(o.details || "—") + "</div>" +
        (o.files.length ? '<b>Attachments</b><div class="files">' + o.files.map(function (f) { return '<a href="' + esc(f.downloadUrl) + '" download><span>' + svg("file").replace("<svg", '<svg width="16" height="16" style="vertical-align:-3px"') + " " + esc(f.name) + "</span><span style=\"color:var(--muted)\">" + Math.max(1, Math.round(f.size / 1024)) + " KB</span></a>"; }).join("") + "</div>" : ""));
    });
  }

  function go(tab) {
    $$(".tab").forEach(function (t) { t.setAttribute("aria-selected", String(t.dataset.tab === tab)); });
    $$(".panel").forEach(function (p) { p.hidden = p.id !== "p-" + tab; });
    if (history.replaceState) history.replaceState(null, "", "#" + tab);
    if (tab === "docs") loadDocs();
    if (tab === "wallet") {
      loadWallet(true);
      if (!W.done) { W.done = true; api("/api/wallet/reconcile", { method: "POST" }).then(function (d) { if (d.success && d.addedCents > 0) { paintWallet(d); loadWallet(true); toast(money(d.addedCents) + " from an earlier payment was added to your wallet.", "ok"); } }); }
    }
  }

  /* Documents this user uploaded to the library, each with its public URL. */
  var SRC = { upload: "Upload unlock", pack: "30-unlock pack", paid: "Paid $5 download", plan: "Plan" };
  function loadUnlocked() {
    var box = $("#unlocked"), sum = $("#unlsum"); box.innerHTML = "";
    api("/api/docs/unlocked").then(function (d) {
      if (!d.success) { sum.textContent = "Could not load your unlocked documents."; return; }
      var b = d.balance || {};
      sum.innerHTML = "<b>" + (b.total || 0) + " unlock" + (b.total === 1 ? "" : "s") + " left</b> (" + (b.upload || 0) + " from uploads, " + (b.pack || 0) + " from your 30-unlock pack" + (b.pack && b.packExpires ? ", valid until " + new Date(b.packExpires).toLocaleDateString() : "") + "). An unlock is used automatically when you open a document, and the document then stays unlocked and downloadable for as long as your account is active.";
      if (!d.docs.length) { box.innerHTML = '<p class="sub">You have not unlocked any document yet.</p>'; return; }
      box.innerHTML = d.docs.map(function (x) {
        return '<div class="order" style="cursor:default"><div class="t"><a href="' + esc(encodeURI(x.url)) + '">' + esc(x.title) + '</a></div>' +
          '<div><a class="btn ghost sm" href="/api/docs/' + esc(x.id) + '/download">Download</a></div>' +
          '<div class="m"><span>Unlocked with: ' + esc(SRC[x.source] || x.source) + '</span><span>' + new Date(x.unlocked).toLocaleDateString() + '</span><span>' + x.pages + ' page(s)</span>' +
          '<span>' + (x.downloads ? 'Downloaded ' + x.downloads + 'x, last ' + new Date(x.lastDownload).toLocaleDateString() : 'Not downloaded yet') + '</span></div></div>';
      }).join("");
    });
  }
  function loadDocs() {
    loadUnlocked();
    var box = $("#mydocs"); box.innerHTML = '<p class="sub">Loading…</p>';
    api("/api/docs/mine").then(function (d) {
      if (!d.success) { box.innerHTML = '<p class="sub">Could not load your documents.</p>'; return; }
      if (!d.docs.length) { box.innerHTML = '<p class="sub">You have not uploaded anything yet.</p>'; return; }
      box.innerHTML = d.docs.map(function (x) {
        var full = location.origin + encodeURI(x.url);
        return '<div class="order" style="cursor:default"><div class="t"><a href="' + esc(encodeURI(x.url)) + '" target="_blank" rel="noopener">' + esc(x.title) + '</a></div>' +
          '<div><button class="btn ghost sm" data-copydoc="' + esc(full) + '">Copy link</button></div>' +
          '<div class="m"><span>' + esc([x.course, x.school].filter(Boolean).join(" · ")) + '</span><span>' + x.pages + ' page(s)</span><span>' + x.views + ' views</span><span>' + new Date(x.created).toLocaleDateString() + '</span></div>' +
          '<div class="m"><a href="' + esc(encodeURI(x.url)) + '" target="_blank" rel="noopener" style="word-break:break-all">' + esc(full) + '</a></div></div>';
      }).join("");
    });
  }
  document.addEventListener("click", function (e) {
    var c = e.target.closest("[data-copydoc]");
    if (c) { if (navigator.clipboard) navigator.clipboard.writeText(c.getAttribute("data-copydoc")); c.textContent = "Copied"; }
  });

  /* events */
  document.addEventListener("click", function (e) {
    var p = e.target.closest("[data-preset]"); if (p) { $("#wAmt").value = p.dataset.preset + ".00"; $$("#wPre button").forEach(function (x) { x.classList.toggle("on", x === p); }); return; }
    var m = e.target.closest("[data-wm]"); if (m && !m.disabled) { startTopup(m.dataset.wm, m); return; }
    var g = e.target.closest("[data-go-wallet]"); if (g) { e.preventDefault(); go("wallet"); }
  });
  $("#wMore").addEventListener("click", function () {
    var btn = $("#wMore"); busy(btn, true);
    api("/api/wallet/ledger?page=" + (W.page + 1)).then(function (d) {
      busy(btn, false);
      if (d.success) { W.page = d.page; $("#wLedger").insertAdjacentHTML("beforeend", d.items.map(ledgerRow).join("")); btn.hidden = d.items.length < 20; }
    });
  });
  $$(".tab").forEach(function (t) { t.addEventListener("click", function () { go(t.dataset.tab); }); });
  $$("[data-go]").forEach(function (b) { b.addEventListener("click", function () { go(b.dataset.go); $("#curPw").focus(); }); });
  document.addEventListener("click", function (e) { var b = e.target.closest("[data-order]"); if (b) showOrder(b.getAttribute("data-order")); });
  $("#mClose").addEventListener("click", closeModal);
  $("#modal").addEventListener("click", function (e) { if (e.target.id === "modal") closeModal(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });
  $("#more").addEventListener("click", function () {
    var btn = $("#more"); busy(btn, true);
    api("/api/account/orders?page=" + (state.page + 1)).then(function (d) {
      busy(btn, false);
      if (d.success) { state.page = d.page; state.totalPages = d.totalPages; state.orders = state.orders.concat(d.orders); renderOrders(); }
    });
  });
  $("#setPwBtn").addEventListener("click", openPasswordModal);
  $("#moreTxn").addEventListener("click", function () {
    var btn = $("#moreTxn"); busy(btn, true);
    api("/api/account/transactions?page=" + (state.txnPage + 1)).then(function (d) {
      busy(btn, false);
      if (d.success) { state.txnPage = d.page; state.txnPages = d.totalPages; state.txns = state.txns.concat(d.items); renderTxns(); }
    });
  });
  [["#suspendBtn", "SUSPEND", "/api/account/suspend", "POST", "Suspend your account? You will be signed out and can reactivate it by logging in again.\n\nType SUSPEND to confirm."],
   ["#deleteBtn", "DELETE", "/api/account/me", "DELETE", "Delete your account permanently? This cannot be undone.\n\nType DELETE to confirm."]].forEach(function (c) {
    $(c[0]).addEventListener("click", function () {
      var v = window.prompt(c[4]);
      if (v === null) return;
      if (v.trim().toUpperCase() !== c[1]) { toast("Confirmation did not match. Nothing was changed.", "error"); return; }
      api(c[2], { method: c[3], body: { confirm: c[1] } }).then(function (d) {
        if (d.success) { toast(d.message, "ok"); setTimeout(function () { location.href = "/login"; }, 1200); }
        else toast(d.message || "Something went wrong.", "error");
      });
    });
  });
  $("#logoutBtn").addEventListener("click", function () { try { localStorage.setItem("ah_no_autog", "1"); } catch (e) {} api("/api/auth/logout", { method: "POST" }).then(function () { location.href = "/login"; }); });

  $("#profileForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var btn = $("#profileBtn"); busy(btn, true, "Saving…");
    api("/api/account/me", { method: "PATCH", body: { name: $("#pName").value, phone: $("#pPhone").value } }).then(function (d) {
      busy(btn, false);
      if (d.success) { state.user = d.user; renderProfile(); toast("Profile updated.", "ok"); } else toast(d.message || "Could not save.", "err");
    });
  });

  $("#newPw").addEventListener("input", function () {
    paintMeter($("#meter"), this.value);
  });
  $("#pwForm").addEventListener("submit", function (e) {
    e.preventDefault(); $("#pwMsg").textContent = "";
    var cur = $("#curPw").value, next = $("#newPw").value;
    var needCur = state.user && state.user.hasPassword;
    if ((needCur && !cur) || !next) { $("#pwMsg").textContent = needCur ? "Fill in both fields." : "Enter a new password."; return; }
    var btn = $("#pwBtn"); busy(btn, true, "Updating…");
    api("/api/auth/change-password", { method: "POST", body: { currentPassword: cur, newPassword: next } }).then(function (d) {
      busy(btn, false);
      if (d.success) { $("#pwForm").reset(); $("#meter").style.width = "0"; toast(needCur ? "Password updated." : "Password saved. You can now log in with your email.", "ok"); loadOverview(true); }
      else $("#pwMsg").textContent = d.message || "Could not update password.";
    });
  });

  /* live refresh while the tab is visible */
  function tick() { if (!document.hidden) loadOverview(true); }
  state.timer = setInterval(tick, 60000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) loadOverview(true); });

  /* live: admin top-ups, payments and every spent unlock / citation / AI detection / Ask AI question show up here at once */
  var liveT = null;
  window.addEventListener("ah:live", function (e) {
    clearTimeout(liveT);
    liveT = setTimeout(function () {
      var t = e.detail && e.detail.type;
      loadOverview(true);
      if (t === "wallet" || t === "resync") loadWallet(true);
      if (t === "unlocks" || t === "quota" || t === "resync") { try { loadDocs(); } catch (x) { /* tab not built yet */ } }
    }, 250);
  });

  var start = (location.hash || "").replace("#", "");
  loadOverview().then(function () {
    if (handleStripeReturn()) return;
    if (["overview", "orders", "subscription", "payments", "settings", "docs", "wallet"].indexOf(start) > -1) go(start);
  });
}

/* ---------- boot ---------- */
document.addEventListener("DOMContentLoaded", function () {
  paintIcons(document); wireEyes();
  var page = document.body.getAttribute("data-page");
  if (page === "login" || page === "signup") authPage();
  else if (page === "account") accountPage();
});
})();
