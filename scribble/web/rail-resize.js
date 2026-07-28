// rail-resize.js — user-set width for the OVERLAY toolbar (#rail).
//
// The width lives in the CSS custom property --rail-w, NEVER style.width. That is load-bearing: the drag engine
// clears the width LONGHAND on every lift (floating-panel.js, review fix R-3) and restores it on cancel, so an
// inline width would be wiped the first time the student moved the bar. A custom property is a different
// declaration and survives untouched — a resized bar keeps its width across drags, cancels, and collapse/expand
// with ZERO edits to the drag engine. The handle is a <button>, so DRAG_EXCLUDE already stops a resize gesture
// from LIFTING the bar. Bump this module's ?v= import with APP_VERSION.

import { visibleBand } from "./visible-band.js?v=188";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(Math.max(lo, hi), v));

// el      : #rail (position:fixed, its own containing block)
// handle  : the .fp-resize <button> strip on the bar's right edge
// getMinW : () => px, the narrowest useful bar (shell chrome + one group); below that, collapse instead
// onLive  : called after every width write (re-fit the overflow, re-push the notes clearance)
// onChange: called once per committed gesture (savePrefs + calc-dodge nudge)
// announce: (text) => void, routed to the #status aria-live region — DEBOUNCED here, never per frame
export function makeResizable(el, { handle, win = window, getMinW, onLive, onChange, announce }) {
  // review F2: the FLOOR yields to the screen, never the reverse. The v171 floor (shell + Draw + Select via
  // coreWidth, larger under .big) can exceed a narrow viewport — and the old Math.max(minW, band) then made
  // maxW equal minW, so ANY handle gesture forced the bar WIDER than the screen (More/collapse/handle pushed
  // off-viewport) and persisted that width. Cap the floor at the band instead: the bar tops out at the screen
  // and the protected core scrolls within (.rail-scroll's overflow-x carries it — same rule as the demote
  // guard's "only the un-demotable remain" case).
  const bandW = () => { const b = visibleBand(win); return Math.max(160, b.right - b.left - 8); };
  // v177 A4: the card cap (--rail-max, set by alignRailToCard) must bound the GESTURE too — without it the
  // handle had a dead zone past the card edge, announced widths the CSS min() never rendered, and persisted
  // the lie. Falls back to the band when unset (moved bars / non-reparented modes).
  const railMax = () => parseFloat(el.style.getPropertyValue("--rail-max")) || Infinity;
  const minW = () => Math.min(Math.max(160, (getMinW && getMinW()) || 240), bandW(), railMax());
  const maxW = () => Math.max(minW(), Math.min(bandW(), railMax()));
  const getWidth = () => parseFloat(el.style.getPropertyValue("--rail-w")) || 0; // 0 => unset (full span)

  let sayTimer = 0;
  const sayLater = (txt) => {
    if (!announce) return;
    clearTimeout(sayTimer);
    sayTimer = setTimeout(() => announce(txt), 300);
  };

  function syncAria() {
    if (!handle) return;
    const w = getWidth(), mx = maxW();
    handle.setAttribute("aria-valuenow", String(w ? Math.round(clamp(w / mx, 0, 1) * 100) : 100));
    handle.setAttribute("aria-valuetext", w ? `${Math.round(w)} pixels` : "Full width");
  }

  // THE only writer of bar width. null/non-finite => remove the property (back to the CSS full-span default).
  function setWidth(px) {
    if (px == null || !Number.isFinite(px)) {
      el.style.removeProperty("--rail-w"); el.style.removeProperty("--rail-w-mode");
    } else {
      el.style.setProperty("--rail-w", `${Math.round(clamp(px, minW(), maxW()))}px`);
      // GEOM-1 (audit): a card-aligned DEFAULT bar carries an inline style.width; the cap channel is
      // width:max-content + max-width:--rail-w, which an inline longhand overrides — the bar then never
      // content-shrinks. Clear it whenever a cap is applied (the drag-lift does the same, review R-3).
      el.style.width = "";
      // The chosen width is a CAP: the bar sizes to its content and stops there, so a bar whose tools have moved
      // into More shrinks tight rather than leaving an empty gap between the last tool and the actions.
      el.style.setProperty("--rail-w-mode", "max-content");
    }
    syncAria();
    onLive?.();
  }

  // ---- pointer drag ----
  let drag = null, raf = 0;
  handle?.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const r = el.getBoundingClientRect();      // read ONCE — the live loop is write-only (CLAUDE.md §10)
    drag = { id: ev.pointerId, left: r.left, grabDx: r.right - ev.clientX };
    el.classList.add("rail-resizing"); // v177: freezes re-centering for the duration of the gesture
    try { handle.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
    ev.preventDefault(); ev.stopPropagation(); // never let the bar's own pointerdown see this
  });
  handle?.addEventListener("pointermove", (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    if (!(ev.buttons & 1)) return end();       // the press ended somewhere we never heard about
    const w = ev.clientX - drag.left + drag.grabDx;
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; setWidth(w); });
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    el.classList.remove("rail-resizing");
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    onChange?.();
    sayLater(getWidth() ? `Toolbar ${Math.round(getWidth())} pixels wide` : "Toolbar full width");
  };
  handle?.addEventListener("pointerup", end);
  handle?.addEventListener("pointercancel", end);
  handle?.addEventListener("dblclick", (ev) => {
    ev.preventDefault();
    setWidth(null); onChange?.(); sayLater("Toolbar full width");
  });

  // ---- keyboard: the handle is focusable, so width is reachable without a pointer ----
  handle?.addEventListener("keydown", (ev) => {
    const cur = getWidth() || maxW();
    const step = ev.shiftKey ? 64 : 16;
    if (ev.key === "ArrowLeft") setWidth(cur - step);
    else if (ev.key === "ArrowRight") setWidth(cur + step);
    else if (ev.key === "Home") setWidth(minW());
    else if (ev.key === "End") setWidth(null);
    else return;
    ev.preventDefault();
    onChange?.();
    sayLater(getWidth() ? `Toolbar ${Math.round(getWidth())} pixels wide` : "Toolbar full width");
  });

  syncAria();
  return { setWidth, getWidth, maxW, syncAria };
}
