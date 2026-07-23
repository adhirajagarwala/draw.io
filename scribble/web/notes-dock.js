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

import { visibleBand, clampIntoBand } from "./visible-band.js?v=175";

let els, $, savePrefs, relayoutSketches, stageEl;
const MIN_W = 318, MIN_H = 140, DOCK_BAND = 72; // MIN_W fits the header (grip + title + +Text/+Draw/Minimise/✕) without collision
// px reserved at the visible-band TOP so the notes header can't be placed/dragged behind the sticky toolbar.
// PUSHED (not measured) from app.js whenever the bar's height changes — a WRAPPED 2-row toolbar is taller than
// the old hardcoded 64, and notes parked behind it is exactly the occlusion this reserve exists to prevent.
// Kept a plain module variable so the per-frame drag clamp never measures (no layout flush, no cross-realm read).
let railClear = 64;
export function setRailClear(px) { railClear = Math.max(64, px | 0); }
const DRAG_SLOP = 4; // px the pointer must travel before a header press becomes a lift (a click is a no-op)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(Math.max(lo, hi), v));
const embedded = () => document.body.classList.contains("embedded");
const overlay = () => document.body.classList.contains("overlay");

export function isNotesFloating() { return document.body.classList.contains("notes-floating"); }
export function isNotesCollapsed() { return els.notesPane.classList.contains("notes-collapsed"); }

// Overlay "minimise": collapse the floating notes to just its header strip, IN PLACE. The strip stays
// put and is click-to-expand, so the notes can never be lost the way a full hide loses it. Mirrors the
// colour bar / rail collapse-to-handle pattern the user asked for.
export function setNotesCollapsed(on) {
  const pane = els.notesPane;
  const was = pane.classList.contains("notes-collapsed");
  if (on && !was) { pane.dataset.expW = pane.style.width || ""; pane.dataset.expH = pane.style.height || ""; }
  pane.classList.toggle("notes-collapsed", on);
  if (on) {
    pane.style.width = ""; pane.style.height = ""; // shrink to the header pill (CSS width:max-content)
  } else {
    pane.style.width = pane.dataset.expW || "";
    pane.style.height = pane.dataset.expH || "";
  }
  setDockBtn(isNotesFloating()); // minimise is a sub-state of "visible" — the toolbar Notes button
                                 // (shown-vs-hidden) is left untouched here.
  clampNotes(); // both ways: expanding near an edge must not overflow, and the strip clamps position-only
}

