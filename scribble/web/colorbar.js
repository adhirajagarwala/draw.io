// Scribble — the movable / collapsible / dockable colour bar: the grip-drag
// engine and the dock-into-toolbar logic. It holds no app
// state of its own — initColorBar() injects the few app handles it needs (els,
// $, status, savePrefs) and wires the listeners, and app.js calls the exported
// dockCbar / isCbarDocked / clampContextBar / setCbarCollapsed back from its
// prefs, resize and tool-visibility code. Bump this module's ?v= import in
// app.js together with APP_VERSION.

let els, $, status, savePrefs, topbarEl;

function setCbarCollapsed(on) {
  els.contextBar.classList.toggle("collapsed", on);
  const btn = $("cbar-collapse");
  const t = on ? "Show the colour bar" : "Hide the colour bar";
  btn.setAttribute("aria-expanded", String(!on));
  btn.title = t;
  btn.setAttribute("aria-label", t); // keep the accessible name in sync (aria-label wins over title)
}

function isCbarDocked() { return document.body.classList.contains("cbar-docked"); }

// The free horizontal zone for a docked bar's LEFT edge: between the Open button
// and the right-hand controls. `fits` is false when the gap is narrower than the
// bar — docking there would overlap the toolbar's own buttons.
function dockZone() {
  const bw = els.contextBar.offsetWidth || 220;
  const tr = topbarEl.getBoundingClientRect();
  const openEl = $("btn-open");
  const rightEl = topbarEl.querySelector(".topbar-right");
  const GAP = 8;
  const lo = openEl ? openEl.getBoundingClientRect().right - tr.left + GAP : 4;
  const hi = rightEl ? rightEl.getBoundingClientRect().left - tr.left - bw - GAP
                     : tr.width - bw - 4;
  return { lo, hi, fits: hi >= lo };
}
function clampDockLeft(left) {
  const { lo, hi } = dockZone();
  return Math.max(lo, Math.min(Math.max(lo, hi), left));
}
function dockCbar(left) {
  // Refuse to dock when the toolbar gap is too narrow — floating beats covering
  // the Save/Resume/Export buttons. Returns whether it actually docked.
  if (!dockZone().fits) {
    floatCbar(12, 10);
    return false;
  }
  const cb = els.contextBar;
  if (cb.parentElement !== topbarEl) topbarEl.appendChild(cb);
  document.body.classList.add("cbar-docked");
  cb.classList.remove("moved");
  cb.style.top = ""; // vertical centring is handled in CSS
  cb.style.left = `${Math.round(clampDockLeft(left))}px`;
  return true;
}
function floatCbar(left, top) {
  const cb = els.contextBar;
  const stage = $("stage");
  if (cb.parentElement !== stage) stage.appendChild(cb);
  document.body.classList.remove("cbar-docked");
  cb.classList.add("moved");
  cb.style.left = `${Math.round(left)}px`;
  cb.style.top = `${Math.round(top)}px`;
}

// Keep a dragged colour bar on-screen when the window/stage resizes.
function clampContextBar() {
  // Overlay mode floats the bar viewport-fixed; the stage-relative clamp below would mis-measure
  // and fling it on resize, so leave it where the user dropped it.
  if (document.body.classList.contains("overlay")) return;
  const cb = els.contextBar;
  // Skip while mid-lift: the bar is position:fixed then, so style.left/top are
  // viewport coords — clamping them against stage bounds would jump it.
  if (cb.hidden || cb.classList.contains("cbar-dragging")) return;
  if (isCbarDocked()) {
    // On resize: if the toolbar gap can no longer fit the bar, float it rather
    // than let it overlap the buttons; otherwise re-pin within the gap.
    if (!dockZone().fits) { floatCbar(12, 10); return; }
    cb.style.left = `${Math.round(clampDockLeft(parseFloat(cb.style.left) || 0))}px`;
    return;
  }
  if (!cb.classList.contains("moved")) return;
  const stage = cb.offsetParent || cb.parentElement;
  const sr = stage.getBoundingClientRect();
  const br = cb.getBoundingClientRect();
  const left = Math.max(4, Math.min(sr.width - br.width - 4, parseFloat(cb.style.left) || 0));
  const top = Math.max(4, Math.min(sr.height - br.height - 4, parseFloat(cb.style.top) || 0));
  cb.style.left = `${Math.round(left)}px`;
  cb.style.top = `${Math.round(top)}px`;
}

