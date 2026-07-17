// calc-dodge.js — stop the transparent overlay iframe from eating clicks meant for
// PrairieLearn's Calculator drawer (and stop our ink painting over it).
//
// Mechanism: punch a CSS `clip-path` evenodd-polygon HOLE in the overlay <iframe>
// element wherever the calculator panel overlaps it. clip-path removes both PAINT and
// HIT-TESTING for the clipped region, independent of stacking contexts — clicks fall
// through to the calculator; previously-drawn ink stops painting over it. Verified live
// on hosted PL (probe 2026-07-17): evenodd supported; elementFromPoint at the keypad
// flipped from our iframe to the page beneath once the hole was applied.
//
// The same-origin parent access follows the frameElement precedent in embed.js (the
// wrap/parent handle); writing `frameElement.style.clipPath` itself is NEW code with no
// prior in-tree use. Everything here is fail-open: any error clears the clip entirely
// (today's behaviour) rather than leaving a corrupt one.
//
// Detection (two tiers, probed live on hosted PL):
//   1. `#calculatorDrawer` / `section.calculator-drawer` — PL's drawer. OPEN state is
//      the `open` class; the CLOSED drawer keeps its rect (body is visibility:hidden,
//      so it doesn't hit-test) — geometry alone must never be the signal.
//   2. Fallback for markup drift: any parent <math-field> OUTSIDE `.pl-scribble-wrap`
//      → nearest fixed/absolute-positioned VISIBLE ancestor. Visibility must be checked
//      (computed visibility + display + area) — offsetParent is null for fixed elements.
//
// The hole applies whenever the drawer is open, regardless of annotate state: it is
// hit-test-neutral while the iframe is already click-through, but it stops idle ink
// from painting over an open calculator. Never scroll-coupled positioning (CLAUDE.md
// §10): observers/listeners only funnel into one rAF-coalesced sync of a static clip.
//
// Bump this module's ?v= import in app.js together with APP_VERSION.

let frame = null;       // the overlay <iframe> element (PARENT-realm node)
let pw = null;          // parent window
let pdoc = null;        // parent document
let onHoleChange = null;
let holes = [];         // current hole rects in FRAME-relative CSS px
let raf = 0;
let cleanupFns = [];
let clipBroken = false;    // clip unsupported/broken — degrade to pointer-events while open
let mo = null, ro = null;  // module-level so syncNow can re-attach when the drawer node changes
let observedDrawer = null; // the drawer node the observers are currently attached to

const PAD = 6; // px of breathing room around the panel so its border/shadow stays clickable

export function calcHoles() { return holes; }

// The calculator panel elements currently open + visible, parent-realm. Tier 1: PL's
// drawer by id/class + `.open`. Tier 2: math-field walk (markup-drift insurance).
function findPanels() {
  const out = [];
  const drawer = pdoc.getElementById("calculatorDrawer") || pdoc.querySelector("section.calculator-drawer");
  if (drawer) {
    if (drawer.classList.contains("open")) out.push(drawer);
    return out; // the drawer exists — trust its state; don't double-count via tier 2
  }
  for (const mf of pdoc.querySelectorAll("math-field")) {
    if (mf.closest(".pl-scribble-wrap")) continue; // our own content is not a calculator
    let panel = null;
    for (let n = mf.parentElement; n && n !== pdoc.body; n = n.parentElement) {
      const cs = pw.getComputedStyle(n);
      if (cs.position === "fixed" || cs.position === "absolute") { panel = n; break; }
    }
    if (!panel || out.includes(panel)) continue;
    const cs = pw.getComputedStyle(panel);
    const r = panel.getBoundingClientRect();
    if (cs.display === "none" || cs.visibility === "hidden" || r.width * r.height === 0) continue;
    out.push(panel);
  }
  return out;
}

