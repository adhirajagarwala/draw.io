// Scribble — embedded-mode bootstrap. When the tool is framed in a host page
// with ?embed (see embed/host-demo.html), this wires up the host-page capture
// affordances: hover-to-highlight + click-to-snip a figure/equation out of the
// problem, and "grab problem text" from the host selection, both landing in the
// notes. Only reaches the host DOM when it's same-origin (cross-origin throws and
// degrades gracefully). Dependencies are injected so the module holds no app
// state. Bump embed.js's ?v= import in app.js together with APP_VERSION.
export function initEmbed({ app, els, status, toggleNotes, renderNotes, openHtml }) {
  // PrairieLearn frames Scribble via a srcdoc iframe (no ?embed query), flagged by
  // window.__SCRIBBLE_EMBED; the host-demo uses ?embed. Either enters embed mode.
  const plMode = !!window.__SCRIBBLE_EMBED;
  if (!plMode && !new URLSearchParams(location.search).has("embed")) return;
  document.body.classList.add("embedded");
  toggleNotes(true);

  // PrairieLearn (Option B): render the question content INSIDE Scribble so the student
  // annotates it directly. The content is OUR element's own output — pl-scribble.py emits
  // it as <div class="pl-scribble-source" hidden> right beside this iframe inside the
  // .pl-scribble-wrap. We read only our own wrapper (frameElement.parentElement); we never
  // traverse PrairieLearn's surrounding DOM, so a future PL layout change can't break this.
  if (plMode) {
    try {
      const wrap = window.frameElement && window.frameElement.parentElement;
      const src = wrap && wrap.querySelector(":scope > .pl-scribble-source");
      if (!src) { status("Embedded — no content was placed inside <pl-scribble>."); return; }
      const c = src.cloneNode(true);
      c.querySelectorAll("script").forEach((el) => el.remove());
      const docHtml =
        '<!doctype html><html><head><meta charset="utf-8">' +
        '<style>body{font-family:-apple-system,system-ui,sans-serif;color:#1f2428;' +
        'line-height:1.6;padding:24px;max-width:780px;margin:0 auto;}' +
        'img,svg{max-width:100%;height:auto;}</style></head><body>' +
        c.innerHTML + '</body></html>';
      openHtml(new File([docHtml], "question.html", { type: "text/html" }));
    } catch (e) {
      status("Embedded — couldn't load the question: " + (e.message || e));
    }
    return;
  }

  // host-demo (?embed) ONLY past this point — it reaches into the host page DOM for the
  // snip / grab-text affordances. PrairieLearn mode returned above and never gets here.
  let host, sourceEl;
  try {
    host = window.parent.document;                      // throws if cross-origin
    const sel = (window.frameElement && window.frameElement.dataset.source)
      || "[data-scribble-source]";
    sourceEl = host.querySelector(sel) || host.body;
  } catch {
    status("Embedded, but can't read the host page (cross-origin).");
    return;
  }

  els.placeholder.textContent =
    "Snip text, figures or equations from the problem on the left — they land in your notes. You can also draw your own scratch work (＋ Draw).";

  const dpr2 = () => Math.min(3, Math.max(1, window.devicePixelRatio || 1));

  function svgToPng(svg) {
    return new Promise((res, rej) => {
      const box = svg.getBoundingClientRect();
      const w = Math.max(1, Math.round(box.width));
      const h = Math.max(1, Math.round(box.height));
      const clone = svg.cloneNode(true);
      clone.setAttribute("width", w);
      clone.setAttribute("height", h);
      if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      const xml = new XMLSerializer().serializeToString(clone);
      const url = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(xml)));
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = w * dpr2(); c.height = h * dpr2();
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        res(c.toDataURL("image/png"));
      };
      img.onerror = () => rej(new Error("could not rasterize SVG"));
      img.src = url;
    });
  }
  function imgToPng(imgEl) {
    return new Promise((res, rej) => {
      const draw = (image) => {
        const c = document.createElement("canvas");
        c.width = image.naturalWidth || image.width;
        c.height = image.naturalHeight || image.height;
        c.getContext("2d").drawImage(image, 0, 0);
        res(c.toDataURL("image/png"));
      };
      const im = new Image();
      im.onload = () => { try { draw(im); } catch (e) { rej(e); } };
      im.onerror = () => rej(new Error("image load failed"));
      im.src = imgEl.src;
    });
  }
  function latexOf(node) {
    const eq = node.closest && node.closest("[data-latex]");
    if (eq && eq.dataset.latex) return eq.dataset.latex.trim();
    const ann = node.querySelector && node.querySelector('annotation[encoding="application/x-tex"]');
    return ann ? ann.textContent.trim() : "";
  }
  function capturableAt(x, y) {
    let n = host.elementFromPoint(x, y);
    while (n && n !== sourceEl.parentNode) {
      if (n.matches && n.matches("[data-latex], svg, img, canvas")) return n;
      n = n.parentNode;
    }
    return null;
  }
  async function pngOf(node) {
    const tag = node.tagName.toLowerCase();
    const svg = tag === "svg" ? node : node.querySelector && node.querySelector("svg");
    if (svg) return svgToPng(svg);
    if (tag === "img") return imgToPng(node);
    if (tag === "canvas") return node.toDataURL("image/png");
    return "";
  }
  async function captureNode(node) {
    try {
      const dataUrl = await pngOf(node);
      if (!dataUrl) { status("Couldn't capture that element."); return; }
      const latex = latexOf(node);
      app.add_clipping(dataUrl.split(",")[1], 0,
        latex || node.getAttribute("alt") || "from the problem");
      renderNotes();
      if (els.notesPane.hidden) toggleNotes(true);
      status(latex ? "Captured figure + LaTeX into your notes." : "Captured into your notes.");
    } catch (e) {
      status("Capture failed: " + (e.message || e));
    }
  }
  function grabText() {
    const sel = host.getSelection ? host.getSelection() : null;
    const t = sel ? sel.toString().trim() : "";
    if (!t) { status("Select some text in the problem first."); return; }
    try { app.add_text_note(t); renderNotes(); if (els.notesPane.hidden) toggleNotes(true); sel.removeAllRanges(); status("Added the problem text to your notes."); }
    catch (e) { status(String(e)); }
  }

  // host-snip mode: hover highlights a figure/equation in the problem, click captures
  let snipMode = false, hovered = null;
  function setSnip(on) {
    snipMode = on;
    btnSnipHost.classList.toggle("active", on);
    sourceEl.style.cursor = on ? "copy" : "";
    if (!on) clearHover();
    status(on ? "Click a figure or equation in the problem to capture it." : "");
  }
  function clearHover() { if (hovered) hovered.classList.remove("se-host-hl"); hovered = null; }
  host.addEventListener("mousemove", (ev) => {
    if (!snipMode) return;
    const n = capturableAt(ev.clientX, ev.clientY);
    if (n !== hovered) { clearHover(); hovered = n; if (n) n.classList.add("se-host-hl"); }
  }, true);
  host.addEventListener("click", (ev) => {
    if (!snipMode) return;
    const n = capturableAt(ev.clientX, ev.clientY);
    if (!n) return;
    ev.preventDefault(); ev.stopPropagation();
    captureNode(n);
    setSnip(false);
  }, true);
  const hl = host.createElement("style");
  hl.textContent = ".se-host-hl{outline:2px solid #2f5fde;outline-offset:3px;border-radius:4px;cursor:copy;}";
  host.head.appendChild(hl);

  // embed-only action buttons in our top bar. They carry an icon so they stay
  // usable at the narrow widths where text labels collapse (like other btns).
  const mk = (svg, label, fn) => {
    const b = document.createElement("button");
    b.className = "btn labeled";
    b.title = label;
    b.innerHTML = `<svg viewBox="0 0 24 24">${svg}</svg>`;
    b.append(document.createTextNode(label));
    b.addEventListener("click", fn);
    return b;
  };
  const btnSnipHost = mk(
    '<path d="M4 8V4h4"/><path d="M16 4h4v4"/><path d="M20 16v4h-4"/><path d="M8 20H4v-4"/><rect x="9" y="9" width="6" height="6"/>',
    "Snip from problem", () => setSnip(!snipMode));
  const btnGrab = mk(
    '<path d="M5 6h14M5 11h9"/><path d="M17.5 13v7M14 16.5h7"/>',
    "Grab problem text", grabText);
  const group = document.createElement("div");
  group.className = "embed-actions";
  group.append(btnSnipHost, btnGrab);
  document.getElementById("topbar").insertBefore(
    group, document.querySelector(".topbar-right"));
}
