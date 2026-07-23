# Scribble — open issues, ranked (as of v171, 2026-07-22; older entries below may reference v168)

## v171 SHIPPED (pending push/sync + hosted verify) — the toolbar redesign
One auto-sized single-row bar + Priority+ "More" + ONE width-drag handle (drag narrower → Snip, Undo/Redo,
colours demote into More; wider → they return); "Customize tools" checklist in More (pen/eraser/select locked
on, per-question persistence, Reset); Larger-controls now announces and REFITS into More instead of overlapping;
DELETED: Compact/Medium/Full presets, the wrap mode, the student-facing A/B toggle. chrome.css mirror written
against this final layout (still deploy-excluded; inert until the v172 reparent). Adversarial review: 16
confirmed findings, 13 fixed pre-deploy (incl. 3 high: the host-padding shorthand clobber, popover flip-above
off-band, announce stomping). **Deferred, tracked:**
- **(v172, flip-true only) alignRailToCard's inline style.width defeats the chrome.css max-content channel** —
  rework alongside the card-top-default decision when the reparent flips.
- **(done in v172) chrome.css deploy**: deploy.sh no longer excludes it; the CLAUDE.md §0.1 class-repo rsync
  must also be run WITHOUT `--exclude 'chrome.css'` from v172 on (both bundles carry it before the flip).
- **(minor) a saved width restored at boot clamps against the degraded 160px floor** (rail is display:none so
  coreWidth can't measure); self-corrects on the first handle gesture. Fix only if ever user-visible.
- **(decision) Marks tools (tick/cross/circle/arrow/box) stay hidden in overlay** — surfacing them needs a
  finite priority in rail-overflow.js prioFor + deleting the style.css trim rules + a checklist row set.


Live version: **v168** on hosted PL (`us.prairielearn.com` → ECE 498SL → `ECE120-Quiz-L8-Q3-scribble`).
Everything below is **not yet fixed**. Each entry: what you see → why it happens (root cause, with file:line) →
how to fix it → how to verify. Ordered by importance.

**How to work here:** see `CLAUDE.md` (§0 plan→critique→execute, §0.1 pipeline + staged deploy). Deploy =
rsync into BOTH `prairielearn/example-course/clientFilesCourse/scribble/` and
`pl-uiuc-ece498sl/clientFilesCourse/scribble/`, bump `APP_VERSION` + every `?v=`, commit both repos
(fetch the class repo FIRST), then **the user pushes + Syncs** — never push the class repo yourself.

---

## P0 — Fix before real students

### 1. `element.py` change can be forgotten → element and bundle drift
**Symptom:** a change to the Done/Annotate button silently doesn't appear live even though "everything deployed".
**Root cause:** the tool ships as TWO artifacts — the **bundle** (`clientFilesCourse/scribble/`, rsynced by
script) and the **element** (`elements/pl-scribble/pl-scribble.py`, copied by hand). The rsync only covers the
bundle. This already bit once in v166: the Done restyle landed in `example-course` and never reached the class
repo, so PL served the old button.
**Fix:** make the element copy part of the deploy, not a manual step. Add to `prairielearn/deploy.sh` (or a new
`deploy-all.sh`): copy `prairielearn/example-course/elements/pl-scribble/pl-scribble.py` into
`pl-uiuc-ece498sl/elements/pl-scribble/` and `diff -q` both as a hard gate that fails the deploy on mismatch.
**Verify:** change a string in the element, run the deploy, confirm `diff -q` passes and the string appears live.

### 2. No automated JS tests (audit item **Batch T**)
**Symptom:** every fix in this file risks silently breaking a sibling mode; only manual hosted checks catch it.
**Root cause:** `test-zero-js-coverage` — Rust has 44 tests, JS has **zero**, and the exam-critical logic
(`serializeAnnotations`/`hydrateAnnotations` round-trip, the 1.5s save loop, the pointer state machine, PL
seeding) is all JS-side.
**Fix:** stand up `node:test` + `jsdom`. First targets, in order: (a) serialize→hydrate round-trip incl. the cap
path, (b) `visible-band.js` `clampIntoBand` edge math (pure function, trivial to cover, and it now underpins
every panel), (c) `rail-overflow.js` demote/promote convergence + original-order restore. Wire into CI beside
`cargo test`.
**Why this high:** it is the audit's own #1 recommendation and it de-risks everything below it.

### 3. Remaining exam-critical audit items (E7, E10, E11, E3, E4, E9)
Not restated here — see **`DEEP-AUDIT-PLAN.md` §0**. Summary of what's still open:
- **E7** no durable crash-recovery autosave in exam modes (work lives in an in-DOM input until PL Save)
- **E10** a mid-exam redeploy that changes the blob schema orphans in-flight work, then the save loop overwrites it
- **E11** the last ≤1.5s of work can miss a non-navigation submit
- **E3** overlay can eat clicks meant for nested graded widgets
- **E4** a locked reference that trips a size/page cap strands the student
- **E9** boot/WASM failure hides the error and can leave a click-trap over the live question
**Why P0-but-later:** these are silent data-loss paths. Low urgency while the course is an experimental testbed
with no real students; **must** be closed before it is used for a graded exam.

---

## P1 — Visible/annoying, fix soon

### 4. Sticky toolbar scroll-follow is UNVERIFIED — may silently do nothing
**Symptom:** unknown. Either the toolbar follows you down a long question, or it scrolls away as it always did.
**Root cause:** `restickRail()` (`app.js`, gated by `RAIL_VIEWPORT_STICKY = true`) re-pins the default bar to the
band top on parent scroll, via a capture-phase `scroll` listener on `window.parent.document` coalesced through the
iframe's own rAF. The *math* is proven (manually applying it pins the bar correctly), but I could never confirm the
**listener actually fires**: the in-app browser reports a 0-size viewport, and the Chrome tab under automation is
backgrounded so its rAF/scroll are throttled to nothing.
**Fix:** verify in a **foreground** browser first — annotate a long question, scroll, watch the bar. If it does not
follow: PL scrolls a **nested container** (measured: a `DIV` ~8 levels above the iframe), not the window, so also
attach the listener to that scroller (walk up from `frameElement` for the first element with
`overflowY: auto|scroll` and `scrollHeight > clientHeight`). If it janks or collides with PL chrome: set
`RAIL_VIEWPORT_STICKY = false` — the band-clamp underneath still satisfies everything else.
**Verify:** foreground, annotate-mode, scroll a tall question; bar should stay within ~4px of the band top.

### 5. Done button can overlap the toolbar's right-end controls at narrow widths
**Symptom:** at a narrow browser (<~900px, i.e. no sidebar so the card fills the width), the Done pill can sit over
the toolbar's More / minimise / collapsed-handle.
**Root cause:** Done is `position:fixed` in the PARENT and anchored to the card's right edge
(`pl-scribble.py`, active-Done branch: `top = frame.top + 60`, `right = innerWidth − frame.right + 8`), while the
toolbar's right-end controls sit at that same card-right. At preview width there is a ~375px sidebar so they clear
each other; with no sidebar they collide. Worst case is a **collapsed** toolbar, whose only restore control is that
right-edge handle → briefly unreachable (Done is draggable, so recoverable, but not discoverably).
**Fix (cheapest first):** (a) offset Done's `top` below the bar (`frame.top + railHeight + 12`, pushed from the app
like `setRailClear`); or (b) anchor Done to the card's **left**; or (c) move Done into the rail itself as a real
toolbar action (cleanest, but cross-realm — the rail is in the iframe, Done must talk to the parent).
**Verify:** narrow the browser under ~900px, annotate, collapse the toolbar, confirm the expand handle is clickable.

