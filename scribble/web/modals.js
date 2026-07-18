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

// After a snip, PREVIEW the captured image so the student sees exactly what was grabbed, and — when text
// was recognised in the region — let them choose whether to keep it as a caption before it lands in notes.
// `text` is passed via textContent only (never innerHTML). Resolves { add, includeText }.
export function confirmSnip(imgUrl, text) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const hasText = !!(text && text.trim());
    const ov = document.createElement("div");
    ov.className = "modal-overlay";
    const card = document.createElement("div");
    card.className = "modal-card snip-confirm";
    const h = document.createElement("h3");
    h.textContent = "Add this clip to your notes?";
    const img = document.createElement("img");
    img.className = "snip-preview";
    img.src = imgUrl;
    img.alt = "Preview of the region you snipped";
    card.append(h, img);
    let checkbox = null;
    if (hasText) {
      const label = document.createElement("label");
      label.className = "snip-text-opt";
      checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true; // default: keep the text (the student can untick to save the image alone)
      const span = document.createElement("span");
      span.textContent = "Keep the recognised text below the image";
      label.append(checkbox, span);
      const preview = document.createElement("p");
      preview.className = "snip-text-preview";
      preview.textContent = text; // textContent-safe: recovered page text is never HTML
      card.append(label, preview);
    }
    const row = document.createElement("div");
    row.className = "modal-actions";
    const cleanup = () => { ov.remove(); document.removeEventListener("keydown", onKey); opener?.focus?.(); };
    const add = document.createElement("button");
    add.className = "btn labeled primary";
    add.textContent = "Add to notes";
    add.addEventListener("click", () => { const inc = checkbox ? checkbox.checked : false; cleanup(); resolve({ add: true, includeText: inc }); });
    const cancel = document.createElement("button");
    cancel.className = "btn labeled";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => { cleanup(); resolve({ add: false, includeText: false }); });
    row.append(add, cancel);
    card.append(row);
    ov.append(card);
    const onKey = (e) => { if (e.key === "Escape") { cleanup(); resolve({ add: false, includeText: false }); } };
    ov.addEventListener("click", (e) => { if (e.target === ov) { cleanup(); resolve({ add: false, includeText: false }); } });
    trapModalFocus(ov, "Add this clip to your notes?");
    document.addEventListener("keydown", onKey);
    document.body.append(ov);
    // Place the dialog in the VISIBLE band of the (possibly multi-screen-tall) overlay iframe, not the centre
    // of its full height — else Add/Cancel land below the fold and you'd scroll to reach them. Recompute once
    // the preview image DECODES and grows the card (its height is unknown at first paint, so a one-shot
    // measure would mis-place it). Same-origin read of the parent's scroll; falls back to the centred layout.
    const place = () => {
      try {
        const fr = window.frameElement && window.frameElement.getBoundingClientRect();
        const pvh = window.parent && window.parent.innerHeight;
        if (!fr || !pvh) return;
        const visTop = Math.max(0, -fr.top);
        const band = Math.min(pvh - fr.top, fr.height) - visTop;
        if (band <= 160) return;
        ov.style.alignItems = "flex-start"; // stop the flex from re-centring in the full iframe height
        card.style.maxHeight = `${Math.round(band - 32)}px`;
        card.style.marginTop = `${Math.max(8, Math.round(visTop + band / 2 - card.offsetHeight / 2 - 20))}px`;
      } catch { /* cross-frame — keep the default centred layout */ }
    };
    place();
    img.addEventListener("load", place);
    img.decode?.().then(place).catch(() => {}); // fires even when the object URL is already decoded
    add.focus();
  });
}

// A generic confirm. Resolves true (confirmed) / false (cancelled). For a DESTRUCTIVE action pass
// danger:true — the confirm button is styled destructive and initial focus + the visual primary go to
// CANCEL, so a reflexive Enter/Space never triggers the irreversible action. Band-placed for the tall
// overlay iframe (like confirmSnip) so Cancel/Confirm never land below the fold in the embed notes pane.
export function confirmDialog({ title, body, confirmLabel = "OK", danger = false } = {}) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const ov = document.createElement("div");
    ov.className = "modal-overlay";
    const card = document.createElement("div");
    card.className = "modal-card";
    const h = document.createElement("h3");
    h.textContent = title || "Are you sure?";
    card.append(h);
    if (body) { const p = document.createElement("p"); p.textContent = body; card.append(p); }
    const row = document.createElement("div");
    row.className = "modal-actions";
    const cleanup = () => { ov.remove(); document.removeEventListener("keydown", onKey); opener?.focus?.(); };
    // Cancel first: leftmost, first in tab order, and focused — the safe default for a destructive dialog.
    const cancel = document.createElement("button");
    cancel.className = "btn labeled primary";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => { cleanup(); resolve(false); });
    const confirm = document.createElement("button");
    confirm.className = "btn labeled" + (danger ? " danger" : "");
    confirm.textContent = confirmLabel;
    confirm.addEventListener("click", () => { cleanup(); resolve(true); });
    row.append(cancel, confirm);
    card.append(row);
    ov.append(card);
    const onKey = (e) => { if (e.key === "Escape") { cleanup(); resolve(false); } };
    ov.addEventListener("click", (e) => { if (e.target === ov) { cleanup(); resolve(false); } });
    trapModalFocus(ov, title || "Confirm");
    document.addEventListener("keydown", onKey);
    document.body.append(ov);
    // Band-place in the VISIBLE part of the (possibly multi-screen-tall) overlay iframe — else the buttons
    // land below the fold. No async image here, so the card height is known immediately (one measure).
    try {
      const fr = window.frameElement && window.frameElement.getBoundingClientRect();
      const pvh = window.parent && window.parent.innerHeight;
      if (fr && pvh) {
        const visTop = Math.max(0, -fr.top);
        const band = Math.min(pvh - fr.top, fr.height) - visTop;
        if (band > 160) {
          ov.style.alignItems = "flex-start";
          card.style.maxHeight = `${Math.round(band - 32)}px`;
          card.style.marginTop = `${Math.max(8, Math.round(visTop + band / 2 - card.offsetHeight / 2 - 20))}px`;
        }
      }
    } catch { /* cross-frame — keep the centred layout */ }
    cancel.focus();
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
  // `src` is a fresh blob URL owned by this lightbox — revoke it on close so it
  // doesn't leak (and so it never aliases the notes-list image's URL).
  const close = () => { URL.revokeObjectURL(big.src); ov.remove(); document.removeEventListener("keydown", onKey, true); opener?.focus?.(); };
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
