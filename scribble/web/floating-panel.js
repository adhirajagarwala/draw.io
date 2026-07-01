// floating-panel.js — viewport-fixed grip-drag + collapse for OVERLAY chrome
// (#rail, #topbar). Distinct from colorbar.js / notes-dock.js, which float
// STAGE-RELATIVE inside #stage and carry dock-zone logic. These overlay panels
// are already position:fixed in body.overlay; this engine lifts them IN PLACE
// (no reparent, no jump), tracks the cursor, drops them clamped to the VIEWPORT,
// and toggles a collapsed state. Bump this module's ?v= import with APP_VERSION.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(Math.max(lo, hi), v));
const DRAG_SLOP = 4; // px before a lift commits — a press-without-move is a no-op

// Keep a moved panel on-screen after a window/iframe resize. Clamp to the
// VIEWPORT (the panel is position:fixed), NOT a stage rect. Skip mid-drag
// (style.left/top are live) and when it was never moved.
export function clampFixed(el) {
  if (!el.classList.contains("fp-moved") || el.classList.contains("fp-dragging")) return;
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.round(clamp(parseFloat(el.style.left) || 0, 4, innerWidth - r.width - 4))}px`;
  el.style.top = `${Math.round(clamp(parseFloat(el.style.top) || 0, 4, innerHeight - r.height - 4))}px`;
}

// el          : the panel (#rail / #topbar). Already position:fixed in body.overlay.
// opts.grip   : the ⠿ drag handle — the ONLY pointerdown target, so tool/action
//               button clicks never start a drag. REQUIRED.
// opts.collapse : the collapse/restore toggle button.
// opts.onChange : savePrefs-style callback after any committed move/collapse.
export function makeFloating(el, { grip, collapse, onChange }) {
  let drag = null, raf = 0;

  grip.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || ev.target.closest("button")) return; // right/middle + any button never lift
    const r = el.getBoundingClientRect();
    // Defer the lift until the pointer passes DRAG_SLOP, so a click-without-move
    // on the grip never re-pins the panel (click ≠ drag).
    drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top, fx: r.left, fy: r.top,
             sx: ev.clientX, sy: ev.clientY, lifted: false };
    try { grip.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
    ev.preventDefault();
  });

  grip.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    if (!drag.lifted) {
      if (Math.abs(ev.clientX - drag.sx) < DRAG_SLOP &&
          Math.abs(ev.clientY - drag.sy) < DRAG_SLOP) return; // below threshold — not a drag yet
      drag.lifted = true;
      const r = el.getBoundingClientRect();
      // fp-moved drops the CSS top/left pin; lift in place (no reparent, no jump).
      el.classList.add("fp-moved", "fp-dragging");
      el.style.left = `${Math.round(r.left)}px`;
      el.style.top = `${Math.round(r.top)}px`;
    }
    drag.fx = ev.clientX - drag.dx;
    drag.fy = ev.clientY - drag.dy;
    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0;
      el.style.left = `${Math.round(drag.fx)}px`;
      el.style.top = `${Math.round(drag.fy)}px`;
    });
  });

  const end = () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (!d.lifted) return;            // a pure click/press on the grip — nothing moved
    el.classList.remove("fp-dragging");
    clampFixed(el);                   // clamp the drop into the viewport
    onChange?.();
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);

  if (collapse) collapse.addEventListener("click", () => {
    const on = !el.classList.contains("fp-collapsed");
    el.classList.toggle("fp-collapsed", on);
    collapse.setAttribute("aria-expanded", String(!on));
    collapse.title = on ? "Show" : "Hide";
    onChange?.();
  });

  return {
    floatTo(left, top) { el.classList.add("fp-moved"); el.style.left = `${Math.round(left)}px`; el.style.top = `${Math.round(top)}px`; },
    setCollapsed(o) { el.classList.toggle("fp-collapsed", o); if (collapse) collapse.setAttribute("aria-expanded", String(!o)); },
    isCollapsed: () => el.classList.contains("fp-collapsed"),
    isMoved: () => el.classList.contains("fp-moved"),
  };
}