// Recompute the hole set and write (or clear) the frame's clip-path. rAF-coalesced;
// all failure paths clear the clip (fail-open — degrade to today's behaviour).
function syncNow() {
  try {
    if (!frame.isConnected) { teardown(); return; } // PL removed the iframe in place — leave the parent clean
  } catch { /* parent unreadable — fall through to the fail-open path below */ }
  // Drift insurance: a drawer that arrived late (body-subtree observer) or was node-replaced
  // (parent childList) needs the attribute/resize observers moved onto the LIVE node, or its
  // open/close class flips go unheard. observe() on a new target is additive; the old node is dead.
  try {
    const d = pdoc.getElementById("calculatorDrawer") || pdoc.querySelector("section.calculator-drawer");
    if (d && d !== observedDrawer) {
      observedDrawer = d;
      mo?.observe(d, { attributes: true, attributeFilter: ["class", "style"] });
      if (d.parentElement) mo?.observe(d.parentElement, { childList: true });
      ro?.observe(d);
    }
  } catch { /* parent unreadable */ }
  let next = [];
  try {
    const fr = frame.getBoundingClientRect();
    if (fr.width > 0) {
      for (const panel of findPanels()) {
        const pr = panel.getBoundingClientRect();
        const left = Math.max(pr.left - PAD, fr.left), top = Math.max(pr.top - PAD, fr.top);
        const right = Math.min(pr.right + PAD, fr.right), bottom = Math.min(pr.bottom + PAD, fr.bottom);
        const w = right - left, h = bottom - top;
        if (!(w > 0 && h > 0) || !Number.isFinite(w + h)) continue; // no overlap / degenerate
        next.push({ left: left - fr.left, top: top - fr.top, width: w, height: h });
      }
    }
  } catch {
    next = []; // parent went unreadable — clear and carry on
  }
  holes = next;
  try {
    if (!holes.length) {
      frame.style.clipPath = "";
      // Restore what the sizer's m() would have set — "" computes to `auto`, which would
      // make the idle transparent overlay eat every click on the live question.
      if (clipBroken) frame.style.pointerEvents = document.body.classList.contains("annotate-active") ? "auto" : "none";
    } else if (!clipBroken) {
      const p = (v) => `${Math.round(v)}px`;
      // CSS polygon() is ONE subpath: every ring must CLOSE back to its first vertex and
      // return to the outer anchor, so the connector edges are traversed twice and cancel
      // under evenodd. Without the closures the connectors flip parity across a whole
      // wedge of the frame — clipping real question area (live-verified failure + fix).
      const outer = "0 0, 100% 0, 100% 100%, 0 100%, 0 0";
      const rects = holes.map((r) =>
        `${p(r.left)} ${p(r.top)}, ${p(r.left + r.width)} ${p(r.top)}, ` +
        `${p(r.left + r.width)} ${p(r.top + r.height)}, ${p(r.left)} ${p(r.top + r.height)}, ` +
        `${p(r.left)} ${p(r.top)}, 0 0`);
      frame.style.clipPath = `polygon(evenodd, ${outer}, ${rects.join(", ")})`;
      // An unsupported polygon() silently no-ops instead of throwing — read back to detect,
      // and apply the degraded behaviour in the same pass.
      if (!frame.style.clipPath) {
        clipBroken = true;
        console.warn("calc-dodge: clip-path unsupported, degrading to pointer-events");
        frame.style.pointerEvents = "none";
      }
    } else {
      // Last-ditch fallback (clip unsupported/broken): make the whole frame click-through
      // while the calculator is open. Drawing pauses; the calculator stays usable.
      frame.style.pointerEvents = "none";
    }
  } catch (e) {
    if (!clipBroken) { clipBroken = true; console.warn("calc-dodge: clip-path write failed, degrading:", e); }
    try { frame.style.clipPath = ""; frame.style.pointerEvents = "none"; } catch { /* parent gone */ }
  }
  try { onHoleChange?.(holes); } catch { /* dodge callback must never break the sync */ }
}

function sync() {
  if (raf) return;
  // OUR OWN realm's rAF, deliberately: scheduling on the PARENT's rAF with an iframe-realm
  // callback silently never fired on hosted PL — the stuck non-zero `raf` id then swallowed
  // every later trigger here. The iframe renders in the same frame tick, so timing is equal.
  raf = requestAnimationFrame(() => { raf = 0; syncNow(); });
}

// deps: frame (window.frameElement), pw (window.parent), onHoleChange (called with the
// hole list after every sync — app.js dodges the rail/notes out of fresh holes there).
// Returns true when armed; false (and stays inert) when the parent is unreachable.
export function initCalcDodge(deps) {
  try {
    frame = deps.frame; pw = deps.pw; onHoleChange = deps.onHoleChange || null;
    pdoc = pw.document;
    if (!frame || !pdoc || !pdoc.body) return false;

    // Open/close is a class flip on the drawer; PL page swaps can add/remove/replace the node.
    // syncNow() re-attaches these observers whenever the live drawer node changes, so a drawer
    // that arrives late or gets node-replaced keeps its class flips heard. Constructed in OUR
    // realm (observing parent nodes is fine; parent-realm constructors with iframe-realm
    // callbacks proved unreliable on hosted PL — see sync()).
    mo = new MutationObserver(sync);
    const drawer = pdoc.getElementById("calculatorDrawer") || pdoc.querySelector("section.calculator-drawer");
    if (!drawer) {
      // No drawer yet (older PL / different page): watch the body subtree for one arriving;
      // syncNow's re-attach picks it up on the first mutation.
      mo.observe(pdoc.body, { childList: true, subtree: true });
    }
    cleanupFns.push(() => { mo.disconnect(); mo = null; observedDrawer = null; });

    // The drawer is position:fixed while the iframe scrolls with the document — every
    // scroll shifts the frame-relative mapping. Capture-phase on the parent document
    // hears inner scrollers too (PL's preview scrolls a container, not the window).
    const scrollOpts = { capture: true, passive: true };
    pdoc.addEventListener("scroll", sync, scrollOpts);
    cleanupFns.push(() => pdoc.removeEventListener("scroll", sync, scrollOpts));
    pw.addEventListener("resize", sync, { passive: true });
    cleanupFns.push(() => pw.removeEventListener("resize", sync));

    // Panel or frame resizing (resizeOverlay grows the frame with the prose) moves the hole.
    if (window.ResizeObserver) {
      ro = new ResizeObserver(sync); // our realm, same reasoning as the MutationObserver above
      ro.observe(frame);
      cleanupFns.push(() => { ro.disconnect(); ro = null; });
    }

    // PL panel swaps tear the iframe down — leave the parent clean (no stale clip).
    window.addEventListener("pagehide", teardown);
    cleanupFns.push(() => window.removeEventListener("pagehide", teardown));

    syncNow(); // the calculator may already be open before we boot (R2)
    return true;
  } catch {
    teardown(); // cross-origin / hostile parent — stay inert, today's behaviour
    return false;
  }
}

export function teardown() {
  for (const fn of cleanupFns.splice(0)) { try { fn(); } catch { /* already gone */ } }
  if (raf) { try { cancelAnimationFrame(raf); } catch { /* parent gone */ } raf = 0; }
  holes = [];
  try {
    frame.style.clipPath = "";
    // Same annotate-aware restore as the holes-empty branch: "" would compute to `auto`
    // and let the idle transparent overlay eat every click on the live question.
    if (clipBroken) frame.style.pointerEvents = document.body.classList.contains("annotate-active") ? "auto" : "none";
  } catch { /* parent gone */ }
}
