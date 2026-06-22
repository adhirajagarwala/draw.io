// Scribble — the movable / collapsible / dockable colour bar: the grip-drag
// engine, the dock-into-toolbar logic, and the resize handle. It holds no app
// state of its own — initColorBar() injects the few app handles it needs (els,
// $, status, savePrefs) and wires the listeners, and app.js calls the exported
// dockCbar / isCbarDocked / clampContextBar / setCbarCollapsed back from its
// prefs, resize and tool-visibility code. Bump this module's ?v= import in
// app.js together with APP_VERSION.

let els, $, status, savePrefs, topbarEl;

function setCbarCollapsed(on) {
  els.contextBar.classList.toggle("collapsed", on);
  const btn = $("cbar-collapse");
  btn.setAttribute("aria-expanded", String(!on));
  btn.title = on ? "Show the colour bar" : "Hide the colour bar";
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
  const cb = els.contextBar;
  if (cb.hidden) return;
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

// Inject the app handles and wire the grip-drag, resize handle, collapse button
// and window-resize listener. Call once at startup, then use the exports above.
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
  const overTopbar = (y) => y <= topbarEl.getBoundingClientRect().bottom + 6;
  grip.addEventListener("pointerdown", (ev) => {
    const br = cb.getBoundingClientRect();
    // Lift in place: go fixed at the current on-screen spot, then follow the cursor.
    drag = { dx: ev.clientX - br.left, dy: ev.clientY - br.top, fx: br.left, fy: br.top };
    cb.classList.add("cbar-dragging");
    cb.style.left = `${Math.round(br.left)}px`;
    cb.style.top = `${Math.round(br.top)}px`;
    grip.setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
  });
  grip.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    drag.fx = ev.clientX - drag.dx;
    drag.fy = ev.clientY - drag.dy;
    cb.style.left = `${Math.round(drag.fx)}px`;
    cb.style.top = `${Math.round(drag.fy)}px`;
    topbarEl.classList.toggle("cbar-drop", overTopbar(ev.clientY));
  });
  const endDrag = (ev) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    cb.classList.remove("cbar-dragging");
    topbarEl.classList.remove("cbar-drop");
    const wantsDock = ev ? overTopbar(ev.clientY) : isCbarDocked();
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
  grip.addEventListener("pointerup", endDrag);
  grip.addEventListener("pointercancel", endDrag);

  // Resize the bar width (content scrolls horizontally within it).
  const resize = cb.querySelector(".cbar-resize");
  let rz = null;
  resize.addEventListener("pointerdown", (ev) => {
    rz = { x: ev.clientX, w: cb.getBoundingClientRect().width };
    resize.setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
  });
  resize.addEventListener("pointermove", (ev) => {
    if (!rz) return;
    cb.style.width = `${Math.max(120, Math.round(rz.w + (ev.clientX - rz.x)))}px`;
  });
  const endRz = () => { if (rz) { rz = null; savePrefs(); } };
  resize.addEventListener("pointerup", endRz);
  resize.addEventListener("pointercancel", endRz);

  window.addEventListener("resize", clampContextBar);
}

export { setCbarCollapsed, isCbarDocked, dockCbar, clampContextBar };