function setDockBtn(floating) {
  const b = $("btn-notes-dock");
  if (!b) return;
  // Overlay: the button minimises/expands the pane in place (collapse-to-strip). Standalone/Option-B
  // keep the dock/float toggle.
  if (overlay()) {
    // "Minimise" = collapse to a strip in place (still there). The separate ✕ button fully hides. Two
    // distinct affordances so the student can tuck the notes to a strip OR get them out of the way entirely.
    const c = els.notesPane.classList.contains("notes-collapsed");
    b.textContent = c ? "Expand" : "Minimise";
    b.title = c ? "Expand the notes" : "Minimise the notes to a strip";
    b.setAttribute("aria-expanded", String(!c)); // disclosure semantics, matching the rail/cbar controls (#8)
    return;
  }
  b.textContent = floating ? "Dock" : "Float";
  b.title = floating ? "Dock notes to the bottom" : "Float notes as a window";
  b.removeAttribute("aria-expanded"); // Float/Dock is a mode toggle, not a disclosure
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
  clampNotes(true); // relaxed: a deliberate drop may hang off the edge (endDrag/boot go through here)
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

// Keep a floating pane inside #stage. Default (window/stage resize) pulls it FULLY inside. `relaxed` (only the
// deliberate drag-drop, and never in overlay) lets it hang off the right/bottom so a student can shove it
// aside — resize must NOT use relaxed, or a merely-resized (never-dragged) pane could get left hanging
// ~off-screen. Overlay is ALWAYS strict (4px margins, Done-button style): the hang-off affordance is what
// produced "my notes bar went off the page" over a live exam question.
export function clampNotes(relaxed = false) {
  if (!els) return; // callable before initNotesDock injects the deps (boot races) — nothing to clamp yet
  const pane = els.notesPane;
  // Skip when NOT RENDERED (no client rect) — hidden, or display:none via the Annotate gate before the
  // student clicks Annotate; measuring offset* then reads 0 and would freeze the pane to 0×0. Also skip
  // mid-lift (position:fixed → style.left/top are viewport, not stage, coords — clamping would jump it).
  if (pane.hidden || !pane.getClientRects().length || pane.classList.contains("notes-dragging")
      || !isNotesFloating()) return;
  const sr = stageEl.getBoundingClientRect();
  if (overlay()) {
    // Overlay: clamp to the VISIBLE BAND (converted to stage-relative coords), the SAME half-off-but-
    // recoverable rule as the rail — collapsed AND full go through clampIntoBand, differing only in the
    // measured size passed in (R2). Replaces the strict fully-inside-the-TALL-stage math below, which let the
    // pane sit far below the fold. The non-overlay branch (standalone / Option-B) keeps that math untouched.
    const b = visibleBand(window);
    // Reserve railClear at the band TOP: the sticky toolbar pins to band.top, and a header dragged/placed
    // fully behind it is occluded (opaque, higher z-index) — the "grabbable slice stays on-screen" rule can't
    // catch occlusion, only off-screen. So the notes band starts below the toolbar.
    const bandStage = { left: b.left - sr.left, right: b.right - sr.left, top: b.top - sr.top + railClear, bottom: b.bottom - sr.top };
    const headH = pane.querySelector("header").offsetHeight || 36; // measured fresh (survives .big "Larger")
    if (pane.classList.contains("notes-collapsed")) { // strip: clamp POSITION only, never write w/h
      const c = clampIntoBand(parseFloat(pane.style.left) || 0, parseFloat(pane.style.top) || 0,
                              pane.offsetWidth, pane.offsetHeight, pane.offsetHeight, bandStage);
      pane.style.left = `${Math.round(c.left)}px`; pane.style.top = `${Math.round(c.top)}px`;
      return;
    }
    // Cap the pane to the visible BAND (not the tall stage) so a pane the student resized taller than the band
    // reopens fitting on-screen (its list scrolls internally) instead of hanging its body below the fold.
    const w = Math.min(pane.offsetWidth, sr.width - 8, bandStage.right - bandStage.left - 8);
    const h = Math.min(pane.offsetHeight, sr.height - 8, bandStage.bottom - bandStage.top - 8);
    pane.style.width = `${Math.round(w)}px`; pane.style.height = `${Math.round(h)}px`;
    const c = clampIntoBand(parseFloat(pane.style.left) || 0, parseFloat(pane.style.top) || 0, w, h, headH, bandStage);
    pane.style.left = `${Math.round(c.left)}px`; pane.style.top = `${Math.round(c.top)}px`;
    return;
  }
  const strict = overlay();
  const lo = strict ? 4 : 0;
  if (pane.classList.contains("notes-collapsed")) {
    // Minimised strip: clamp POSITION only — never write width/height (the pill is content-sized,
    // freezing a size onto it breaks the expand restore). Without this the strip could be dropped
    // fully outside the frame with zero affordance left to recover it.
    const maxL = Math.max(lo, sr.width - pane.offsetWidth - lo);
    const maxT = Math.max(lo, sr.height - pane.offsetHeight - lo);
    pane.style.left = `${Math.round(clamp(parseFloat(pane.style.left) || 0, lo, maxL))}px`;
    pane.style.top = `${Math.round(clamp(parseFloat(pane.style.top) || 0, lo, maxT))}px`;
    return;
  }
  const w = Math.min(pane.offsetWidth, sr.width - 8);
  const h = Math.min(pane.offsetHeight, sr.height - 8);
  pane.style.width = `${Math.round(w)}px`;
  pane.style.height = `${Math.round(h)}px`;
  // relaxed (non-overlay only): keep a grabbable header strip (grip + ~90px) on-screen but allow hang-off;
  // never let the top-left grip go past the top/left. Default: fully inside.
  const rel = relaxed && !strict;
  const EDGE = 90, HEAD = 36;
  const maxL = rel ? Math.max(0, sr.width - EDGE) : Math.max(lo, sr.width - w - lo);
  const maxT = rel ? Math.max(0, sr.height - HEAD) : Math.max(lo, sr.height - h - lo);
  pane.style.left = `${Math.round(clamp(parseFloat(pane.style.left) || 0, lo, maxL))}px`;
  pane.style.top = `${Math.round(clamp(parseFloat(pane.style.top) || 0, lo, maxT))}px`;
}

export function initNotesDock(deps) {
  ({ els, $, savePrefs, relayoutSketches } = deps);
  stageEl = $("stage");
  if (!embedded()) return; // floating is an embed-only affordance; standalone is untouched
  const pane = els.notesPane;
  const grip = pane.querySelector(".notes-grip"); // kept as the visual affordance; the WHOLE header drags
  const header = pane.querySelector("header");
  const resizeH = pane.querySelector(".notes-resize");
  const dockBtn = $("btn-notes-dock");
  const overDockZone = (y) => y >= stageEl.getBoundingClientRect().bottom - DOCK_BAND;

  // ---- header drag: lift to fixed in place, track the cursor, decide on drop ----
  // The WHOLE header is the grab target, so (unlike the old tiny grip) an ordinary CLICK on it is common —
  // defer the lift until the pointer passes DRAG_SLOP so a press-without-move never snaps a wide/tall pane
  // down to the capped float size. Mirrors floating-panel.js.
  let drag = null, raf = 0, suppressExpand = false;
  header.addEventListener("pointerdown", (ev) => {
    // Stale-gesture reset: a drag whose pointerup was swallowed would block every future drag (we bail whenever
    // `drag` is set). Only clear one we no longer hold pointer capture for.
    if (drag && !header.hasPointerCapture?.(drag.id)) drag = null;
    if (drag || ev.button !== 0 || ev.target.closest("button")) return; // one drag at a time; header buttons never lift
    suppressExpand = false; // fresh interaction — a prior strip-drag's suppressor must not linger
    // A collapsed strip is draggable too (to REPOSITION it); a tap without movement still expands it.
    const collapsed = pane.classList.contains("notes-collapsed");
    const br = pane.getBoundingClientRect();
    // Record the grab but DON'T lift yet (no notes-dragging, no inline size/pos): that waits for real
    // movement. preL/preT snapshot the pre-lift stage-relative position so a cancelled drag restores it.
    drag = { id: ev.pointerId, dx: ev.clientX - br.left, dy: ev.clientY - br.top, fx: br.left, fy: br.top,
             w: br.width, h: br.height, fromDocked: !isNotesFloating(), collapsed,
             br, sx: ev.clientX, sy: ev.clientY, lifted: false,
             preL: pane.style.left, preT: pane.style.top };
    try { header.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
    ev.preventDefault();
  });
  header.addEventListener("pointermove", (ev) => {
    if (!drag || ev.pointerId !== drag.id) return; // only the owning contact drives the drag
    // buttons===0 means the user ALREADY RELEASED and we missed the pointerup — a finished gesture is a DROP,
    // not a cancel. Reverting here was the notes half of the v169 "it snaps back the minute I let go" bug, and
    // it was worse here than on the toolbar: a cancel of a pane lifted FROM DOCKED re-docks it (see endDrag),
    // so a flick-drop threw the notes all the way back into the dock. An unlifted press still no-ops.
    if (!(ev.buttons & 1)) return endDrag(null, false);
    if (!drag.lifted) {
      if (Math.abs(ev.clientX - drag.sx) < DRAG_SLOP && Math.abs(ev.clientY - drag.sy) < DRAG_SLOP) return;
      drag.lifted = true;
      drag.band = visibleBand(window); // cache the band + header height at lift — avoid a parent-layout flush every frame
      drag.headerH = header.offsetHeight || 36;
      const br = drag.br;
      pane.classList.add("notes-dragging"); // position:fixed lift-in-place — no reparent, no jump
      els.splitter.hidden = true;           // hide the now-orphaned docked splitter while lifting
      pane.style.left = `${Math.round(br.left)}px`;
      pane.style.top = `${Math.round(br.top)}px`;
      if (!drag.collapsed) {                 // a collapsed strip stays content-sized — don't freeze w/h onto it
        pane.style.width = `${Math.round(br.width)}px`;
        pane.style.height = `${Math.round(br.height)}px`;
      }
    }
    drag.fx = ev.clientX - drag.dx;
    drag.fy = ev.clientY - drag.dy;
    drag.cy = ev.clientY;
    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0;
      // Overlay live clamp (viewport coords while lifted): the pane can never leave the frame even
      // mid-drag — clamp only the APPLIED values, so the grab offset survives sticky-edge contact.
      // Non-overlay keeps free drag (the relaxed shove-aside drop is a designed affordance there).
      let L = drag.fx, T = drag.fy;
      if (overlay()) {
        // Cached band (no per-frame parent layout flush) with railClear reserved at the top so the header
        // can't be dragged behind the sticky toolbar. iframe-fixed coords (the pane is position:fixed while
        // lifted, so NO stage conversion): a notes drag can no longer be stranded below the fold.
        const b = { ...drag.band, top: drag.band.top + railClear };
        const pw = drag.collapsed ? pane.offsetWidth : drag.w, ph = drag.collapsed ? pane.offsetHeight : drag.h;
        const handleH = drag.collapsed ? pane.offsetHeight : drag.headerH;
        ({ left: L, top: T } = clampIntoBand(drag.fx, drag.fy, pw, ph, handleH, b));
      }
      pane.style.left = `${Math.round(L)}px`;
      pane.style.top = `${Math.round(T)}px`;
      // Recompute from the LATEST cy inside the frame (coalesced moves would
      // otherwise apply the newest position with the first frame's drop flag).
      stageEl.classList.toggle("notes-drop", drag.fromDocked && overDockZone(drag.cy));
    });
  });
  const endDrag = (ev, cancelled) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (!d.lifted) return; // a press/click without a drag — never lifted, so leave size & position untouched
    pane.classList.remove("notes-dragging");
    stageEl.classList.remove("notes-drop");
    // A cancel is never a drop intent. For an already-floating pane (or the minimised strip) restore the
    // exact pre-lift stage-relative position — committing the cancel position was how an interrupted drag
    // stranded the pane; a from-docked cancel falls through to dockNotes below.
    if (cancelled && !d.fromDocked) {
      pane.style.left = d.preL; pane.style.top = d.preT;
      clampNotes(); // the stage may have changed size mid-drag — the restored spot must stay reachable
      if (d.collapsed) { suppressExpand = true; return; }
      els.splitter.hidden = true; // still floating — keep the docked splitter hidden
      return;
    }
    if (d.collapsed) {
      // Reposition the minimised strip ONLY — keep it collapsed and content-sized. floatNotes with no
      // w/h sets just left/top (stage-relative), then clampNotes' collapsed branch keeps the whole pill
      // inside the frame. The trailing click must not also expand it.
      suppressExpand = true;
      const sr = stageEl.getBoundingClientRect();
      floatNotes(d.fx - sr.left, d.fy - sr.top);
      relayoutSketches();
      savePrefs();
      return;
    }
    // Drag-to-dock only applies to a pane LIFTED FROM DOCKED; an already-floating pane
    // repositions freely (dock it via the Float/Dock button or double-clicking the header).
    // `ev` is null on the missed-release path (pointermove saw buttons===0), so fall back to the last clientY
    // the drag loop cached — reading ev.clientY unguarded would throw exactly on the drop we just fixed.
    const dropY = ev ? ev.clientY : d.cy;
    const dock = cancelled ? d.fromDocked : (d.fromDocked && dropY != null && overDockZone(dropY));
    if (dock) {
      dockNotes();
    } else {
      const sr = stageEl.getBoundingClientRect();
      // Cap the footprint ONLY when the pane is being lifted out of the docked row — that row is full-width, so
      // floating it at its docked size would fill the frame. An ALREADY-FLOATING pane keeps whatever size the
      // student resized it to: capping unconditionally shrank a deliberately-large pane to 420x360 on every
      // single drag, and clampNotes then wrote the reduced size back inline so it compounded drag after drag.
      // (In the PL overlay the pane floats from boot and is never docked, so this path was ALWAYS the wrong one.)
      const w = d.fromDocked ? Math.min(d.w, 420) : d.w, h = d.fromDocked ? Math.min(d.h, 360) : d.h;
      // Pass the RAW drop point; floatNotes -> clampNotes applies the relaxed (hang-off-edge) clamp, so the
      // pane stays where it was dropped instead of snapping fully back inside.
      floatNotes(d.fx - sr.left, d.fy - sr.top, w, h);
    }
    relayoutSketches();
    savePrefs();
  };
  header.addEventListener("pointerup", (ev) => { if (drag && ev.pointerId === drag.id) endDrag(ev, false); });
  header.addEventListener("pointercancel", (ev) => { if (drag && ev.pointerId === drag.id) endDrag(null, true); });

  // ---- bottom-right resize handle (floating only) ----
  let rz = null, rraf = 0;
  resizeH.addEventListener("pointerdown", (ev) => {
    if (rz) return; // one resize at a time — a second contact must not reassign it
    // Cache the stage rect + pane offset ONCE — they don't change during the drag. Reading
    // stageEl.getBoundingClientRect() every pointermove forced a full synchronous layout of the iframe
    // (with the live question behind it) each frame — the resize lag.
    rz = { id: ev.pointerId, sx: ev.clientX, sy: ev.clientY, sw: pane.offsetWidth, sh: pane.offsetHeight,
           sr: stageEl.getBoundingClientRect(),
           left: parseFloat(pane.style.left) || 0, top: parseFloat(pane.style.top) || 0 };
    try { resizeH.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    ev.preventDefault();
    ev.stopPropagation();
  });
  resizeH.addEventListener("pointermove", (ev) => {
    if (!rz || ev.pointerId !== rz.id) return; // only the owning contact drives the resize
    if (!(ev.buttons & 1)) return endResize(); // press ended unseen — finish the resize, don't chase
    // Cap the MIN floor at what the card can actually fit: on a narrow/short stage the available width
    // (sr.width - left - 4) can be < MIN_W, and a fixed floor would pin the pane past the card edge —
    // dragging the grip off-screen, then snapping back on release. Never let the floor exceed the max.
    const maxW = rz.sr.width - rz.left - 4, maxH = rz.sr.height - rz.top - 4;
    const w = clamp(rz.sw + (ev.clientX - rz.sx), Math.min(MIN_W, maxW), maxW);
    const h = clamp(rz.sh + (ev.clientY - rz.sy), Math.min(MIN_H, maxH), maxH);
    if (!rraf) rraf = requestAnimationFrame(() => {
      rraf = 0;
      pane.style.width = `${w}px`;   // cheap style writes only; the sketch relayout happens once on release
      pane.style.height = `${h}px`;
    });
  });
  const endResize = () => {
    if (!rz) return;
    rz = null;
    if (rraf) { cancelAnimationFrame(rraf); rraf = 0; }
    clampNotes(); // reconcile against the LIVE stage — if it grew/shrank mid-drag the cached rect was stale
    relayoutSketches();
    savePrefs();
  };
  resizeH.addEventListener("pointerup", (ev) => { if (rz && ev.pointerId === rz.id) endResize(); });
  resizeH.addEventListener("pointercancel", (ev) => { if (rz && ev.pointerId === rz.id) endResize(); });

  // ---- dock/float toggle button + double-click the header to dock ----
  dockBtn.addEventListener("click", () => {
    if (overlay()) {
      setNotesCollapsed(!isNotesCollapsed()); // minimise to a strip / expand — never a full hide
      relayoutSketches();
      savePrefs();
      return;
    } else if (isNotesFloating()) {
      dockNotes();
    } else {
      const sr = stageEl.getBoundingClientRect();
      const w = 340, h = 320;
      floatNotes((sr.width - w) / 2, 48, w, h);
    }
    relayoutSketches();
    savePrefs();
  });
  // Click the collapsed strip itself (anywhere but the grip/buttons) to expand — so it's obvious how
  // to get the notes back. Double-click the expanded header (non-overlay) still docks.
  pane.querySelector("header").addEventListener("click", (ev) => {
    if (suppressExpand) { suppressExpand = false; return; } // this click ended a strip-drag — don't expand
    if (!overlay() || !isNotesCollapsed()) return;
    if (ev.target.closest("button") || ev.target.closest(".notes-grip")) return;
    setNotesCollapsed(false);
    relayoutSketches();
    savePrefs();
  });
  pane.querySelector("header").addEventListener("dblclick", (ev) => {
    if (overlay() || ev.target.closest("button") || !isNotesFloating()) return;
    dockNotes();
    relayoutSketches();
    savePrefs();
  });

  window.addEventListener("resize", () => { clampNotes(); relayoutSketches(); });

  // A tab switch / OS overlay can swallow the pointerup — cancel so no zombie survives (drag
  // restores its pre-lift position; a resize commits where it is). On BLUR only, keep a gesture
  // whose element still HOLDS pointer capture: in the overlay the "window" is the iframe, so any
  // tap on the parent PL page blurs it while a captured drag keeps receiving events just fine.
  // On BLUR: never kill a LIFTED drag or an in-flight resize. In the overlay the "window" is the iframe, so
  // dragging the pane toward/past the frame edge blurs us mid-gesture; the old capture check then cancelled a
  // live drag and restored the pre-lift spot — the "drag it half off, it snaps back, drag again and it sticks"
  // bug. Real tab switches still cancel via visibilitychange (fromBlur === false).
  // A LIFTED drag now COMMITS on a real tab switch rather than reverting: the student moved the pane on purpose
  // and the drop position is band-clamped (so always reachable), whereas silently undoing it is the loss the
  // v167 blur fix was about. Only a never-lifted press is ever cancelled. Matches floating-panel.js.
  const cancelGestures = (fromBlur) => {
    if (drag && !(fromBlur && drag.lifted)) endDrag(null, !drag.lifted);
    if (rz && !fromBlur) endResize();
  };
  window.addEventListener("blur", () => cancelGestures(true));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") cancelGestures(false); });

  // Release backstop — same reasoning as floating-panel.js: a pointerup only reaches `header` while pointer
  // capture holds, and in the overlay a release past the iframe edge is dispatched in the PARENT document. Without
  // this the release is lost and the next stray pointermove decides the gesture. endDrag/endResize null their
  // state on entry, so a doubled-up release is a no-op.
  const backstopUp = (ev) => {
    if (drag && ev.pointerId === drag.id) endDrag(null, false);
    else if (rz && ev.pointerId === rz.id) endResize();
  };
  // LEAK-1 companion: a genuine pointercancel must also be heard when it lands in the parent realm —
  // cancel (restore) for a drag, commit-where-it-is for a resize, mirroring floating-panel's backstops.
  const backstopCancel = (ev) => {
    if (drag && ev.pointerId === drag.id) endDrag(null, true);
    else if (rz && ev.pointerId === rz.id) endResize();
  };
  document.addEventListener("pointerup", backstopUp, true); // the pane never leaves this realm — own doc is enough here
  document.addEventListener("pointercancel", backstopCancel, true);
  let parentDoc = null;
  try {
    const p = window.parent;
    if (p && p !== window && p.document) {
      parentDoc = p.document;
      parentDoc.addEventListener("pointerup", backstopUp, true);
      parentDoc.addEventListener("pointercancel", backstopCancel, true);
    }
  } catch { /* cross-origin parent — own-document backstop is the best bound we have */ }
  // LEAK-1 (audit, medium — land BEFORE any srcdoc re-parse machinery): the PARENT-document listeners above
  // outlive this iframe realm on every srcdoc swap, pinning the dead realm (wasm heap included) via their
  // closures. Same disease floating-panel fixed in v170 (review N-1); the dispose half was missed here in
  // that very release. Torn down on pagehide — which fires on parent-driven srcdoc re-parses too.
  window.addEventListener("pagehide", () => {
    if (!parentDoc) return;
    try {
      parentDoc.removeEventListener("pointerup", backstopUp, true);
      parentDoc.removeEventListener("pointercancel", backstopCancel, true);
    } catch { /* parent gone first — nothing to unpin */ }
  }, { once: true });
}