// Inject the app handles and wire the grip-drag, collapse button and window-resize
// listener. Call once at startup, then use the exports above.
export function initColorBar(deps) {
  ({ els, $, status, savePrefs } = deps);
  topbarEl = $("topbar");

  $("cbar-collapse").addEventListener("click", () => {
    setCbarCollapsed(!els.contextBar.classList.contains("collapsed"));
    savePrefs();
  });

  // Drag the bar by its grip. While dragging it's position:fixed and simply tracks
  // the cursor — no reparenting mid-drag, so there are no jumps. On release it
  // docks into the toolbar at the drop's horizontal spot (drag it along the bar to
  // reposition), or floats over the page.
  const cb = els.contextBar;
  const grip = cb.querySelector(".cbar-grip");
  let drag = null;
  const DRAG_SLOP = 4; // px before the lift commits — a plain click on the grip must not run a dock/float commit
  const clampv = (v, lo, hi) => Math.max(lo, Math.min(Math.max(lo, hi), v));
  const overTopbar = (y) => y <= topbarEl.getBoundingClientRect().bottom + 6;
  grip.addEventListener("pointerdown", (ev) => {
    if (drag || ev.button !== 0) return; // one drag at a time; right/middle would open the context menu mid-lift
    const br = cb.getBoundingClientRect();
    // Capture FIRST (it can throw if the pointer is already gone — then we never lift and nothing
    // strands mid-flight), and defer the actual lift until the pointer passes DRAG_SLOP. `pre`
    // snapshots the full pre-lift state so a cancelled drag restores it exactly (mode AND position).
    try { grip.setPointerCapture(ev.pointerId); } catch { return; }
    drag = { id: ev.pointerId, dx: ev.clientX - br.left, dy: ev.clientY - br.top, fx: br.left, fy: br.top,
             br, sx: ev.clientX, sy: ev.clientY, lifted: false,
             pre: { docked: isCbarDocked(), moved: cb.classList.contains("moved"),
                    left: cb.style.left, top: cb.style.top } };
    ev.preventDefault();
  });
  grip.addEventListener("pointermove", (ev) => {
    if (!drag || ev.pointerId !== drag.id) return; // only the owning contact drives the drag
    if (!(ev.buttons & 1)) return endDrag(null); // press ended unseen — restore, don't chase the pointer
    if (!drag.lifted) {
      if (Math.abs(ev.clientX - drag.sx) < DRAG_SLOP && Math.abs(ev.clientY - drag.sy) < DRAG_SLOP) return;
      drag.lifted = true;
      // Lift in place: go fixed at the current on-screen spot, then follow the cursor.
      cb.classList.add("cbar-dragging");
      cb.style.left = `${Math.round(drag.br.left)}px`;
      cb.style.top = `${Math.round(drag.br.top)}px`;
    }
    drag.fx = ev.clientX - drag.dx;
    drag.fy = ev.clientY - drag.dy;
    // Live clamp of the APPLIED values only (viewport coords while lifted) — the bar stays reachable
    // even mid-drag; the grab offset re-attaches when the pointer returns from past the edge.
    cb.style.left = `${Math.round(clampv(drag.fx, 4, window.innerWidth - cb.offsetWidth - 4))}px`;
    cb.style.top = `${Math.round(clampv(drag.fy, 4, window.innerHeight - cb.offsetHeight - 4))}px`;
    topbarEl.classList.toggle("cbar-drop", overTopbar(ev.clientY));
  });
  const endDrag = (ev) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.lifted) return; // a plain click on the grip — nothing lifted, nothing to commit
    cb.classList.remove("cbar-dragging");
    topbarEl.classList.remove("cbar-drop");
    if (!ev) {
      // A cancel (pointercancel / swallowed up) is not a drop intent — restore the exact pre-lift
      // state: mode AND position. No savePrefs, no "not enough room" toast for a mere tab switch.
      if (d.pre.docked) dockCbar(parseFloat(d.pre.left) || 12);
      else if (d.pre.moved) floatCbar(parseFloat(d.pre.left) || 12, parseFloat(d.pre.top) || 10);
      else { cb.classList.remove("moved"); cb.style.left = d.pre.left; cb.style.top = d.pre.top; }
      return;
    }
    const wantsDock = overTopbar(ev.clientY);
    if (wantsDock && dockZone().fits) {
      dockCbar(d.fx - topbarEl.getBoundingClientRect().left);
    } else {
      const sr = $("stage").getBoundingClientRect();
      floatCbar(
        Math.max(4, Math.min(sr.width - cb.offsetWidth - 4, d.fx - sr.left)),
        Math.max(4, Math.min(sr.height - cb.offsetHeight - 4, d.fy - sr.top)),
      );
      if (wantsDock) status("Not enough room to dock — widen the window. Kept it floating.");
    }
    savePrefs();
  };
  grip.addEventListener("pointerup", (ev) => { if (drag && ev.pointerId === drag.id) endDrag(ev); });
  // A pointercancel is not a drop — pass no event so endDrag restores the pre-lift state.
  grip.addEventListener("pointercancel", (ev) => { if (drag && ev.pointerId === drag.id) endDrag(null); });
  // A tab switch / OS overlay can swallow the pointerup. On BLUR only, keep a drag whose grip still
  // HOLDS pointer capture (focus changes don't interrupt captured delivery); visibility:hidden is a
  // real tab switch and cancels unconditionally.
  window.addEventListener("blur", () => { if (drag && !grip.hasPointerCapture?.(drag.id)) endDrag(null); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") endDrag(null); });

  window.addEventListener("resize", clampContextBar);
}

export { setCbarCollapsed, isCbarDocked, dockCbar, clampContextBar };
