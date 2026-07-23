// drag.test.mjs — regression tests for the floating-panel drag state machine.
//
// Covers the v170 fix for "I drag the toolbar and it snaps back to its original place the minute I let go"
// and, just as importantly, the hard-won invariants around it that must NOT regress (v167's blur rule, the
// DRAG_SLOP click-vs-drag rule, the pointercancel restore).
//
// Run: node --test scribble/web/test/
//
// No jsdom: the engine touches a small, well-defined DOM surface, so a hand-rolled fake is both faster and
// more honest about what is being simulated. The fake models the ONE piece of CSS that actually drives the
// bug — a resting bar that is FULL WIDTH at a CSS pin, versus a lifted (.fp-moved) bar that shrinks to
// max-content at inline coords (style.css: body.overlay #rail / #rail.fp-moved).

import { test } from "node:test";
import assert from "node:assert/strict";

const VIEW_W = 1000, VIEW_H = 800;
const FULL_W = 900;   // the resting, card-spanning bar
const CONTENT_W = 300; // the lifted, max-content bar
const BAR_H = 52;

function makeClassList(set) {
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    contains: (c) => set.has(c),
    toggle: (c, on) => { const v = on === undefined ? !set.has(c) : on; v ? set.add(c) : set.delete(c); return v; },
  };
}

