// Scribble — the floating notes window (embed / PrairieLearn mode only). Mirrors
// colorbar.js's dock/float/clamp engine: a grip in the notes header lifts the pane
// to position:fixed IN PLACE (no reparent, no jump), tracks the cursor, and on
// release an overDockZone() test (the bottom band of #stage — the inverse of the
// colour bar's overTopbar) decides whether to dock it back below the document or
// float it as an absolutely-positioned window inside #stage (the only
// position:relative overlay context, exactly where the colour bar floats). Holds no
// app state — initNotesDock() injects the handles it needs, and app.js calls
// floatNotes / dockNotes / clampNotes back from prefs + boot + the splitter guard.
// Bump this module's ?v= import in app.js together with APP_VERSION.

let els, $, savePrefs, relayoutSketches, stageEl;
const MIN_W = 220, MIN_H = 140, DOCK_BAND = 72;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(Math.max(lo, hi), v));
const embedded = () => document.body.classList.contains("embedded");

export function isNotesFloating() { return document.body.classList.contains("notes-floating"); }

function setDockBtn(floating) {
  const b = $("btn-notes-dock");
  if (!b) return;
  b.textContent = floating ? "Dock" : "Float";
  b.title = floating ? "Dock notes to the bottom" : "Float notes as a window";
}

// Float the pane as an absolute window inside #stage, at STAGE-relative coords.
export function floatNotes(left, top, w, h) {
  const pane = els.notesPane;
  if (pane.parentElement !== stageEl) stageEl.appendChild(pane);
  document.body.classList.add("notes-floating");
  els.splitter.hidden = true; // the row-resize splitter is meaningless while floating
  if (w) pane.style.width = `${Math.round(w)}px`;
  if (h) pane.style.height = `${Math.round(h)}px`;
  pane.style.left = `${Math.round(left)}px`;
  pane.style.top = `${Math.round(top)}px`;
  setDockBtn(true);
  clampNotes();
}

// Return the pane to the docked-below grid row (#main / grid-area:notes).
export function dockNotes() {
  const pane = els.notesPane;
  pane.classList.remove("notes-dragging");
  if (pane.parentElement !== $("main")) $("main").appendChild(pane); // grid-area:notes re-places it
  document.body.classList.remove("notes-floating");
  pane.style.left = pane.style.top = pane.style.width = pane.style.height = "";
  els.splitter.hidden = els.notesPane.hidden; // splitter visible iff the pane is
  setDockBtn(false);
}

// Keep a floating pane inside #stage when the window/stage resizes (mirror clampContextBar).
export function clampNotes() {
  const pane = els.notesPane;
  if (pane.hidden || !isNotesFloating()) return;
  const sr = stageEl.getBoundingClientRect();
  const w = Math.min(pane.offsetWidth, sr.width - 8);
  const h = Math.min(pane.offsetHeight, sr.height - 8);
  pane.style.width = `${Math.round(w)}px`;
  pane.style.height = `${Math.round(h)}px`;
  pane.style.left = `${Math.round(clamp(parseFloat(pane.style.left) || 0, 4, sr.width - w - 4))}px`;
  pane.style.top = `${Math.round(clamp(parseFloat(pane.style.top) || 0, 4, sr.height - h - 4))}px`;
}

