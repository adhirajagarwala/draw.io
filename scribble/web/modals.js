// Scribble — modal dialogs. Each builds its own `.modal-overlay` holding no app
// state (content is passed in; user text always via textContent, never innerHTML)
// and resolves a Promise the caller acts on. trapModalFocus makes them accessible.
// Bump this module's ?v= import in app.js together with APP_VERSION.

// Make a freshly-created `.modal-overlay` behave like an accessible dialog:
// announce it to assistive tech and keep Tab focus inside it until it's removed.
function trapModalFocus(ov, label) {
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  if (label) ov.setAttribute("aria-label", label);
  ov.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const f = [...ov.querySelectorAll('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled && el.offsetParent !== null);
    if (!f.length) { e.preventDefault(); return; }
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

// Ask whether to add a snip's captured text to the note (the image goes in either
// way — the caller adds it after this resolves). Enter = keep, Esc = skip.
export function confirmSnipText(text) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const ov = document.createElement("div");
    ov.className = "modal-overlay";
    const card = document.createElement("div");
    card.className = "modal-card";
    const h = document.createElement("h3");
    h.textContent = "Keep the captured text?";
    const pre = document.createElement("p");
    pre.className = "snip-text-preview";
    pre.textContent = text; // textContent — never innerHTML of captured content
    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const add = document.createElement("button");
    add.className = "btn primary";
    add.textContent = "Keep text (Enter)";
    const skip = document.createElement("button");
    skip.className = "btn";
    skip.textContent = "Image only (Esc)";
    const done = (v) => { ov.remove(); document.removeEventListener("keydown", onKey, true); opener?.focus?.(); resolve(v); };
    const onKey = (e) => {
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); done(true); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
    };
    add.addEventListener("click", () => done(true));
    skip.addEventListener("click", () => done(false));
    ov.addEventListener("click", (e) => { if (e.target === ov) done(false); });
    actions.append(add, skip);
    card.append(h, pre, actions);
    ov.appendChild(card);
    trapModalFocus(ov, "Keep the captured text?");
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(ov);
    add.focus();
  });
}

// A small modal that asks what to do with unsaved work before opening a file.
// Resolves to "save" | "newtab" | "discard" | "cancel".
export function confirmOpenDialog() {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const ov = document.createElement("div");
    ov.className = "modal-overlay";
    const card = document.createElement("div");
    card.className = "modal-card";
    const h = document.createElement("h3");
    h.textContent = "You have unsaved work";
    const p = document.createElement("p");
    p.textContent = "Opening a file replaces what's on screen. What would you like to do?";
    const row = document.createElement("div");
    row.className = "modal-actions";
    const cleanup = () => { ov.remove(); document.removeEventListener("keydown", onKey); opener?.focus?.(); };
    const mk = (label, val, cls = "") => {
      const b = document.createElement("button");
      b.className = `btn labeled ${cls}`;
      b.textContent = label;
      b.addEventListener("click", () => { cleanup(); resolve(val); });
      return b;
    };
    row.append(
      mk("Save, then open", "save", "primary"),
      mk("Open in a new tab", "newtab"),
      mk("Discard & open", "discard"),
      mk("Cancel", "cancel"),
    );
    card.append(h, p, row);
    ov.append(card);
    const onKey = (e) => { if (e.key === "Escape") { cleanup(); resolve("cancel"); } };
    ov.addEventListener("click", (e) => { if (e.target === ov) { cleanup(); resolve("cancel"); } });
    trapModalFocus(ov, "You have unsaved work");
    document.addEventListener("keydown", onKey);
    document.body.append(ov);
    row.querySelector("button")?.focus();
  });
}

// Show a clipping enlarged in a dismissible lightbox (click the image to open;
// click anywhere or press Esc to close). For PDF snips it also offers a jump to
// the source page — pass the current docMode and the goToPage callback.
export function showClippingLightbox(src, srcPage, docMode, goToPage) {
  const opener = document.activeElement; // restore focus here when the lightbox closes
  const ov = document.createElement("div");
  ov.className = "modal-overlay lightbox";
  ov.tabIndex = -1;
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey, true); opener?.focus?.(); };
  const big = document.createElement("img");
  big.src = src; big.className = "lightbox-img"; big.alt = "enlarged clipping";
  ov.appendChild(big);
  let firstFocus = null;
  if (srcPage >= 0 && docMode === "pdf") {
    const go = document.createElement("button");
    go.className = "btn primary";
    go.textContent = `Go to page ${srcPage + 1}`;
    go.addEventListener("click", (e) => { e.stopPropagation(); close(); goToPage(srcPage); });
    ov.appendChild(go);
    firstFocus = go;
  }
  ov.addEventListener("click", close);
  trapModalFocus(ov, "Enlarged clipping");
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(ov);
  (firstFocus || ov).focus?.();
}
