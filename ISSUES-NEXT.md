# Scribble — open issues, ranked (as of v168, 2026-07-21)

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

### 6. Toolbar WIDTH still restores from prefs on load (position no longer does)
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

## Also unresolved (not a code bug)

- **The "drag half-off, it snaps back" report** — root-caused as the iframe blurring mid-drag (dragging past the
  frame edge puts the pointer over the parent page) cancelling a live drag, and **fixed in v167** for both the
  toolbar and notes. **Needs a foreground confirmation from the user** that it is actually gone; it was never
  reproducible under automation.

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
