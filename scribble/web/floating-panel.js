// floating-panel.js — viewport-fixed grip-drag + collapse for OVERLAY chrome
// (#rail, #topbar). Distinct from colorbar.js / notes-dock.js, which float
// STAGE-RELATIVE inside #stage and carry dock-zone logic. These overlay panels
// are already position:fixed in body.overlay; this engine lifts them IN PLACE
// (no reparent, no jump), tracks the cursor, drops them clamped to the VIEWPORT,
// and toggles a collapsed state. Bump this module's ?v= import with APP_VERSION.

import { visibleBand, clampIntoBand, GRAB } from "./visible-band.js?v=185";

const DRAG_SLOP = 4; // px before a lift commits — a press-without-move is a no-op

// Keep a moved panel on-screen after a window/iframe resize. Clamp to the
// VIEWPORT (the panel is position:fixed), NOT a stage rect. Skip mid-drag
// (style.left/top are live) and when it was never moved.
// `win` is the realm whose viewport bounds the panel: the iframe's own window by
// default, or `window.parent` once the panel is reparented into the PL page (so
// "fixed" means the REAL browser viewport, not the question-tall iframe box).
export function clampFixed(el, win = window) {
  // Skip when never-moved, mid-drag, or NOT RENDERED (display:none via the Annotate gate) — a hidden
  // element's rect is 0×0, so the clamp bound would be innerWidth-0 and under-clamp a restored position.
  if (!el.classList.contains("fp-moved") || el.classList.contains("fp-dragging") || !el.getClientRects().length) return;
  const r = el.getBoundingClientRect();
  const band = visibleBand(win); // the on-screen band (iframe realm) or the whole viewport (standalone/reparented)
  // handleH is capped at GRAB: clampIntoBand assumes the grab handle is a TOP STRIP no taller than GRAB, which
  // is what pins top_min at the band top. A WRAPPED (2-row, ~100px) bar would otherwise get top_min = by0 - 44
  // and could hide its first tool row above the fold. At today's 52px bar min(52,56)=52 — byte-identical.
  const { left, top } = clampIntoBand(parseFloat(el.style.left) || 0, parseFloat(el.style.top) || 0,
                                      r.width, r.height, Math.min(r.height, GRAB), band);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

// el          : the panel (#rail / #topbar). Already position:fixed in body.overlay.
//               The whole bar is the drag surface, minus the DRAG_EXCLUDE interactive
//               parts below (the ⠿ grip is a visual affordance only).
// opts.collapse : the collapse/restore toggle button.
// opts.onChange : savePrefs-style callback after any committed move/collapse.
// Interactive parts that a pointerdown must NOT turn into a drag (tool/action buttons, the colour+width bar,
// links, form fields, open popovers). Everything ELSE on the panel — grip, labels, gaps, background — drags
// the WHOLE bar.
const DRAG_EXCLUDE = "button, input, select, textarea, a, #context-bar, [contenteditable], [role=button], #more-popover, #about-popover";

// opts.win : the realm whose viewport the drop-clamp measures against — the iframe's
//            own window by default, or `window.parent` when `el` is reparented into the
//            PL page (so a dropped bar is clamped to the REAL screen, not the tall iframe).
export function makeFloating(el, { collapse, onChange, onSettle, win = window }) {
  let drag = null, raf = 0;

  el.addEventListener("pointerdown", (ev) => {
    // Stale-gesture reset: if a previous drag lost its pointerup (OS overlay ate it) it would otherwise block
    // every future drag, since we bail whenever `drag` is set. Only clear one we no longer hold capture for.
    if (drag && !el.hasPointerCapture?.(drag.id)) drag = null;
    if (drag || ev.button !== 0 || ev.target.closest(DRAG_EXCLUDE)) return; // one drag at a time; buttons/inputs never lift
    const r = el.getBoundingClientRect();
    // Defer the lift until the pointer passes DRAG_SLOP, so a click-without-move
    // anywhere on the bar never re-pins the panel (click ≠ drag). Record the owning
    // pointerId and the pre-lift state so a cancelled drag can restore it exactly.
    drag = { id: ev.pointerId, dx: ev.clientX - r.left, dy: ev.clientY - r.top, fx: r.left, fy: r.top,
             sx: ev.clientX, sy: ev.clientY, lifted: false,
             preMoved: el.classList.contains("fp-moved"), preL: el.style.left, preT: el.style.top, preW: el.style.width };
    try { el.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
    ev.preventDefault();
  });

  el.addEventListener("pointermove", (ev) => {
    if (!drag || ev.pointerId !== drag.id) return; // only the owning contact drives the drag
    // buttons===0 means the user ALREADY RELEASED and we missed the pointerup. A finished gesture is a DROP,
    // not a cancel — commit at the last known position. Reverting here WAS the v169 "I drag the toolbar and it
    // snaps back the minute I let go" bug: on release Chrome dispatches a trailing pointermove with buttons:0
    // BEFORE pointerup, so this guard reverted the drag and the real pointerup then found `drag` already null
    // (see the end() guard below) and did nothing. Misses are routine here, not exotic: setPointerCapture is
    // best-effort (try/catch above), the lifted bar shrinks to max-content so the cursor is often not over it,
    // and in the overlay the "window" is the IFRAME — a release past the frame edge or over the parent's Done
    // pill is dispatched in the PARENT realm. An unlifted press still no-ops (end() returns at !d.lifted).
    if (!(ev.buttons & 1)) return end(false);
    if (!drag.lifted) {
      if (Math.abs(ev.clientX - drag.sx) < DRAG_SLOP &&
          Math.abs(ev.clientY - drag.sy) < DRAG_SLOP) return; // below threshold — not a drag yet
      drag.lifted = true;
      const r = el.getBoundingClientRect();
      // fp-moved drops the CSS top/left pin; lift in place (no reparent, no jump).
      el.classList.add("fp-moved", "fp-dragging");
      // review R-3: drop any card-aligned inline width (set by alignRailToCard) so .fp-moved{width:max-content}
      // governs — else a dragged bar keeps full card width and the live clamp pins it, unrepositionable.
      el.style.width = "";
      el.style.left = `${Math.round(r.left)}px`;
      el.style.top = `${Math.round(r.top)}px`;
      // Cache the LIFTED size for the live clamp: fp-moved shrinks the bar to max-content
      // (the pre-lift rect is the full-width bar and would over-clamp left to ~4px).
      const lr = el.getBoundingClientRect();
      drag.pw = lr.width; drag.ph = lr.height;
      // Re-seat the grab offset against the LIFTED (max-content) width. dx/dy were measured on the FULL-WIDTH
      // resting bar, but fp-moved switches it to max-content — so a grab to the right of the content width left
      // the bar entirely LEFT of the cursor for the whole drag: it never tracked the pointer, and every event
      // (including the release) landed off the element, which is what made the snap-back so likely on a
      // right-side grab. Clamp rather than recentre, so a grab still over the lifted bar keeps its exact feel.
      drag.dx = Math.min(drag.dx, Math.max(0, lr.width - 8));
      drag.dy = Math.min(drag.dy, Math.max(0, lr.height - 8));
      drag.band = visibleBand(win); // cache the band at lift — a per-frame cross-realm frameElement read would thrash layout
    }
    drag.fx = ev.clientX - drag.dx;
    drag.fy = ev.clientY - drag.dy;
    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0;
      // Live clamp against the VISIBLE BAND (cached at lift — no per-frame layout flush): the bar can never be
      // dragged below the fold. Clamp only the APPLIED values (never drag.dx/dy) — sticky-edge, and the grab
      // offset re-attaches when the pointer comes back.
      const { left, top } = clampIntoBand(drag.fx, drag.fy, drag.pw, drag.ph, Math.min(drag.ph, GRAB), drag.band);
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
    });
  });

  const end = (cancelled = false) => {
    if (!drag) return;
    const d = drag; drag = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (!d.lifted) return;            // a pure click/press on the grip — nothing moved
    el.classList.remove("fp-dragging");
    if (cancelled) {
      // A cancel is not a drop intent — restore the exact pre-lift state (position or CSS pin),
      // then re-clamp: the window may have shrunk while the drag was in flight.
      el.style.width = d.preW; // review R-3: restore the pre-lift width (a card-aligned inline width, or "")
      if (d.preMoved) { el.style.left = d.preL; el.style.top = d.preT; }
      else { el.classList.remove("fp-moved"); el.style.left = ""; el.style.top = ""; }
      // Only the preMoved branch can be clamped — clampFixed early-returns on a non-fp-moved element, so the
      // reverted-to-default bar is rescued by onSettle -> restickRail below, not here. Gated so the call isn't
      // misread as protecting both branches.
      if (d.preMoved) clampFixed(el, win);
      onSettle?.(); // a cancelled FIRST drag reverts to the default (non-moved) bar — re-stick it to the band top
      return;
    }
    // FLUSH the frame we just cancelled instead of dropping it. The live loop only writes left/top inside a rAF,
    // so el.style.* lags the pointer by up to one frame — and if NO frame ran at all (a fast flick landing in one
    // coalesced input batch, or rAF starved: CLAUDE.md §6 occluded/background throttling) el.style.* is STILL the
    // pre-lift rect written at lift, i.e. the drop would commit exactly where the drag started — the snap-back
    // again, by a second route. Re-use the LIFT-cached band and the same clamp the live loop used, so the drop
    // lands where the bar was painted to be heading (never a fresh cross-realm band read here — that would
    // reintroduce the drag-time/drop-time band disagreement).
    if (d.band) {
      const { left, top } = clampIntoBand(d.fx, d.fy, d.pw, d.ph, Math.min(d.ph, GRAB), d.band);
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
    }
    clampFixed(el, win);              // clamp the drop into the (possibly parent) viewport
    onChange?.();
    onSettle?.();                     // a MOVED drop is left as-is (restickRail no-ops on fp-moved); harmless here
  };
  el.addEventListener("pointerup", (ev) => { if (drag && ev.pointerId === drag.id) end(false); });
  el.addEventListener("pointercancel", (ev) => { if (drag && ev.pointerId === drag.id) end(true); });
  // A tab switch / OS overlay can swallow the pointerup entirely. But in the overlay the "window"
  // is the iframe, so ANY tap on the parent PL page fires blur — a drag whose element still HOLDS
  // pointer capture keeps receiving events across that and must not be killed. Only cancel on blur
  // when capture is gone; visibility:hidden is a real tab switch and cancels unconditionally.
  // NEVER cancel a LIFTED drag on blur. In the overlay the "window" IS the iframe, so dragging the bar toward or
  // past the frame edge puts the pointer over the parent page and blurs us MID-GESTURE. The old capture check
  // then cancelled a perfectly live drag and restored the pre-lift position — that was the reported "drag it half
  // off, it snaps back where it came from; drag again and it sticks" bug (the 2nd drag starts with the iframe
  // already focused, so no blur fires). A genuinely swallowed pointerup is still cleaned up by visibilitychange
  // and by the stale-gesture reset in pointerdown below.
  const onWinBlur = () => { if (drag && !drag.lifted) end(true); };
  win.addEventListener("blur", onWinBlur);
  // A real tab switch. Cancel an UNLIFTED press, but COMMIT a lifted one: the student moved the bar on purpose,
  // and silently undoing that on an alt-tab is the same class of loss as the blur bug fixed in v167. Same rule
  // as onWinBlur above, so "a lifted drag always commits" holds for every exit path except pointercancel.
  const onVisChange = () => { if (drag && document.visibilityState === "hidden") end(!drag.lifted); };
  document.addEventListener("visibilitychange", onVisChange);

  // ---- release backstop (mirrors the window-level pointerup/pointercancel capture in app.js, which exists for
  // exactly this failure mode on the drawing canvas). A release only reaches `el` while pointer capture holds,
  // and capture is best-effort: setPointerCapture is wrapped in try/catch, the lifted bar is max-content so the
  // cursor is frequently off it, and the overlay's realm is the IFRAME — a release past the frame edge or over
  // the parent's Done pill (which paints ABOVE our iframe) is dispatched in the PARENT document. Without this
  // the release is silently lost and the next stray pointermove decides the gesture's fate. end() nulls `drag`
  // on entry, so a doubled-up release is a guarded no-op.
  const backstopUp = (ev) => { if (drag && ev.pointerId === drag.id) end(false); };
  const backstopCancel = (ev) => { if (drag && ev.pointerId === drag.id) end(true); };
  const backstopDocs = [];
  const addBackstop = (doc) => {
    if (!doc || backstopDocs.includes(doc)) return;
    doc.addEventListener("pointerup", backstopUp, true);
    doc.addEventListener("pointercancel", backstopCancel, true);
    backstopDocs.push(doc);
  };
  addBackstop(document);
  addBackstop(el.ownerDocument);
  try { if (win.document) addBackstop(win.document); } catch { /* cross-origin realm — element listeners only */ }
  try { const p = window.parent; if (p && p !== window && p.document) addBackstop(p.document); }
  catch { /* cross-origin parent — element + own-doc listeners are the best bound we have */ }

  // Keep title AND aria-label in sync (aria-label wins as the accessible name — a stale one makes a screen
  // reader announce "Hide" on a button that now Shows).
  const labelCollapse = (on) => {
    if (!collapse) return;
    // "Minimise", not "Hide": the bar collapses to a visible handle, it never disappears (#8).
    const t = on ? "Expand the toolbar" : "Minimise the toolbar";
    collapse.title = t;
    collapse.setAttribute("aria-label", t);
    collapse.setAttribute("aria-expanded", String(!on));
  };
  if (collapse) collapse.addEventListener("click", () => {
    const on = !el.classList.contains("fp-collapsed");
    // Keep a MOVED bar's RIGHT edge fixed across BOTH collapse and expand — the minimise button sits at the
    // far right, so anchoring the right edge means the handle stays under the cursor on collapse AND the bar
    // returns to its parked spot on expand (idempotent: left = right − newWidth). The DEFAULT (un-dragged) bar
    // gets right-anchoring from CSS (.fp-collapsed:not(.fp-moved){right:4px}); a MOVED bar keeps its own inline
    // left, so capture the current right edge here and re-apply it after the width changes.
    const preRight = el.classList.contains("fp-moved") ? el.getBoundingClientRect().right : null;
    el.classList.toggle("fp-collapsed", on);
    labelCollapse(on);
    // The bar's width jumps on collapse/expand (handle ↔ max-content); re-anchor + re-clamp at the NEW size so
    // it stays on-screen. rAF: measure after the class change lands in layout. Guard getClientRects: if the
    // Annotate gate hid the bar in the interim, a 0-width read would strand the right edge.
    requestAnimationFrame(() => {
      if (preRight != null && el.getClientRects().length) el.style.left = `${Math.round(preRight - el.getBoundingClientRect().width)}px`;
      clampFixed(el, win);
    });
    onChange?.();
  });

  return {
    floatTo(left, top) { el.classList.add("fp-moved"); el.style.left = `${Math.round(left)}px`; el.style.top = `${Math.round(top)}px`; },
    setCollapsed(o) { el.classList.toggle("fp-collapsed", o); labelCollapse(o); },
    isCollapsed: () => el.classList.contains("fp-collapsed"),
    isMoved: () => el.classList.contains("fp-moved"),
    // review N-1: teardown the parent-realm listeners on iframe swap. The visibilitychange listener was never
    // torn down (a leak that outlived every iframe swap); the backstops below live on the PARENT document, so
    // they must go the same way. Callers should invoke this on pagehide even when the rail was never reparented.
    dispose() {
      win.removeEventListener("blur", onWinBlur);
      document.removeEventListener("visibilitychange", onVisChange);
      for (const doc of backstopDocs) {
        doc.removeEventListener("pointerup", backstopUp, true);
        doc.removeEventListener("pointercancel", backstopCancel, true);
      }
      backstopDocs.length = 0;
    },
  };
}
