// PURE decision function for the overlay iframe's pointer-events. Extracted from app.js's iframeShouldCapture
// (Fable strategic audit — "THE ONE THING") so the single decision behind nearly every v170–v181 live-exam
// incident (blank questions, the Select trap's cousin, help stranded across Done, the pause pe-leak, the
// embed lock-out) can be TRUTH-TABLE tested — one named row per historical incident — instead of only ever
// exercised on hosted PL. app.js reads the five DOM signals into `state`; ALL the logic lives here.
//
// Returns true  = CAPTURE  (pointer-events:auto — the iframe eats the click; the student draws / uses a modal)
//         false = PASS THROUGH (pointer-events:none — the click falls to the question/host beneath)
//
// state = {
//   overlay:    boolean  // body.overlay — the TRANSPARENT PL overlay iframe (vs the opaque standalone/embed)
//   annotating: boolean  // body.annotate-active — student pressed Annotate (vs Done / not-yet)
//   paused:     boolean  // the Answering pause (draw ↔ answer without leaving annotate)
//   helpOpen:   boolean  // the keyboard-shortcuts modal is open (rendered INSIDE the iframe)
//   modalOpen:  boolean  // a .modal-overlay (clipping lightbox / confirm / prompt) is open inside the iframe
// }
export function computeOverlayPE(state) {
  const { overlay, annotating, paused, helpOpen, modalOpen } = state;
  // Only the transparent OVERLAY iframe ever passes clicks through. The opaque standalone/embed tool IS the
  // whole tool and must ALWAYS capture — else closing an in-iframe modal there sets pe:none and locks the tool
  // out with no mouse path back (v181 embed lock-out).
  if (!overlay) return true;
  // A modal rendered INSIDE the iframe must be clickable no matter the base state — otherwise its ✕/backdrop
  // are dead and Esc is unreachable (v180: help un-closable while Answering; v180 review: help stranded when
  // Done fires with a modal still open). These win over pause AND Done.
  if (helpOpen) return true;
  if (modalOpen) return true;
  // Base state: Done (not annotating) passes answers through; the Answering pause passes through; only active
  // drawing captures. This mirrors the parent sizer's Annotate/Done base so re-asserting it on modal-close
  // never strands the iframe capturing over a finished question.
  if (!annotating) return false;
  if (paused) return false;
  return true;
}