export function initNotesDock(deps) {
  ({ els, $, savePrefs, relayoutSketches } = deps);
  stageEl = $("stage");
  if (!embedded()) return; // floating is an embed-only affordance; standalone is untouched
  const pane = els.notesPane;
  const grip = pane.querySelector(".notes-grip");
  const resizeH = pane.querySelector(".notes-resize");
  const dockBtn = $("btn-notes-dock");
  const overDockZone = (y) => y >= stageEl.getBoundingClientRect().bottom - DOCK_BAND;

  // ---- grip drag: lift to fixed in place, track the cursor, decide on drop ----
  let drag = null, raf = 0;
  grip.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || ev.target.closest("button")) return; // ignore right/middle + header buttons
    const br = pane.getBoundingClientRect();
    drag = { dx: ev.clientX - br.left, dy: ev.clientY - br.top, fx: br.left, fy: br.top, w: br.width, h: br.height };
    pane.classList.add("notes-dragging"); // position:fixed lift-in-place — no reparent, no jump
    els.splitter.hidden = true;           // hide the now-orphaned docked splitter while lifting
    pane.style.left = `${Math.round(br.left)}px`;
    pane.style.top = `${Math.round(br.top)}px`;
    pane.style.width = `${Math.round(br.width)}px`;
    pane.style.height = `${Math.round(br.height)}px`;
    try { grip.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
    ev.preventDefault();
  });
  grip.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    drag.fx = ev.clientX - drag.dx;
    drag.fy = ev.clientY - drag.dy;
    const over = overDockZone(ev.clientY);
    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0;
      pane.style.left = `${Math.round(drag.fx)}px`;
      pane.style.top = `${Math.round(drag.fy)}px`;
      stageEl.classList.toggle("notes-drop", over);
    });
  });
  const endDrag = (ev) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    pane.classList.remove("notes-dragging");
    stageEl.classList.remove("notes-drop");
    const wantsDock = ev ? overDockZone(ev.clientY) : isNotesFloating();
    if (wantsDock) {
      dockNotes();
    } else {
      const sr = stageEl.getBoundingClientRect();
      floatNotes(
        clamp(d.fx - sr.left, 4, sr.width - d.w - 4),
        clamp(d.fy - sr.top, 4, sr.height - d.h - 4),
        d.w, d.h,
      );
    }
    relayoutSketches();
    savePrefs();
  };
  grip.addEventListener("pointerup", endDrag);
  grip.addEventListener("pointercancel", endDrag);

  // ---- bottom-right resize handle (floating only) ----
  let rz = null, rraf = 0;
  resizeH.addEventListener("pointerdown", (ev) => {
    rz = { sx: ev.clientX, sy: ev.clientY, sw: pane.offsetWidth, sh: pane.offsetHeight };
    try { resizeH.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    ev.preventDefault();
    ev.stopPropagation();
  });
  resizeH.addEventListener("pointermove", (ev) => {
    if (!rz) return;
    const sr = stageEl.getBoundingClientRect();
    const left = parseFloat(pane.style.left) || 0, top = parseFloat(pane.style.top) || 0;
    const w = clamp(rz.sw + (ev.clientX - rz.sx), MIN_W, sr.width - left - 4);
    const h = clamp(rz.sh + (ev.clientY - rz.sy), MIN_H, sr.height - top - 4);
    if (!rraf) rraf = requestAnimationFrame(() => {
      rraf = 0;
      pane.style.width = `${w}px`;
      pane.style.height = `${h}px`;
      relayoutSketches();
    });
  });
  const endResize = () => {
    if (!rz) return;
    rz = null;
    if (rraf) { cancelAnimationFrame(rraf); rraf = 0; }
    relayoutSketches();
    savePrefs();
  };
  resizeH.addEventListener("pointerup", endResize);
  resizeH.addEventListener("pointercancel", endResize);

  // ---- dock/float toggle button + double-click the header to dock ----
  dockBtn.addEventListener("click", () => {
    if (isNotesFloating()) {
      dockNotes();
    } else {
      const sr = stageEl.getBoundingClientRect();
      const w = 340, h = 320;
      floatNotes((sr.width - w) / 2, 48, w, h);
    }
    relayoutSketches();
    savePrefs();
  });
  pane.querySelector("header").addEventListener("dblclick", (ev) => {
    if (ev.target.closest("button") || !isNotesFloating()) return;
    dockNotes();
    relayoutSketches();
    savePrefs();
  });

  window.addEventListener("resize", () => { clampNotes(); relayoutSketches(); });
}
