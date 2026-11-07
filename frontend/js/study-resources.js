/* "AI Tools" menu: Citation Generator, Document Creator, Image & PDF to Text, Diagram Generator, Grammar Checker, Spell Checker, Proofreader, Paraphraser and Flashcards.
   Every entry opens a page on THIS site; nothing here links to another company's service. Put <div data-study-resources></div> where the menu should appear. */
(function () {
  var I = function (p) { return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>'; };
  var ITEMS = [
    ["/citation-generator", "Citation Generator", I('<path d=\"M4 5h16v11H8l-4 4z\"/><path d=\"M8 9h8M8 12h5\"/>')],
    ["/tools/document-creator", "Document Creator", I('<path d=\"M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z\"/><path d=\"M14 3v5h5\"/><path d=\"M9 13h6M9 17h4\"/>')],
    ["/tools/ocr", "Image & PDF to Text", I('<path d=\"M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10\"/>')],
    ["/tools/diagram", "Diagram Generator", I('<rect x=\"3\" y=\"3\" width=\"7\" height=\"6\" rx=\"1\"/><rect x=\"14\" y=\"3\" width=\"7\" height=\"6\" rx=\"1\"/><rect x=\"8.5\" y=\"15\" width=\"7\" height=\"6\" rx=\"1\"/><path d=\"M6.5 9v2.5h11V9M12 11.5V15\"/>')],
    ["/tools/grammar-checker", "Grammar Checker", I('<path d=\"M5 12l4.5 4.5L19 7\"/>')],
    ["/tools/spell-checker", "Spell Checker", I('<path d=\"M4 19l4-12 4 12M5.5 15h5\"/><path d=\"M14 14l2.5 2.5L21 11\"/>')],
    ["/tools/proofreader", "Proofreader", I('<path d=\"M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z\"/><path d=\"M14 3v5h5\"/><path d=\"M8.5 16l2-2 1.5 1.5 3-3.5\"/>')],
    ["/tools/paraphraser", "Paraphraser", I('<path d=\"M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7\"/>')],
    ["/tools/flashcards", "Flashcards", I('<rect x=\"3\" y=\"7\" width=\"18\" height=\"12\" rx=\"2\"/><path d=\"M6 4h12\"/>')]
  ];

  /* Opens on mouse HOVER (pointer devices); on touch screens a tap opens it. The menu opens under the button (right-aligned so it never leaves the screen) and its entries slide in one after another,
     so the whole list is on show within a fraction of a second. */
  var css = '.srx{position:relative;display:inline-block}.srx-b{display:inline-flex;align-items:center;gap:5px;border:1.5px solid #14b8a6aa;background:#14b8a61a;color:inherit;font:700 13px/1 system-ui,sans-serif;height:34px;padding:0 10px;border-radius:10px;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s}.srx-b:hover,.srx.o .srx-b{background:#14b8a633;border-color:#0f766e}.srx-b svg{transition:transform .2s}.srx.o .srx-b svg{transform:rotate(180deg)}.srx-b:focus-visible{outline:3px solid #0f766e55;outline-offset:2px}'
    + '.srx-m{position:absolute;right:0;top:calc(100% + 8px);min-width:270px;max-height:calc(100vh - 110px);overflow-y:auto;overscroll-behavior:contain;background:#fff;color:#0b1220;border-radius:22px;box-shadow:0 18px 50px #0b122033,0 0 0 1px #e4e7ee;padding:10px;z-index:9999;opacity:0;visibility:hidden;transform:translateY(-8px) scale(.98);transform-origin:top right;transition:opacity .18s,transform .22s,visibility 0s linear .22s}.srx.o .srx-m{opacity:1;visibility:visible;transform:none;transition:opacity .18s,transform .22s,visibility 0s}'
    + '.srx-m:before{content:"";position:absolute;left:0;right:0;top:-12px;height:12px}'   /* keeps the menu open while the pointer crosses the gap */
    + '.srx-m a{white-space:nowrap;display:flex;align-items:center;gap:14px;padding:10px 14px;border-radius:12px;color:#0b1220;text-decoration:none;font:600 14.5px/1.2 system-ui,sans-serif;opacity:0;transform:translateY(-10px);transition:opacity .2s,transform .22s,background .15s}.srx.o .srx-m a{opacity:1;transform:none;transition-delay:calc(var(--i,0)*28ms),calc(var(--i,0)*28ms),0s}'
    + '.srx-m a svg{color:#8a94a6;flex:none;transition:color .15s,transform .2s}.srx-m a:hover,.srx-m a:focus-visible{background:#e6f7f4;outline:0}.srx-m a:hover svg{color:#0f766e;transform:scale(1.15)}'
    + '.srx-t{margin-left:auto;font-size:10px;font-weight:800;letter-spacing:.4px;color:#047857;background:#d1fae5;border-radius:6px;padding:3px 6px}.srx-hr{height:1px;background:#e8ebf2;margin:6px 8px}'
    + '@media(max-width:640px){.srx-b span{display:inline}.srx-m{min-width:250px}}@media(prefers-reduced-motion:reduce){.srx-m,.srx-m a,.srx-m a svg,.srx-b svg{transition:none!important}}';
  function build(host) {
    if (host.__sr) return; host.__sr = 1;
    host.className = (host.className ? host.className + " " : "") + "srx";
    host.innerHTML = '<button type="button" class="srx-b" aria-haspopup="true" aria-expanded="false"><span>AI Tools</span>' + I('<path d="M6 9l6 6 6-6"/>') + '</button><div class="srx-m" role="menu">'
      + ITEMS.map(function (x, i) { return '<a role="menuitem" style="--i:' + i + '" href="' + x[0] + '">' + x[2] + '<span>' + x[1] + '</span>' + (x[3] ? '<em class="srx-t" style="font-style:normal">' + x[3] + '</em>' : "") + '</a>'; }).join("")
      + '</div>';
    var b = host.querySelector(".srx-b"), set = function (o) { host.classList.toggle("o", o); b.setAttribute("aria-expanded", o); };
    var hover = !!(window.matchMedia && matchMedia("(hover:hover) and (pointer:fine)").matches), t = null;
    if (hover) {   /* mouse: open on hover, close shortly after the pointer leaves */
      host.addEventListener("mouseenter", function () { clearTimeout(t); set(true); });
      host.addEventListener("mouseleave", function () { clearTimeout(t); t = setTimeout(function () { set(false); }, 200); });
    }
    b.onclick = function (e) {
      e.stopPropagation();
      if (hover && e.detail > 0) set(true);      /* a mouse click never closes a menu that hover already opened */
      else set(!host.classList.contains("o"));   /* keyboard (Enter / Space) and touch toggle */
    };
    document.addEventListener("click", function (e) { if (!host.contains(e.target)) set(false); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") { set(false); } });
  }
  var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  [].forEach.call(document.querySelectorAll("[data-study-resources]"), build);
})();
