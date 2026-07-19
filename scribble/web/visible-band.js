// visible-band.js — the VISIBLE BAND of a (possibly question-tall) overlay iframe, and the ONE
// half-off-but-recoverable clamp every floating panel uses. The overlay chrome (#rail, #notes-pane)
// is position:fixed/absolute inside an iframe whose height is the WHOLE question (measured ~1208px),
// so "in bounds" against innerHeight can still be far below the browser fold — the panel opens or
// drops off-screen and its drag handle goes with it (unrecoverable). Everything here bounds against
// the part of the iframe the user can actually see. Bump this module's ?v= import with APP_VERSION.

export const GRAB = 56; // px of the drag handle kept inside the band on every edge (>= a 44px touch target)
export const MARGIN = 4; // inset from the band edges (matches the retired strict-4px overlay margins)
// clamp with lo>hi collapsing to lo — a band narrower than the panel pins its near (grabbable) edge in view.
const clamp = (v, lo, hi) => Math.max(lo, Math.min(Math.max(lo, hi), v));

// The RAW visible band in `win`-fixed coords (NO margin — clampIntoBand applies MARGIN, and callers like
// dodgeEl read raw top/bottom). Keyed on `win`, it auto-degenerates so callers need no branching:
//   standalone (frameElement === null) & reparented (win = window.parent) -> the whole viewport (today's behaviour)
//   iframe realm (win = window, question-tall)                            -> the real on-screen band
export function visibleBand(win = window) {
  let top = 0, bottom = win.innerHeight, left = 0, right = win.innerWidth;
  try {
    const fr = win.frameElement && win.frameElement.getBoundingClientRect(); // iframe box in the parent viewport
    const pvh = win.parent && win.parent.innerHeight, pvw = win.parent && win.parent.innerWidth;
    if (fr && pvh && pvw) {
      top = Math.max(0, -fr.top);
      bottom = Math.min(win.innerHeight, pvh - fr.top);
      left = Math.max(0, -fr.left);
      right = Math.min(win.innerWidth, pvw - fr.left);
    }
  } catch { /* cross-origin parent — the whole box is the best bound we have */ }
  if (bottom - top < 120) { top = 0; bottom = win.innerHeight; } // degenerate sliver -> fall back to the whole box
  if (right - left < 120) { left = 0; right = win.innerWidth; } // (the iframe is full-width in practice; guard anyway)
  return { top, bottom, left, right };
}

// THE single clamp — used by the rail engine AND the notes pane, for BOTH collapsed and full (they differ
// only in the measured w/h/handleH passed in), so the edge rules can never diverge (R2). A panel of size
// (w,h) whose grabbable handle is the TOP strip (full width, height handleH) may hang off ANY edge, but at
// least gx px of its width and gy px of its handle stay in-band, so it can always be dragged back (R3).
// One formula for all four edges:
//   left/right : may hang off until gx px of WIDTH remain in-band.
//   bottom     : may hang off until gy px of the HANDLE remain above the fold.
//   top        : because the handle IS the top strip and GRAB(56) >= every header height, gy = handleH, so
//                top_min = by0 — the handle can NEVER cross above the top fold (this is R1's "open at band top").
// (`h`, the panel's full height, is intentionally unused — the handle is top-anchored, so only w and handleH
// bound the clamp. It's kept in the signature so call sites read as (position, full-size, handle-size, band).)
export function clampIntoBand(left, top, w, h, handleH, band, { grab = GRAB, m = MARGIN } = {}) {
  const gx = Math.min(grab, w), gy = Math.min(grab, handleH);
  const bx0 = band.left + m, bx1 = band.right - m, by0 = band.top + m, by1 = band.bottom - m;
  return {
    left: clamp(left, bx0 - (w - gx), bx1 - gx),
    top: clamp(top, by0 - (handleH - gy), by1 - gy),
  };
}
