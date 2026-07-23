// Scribble — embedded-mode bootstrap. When the tool is framed in a host page
// with ?embed (see embed/host-demo.html), this wires up the host-page capture
// affordances: hover-to-highlight + click-to-snip a figure/equation out of the
// problem, and "grab problem text" from the host selection, both landing in the
// notes. Only reaches the host DOM when it's same-origin (cross-origin throws and
// degrades gracefully). Dependencies are injected so the module holds no app
// state. Bump embed.js's ?v= import in app.js together with APP_VERSION.
export function initEmbed({ app, els, status, toggleNotes, renderNotes, openHtml, openOverlay, resizeOverlay,
  hydrateAnnotations, serializeAnnotations, setPersistAlert }) {
  // No-op fallback so a missing dep can never throw out of the save loop.
  const persistAlert = typeof setPersistAlert === "function" ? setPersistAlert : () => {};
  // DEV-ONLY (localhost): ?overlay forces overlay mode from a plain <iframe src> for the local overlay harness
  // (embed/overlay-demo.html). PL sets these flags via its srcdoc head script; on hosted PL location.hostname is
  // never localhost, so this is inert in production. The harness supplies the .pl-scribble-overlay wrap around us.
  if ((location.hostname === "localhost" || location.hostname === "127.0.0.1") &&
      new URLSearchParams(location.search).has("overlay")) {
    window.__SCRIBBLE_EMBED = true; window.__SCRIBBLE_OVERLAY = true;
    document.documentElement.classList.add("pl-overlay");
  }
  // PrairieLearn frames Scribble via a srcdoc iframe (no ?embed query), flagged by
  // window.__SCRIBBLE_EMBED; the host-demo uses ?embed. Either enters embed mode.
  const plMode = !!window.__SCRIBBLE_EMBED;
  if (!plMode && !new URLSearchParams(location.search).has("embed")) return;
  document.body.classList.add("embedded");
  // Don't force the notes pane open — it steals height from the question on first load.
  // It auto-opens when there's something to show (a snip, a grab, or hydrated notes).
  const pl = window.__SCRIBBLE_PL || {}; // server-injected config: { readOnly, name?, data? }

  // Whenever there are unsaved edits, write base64(save_json()) into the hidden form input
  // and fire input/change so PrairieLearn marks the form dirty + persists on its Save. The
  // Rust dirty flag is the debounce (cleared by save_json). Shared by Option B and C.
  function wireSaveLoop(input) {
    // E-SEED: a save failure MUST be visible. The old bare `catch {}` swallowed every error, so a
    // deterministically-throwing serialize failed permanently and invisibly. Count consecutive failures;
    // surface a persistent (non-auto-clearing) banner + a distinctive console.error for staff.
    let saveFailures = 0;
    // `terminal` = a last-chance flush (unload/hide/blur/PL Save click) — surface a failure immediately then.
    const flush = (terminal) => {
      let res;
      try {
        res = serializeAnnotations(); // null when nothing changed; { b64, decodedBytes, nodes } otherwise
      } catch (e) {
        console.error("Scribble autosave: serialize failed", e);
        saveFailures++;
        if (saveFailures >= 2 || terminal) persistAlert("save-fail", "Couldn't save your work — please tell a proctor.");
        return;
      }
      if (res == null) return; // nothing changed
      // E1: refuse to write an over-cap blob — the server would reject the WHOLE submission (null it).
      // Keep the last-good input.value so a PL Save still persists prior work; tell the student to simplify.
      // (This is a deliberate refusal, NOT a save failure — do not touch saveFailures. Cap decided in app.js.)
      if (res.overCap) {
        persistAlert("cap", "Your scratchpad is nearly full — simplify your marks so they can be saved.");
        return;
      }
      try {
        input.value = res.b64;
        // Firing input+change makes PrairieLearn mark its form dirty → PL's own unsaved-changes
        // warning covers navigation; we don't add a second iframe-level one.
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        // A successful, under-cap write clears both banners and resets the failure counter.
        persistAlert("cap", null);
        persistAlert("save-fail", null);
        saveFailures = 0;
      } catch (e) {
        console.error("Scribble autosave: write failed", e);
        saveFailures++;
        if (saveFailures >= 2 || terminal) persistAlert("save-fail", "Couldn't save your work — please tell a proctor.");
      }
    };
    let timer = setInterval(() => flush(false), 1500);
    window.addEventListener("beforeunload", () => flush(true));
    window.addEventListener("pagehide", () => flush(true));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") { flush(true); clearInterval(timer); timer = null; }
      else if (!timer) { timer = setInterval(() => flush(false), 1500); }
    });
    window.addEventListener("blur", () => flush(true)); // best-effort: focus leaving the iframe (e.g. clicking Save)
  }

  // Option C (transparent overlay): the question is rendered LIVE in the PARENT page; we set
  // up an empty drawable page over it (no clone) so the live question shows through. We read
  // only our own wrapper (frameElement.parentElement) — never PrairieLearn's surrounding DOM.
  if (plMode && window.__SCRIBBLE_OVERLAY) {
    const wrap = window.frameElement && window.frameElement.parentElement; // .pl-scribble-overlay
    if (!wrap) { status("Embedded — overlay host not found."); return; }
    const input = pl.readOnly ? null : wrap.querySelector(":scope > .pl-scribble-input");
    // Measure the live prose host in the PARENT (same-origin, already laid out) — race-free,
    // unlike the iframe's own window.innerHeight which depends on the parent having sized us.
    const host = wrap.querySelector(":scope > .pl-scribble-host");
    // v179 item 3: the drawable overlay must cover the WHOLE question panel, not just the wrapped prose —
    // graded answer inputs are authored as SIBLINGS of <pl-scribble> (below the wrap), so a host-only page
    // left them un-drawable. Measure from the wrap's top to the panel's (.card-body) bottom; the parent
    // sizer sizes the iframe ELEMENT to the same span, and item 4's pause lets the student still type answers.
    // Falls back to the host height when no panel ancestor is found (older layouts / Option-B).
    const panel = wrap.closest(".card-body") || wrap.parentElement || host;
    const coverHeight = () => {
      try {
        const pr = panel.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
        return Math.max((host && host.offsetHeight) || 0, Math.round(pr.bottom - wr.top), 200);
      } catch { return (host && host.offsetHeight) || window.innerHeight || 600; }
    };
    openOverlay(coverHeight());
    const seed = pl.readOnly ? pl.data : (input && input.value);
    // Restoring saved work must NEVER abort the boot. This runs synchronously (unlike Option B's async IIFE
    // below), so a throw here would propagate out of initEmbed and skip the toolbar merge + notes setup that
    // run right after this call — leaving a raw, unresponsive bar. Contain it; the scratchpad still works.
    try { if (seed) hydrateAnnotations(seed); }
    catch (e) { console.warn("hydrate failed — starting with a blank scratchpad:", e); status("Couldn't restore your last work — starting fresh."); }
    if (pl.readOnly || !input) { if (pl.readOnly) status("Read-only — viewing a submitted answer."); return; }
    status("Scratchpad — draw right on the question.");
    wireSaveLoop(input);
    // F3: the live question can grow after boot (MathJax typeset, late images) — grow the drawable page to
    // match so the lower half stays annotatable. Same-origin: observe the parent host + its MathJax promise.
    try {
      const pw = window.parent;
      if (pw.MathJax?.startup?.promise) pw.MathJax.startup.promise.then(() => resizeOverlay(coverHeight())).catch(() => {});
      if (pw.ResizeObserver) {
        // Coalesce + defer to the next frame so growing the page (which re-renders) can't re-enter the
        // observer synchronously (the "ResizeObserver loop" warning).
        let rafId = 0;
        const ro = new pw.ResizeObserver(() => {
          if (rafId) return;
          // RAF-1 (audit, high): the callback is IFRAME-realm, so it must ride the IFRAME's rAF — a parent
          // rAF with an iframe callback silently never fires on hosted PL (the measured v155 failure mode,
          // CLAUDE.md §11 rule 2). With pw.requestAnimationFrame here, the overlay NEVER grew with the
          // question after boot: ink and pointer capture silently stopped short of the bottom.
          rafId = requestAnimationFrame(() => { rafId = 0; resizeOverlay(coverHeight()); });
        });
        if (host) ro.observe(host);
        if (panel && panel !== host) ro.observe(panel); // v179 item 3: grow when an answer input below the prose changes
        // Tear down on unload so a PL in-place panel swap can't leave a PARENT observer firing into this
        // torn-down iframe realm (GC leak / errors against a dead document).
        window.addEventListener("pagehide", () => {
          try { ro.disconnect(); } catch { /* ignore */ }
          if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } // own-realm cancel, defensive reset
        }, { once: true });
      }
    } catch { /* cross-frame access guard — non-fatal */ }
    return;
  }

  // PrairieLearn (Option B): render the question content INSIDE Scribble so the student
  // annotates it directly. The content is OUR element's own output — pl-scribble.py emits
  // it as <div class="pl-scribble-source" hidden> right beside this iframe inside the
  // .pl-scribble-wrap. We read only our own wrapper (frameElement.parentElement); we never
  // traverse PrairieLearn's surrounding DOM, so a future PL layout change can't break this.
  if (plMode) {
    const wrap = window.frameElement && window.frameElement.parentElement;
    const src = wrap && wrap.querySelector(":scope > .pl-scribble-source");
    if (!wrap || !src) { status("Embedded — no content was placed inside <pl-scribble>."); return; }
    // The live form input (question panel only) — also our own output, in PL's form.
    const input = pl.readOnly ? null : wrap.querySelector(":scope > .pl-scribble-input");

    // The doc to annotate = our own (cloned) question source, scripts stripped.
    const c = src.cloneNode(true);
    c.querySelectorAll("script").forEach((el) => el.remove());
    const docHtml =
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<style>body{font-family:-apple-system,system-ui,sans-serif;color:#1f2428;' +
      'line-height:1.6;padding:24px;max-width:780px;margin:0 auto;}' +
      'img,svg{max-width:100%;height:auto;}</style></head><body>' +
      c.innerHTML + '</body></html>';
    const file = new File([docHtml], "question.html", { type: "text/html" });

    (async () => {
      const ok = await openHtml(file); // returns false on any failure
      if (!ok) { status("Embedded — couldn't load the question."); return; }
      // HYDRATE strictly AFTER the question rendered (page 0 exists). Read-only panels
      // get the submission's saved blob (server-injected); the question panel gets the
      // prior submission seeded into the hidden input's value.
      const seed = pl.readOnly ? pl.data : (input && input.value);
      if (seed) hydrateAnnotations(seed);
      // read-only view (or no input): announce it (aria-live) and skip the save loop.
      if (pl.readOnly || !input) { if (pl.readOnly) status("Read-only — viewing a submitted answer."); return; }

      // Orient the first-time student (one toast; auto-hides, aria-live, textContent-safe).
      status("Scratchpad — draw on the question; tools are on the left.");
      wireSaveLoop(input);
    })();
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
