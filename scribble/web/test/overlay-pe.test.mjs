// Truth-table test for the overlay pointer-events decision (overlay-pe.js). The Fable audit named this "THE
// ONE THING": the single decision behind nearly every v170–v181 live-exam incident, now pinned so a wrong
// transition fails HERE instead of blanking a real exam. Each row is named for the incident it guards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeOverlayPE } from "../overlay-pe.js";

// Base = actively drawing in the overlay (the only "capture" base state). Rows override just what they test.
const DRAWING = { overlay: true, annotating: true, paused: false, helpOpen: false, modalOpen: false };
const S = (o) => ({ ...DRAWING, ...o });

// [name, state, expectedCapture]. true = capture (pe:auto, iframe eats the click); false = pass through.
const ROWS = [
  // --- the two base "capture" cases ---
  ["overlay, drawing → CAPTURE (ink lands)", S(), true],
  ["standalone/embed (not overlay) → CAPTURE (the whole opaque tool)", S({ overlay: false, annotating: false }), true],

  // --- pass-through base states ---
  ["overlay, Done (not annotating) → PASS (finished question is answerable)", S({ annotating: false }), false],
  ["overlay, Answering pause → PASS (v179 item4: answer with the bar up)", S({ paused: true }), false],

  // --- modal-open ALWAYS captures (a modal renders inside the iframe; its ✕/backdrop must be clickable) ---
  ["help open WHILE PAUSED → CAPTURE (v180: 'why can't I minimise help')", S({ paused: true, helpOpen: true }), true],
  ["help open AFTER Done → CAPTURE (v180 review: help stranded across Done)", S({ annotating: false, helpOpen: true }), true],
  ["lightbox open while paused → CAPTURE (clipping/confirm clickable)", S({ paused: true, modalOpen: true }), true],
  ["lightbox open after Done → CAPTURE (never strand a modal over a finished question)", S({ annotating: false, modalOpen: true }), true],
  ["modal open while drawing → CAPTURE", S({ modalOpen: true }), true],

  // --- the v181 embed lock-out class: not-overlay must NEVER pass through, even with help/pause signals ---
  ["embed, help just closed, not annotating → CAPTURE (v181: no pe:none lock-out)", S({ overlay: false, annotating: false, helpOpen: false }), true],
  ["embed, 'paused' flag stale → CAPTURE (embed ignores the overlay pause)", S({ overlay: false, paused: true }), true],

  // --- fail-invisible finished question: overlay + Done + nothing open → PASS ---
  ["overlay, Done, everything closed → PASS (fail-invisible, unobstructed)", S({ annotating: false }), false],
];

for (const [name, state, expected] of ROWS) {
  test(name, () => {
    assert.equal(computeOverlayPE(state), expected, `state=${JSON.stringify(state)}`);
  });
}

// Exhaustive determinism + precedence: all 32 states match the spec'd precedence (overlay > modal > Done > pause).
test("all 32 states obey the precedence spec", () => {
  const spec = ({ overlay, annotating, paused, helpOpen, modalOpen }) => {
    if (!overlay) return true;
    if (helpOpen || modalOpen) return true;
    if (!annotating) return false;
    if (paused) return false;
    return true;
  };
  for (let i = 0; i < 32; i++) {
    const st = {
      overlay: !!(i & 1), annotating: !!(i & 2), paused: !!(i & 4),
      helpOpen: !!(i & 8), modalOpen: !!(i & 16),
    };
    assert.equal(computeOverlayPE(st), spec(st), `state=${JSON.stringify(st)}`);
  }
});