// A fake element with just enough surface for makeFloating.
function makeEl(doc) {
  const set = new Set();
  const handlers = new Map();
  const captured = new Set();
  const el = {
    style: { left: "", top: "", width: "" },
    classList: makeClassList(set),
    ownerDocument: doc,
    addEventListener: (t, fn) => { if (!handlers.has(t)) handlers.set(t, []); handlers.get(t).push(fn); },
    removeEventListener: (t, fn) => { const a = handlers.get(t) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    setPointerCapture: (id) => captured.add(id),
    releasePointerCapture: (id) => captured.delete(id),
    hasPointerCapture: (id) => captured.has(id),
    getClientRects: () => [{}], // always rendered
    querySelector: () => null,
    getBoundingClientRect() {
      // .fp-moved drops the CSS pin (inline left/top win) AND shrinks the bar to max-content.
      if (set.has("fp-moved")) {
        const left = parseFloat(el.style.left) || 0, top = parseFloat(el.style.top) || 0;
        return { left, top, width: CONTENT_W, height: BAR_H, right: left + CONTENT_W, bottom: top + BAR_H };
      }
      return { left: 4, top: 4, width: FULL_W, height: BAR_H, right: 4 + FULL_W, bottom: 4 + BAR_H };
    },
    _fire(type, ev) { for (const fn of (handlers.get(type) || []).slice()) fn(ev); },
    _has: (c) => set.has(c),
  };
  return el;
}

function makeDoc() {
  const handlers = new Map();
  return {
    visibilityState: "visible",
    addEventListener: (t, fn) => { if (!handlers.has(t)) handlers.set(t, []); handlers.get(t).push(fn); },
    removeEventListener: (t, fn) => { const a = handlers.get(t) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    _fire(type, ev) { for (const fn of (handlers.get(type) || []).slice()) fn(ev); },
  };
}

// Install the globals floating-panel.js reads, then import it ONCE (ESM caches the module).
const doc = makeDoc();
let rafQueue = [];
globalThis.document = doc;
// TEST-1 (audit): the fake window must HOLD listeners and dispatch them — the old `addEventListener: () => {}`
// dropped the blur handler, making the blur-invariant test pass against ANY implementation (proven vacuous).
const winHandlers = new Map();
globalThis.window = {
  innerWidth: VIEW_W, innerHeight: VIEW_H,
  frameElement: null, // standalone realm -> visibleBand degenerates to the whole viewport
  document: doc,
  addEventListener: (t, fn) => { if (!winHandlers.has(t)) winHandlers.set(t, []); winHandlers.get(t).push(fn); },
  removeEventListener: (t, fn) => { const a = winHandlers.get(t) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
  dispatchEvent: (evOrType) => {
    const t = typeof evOrType === "string" ? evOrType : evOrType.type;
    const fns = (winHandlers.get(t) || []).slice();
    for (const fn of fns) fn(typeof evOrType === "string" ? { type: t } : evOrType);
    return fns.length > 0; // lets a test assert the handler was actually registered AND ran
  },
};
globalThis.window.parent = globalThis.window; // no separate parent realm in the fake
globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
globalThis.cancelAnimationFrame = (id) => { rafQueue[id - 1] = null; };

const { makeFloating } = await import("../floating-panel.js?v=175");

const flushRaf = () => { const q = rafQueue; rafQueue = []; for (const fn of q) if (fn) fn(); };

function ptr(type, x, y, buttons, id = 7) {
  return { type, pointerId: id, clientX: x, clientY: y, buttons, button: buttons ? 0 : -1,
           target: { closest: () => null }, preventDefault() {} };
}

function setup() {
  rafQueue = [];
  const el = makeEl(doc);
  let changes = 0;
  const fp = makeFloating(el, { collapse: null, onChange: () => { changes++; }, onSettle: () => {} });
  return { el, fp, changed: () => changes };
}

// ---------------------------------------------------------------------------
// THE reported bug: a release the element never sees must COMMIT, not revert.
// ---------------------------------------------------------------------------
test("missed pointerup commits the drop instead of snapping back (v170)", () => {
  const { el, changed } = setup();
  el._fire("pointerdown", ptr("pointerdown", 100, 20, 1));
  el._fire("pointermove", ptr("pointermove", 160, 90, 1)); // lift (past 4px slop)
  el._fire("pointermove", ptr("pointermove", 300, 240, 1)); // drag
  flushRaf();
  const painted = { left: el.style.left, top: el.style.top };
  // The release is deliberately NOT delivered to the element — the real-world case (capture lost, cursor off
  // the shrunken bar, or the release landing in the parent realm). Then the trailing buttons:0 move arrives.
  el._fire("pointermove", ptr("pointermove", 305, 245, 0));
  flushRaf();

  assert.equal(el._has("fp-moved"), true, "the bar must stay moved, not revert to the CSS pin");
  assert.equal(el._has("fp-dragging"), false, "the drag must have ended");
  assert.notEqual(el.style.left, "", "a committed drop keeps an inline position");
  assert.ok(Math.abs(parseFloat(el.style.left) - parseFloat(painted.left)) <= 6,
    `committed near the drop point, got ${el.style.left} vs painted ${painted.left}`);
  assert.equal(changed(), 1, "onChange/savePrefs must run exactly once for a committed drop");
});

// ---------------------------------------------------------------------------
// The second, independent snap-back route: no rAF ever ran (fast flick / throttled rAF).
// ---------------------------------------------------------------------------
test("drop commits at the pointer target even if no rAF frame ever ran", () => {
  const { el } = setup();
  el._fire("pointerdown", ptr("pointerdown", 100, 20, 1));
  el._fire("pointermove", ptr("pointermove", 400, 300, 1)); // lift AND move, in one batch
  // NOTE: no flushRaf() — this is the starved-rAF case (CLAUDE.md §6: occluded/background windows).
  el._fire("pointerup", ptr("pointerup", 400, 300, 0));

  assert.equal(el._has("fp-moved"), true);
  const left = parseFloat(el.style.left), top = parseFloat(el.style.top);
  // Pre-fix this committed the PRE-LIFT rect (left 4, top 4) because end() threw the pending frame away.
  assert.ok(left > 50, `expected the drop to track the pointer, got left=${left}`);
  assert.ok(top > 50, `expected the drop to track the pointer, got top=${top}`);
});

// ---------------------------------------------------------------------------
// The reason releases got missed so often: the bar must sit UNDER the cursor after the lift.
// ---------------------------------------------------------------------------
test("grabbing the right end re-seats the grab offset so the bar tracks the cursor", () => {
  const { el } = setup();
  const grabX = 850; // near the right end of the 900px resting bar, far beyond the 300px lifted width
  el._fire("pointerdown", ptr("pointerdown", grabX, 20, 1));
  el._fire("pointermove", ptr("pointermove", grabX + 60, 120, 1));
  el._fire("pointermove", ptr("pointermove", 600, 300, 1));
  flushRaf();
  el._fire("pointerup", ptr("pointerup", 600, 300, 0));

  const r = el.getBoundingClientRect();
  assert.ok(600 >= r.left && 600 <= r.right,
    `cursor x=600 must lie within the bar [${r.left}, ${r.right}] — otherwise it never tracks and the release is lost`);
});

// ---------------------------------------------------------------------------
// Invariants that must NOT regress.
// ---------------------------------------------------------------------------
test("a click without movement never moves the bar (DRAG_SLOP)", () => {
  const { el, changed } = setup();
  el._fire("pointerdown", ptr("pointerdown", 100, 20, 1));
  el._fire("pointermove", ptr("pointermove", 102, 21, 1)); // 2px — under the 4px slop
  el._fire("pointerup", ptr("pointerup", 102, 21, 0));
  flushRaf();

  assert.equal(el._has("fp-moved"), false, "a click must not pin the bar");
  assert.equal(el.style.left, "", "no inline position from a mere click");
  assert.equal(changed(), 0, "a click must not write prefs");
});

test("pointercancel after a lift still restores the pre-lift position (v167 behaviour kept)", () => {
  const { el } = setup();
  el._fire("pointerdown", ptr("pointerdown", 100, 20, 1));
  el._fire("pointermove", ptr("pointermove", 300, 240, 1));
  flushRaf();
  assert.equal(el._has("fp-moved"), true, "lifted");
  el._fire("pointercancel", ptr("pointercancel", 300, 240, 0));

  assert.equal(el._has("fp-moved"), false, "a genuine cancel reverts a first drag to the CSS default");
  assert.equal(el.style.left, "", "and clears the inline pin");
});

test("window blur never cancels a LIFTED drag (v167 fix kept)", () => {
  const { el } = setup();
  el._fire("pointerdown", ptr("pointerdown", 100, 20, 1));
  el._fire("pointermove", ptr("pointermove", 300, 240, 1));
  flushRaf();
  const before = el.style.left;
  // In the overlay, dragging toward the frame edge blurs the iframe mid-gesture. That must not kill the drag.
  const blurHandled = globalThis.window.dispatchEvent("blur");
  assert.equal(blurHandled, true, "the engine must actually register a blur handler on the realm window (a fake that drops it makes this test vacuous)");
  el._fire("pointermove", ptr("pointermove", 320, 260, 1));
  flushRaf();

  assert.equal(el._has("fp-moved"), true, "still dragging after a blur");
  assert.notEqual(el.style.left, "", "position intact");
  assert.notEqual(el.style.left, before, "the drag kept tracking after the blur");
});

test("the drop is clamped into the visible band (never off-screen)", () => {
  const { el } = setup();
  el._fire("pointerdown", ptr("pointerdown", 100, 20, 1));
  el._fire("pointermove", ptr("pointermove", 300, 240, 1));
  flushRaf();
  // Drag far below the fold, then release.
  el._fire("pointermove", ptr("pointermove", 5000, 5000, 1));
  flushRaf();
  el._fire("pointerup", ptr("pointerup", 5000, 5000, 0));

  const r = el.getBoundingClientRect();
  assert.ok(r.top < VIEW_H, `the bar must stay reachable in the band, got top=${r.top}`);
  assert.ok(r.left < VIEW_W, `the bar must stay reachable in the band, got left=${r.left}`);
});

test("a second drag from a moved bar commits relative to its current spot", () => {
  const { el } = setup();
  el._fire("pointerdown", ptr("pointerdown", 100, 20, 1));
  el._fire("pointermove", ptr("pointermove", 300, 240, 1));
  flushRaf();
  el._fire("pointerup", ptr("pointerup", 300, 240, 0));
  const first = parseFloat(el.style.left);

  el._fire("pointerdown", ptr("pointerdown", first + 20, 250, 1));
  el._fire("pointermove", ptr("pointermove", first + 120, 350, 1));
  flushRaf();
  el._fire("pointerup", ptr("pointerup", first + 120, 350, 0));

  assert.ok(parseFloat(el.style.left) > first, "the second drag moved it further right");
  assert.equal(el._has("fp-moved"), true);
});

test("visibilitychange-hidden COMMITS a lifted drag (v171 rule)", () => {
  const { el } = setup();
  el._fire("pointerdown", ptr("pointerdown", 100, 20, 1));
  el._fire("pointermove", ptr("pointermove", 300, 240, 1)); // lift + drag
  flushRaf();
  doc.visibilityState = "hidden";
  doc._fire("visibilitychange", { type: "visibilitychange" });
  doc.visibilityState = "visible";
  assert.equal(el._has("fp-moved"), true, "an alt-tab mid-drag keeps the student's placement (commit, not revert)");
  assert.equal(el._has("fp-dragging"), false, "the drag ended");
  assert.notEqual(el.style.left, "", "committed position retained");
});