### 6. ~~Toolbar WIDTH still restores from prefs on load (position no longer does)~~ — RESOLVED in v170
**Decision (user, 2026-07-21):** position SHOULD persist, but **a new question must always open at the default
layout**. Both now hold: position is restored again, gated on `PREFS_PER_QUESTION` (a real per-question `qid`
from the element, so `PREFS_KEY` is genuinely namespaced — a new question finds no saved layout and lands at the
default), and band-clamped on restore by the `clampFixed` that did not exist when v168 removed the restore. If
the element ever fails to supply a `qid`, every question shares one legacy key, so the flag fails safe to the
old always-default behaviour. Width was already restored; the two are now consistent. The COLLAPSED state is
still deliberately never re-applied (R4) — unlike a position, a collapse has no on-screen affordance pulling it
back. Notes still stage at the band top every load (they're scratch).
*Original text below, kept for context.*

### 6-old. Toolbar WIDTH still restores from prefs on load (position no longer does)
**Symptom:** a question can open with a narrow (Compact) toolbar you don't remember choosing — e.g. left over from
an earlier session or someone else's testing on that browser.
**Root cause:** v168 deliberately stopped restoring the saved **position** (`railFloat2.left/top`) so the bar always
loads in the default place, but the saved **width** (`railFloat2.width` → `--rail-w`) is still applied at
`app.js` rail-init. That is defensible (an explicit user choice) but inconsistent with "default on load", and it is
why the bar currently loads at ~528px rather than full width.
**Fix — a product decision, pick one:** (a) treat width like position: don't restore it, always load full
(one-line: drop the `railResize.setWidth(savedRailW)` restore); (b) keep restoring it (current); (c) restore it only
within a session (sessionStorage) so a reload is always clean.
**Verify:** set Compact, reload, observe.

### 7. Notes size is "sticky" — never grows back
**Symptom:** notes that once opened small stay small even when there is plenty of room later.
**Root cause:** `clampNotes()` caps `w/h` to the visible band and writes those px back onto `pane.style`. When the
band was small the pane is frozen small; when the band grows, nothing ever re-grows it because
`placeNotesAtBandTop()` reads `parseFloat(pane.style.height) || DEFH` — a set inline height always wins over the
default. Reproduced during harness work: pane capped to 128px tall stayed 128px after the frame grew to 1307px.
**Fix:** distinguish "student resized it" from "we capped it". Set a flag in the resize handle's `endResize`
(`pane.dataset.userSized = "1"`) and have `clampNotes` only *cap for display* without persisting the capped value
when that flag is absent — or have `placeNotesAtBandTop` ignore the inline size unless `userSized` is set.
**Verify:** open notes in a short band, grow the window, reopen notes — should return to 400×240.

---

## P2 — Correctness debt, not user-visible today

### 8. `chrome.css` has drifted from `style.css`
**Symptom:** none today.
**Root cause:** `chrome.css` is the hand-ported copy of the overlay toolbar styling used **only** by the Phase-1
reparented chrome, which is gated off (`PHASE1_CHROME_REPARENT = false`). v166–v168 added a lot of CSS (resize
handle, `.ov-wrap` / `.ov-more`, `#more-overflow`, badge, popover controls) and only 3 of those edits were
mirrored. If Phase 1 is ever switched on, the toolbar will render unstyled/broken.
**Fix:** either mirror the v166–v168 block into `chrome.css` (per `V166-TOOLBAR-PLAN.md` §3.5, and note the
source-order warning at `chrome.css:387`), or — better — **delete `chrome.css` and Phase 1** if the sticky rail
(#4) makes the reparent unnecessary, which it plausibly does.
**Decide first:** is Phase 1 still wanted at all? v163's sticky bar was built to solve the same problem.

### 9. Local overlay harness is half-broken
**Symptom:** `embed/overlay-demo.html` loads the tool in real overlay mode, but its **Annotate button doesn't
toggle**, so you must set `annotate-active` by hand.
**Root cause:** the harness inlines a copy of `pl-scribble.py`'s `_OVERLAY_SIZER` script; its `on`/`sc` closure
state doesn't toggle there (likely the `f.addEventListener('load', m)` re-entry racing the harness's own frame
sizing). Dev-only, does not affect the product.
**Fix:** simplify the harness's copy to a minimal toggle (`on = !on; frame.contentDocument.body.classList.toggle(
'annotate-active', on)`), dropping the drag/reparent logic it doesn't need.
**Value:** real. A working harness removes the deploy→sync→hard-refresh loop for every UI change, and it is the
only place drags can be tested reliably (both automation surfaces throttle them).

### 10. Overflow A/B is still shipped as a live toggle
**Symptom:** the More menu carries a "Wrap to a 2nd row" / "Hide extras in More" switch that students would see.
**Root cause:** deliberate — `RAIL_OVERFLOW_TRIAL = true` so the two behaviours can be compared on the real
question. Not a bug; just unfinished.
**Fix:** once the winner is chosen, set `RAIL_OVERFLOW_TRIAL = false`, set `RAIL_OVERFLOW_DEFAULT` to the winner,
and delete the loser's code path (`.ov-wrap` CSS block, or `rail-overflow.js`'s demote/promote engine).

---

## FIXED in v170 — the drag snap-back (was mis-closed twice)

- **"I drag the toolbar and it snaps back to its original place the minute I let go."** Re-reported by the user
  at v169. **v167 closed the wrong mechanism**: it fixed the iframe-blur cancel (real, still needed), but the
  actual high-frequency trigger was `floating-panel.js`'s `if (!(ev.buttons & 1)) return end(true)`. On release
  Chrome dispatches a trailing `pointermove` carrying `buttons:0` **before** `pointerup`; that guard read it as
  "the press ended somewhere we never heard about", took the **cancel** branch — the one code path that restores
  the pre-lift position — and `pointerup` then found `drag` already null and did nothing. Net effect of v167:
  turned a deterministic "drag half-off → snap back" into a probabilistic "drag anywhere → snap back".
  **Three compounding causes, all fixed:**
  1. **Cancel-on-release inversion.** A finished gesture is a DROP. Now `end(false)`. The same inversion existed
     in `notes-dock.js:195` (worse: a cancel of a pane lifted from docked *re-docks* it) and `colorbar.js:128`.
     New invariant across all three engines: **a lifted drag always commits; only a never-lifted press cancels.**
  2. **The pending rAF was discarded, not flushed.** The live loop only writes left/top inside a rAF, so if no
     frame ran (fast flick, or rAF starved per CLAUDE.md §6) the drop committed the *pre-lift* rect — the same
     symptom by an independent route. `end()` now flushes from the cached pointer target.
  3. **The grab offset was never re-seated after the lift.** `dx` was measured on the FULL-WIDTH resting bar,
     but `.fp-moved` shrinks it to `max-content` — so a grab on the right half left the bar entirely left of the
     cursor, it never tracked the pointer, and every event *including the release* landed off the element. This
     is why right-side grabs failed far more often than left-side ones.
  Plus a **release backstop** on the own + parent document (a release past the iframe edge, or over the parent's
  Done pill, is dispatched in the PARENT realm and the element never sees it), and `dispose()` now tears down
  the listeners it registers — wired to `pagehide` unconditionally, since the reparent branch that used to own
  teardown is dead while `PHASE1_CHROME_REPARENT = false`.
- **Regression-tested, and the tests are the first JS tests in the repo** (a start on Batch T / issue #2):
  `scribble/web/test/drag.test.mjs`, run with `node --test scribble/web/test/drag.test.mjs`. 8 tests. The 3
  bug tests **fail against the v169 module and pass against v170**; the 5 invariant tests (DRAG_SLOP click≠drag,
  pointercancel still restores, blur never cancels a lifted drag, band clamp, second drag) pass on both — so the
  v167 behaviour is provably preserved. Verify this way, not by eyeballing: this bug has now been "fixed" twice.
- Still needs the **foreground hosted confirmation** (automation Chrome is backgrounded, so real pointer capture
  and rAF timing cannot be exercised there).

## Newly confirmed by the v170 sweep — not yet fixed

Adversarially verified (43 candidates → 7 survived) during the v170 root-cause pass. Ranked.

1. **Notes teleport to the band top on every reopen and every snip** (`app.js` `toggleNotes` / `revealNotes`).
   The re-place fires whenever the pane drifted out of the band, and `clampNotes` only keeps the ~36px *header*
   in band — so almost any lower-half pane qualifies. `savePrefs()` runs right after, so it is unrecoverable.
   **Fix:** drop the `pr.bottom > b.bottom` clause; replace the full re-place with `clampNotes()`.
2. **Tools parked in More can never come back once the bar is dragged** (`rail-overflow.js` promote test).
   With no `--rail-w`, promotion tests `scroll.clientWidth - scroll.scrollWidth >= w + GAP`, which presumes a
   fixed outer width — but `.fp-moved` makes the bar `max-content`, so `clientWidth === scrollWidth` by
   construction and the LHS is permanently 0. **Fix:** treat the content-sized regime like the cap branch.
3. **`clampNotes` persists its display cap so notes never grow back** (this is the old #7 above, now root-caused).
4. **`railClear` re-shrinks the band below the 120px floor** (`notes-dock.js`) — `visible-band.js` guarantees a
   ≥120px band, but `railClear` (≥64) is subtracted *after* that guard, collapsing the vertical bound.
   *Verified mathematically unreachable for the rail*; affects notes only.
5. **`syncHostPad` grows the parent host but nothing re-sizes the iframe** — the host ends up taller than the
   overlay, so ink and pointer capture silently stop short of the last `railHeight` px of the question.
   **Fix:** expose the parent sizer and call it, or add a parent-realm `ResizeObserver` on the host.
6. **The Done pill overlaps the toolbar's right-end controls** (the old #5) — now also confirmed as a *direct
   contributor* to the snap-back: it paints above the overlay iframe, so a release over it was a lost pointerup.
   The v170 parent-document backstop removes the lost-release half; the click-collision half remains.

## Verification notes (learned the hard way)
- Always confirm the loaded `APP_VERSION` **in the page** before asserting anything; add `?cb=<n>` to force a
  fresh `index.html`.
- After navigating, the app boots asynchronously — **probe twice**; a first probe often reads a half-built DOM
  and produces false "it's missing" results.
- JS probes in the hosted Chrome tab get **blocked** if they return string-ish payloads that look like cookie or
  query data — return numbers/booleans, or short JSON.
- Pixel clicks use **screenshot-space** coordinates, not `getBoundingClientRect` viewport coordinates.
- The automation Chrome tab is **backgrounded** (`visibilityState: hidden`): rAF and scroll events are throttled,
  so drag/scroll behaviour cannot be trusted there. Dispatch `PointerEvent`s directly, or test in the foreground.
