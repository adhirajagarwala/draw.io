# Scribble — Next Batches: Master Plan + SDM Ruling (post-v154)

> STATUS: groundwork COMPLETE, implementation NOT started (user instruction).
> Produced 2026-07-17 by the research workflow (6 deep-dives → synthesis → SDM critique), all
> anchors verified against commit 0c1c3b5 (v154). Re-grep every file:line anchor at batch start.
>
> HOW TO USE: read the SDM ruling FIRST — its required changes R1-R6 amend the plan below and are
> binding. Per batch: fold the R-changes → user sign-off (the SDM lists which questions are genuinely
> the user's) → implement → adversarial review (reviewers READ-ONLY) → fix → live-verify on hosted
> PL in the user's Chrome at iframe <900px → commit (short msg, no co-author) → USER pushes + syncs.

---

# PART 1 — SDM RULING (binding amendments)

All load-bearing anchors verified against `0c1c3b5` (v154, clean tree, chrome.css untracked, deploy.sh:25 excludes it). Findings and ruling below.

# SDM Ruling: APPROVE-WITH-CHANGES

The batch order (A → B → C → D → E → F), the split/merge decisions (E split out of B; chrome.css edited once in F via the C15 ledger; C's strict internal order), and the settled technical decisions are sound. I verified ~50 file:line anchors; all held except one false citation (R1). Four required changes, two minor notes. No batch needs re-planning.

## Verification summary (what I checked against the tree)

Held exactly: `PHASE1_CHROME_REPARENT` app.js:114; lastDrawTool observer 3632-3653 (incl. boot catch-up 3653 and clampRailOnShow@3644 → syncRailVis@3647 order — C14's premise confirmed); overlayHost 892-897; visibleBand 3602-3614; embed.js parent-RO + pagehide teardown 67-84; py `_OVERLAY_FRAME` z-2147482000/no-sandbox, sizer `m()` pointerEvents writes, Done reparent+drag at z-2147483000; index.html:162/212/277-279 lying "Hide" labels and the ✕; style.css 453/771-773 rotates, 445/761 transitions, 747-748 mode-neutral hide, 672 `#doc-controls`, 730 annotate gate, 1523-1530 about-line; floating-panel.js:112-118 labels, 27-28 vestigial grip (caller 3585); colorbar.js:14/69; notes-dock.js:13/49-54 (aria-expanded absent in overlay branch, confirmed)/296-302; C10 registration order About@2342 < main@2512 < More@3534, parent closer 3580, `closeAbout` trapped in a bare block 2321-2343; endStroke 1247 with unfiltered snip/marquee branches, gesturePointerId infra 132-136; SketchView down 2719 (no state guard) / move 2756 (pid-filtered) / up 2772 (unfiltered); open/lock escape surface 2235-2280 complete as claimed; updateContextBar 2354-2367; all 13 `classList.contains("overlay")` gates exactly as listed (incl. 2447 zoom lock); PREFS_KEY 3302 / A11Y_KEY 3306; CSP index.html:11 (no connect-src → falls back to `default-src 'self'` — backstop claim correct); lib.rs:960/970/2185, model.rs:20/327-328, py:36; py cfg dicts 307-308/319, no qid today; about-wrap/about-line merges 3489-3490/3513; chrome.css:365 `width:140px`, 239-241 parent-viewport geometry, 22-32 dead block, 229, 375-vs-114; applyPrefs pre-reparent 3461; wireSaveLoop embed.js:22; revealNotes 1534-1536; snip clipboard 1630-1635; copyImageToClipboard 2911; per-clipping copy 2955-2960. `grep -c body.overlay style.css` = **127** — record this number in the C2 review contract as the reconciliation baseline.

## Required changes

**R1 (Batch A — false precedent).** "CSS clip-path … same pattern as `embed.js:48`" is wrong: there is **no clipPath anywhere in the tree** (grepped app.js/embed.js/style.css). embed.js:48 is the `frameElement.parentElement` wrap-access pattern. Rewrite: the same-origin `window.frameElement` access precedent is embed.js:48; writing `frameElement.style.clipPath` is **new code with no in-tree precedent**. Left as-is, an implementer will hunt for a pattern that doesn't exist or copy the wrong thing.

**R2 (Batch A — irrecoverable-panel hole).** Dodge triggers are calc-open / calc-drag-end / annotate-ON only. A student can then drag the rail (or notes) **into** the hole: it becomes invisible and non-hit-testable — exactly the irrecoverable-panel failure the user has vetoed before. Add: rail and notes **drag-end while a hole is active** as a dodge trigger (same ~200ms debounce; hook `makeFloating`'s `onChange` / the notes drag commit). Also make explicit in the spec: (a) one `syncHole()` at module init — the calc may already be open before Annotate; (b) the parent `ResizeObserver` observes **both** the panel and the overlay frame (the frame grows via `resizeOverlay`, which shifts hole coordinates).

**R3 (Batch C1 — double-encoding hole).** The validator checks `url.pathname` for `..` segments, but `?file=%2Fpl%2F%252e%252e%2Fx.pdf` survives one `searchParams` decode as literal `%2e%2e` in the pathname — no `..` to find, and the server decodes again. Add a mandatory step: run the `..`-segment and `/pl/`-prefix checks on `decodeURIComponent(url.pathname)` as well (treat a decode throw as invalid), and add the `%252e%252e` probe to §9.3. CSP/PL remain backstops, not the fix.

**R4 (Batch E — basename is wrong).** PL QIDs can be nested directories (`questions/exams/mt1/q3`); `os.path.basename(question_path)` collapses `mt1/q3` and `mt2/q3` to the same `"q3"` — silently recreating the collision this batch exists to kill, inside one course. Spec change: derive qid as the path **after the `/questions/` segment** (full relative path, `/`→`.`-sanitized or similar), falling back to basename only if the marker is absent; keep the composite with `name` and the missing-qid → current-key fallback. This also largely retires user-question E(2) — residual cross-course collision now requires two courses sharing a full nested QID path; accept and document.

**R5 (Batch B ride-along 3 — hallucination trap).** Specify placement: the `gesturePointerId` filter applies only to the **snip/marquee/select branches**, after the unconditional bookkeeping (`activePointers.delete`, `penActive` reset) — those lines must keep running for every pointer or palm-rejection accounting breaks. A top-of-function early-return is the obvious wrong implementation.

**R6 (Batch C1 — record, no code).** The "no file-drop-open" claim is true (app.js:3007-3025 is internal note reordering, gated on `dragFromIndex`), but a file dropped on the page hits the **browser default** and navigates the tab away from the locked tool. Out of scope — state it in the lock's escape-surface paragraph so adversarial review doesn't re-litigate it.

## Open questions: USER vs SDM

**Genuinely USER (do not proceed without):**
1. Batch C: Save-visible / Resume-hidden / Export-visible split, and acceptance of the affordance-only (bypassable) lock — policy calls on exam material.
2. Batch C: Lumetta coordination — the `?file=` link edit is external and gates C1's activation.
3. Batch E: deploy timing (one-time layout reset for every student — calendar call).
4. Batch F: item-12 parent-realm bar geometry, and whether Phase 1 flips this semester at all.
5. Batch B glyphs — nominally mine, but the user has strong UI taste: present my rulings below as decided-unless-vetoed at sign-off (one line, not a discussion).

**Ruled now (SDM authority):**
- B(a) minimise glyph: **low bar `M5 16h14`** — centred reads as minus/remove.
- B(b) expand glyph: **diagonal expand arrows** — matches the existing 2px-stroke set; Windows-restore double-square is heavier at 16px and connotes window management.
- B(c): **defer** the dead `#topbar` fp-rule deletion (agree with plan; keep the diff single-purpose).
- C FOUC: **ship the tiny `'self'` sync script** — a 160ms classic flash on an exam-reference tab is the kind of "slop" the user rejects, and the script is ~5 lines.
- D(1): **no preview/confirm dialog** — paste is deliberate; ✕ is the take-back.
- D(2): **defer** auto-focus-on-Annotate — parent focus-steal/scroll risk outweighs saving one click.
- D(3): **empty caption** when both clipboard flavors present.
- D(4): **"＋ Paste"** contingent on the 550px header-fit check at implementation — this is measurable, not a user question; only escalate if it doesn't fit.
- E key shape: **ruled via R4** (path-after-`/questions/`); only the timing question remains for the user.

## Notes
- The plan correctly acknowledges CLAUDE.md §0.1's local-Docker stage is inoperative and substitutes rsync → user push → hosted verify; have the user ack that substitution once at the next sign-off so the process deviation is on the record.
- Batch A's probe must run with the Calculator actually enabled on the test assessment and in the exam-like page chrome — the plan says this; treat it as a hard precondition, not advice.
- Anchor-drift discipline (re-grep at batch start) stays mandatory; every number above is v154.

---

# PART 2 — MASTER PLAN (as synthesized; apply R1-R6 amendments above)

# Scribble — Next Batches Master Plan (post-v154)

All file:line anchors verified against the committed v154 tree (`0c1c3b5` on top of `d1f55ab`). Anchors WILL drift as batches land — re-grep every anchor at the start of each batch; treat the cited line as "where it was at v154," not gospel. Version numbers are assigned sequentially at implementation time starting at **v155**; ignore any hard-coded version in the per-batch notes below (each research doc claimed "v155" for itself).

## 0. State of the world

- **Shipped (committed, deployed to both courses at v154):** cursor tool-restore via `lastDrawTool` in the annotate observer (`app.js:3632-3643`), unified panel clamps + pointerId hardening, About popover + `#about-line` attribution chip in the rail (`app.js:3513`, `index.html:340`, `style.css:1522-1530`).
- **Gated dark:** `PHASE1_CHROME_REPARENT = false` (`app.js:114`); `chrome.css` is untracked, untrusted, and excluded from deploy (`prairielearn/deploy.sh:25`).
- **Verification reality:** hosted PL only, user's Chrome, overlay iframe <900px (real width 550-800px). Local Docker is dead — the CLAUDE.md §0.1 "local first" stage is currently inoperative; the gate is: rsync both course copies → **user pushes/syncs** → live-verify hosted → user confirms.
- **Class repo:** `pl-uiuc-ece498sl` at v154 (verified `clientFilesCourse/scribble/app.js:6`). Element: `prairielearn/example-course/elements/pl-scribble/pl-scribble.py` (+ class-repo mirror).
- **Open review debts:** C10 (Escape layering), C14/C15 (Phase-1-only), plus the calculator click-eating defect (#13) observed live.

## 1. Batch order + rationale

| Batch | Contents | Prereqs | Est. size | Risk |
|---|---|---|---|---|
| **A** | #13 Calculator click-eating (clip-path hole + panel dodge) | Live DOM probe (§9.1) run first, in exam-like mode | New ~150-line module + small embed.js/app.js touches | Medium (parent-DOM coupling; fail-open design caps downside) |
| **B** | #8 Icon/label standard (retire the chevron) + small-debt ride-alongs: C10, sketch multi-contact guards, endStroke pointer filter, dead `grip` option | None | ~10 files, mostly mechanical | Low (C10 listener-order reasoning is the one subtle bit) |
| **C** | Reference tool: #15 `?file=` auto-open+lock → CSS split → #11 UI unify + #3 attribution. Internal order **C0 recon → C1 → C2 → C3 is strict** | C0 recon; Lumetta link edit (external) to activate C1 | Largest non-Phase-1 item; 3 version bumps | Medium-high (C2/C3 touch shared overlay CSS/JS) |
| **D** | #12 Paste image into notes | None (Rust groundwork already shipped) | JS-only, ~4 files | Low-medium (clipboard permission UX) |
| **E** | Per-question prefs key (`qid` from `question_path`) | None | 1 py touch + 1 app.js line | Low (but user-visible one-time layout reset + element deploy) |
| **F** | Phase 1 chrome reparent resume (chrome.css hand-port + realm fixes + C14/C15) | ALL of Blocks 1-3 in §7; consumes the C15 ledger from B and C; NO-GO list clean | Large; full pipeline | High (the one batch that can break the whole overlay) |

**Order justifications / deviations from the brief:**
1. **Small-debts split across B and E.** The prefs-polish research bundled everything into one batch; this plan puts the pure-bundle items (C10, sketch guards, endStroke, grip cleanup) into B and keeps the prefs-key change as its own batch E, because E is the only item that (a) touches `pl-scribble.py` (different deploy artifact, both course repos' `elements/`) and (b) visibly resets every student's saved panel layout — it deserves its own sign-off and its own rollback boundary. The two halves are deploy-order-safe by construction (see §6).
2. **C1 and D are order-independent.** D can ship before or in parallel with C's later sub-batches if the user wants paste sooner; snip→clipboard already works today (`app.js:1630-1635`, `2955-2960`). Only the order *inside* C is strict.
3. **A's probe and C's C0 recon share one live session** — both are read-only console work on hosted PL; do them together to save a session.
4. **chrome.css is edited exactly once, in F.** The icons research suggested mirroring its rules now; overruled: the file is untrusted, needs a full rule-by-rule hand-port in F Block 2 anyway, and edits to it have zero live effect while gated and deploy-excluded. Instead, batches B and C **append to the C15 ledger** (§7, Block 2) and F applies it all in one reviewed pass.

---

## 2. Batch A — #13 Calculator click-eating

**Objective.** PL's Calculator is a floating panel (with a `<math-field>` + keypad) that overlaps the question card. The overlay iframe (`_OVERLAY_FRAME`, `pl-scribble.py:100-108`) sits at z 2147482000 and goes `pointer-events:auto` for the whole annotate session (sizer `m()`, py:134); the calc stacks below it, so every click on its keypad hits our canvas — confirmed live: we drew ink across the keypad. Two defects: stolen clicks, and our ink painting over the panel (even idle — idle iframe is click-through but still painted on top).

**Settled decisions (rationale distilled):**
- **Detection from inside the iframe via `window.parent` — bundle-only, no py change.** Same-origin parent access gives identical capability to a parent script; proven precedents: `overlayHost()` (`app.js:893-897`), parent-realm `ResizeObserver` + `pagehide` teardown (`embed.js:~67-84`, teardown verified at 79-84), `visibleBand()` parent peek (`app.js:3602-3614`). Deploy = rsync + version bump. Adding this to the py's string-embedded sizer script was rejected: unversioned, unmaintainable, still needs observers.
- **Two-tier detection:** (1) pinned selector from the live probe (§9.1 — **unknown today, must be pinned first**); (2) fallback: any parent `math-field` NOT inside `.pl-scribble-wrap` → walk to the outermost non-static-positioned ancestor below `<body>` → require rect overlap with the frame and area > 0. Result is a **list** of panel rects. Do NOT use `offsetParent === null` as a visibility check (null for `position:fixed`) — use rect area + computed display/visibility.
- **Reaction: CSS `clip-path` evenodd-polygon hole punched in the frame element** (`window.frameElement.style.clipPath`, same pattern as `embed.js:48`). Clips **both painting and hit-testing**, independent of stacking contexts. Rejected alternatives: full `pointer-events:none` (kills drawing; fights `m()`'s `pointerEvents` writes at py:134/165 — kept only as last-ditch fallback), parent pointermove hand-off (parent gets no moves while pointer is over our capturing iframe; first touch tap has no pre-hover), z-demotion (stacking-context-topology-fragile — the same trap that forced the Done-button reparent, py:137-141).
- **Hole applied whenever the calc is open, regardless of annotate state** — hit-test-neutral when idle, but stops previously-drawn ink painting over an open calc. Fully decouples from `m()`.
- **Observers:** parent-realm constructors (`pw.MutationObserver` on the panel's mount parent for open/close and on the panel for `style`/`class`; `pw.ResizeObserver`; parent `scroll`/`resize` `{passive:true}` — load-bearing only if the panel is `position:fixed`), all funneling into one rAF-coalesced `syncHole()`. §10-rule-4 compliant. Teardown on `pagehide` per `embed.js:79-84` (PL panel-swap safety).
- **Mid-stroke coherence is free:** pointer capture keeps an in-flight stroke drawing across the hole (ink hidden under the panel until close); a stroke cannot *start* in the hole — the calc wins, which is the point.
- **Fail-open:** NaN/zero-area/no-overlap → clear `clipPath` entirely (today's behavior, never a corrupt clip). Clip assignment throws → `pointerEvents:'none'` on the frame while panel open, logged once.
- **Rail/notes dodge (they live inside the iframe; a half-clipped rail looks broken):** one-shot `dodgeRect(el, holeRect, band)` — >50% overlap → translate to nearest free spot in `visibleBand()`; nowhere fits → leave it (clip wins). Triggers: calc open, calc drag-end (~200ms debounce), annotate-ON (beside `clampRailOnShow(); clampNotes();` at `app.js:3644-3645` and boot catch-up at 3653). Never scroll-coupled. Signature `(el, win)` like `clampFixed` so it survives a Phase-1 flip (a parent-realm rail escapes the clip and outstacks the calc — the dodge then becomes its only mitigation; noted in the C15 ledger).
- **Done button unaffected:** parent `<body>`, z 2147483000 > calc, not in the iframe, already draggable (py:157-164).

**Steps:** (1) run §9.1 probe live, pin selector/position/z/lifecycle/evenodd/scale; (2) new `scribble/web/calc-dodge.js` (~150 lines, injected deps); (3) `embed.js` overlay branch: init with `{pw, wrap, frame}` in the try block, extend the pagehide teardown; (4) `app.js`: import beside :27-28, dodge calls at 3644-3645/3653, version bump (no Rust → no rebuild, but bump the glue `?v=` with everything per convention); (5) no py change; (6) review → rsync both courses → user pushes → live-verify.

**Open questions for user:** none — probe outcomes and SDM critique resolve the technical unknowns.

**Risks:** PL markup drift (fallback; if both miss, behavior degrades exactly to today + one console warn); evenodd unsupported (probe tests live; keyhole-polygon fallback ready); scaled/transformed ancestor breaks px mapping (probe `scale1to1`; `visibleBand()` already bets on 1:1 in production); one-frame-stale hole during fast scroll (cosmetic); CBTF page chrome may differ from instructor preview — **run probe and verification in the mode the exam uses**.

**Verification (hosted, <900px, `APP_VERSION` confirmed first):** (1) calc closed: full regression, `clipPath` empty; (2) calc open + annotating: every keypad row clicks, math-field accepts typing, zero ink; drag calc fast / scroll / resize → hole tracks; (3) stroke dragged across panel keeps drawing, hidden under it, reappears on close; (4) rail/notes under calc → one-shot nudge, no jitter; (5) Done↔Annotate cycles with calc open: `lastDrawTool` restore intact, hole persists; (6) calc close → region drawable again; (7) Save & Grade panel swap: no observer errors, reload seeds; (8) touch/pen tap on keys if hardware available.

**Deploy:** bundle-only, both courses.

---

## 3. Batch B — #8 icon standard + small-debt ride-alongs

**Objective.** One vocabulary for collapse/minimise/hide: after this batch **zero chevrons remain in the app**, and labels stop lying (rail/cbar say "Hide" while actually minimising to a handle — verified `index.html:162` title="Hide"/aria "Hide the tools", `floating-panel.js:114` "Show/Hide the toolbar", `colorbar.js:14` "Show/Hide the colour bar"). Plus four small hardening items from the debt sweep.

**Settled decisions:**
- **Three semantics → three affordances:** minimise-to-handle = "＿" glyph (`<path d="M5 16h14"/>` — low bar; centred `M5 12h14` reads as minus/remove); expand-from-handle = diagonal expand arrows (`M15 5h4v4` / `M19 5l-6 6` / `M9 19H5v-4` / `M5 19l6-6`); ✕ reserved exclusively for full-hide (`#btn-notes-hide` `index.html:277-279`, `#help-close` — both already correct, untouched).
- **Glyph swap, not rotation:** both SVGs inside each button (`.ico-min`/`.ico-expand`), CSS-toggled off the existing collapsed classes. Initial HTML state correct with zero JS; kills the rotate transforms (`style.css:453`, `771-773`) — which are exactly the realm-fragile bits C14/C15 flagged (chrome.css never even had the rail rotate).
- **Canonical labels:** "Minimise the toolbar"/"Expand the toolbar", "Minimise the colour bar"/"Expand the colour bar", notes stays text-only "Minimise"/"Expand" (header MIN_W 318px, `notes-dock.js:13`; strip already whole-surface click-to-expand `notes-dock.js:296-302`). Add missing `aria-expanded` in the overlay branch of `setDockBtn` (`notes-dock.js:49-51`); explicitly remove the attribute in the Float/Dock branch.
- **No behavior changes** — only glyphs/labels/aria.

**Touch list:** `index.html:162` (rail-collapse two-glyph pair + labels), `:212` (cbar-collapse same); `style.css:445` (drop transform from transition), `:453` (rotate → glyph-swap under `#context-bar.collapsed`), `:761` (drop transform transition), `:771-773` (rotate → glyph-swap keyed on `#rail.fp-collapsed`); `floating-panel.js:114` label strings; `colorbar.js:14` label strings; `notes-dock.js:50-54` aria-expanded; `app.js:3512` comment.

**Ride-alongs (from the debt sweep — all pre-verified still present at v154):**
1. **C10 Escape layering** (~20 min). Registration order on `document`: About closer (`app.js:2341`) registers BEFORE the main keydown (`app.js:2512`); More closer (`app.js:3534`) AFTER (inside boot `.then`). So: About closer becomes conditional + consuming (`if (e.key==="Escape" && !aboutPop.hidden) { closeAbout(); e.stopImmediatePropagation(); }`); main handler's Escape branch (`2560-2567`) early-returns when `railHostDoc.getElementById("more-popover")` exists and is visible (main runs before More's closer; `railHostDoc` for Phase-1 survival); optionally make More's closer conditional+consuming for order-robustness. Parent-realm closer (3580) is a different target — untouched.
2. **Sketch multi-contact guards:** `SketchView.down()` (`app.js:2719`) add `if (this.state) return;` (second touch mid-stroke currently reassigns state and calls into Rust mid-gesture); `SketchView.up()` (`app.js:2772`) add pid filter (move() at 2756 already filters).
3. **endStroke foreign-pointerup guard** (`app.js:1247`): non-drawing branches (snip ~1255, marquee ~1263, select) accept ANY canvas pointerup — filter to `gesturePointerId` (infra at `app.js:132-133` exists since C1).
4. **Dead `grip` option cleanup:** caller `app.js:3585` passes `grip:` to `makeFloating`; option is vestigial (`floating-panel.js:27-28`). Drop both.

**Open questions for user:** (a) expand glyph — diagonal arrows (recommended) vs Windows-restore double-square; (b) minimise bar — low `M5 16h14` (recommended) vs centred; (c) dead `#topbar` fp-rule deletion (`style.css:748, 759-773, 801` — markup has no topbar fp controls) — recommend **defer** to keep the diff single-purpose.

**C15 ledger entries (applied in Batch F, not now):** the two glyph-swap rule pairs re-scoped `.scribble-chrome`; deletion of the cbar rotate at `chrome.css:229`; drop transform transitions at `chrome.css:221`.

**Risks:** transient re-learning (chevron→＿; covered by unchanged button position + labels); C10's fix depends entirely on the listener-registration-order reasoning above — **adversarial reviewer must independently re-derive it**; ride-along 3 must not break the legitimate marquee-commit path (reviewer focus item).

**Verification (hosted <900px + standalone; `APP_VERSION` first):** (1) overlay rail minimise → handle, `#about-line` hides (`style.css:1530`), expand-arrows glyph, labels + `aria-expanded="false"`; expand near right edge re-clamps (rAF clamp `floating-panel.js:126`); (2) prefs round-trip: boot `railFP.setCollapsed(true)` path (`app.js:~3588`) shows correct glyph+labels; (3) standalone: cbar cycles, `#rail-collapse` NOT visible (`style.css:747-748`); (4) notes overlay: strip contents, strip-click expands, aria flips; snip-while-minimised auto-expands (`app.js:1536`); (5) Option-B host-demo: Float/Dock text, NO aria-expanded; (6) read-only: nothing leaks; (7) C10: select marks → open About → Esc closes popover, selection survives; second Esc clears; repeat with More and with armed snip; (8) touch-emulation two-finger on a sketch; (9) 16px screenshot: glyph optical weight matches the 2px-stroke icon set.

**Deploy:** bundle-only, both courses.

---

## 4. Batch C — reference tool: #15 auto-open+lock, #11 UI unify, #3 attribution

Strict internal order: **C0 (recon) → C1 (#15) → C2 (CSS split) → C3 (#11+#3)**. Each sub-batch is its own version bump and its own review cycle. C1 is independently shippable.

**C0 — live recon (read-only, ~30 min, same session as Batch A's probe).** Right-click Lumetta's existing mt.pdf link on the live exam page → confirm the student-visible URL shape (assessment vs assessment_instance route); confirm a logged-in fetch of it from a `clientFilesCourse` page succeeds (same-origin credentials) + content-type; screenshot the current reference tool as "before". mt.pdf lives at `pl-uiuc-ece498sl/courseInstances/Sum26/assessments/test-scribble/clientFilesAssessment/mt.pdf`; the tool serves from `clientFilesCourse/scribble/` — **different URL trees, same origin**, so a bare relative filename can't reach it. **OPEN until C0 runs:** the exact route shape freezes the validator regex.

**C1 — #15: `?file=` two-tier validator + lock.**
- **Tier 1 (primary): full URL-encoded same-origin path passed whole.** Validation, every step mandatory: (1) decoded value starts with exactly one `/` (kills schemes and `//host`); (2) `new URL(raw, location.origin)`, assert same origin; (3) normalized pathname starts `/pl/`, contains **no `..` segment (explicit check)**, contains a `/clientFiles(Course|Assessment|Question)/` segment; (4) leaf matches `^[A-Za-z0-9_.\-]+\.(pdf|html?)$`. Fetch same-origin-credentialed → blob → `new File` → `routeOpen` (`app.js:~2253`). Rationale: `clientFilesAssessment` is gated by PL's assessment access rules — copying mt.pdf into course-wide-readable `refs/` would leak exam material pre-window and create drift; passing the path whole keeps PL the single access-control authority. CSP (`index.html:11`, `default-src 'self'`, no `connect-src`) is a hard second layer — even a validator bug can't reach another origin.
- **Tier 2:** bare filename (no slash, same leaf regex) → `refs/<name>` in the bundle, for non-sensitive standing references.
- **Failure policy:** invalid `?file=` → kind status, **no lock** (normal Open UI). Valid-but-failed fetch (403 pre-window, 404) → kind error **and remove `body.locked`** (no dead locked tool). `?file` + `?open` → lock wins.
- **Lock scope — affordance-only, bypassable by typing bare index.html (user accepted; restate at sign-off):** `body.locked` hides `#btn-open`/`#btn-load` (display:none); JS early-returns in the Open click handler (`app.js:2235`, which also neutralizes the `?open` new-tab escape at 2242) and `autoOpenIfRequested` (`app.js:2267`). Escape surface is exactly those + `#btn-load`/`#file-json` (2249, 2276-2280) — verified: no global file-drop-open handler, no Ctrl+O shortcut. **Save and Export PDF stay visible; Resume (JSON load) hidden** — IDB autosave restores prior annotations on reopen and is the sanctioned resume path.

**C2 — mechanical CSS split, zero intended behavior change.** `openOverlay` (`app.js:~908`) adds `chrome-merged` **alongside** `overlay`; look-rules rename `body.overlay …` → `body.chrome-merged …` in place (same order, same specificity). Because the overlay carries both classes, **a renamed rule still matches the overlay — the rename is provably non-regressive even if incomplete**; the only hazard is mis-classifying a rule. The MOVE/STAY tables from the research are the review contract (MOVE: `style.css` 680-696, 705-707, 717-723, the Hairline+ block 813-940 in full, 869-870, 1523-1530. STAY on `body.overlay`: 643-647, 652-654, 657, 658-672 — **672 `#doc-controls` hidden is the heart of the policy split**, reference keeps zoom/nav — 621, 699-703, 710-712, 725, 730, 750-801 floatability suite; 747-748 mode-neutral default keeps grip/collapse hidden in reference). Reviewer runs a before/after `grep -c body.overlay` audit + pixel-compare overlay screenshots at <900px.

**C3 — #11 merged reference UI + #3 attribution.**
- Extract `app.js:3480-3543` into `buildMergedBar(opts)` **returning `{moreBtn, morePop, closeMore}`** — the gated Phase-1 block (3555-3581) and the overlay continuation close over them (C14/C15 stay live debts; `PHASE1_CHROME_REPARENT` untouched). Overlay branch calls it then runs 3546-3654 unchanged. Reference branch (non-embedded, valid `REF_FILE`): `buildMergedBar({fileActions:true})` + migrate `#btn-thumbs` onto the row and `#btn-save`/`#btn-load`/`#btn-export` into More; skip makeFloating/clamps/observer entirely.
- Gate widenings: `updateContextBar`'s `overlay` const (`app.js:2354-2367`) and `colorbar.js:69`'s early-return (verified: `if (document.body.classList.contains("overlay")) return;`) become `mergedChrome()` = overlay || chrome-merged. **All other overlay gates stay `overlay`** (935, 1536, 1564, 1638, 1830, 2119, **2447 zoom lock — verified**, 3312, 3664, `notes-dock.js:17`).
- New `body.chrome-merged:not(.overlay)` block: `#main` top-padding/height for the fixed bar; `body.locked` hide rules.
- FOUC: CSP has no `'unsafe-inline'` scripts → the overlay's sync-tag trick needs a tiny separate `'self'` sync script, or accept a ~160ms classic flash. **Recommend the tiny script** (SDM ratifies).
- #3 rides free: `#about-wrap` moves with the merge (`app.js:3489-3490`), `#help-about` footer is mode-neutral, `#about-line` rename is in the MOVE list. C10 is fixed in Batch B, before this lands.
- Merged UI triggers on valid `?file=` only — bare index.html keeps the classic UI (the old entry point disappears when Lumetta edits his link, which #15 requires anyway).
- Prefs: no collision — reference/standalone uses bare `"scribble.prefs.v1"`, overlay questions get the suffixed key (`app.js:3302`, verified).

**Open questions for user:** (1) confirm the Save-visible / Resume-hidden / Export-visible split; (2) confirm affordance-only lock is acceptable (it is bypassable); (3) FOUC: tiny sync script (recommended) vs accept the flash; (4) **coordinate with Lumetta** — he must edit the exam-page link to add `?file=` at C1 ship; this is the only piece we don't control.

**Risks + mitigations:** CSS mis-classification (tables = review contract + grep audit); `buildMergedBar` closure breakage silently killing the dark Phase-1 path (return the trio; re-flag C14/C15); locked+failed-fetch deadlock (auto-unlock mandatory; test 403 pre-window specifically); validator holes (`..`, `//host`, `%2e%2e`, backslashes — test each; CSP is backstop, not primary); URL couples to course-instance ids (acceptable; tier-2 exists for stable material); narrow reference windows — rail-scroll (moved 937-940) must absorb thumbs+More additions at ≈800px; IDB autosave restore must still offer on the auto-opened mt.pdf.

**Verification:** C1 — `?file=<assessment path>` opens with no picker; Open/Resume absent; `?open` appended → nothing; each validator-hole probe → kind error + unlocked UI; bogus name → error + Open returns; annotate→reload→autosave restore; Export PDF; bare index.html unchanged; one overlay question spot-checked. C2 — overlay before/after screenshots identical (bar, More, collapse/drag/clamp, about chip, annotate gate, read-only); standalone unchanged. C3 — ONE merged bar; page-nav/zoom/scroll-mode/thumbnails live on a multi-page PDF; ALL tools incl. shapes/snip; persistent colour strip; More = Larger/Help/palette/Save/Export; Notes+splitter; ⓘ+chip+Help footer; zero console errors (no frameElement/parent throws); full overlay regression at <900px + Option-B host-demo via a local static server (CLAUDE.md §4 three-mode rule — host-demo needs no Docker).

**Deploy:** bundle-only per sub-batch, both courses; mt.pdf stays where it is.

---

## 5. Batch D — #12 paste an image into notes

**Objective.** Student snips from the reference tab (snip already best-effort-copies PNG to clipboard, `app.js:1630-1635`; per-clipping "Copy image" at 2955-2960) and pastes into the question's notes.

**Settled decisions:**
- **Zero Rust changes.** `App::add_pasted_clipping(png_b64, caption, disp_w, disp_h)` verified at `lib.rs:960` (`source_page: None`; `disp 0` ⇒ natural size, test at lib.rs:2185); `valid_b64_png` at `model.rs:327`, `MAX_CLIPPING_B64 = 2 MiB` of b64 chars (`model.rs:20`); render side already tolerates source-less clippings (`app.js:2922-2978`). Server budget: `MAX_ANNOTATION_BYTES = 16 MiB` (`pl-scribble.py:36`) ≈ 8-10 max-size pastes.
- **Button primary, Ctrl+V accelerator.** A `paste` event needs iframe focus; returning from the reference tab leaves focus on the parent page, so Ctrl+V fires in the parent and we never see it. `＋ Paste` button (`#btn-paste-img`) in the notes header between ＋ Draw and Float (`index.html:~275-276`, verified). **No parent-document paste listener** (violates minimal-touch; C14/C15 territory).
- **Button handler:** feature-detect `navigator.clipboard?.read` BEFORE anything async (missing → status pointing at Ctrl+V); call `read()` **synchronously in the click handler** (WebKit consumes user activation at the first await); pick first `image/png` item (Chrome/Safari transcode) else any `image/*`.
- **Document-level paste listener,** active when `docOpen() && !READONLY`, guards in order: (1) modal open (`.modal-overlay:not([hidden])`, same as keydown:2529) → ignore; (2) target matches text-field selector (same as keydown:2514) AND clipboard has `text/plain` → return WITHOUT preventDefault (native text paste untouched); (3) image item present → `preventDefault()` + pipeline (image-only clipboard in a textarea becomes a successful paste — strictly better than native no-op); (4) otherwise nothing, no nag. Notes-pane visibility is not a gate: success → `renderNotes(); revealNotes()` (`app.js:1534`, verified — also un-collapses the floating pane).
- **Pipeline** (helpers beside `copyImageToClipboard`, `app.js:2911` verified): 32 MiB early blob guard → `createImageBitmap` with scriptless `<img>`-decode fallback (rasterizes SVG, revoke URL in finally) → downscale ladder long-edge 2000px, ×0.7 retries until b64 ≤ 2 MiB (JS-side check against the same constant so the user gets a friendly message, not the Rust error), floor ~300px → `add_pasted_clipping(b64, "", 0, 0)` in try/catch (Rust "notes are full" surfaces via `status`, same pattern as `app.js:3057-3059`) → renderNotes/revealNotes/status. **No confirm dialog** (a paste is deliberate; take-back = the block's ✕).
- **Persistence free:** `wireSaveLoop` (`embed.js:22-44`) polls the Rust dirty flag; `push_clipping` sets dirty (`lib.rs:~992`). No embed.js/notes-dock.js changes.
- **Security (§7 holds):** blob-only, never fetch clipboard URLs, `text/html` flavors never parsed; every paste decoded to pixels and re-encoded by our canvas (strips EXIF/polyglots); Rust re-gates on insert AND on every load (`model.rs:384`); reads only on explicit gesture, never poll, never log content; CSP unchanged (`img-src blob:` already allowed).
- **Permission contingency (checklist-gated, not default):** overlay iframe is srcdoc with NO sandbox attribute (py:101-107) ⇒ same-origin ⇒ default `clipboard-read` allowlist (`self`) should cover it. **Only if** live Chrome throws a permissions-policy NotAllowedError: add `allow="clipboard-read; clipboard-write"` to `_OVERLAY_FRAME` (py:101) and `_FRAME` (py:90) — that turns this into an element deploy.

**Failure matrix (statuses, all friendly):** empty/text-only via button → "No image on the clipboard…"; permission denied / `read()` unsupported / not-focused race → "…press Ctrl+V instead"; ladder exhausted → "too detailed — crop it smaller"; undecodable → "Couldn't read that image."; 500-block cap → Rust message via status; modal open → ignored; READONLY → button hidden (`style.css` readonly list ~627-635) + listener gated.

**Open questions for user:** (1) confirm no preview dialog (recommend none); (2) auto-focus the iframe on Annotate so Ctrl+V works immediately after tab-switch? (focus-steal/scroll risk in the parent — recommend defer); (3) caption-from-clipboard-text when both flavors present (recommend empty now); (4) label "＋ Paste" vs "Paste image" (550px header width decides — verify with Batch B's aria work already landed).

**Verification (hosted, Chrome, <900px):** the 11-item list — version check; snip-in-tab-2 → Annotate → ＋ Paste with permission prompt Allow (once, origin-attributed); prompt Blocked → hint + Ctrl+V works after clicking the pane; text-vs-image clipboard in a caption textarea; OS screenshot + >4000px photo through the ladder; cap/reject statuses; ≥2s autosave → Save → reopen → submit read-only render (no page badge, lightbox works, no Paste button); **notes header fits at 550px** (grip+Notes+＋Text/＋Draw/＋Paste/Float/✕, plus collapsed strip); shortcuts unaffected; all three modes boot (standalone-HTML: paste requires focus outside the viewer iframe — expected, document it).

**Deploy:** bundle-only expected, both courses; py only on the contingency (then it's an element deploy to both `elements/` dirs).

---

## 6. Batch E — per-question prefs key

**Objective.** `PREFS_KEY = "scribble.prefs.v1" + name-suffix` (`app.js:3302`, verified) with `answers-name` defaulting to "scribble" means panel-layout prefs are shared across questions. Make them per-question.

**Settled decisions:**
- **Option 2: element change (recommended).** Verified against PL source (freeform.ts `getContextOptions`): `data["options"]["question_path"]` reaches element code every phase (`variant_id` rejected — variant-scoped). Verified no `qid`/`question_path` in py today. Spec: py derives `qid = os.path.basename(data["options"].get("question_path", "")) or None`, adds `"qid"` to **both** cfg dicts (readonly branch py:307-308 and py:319). `app.js:3302` becomes `"scribble.prefs.v1." + (qid ? qid + "." + name : name)` — composite so two elements in ONE question (distinct names) stay separate; standalone (`__SCRIBBLE_PL` undefined) keeps the bare key.
- **Option 1 (per-question `answers-name`) rejected:** renaming orphans prior submissions — the seed lookup (py:~323) reads the new name; students silently lose saved work mid-semester. Also manual/forgettable.
- **Deploy-order-safe by construction:** app.js treats missing `qid` as the current key; py adds it later. Either artifact can land first without breakage.
- `A11Y_KEY` (`app.js:3306`, verified) stays intentionally shared — do not namespace.
- Old shared key orphaned in localStorage — harmless bytes, never read again.

**Open questions for user:** (1) accept the **one-time layout reset** on every question's first visit post-deploy (time it against the semester calendar); (2) basename collision across two courses sharing a question-dir name on one PL origin — acceptable for layout prefs, or use the last two path components?

**Verification:** two overlay questions — drag rail on one, other unaffected; reload each restores its own; readonly panel unaffected; standalone key unchanged; single-question page with the default name still round-trips.

**Deploy:** py → `elements/pl-scribble/` in BOTH course repos + bundle bump for the app.js line; user pushes both.

---

## 7. Batch F — Phase 1 chrome-reparent resume

**Gate state:** `PHASE1_CHROME_REPARENT = false` (`app.js:114`, verified); reparent block `app.js:3547-3581`, runs only in `!READONLY` (`app.js:3546`, verified). **Already done — do not redo:** MF-A (`clampFixed(el, win)` + `{win}` throughout `floating-panel.js:17-136`), round-1 realm-query fixes (`activeTool` :121, `updateContextBar` queries, shortcut lookup :2572, `applyBig` :3222, `toggleHelp` :3282, `savePrefs` :3353-3360, `railEl.querySelector` :3585), MF-F `syncRailVis` (:3594-3596), More-popover parent closers (:3577-3580); the `lastDrawTool` observer is reparent-safe by construction (watches the iframe body, queries via `railHostDoc`).

**Block 1 — packaging:** (1) commit chrome.css only AFTER the Block-2 hand-port; (2) remove the `--exclude 'chrome.css'` at `deploy.sh:25` (verified present) and rsync both courses; (3) re-verify injection on hosted PL — the CSP probe validated an inline `<style>`, the code uses a `<link>` (:3557-3561); assert with `getComputedStyle` on a rail property, never absence-of-error (CSP stripping is silent); `<link>` blocked → fall back to fetched-text inline `<style>`; (4) version discipline incl. the chrome.css link tracking APP_VERSION (:3560).

**Block 2 — chrome.css hand-port (file is UNTRUSTED; port rule-by-rule, diff against style.css; do NOT re-run the generator):** confirmed-present defects: delete `width:140px` from `.scribble-chrome.big #rail` (chrome.css:365 — Larger crushes the bar); port `.fp-grip`/`.fp-collapse` base display+SVG rules (style.css:750-773 — else invisible grip + black-wedge glyph); port `.fp-dragging` (style.css:786-790) and the full `#rail.fp-moved` (style.css:778); fix the focus-ring EOF override order (chrome.css:375 vs :114); port About rules (style.css:1507-1514, 1522-1530 re-scoped — C15 CSS half); port touch rules (style.css:795-796); full diff pass over 676-723/743-800/~804-940 translations + clean up generator artifacts + the dead vertical-rail base block (chrome.css:22-32). **Consume the C15 ledger** (Batch B glyph-swap rules; any Batch C additions). **Item 12 — parent-page geometry decision:** chrome.css:239-241's `position:fixed; top:4px; width:calc(100% - 8px)` spans the ENTIRE browser viewport in the parent realm, over PL's header — default placement is an SDM+**user** design call, decided BEFORE flipping.

**Block 3 — app.js realm fixes:** C14 (`syncRailVis()` before `clampRailOnShow()` in the show branch — currently 3644 runs before 3647, verified — and skip the `visibleBand` clamp when `railWin !== window`, since band coords are iframe-realm); re-apply `.big` to the host at reparent end (`applyPrefs` runs pre-reparent at :3461); namespace the singleton host per element instance + scope all rail queries to `railHostEl ?? document` (multi-question collision, :3563-3568 + :121/:2287-2289/:2572/:3353-3355); About parent-realm closers + hoist `closeAbout` out of its bare block scope (2321-2343) — else More/About mutual exclusion breaks cross-realm; `railHostDoc.activeElement` in both closers (:3517, :2325 — iframe `document.activeElement` is always wrong post-flip); decide keyboard-shortcut realm (mirror the :2512 handler on pdoc, or refocus the iframe after parent-side tool clicks) + finish the full `document.addEventListener` realm audit; version geometry prefs (`railFloat` → `railFloat2`; mixed-realm coords through one key is the MF-E hazard); pick distinct z values (recommend host 2147482900 < Done 2147483000; calc at ~2147482000 stays below the rail — **verify coexistence with Batch A's clip**: the parent-realm rail escapes the clip, the Batch-A dodge `(el, win)` is its mitigation); host stays on `pdoc.body` (transform-ancestor lesson, py:137-142).

**Block 4 — scope guards:** step **1a only** — notes pane (1b: MF-C/D/E) must NOT ride; full XHIGH pipeline; re-test C10 after the closers move realms.

**NO-GO list (do not flip if ANY holds):** chrome.css untracked/excluded/un-ported; the `getComputedStyle` injection assert fails; C14 unfixed; `.big` re-apply or multi-question namespacing unfixed; MF-B realm audit (About closers, activeElement, shortcuts) incomplete; local-style verification only; notes pane included; item-12 geometry decision unsigned.

**Verification matrix:** V1 standalone PDF (no reparent, no `body.overlay`); V2 standalone HTML (draws — `docOpen()` invariant); V3 host-demo catch path (:3582 — rail in-iframe as v154); V4 hosted <900px primary (viewport-pinned bar while scrolling, computed-style assert, drag/clamp/cancel, collapse+glyphs, More+About from BOTH realms incl. mutual exclusion, Larger with no 140px crush, Done→Annotate `lastDrawTool`, shortcuts after clicking a parent button); V5 resize/zoom clamps; V6 multi-question page; V7 calculator coexistence; V8 read-only (no reparent); V9 prefs migration (`railFloat2`); V10 cache (stale parent-cached chrome.css vs new JS is a NEW failure mode of the recorded class); V11 touch.

**Open questions for user:** the item-12 default geometry (bar over PL's header vs clamped/bottom-anchored), and whether Phase 1 flips this semester at all.

---

## 8. Standing constraints (every batch)

- **Process (CLAUDE.md §0/§0.1):** plan → SDM critique → **user sign-off** → implement → read-only adversarial review (reviewers NEVER edit the tree — a Cycle-2 agent once reverted lib.rs) → fix → live-verify. XHIGH agents for substantive changes.
- **Verification reality:** hosted PL, user's Chrome, **iframe <900px** (wide passes miss width-gated CSS bugs — recorded lesson). First act of every session: confirm loaded `APP_VERSION` in-console (stale-cache mistakes log). Local Docker is dead; host-demo via local static server covers Option-B (§4 three-mode rule).
- **Deploys:** bundle rsync to BOTH courses (`prairielearn/deploy.sh`; note it also excludes `embed/` and currently `chrome.css`); **the user pushes/syncs** — commits as the user, sole author, **no co-author trailer**. py changes are element deploys to both repos' `elements/`. Always `git fetch`/rebase the class repo first (the prof pushes to the same main).
- **Version bumps every web change:** `APP_VERSION` (`app.js:6`) + every `?v=` in `index.html` + module-import `?v=` strings + the **hand-bumped** `./pkg/scribble.js` glue import (CLAUDE.md rule 2). Rust change ⇒ rebuild wasm first (rule 3), then `cargo test` / clippy / fmt (rule 8).
- **Security invariants (§7):** no user content as HTML ever; colours/fonts from closed Rust enums; Rust validates all loaded JSON; sandboxed no-script HTML iframe; `style-src 'unsafe-inline'` stays ON PURPOSE; never `'unsafe-inline'` in `script-src`. `docOpen()` gates interaction, never `pdfDoc` (§5). No scroll-jacking; passive listeners + rAF coalescing (§10).
- **Realm discipline:** parent-DOM observers use parent-realm constructors + `pagehide` teardown (`embed.js:79-84` pattern); anything that could outlive the flip takes `(el, win)`-style parameters; `railHostDoc` for rail queries. **C15 ledger:** any batch touching style.css rules with chrome.css counterparts appends the delta to the ledger (seeded in §3/§4); Batch F Block 2 applies it once.
- **Anchor drift:** all line numbers here are v154; re-grep at batch start.
- **UI taste (memory):** no cramped "slop" layouts; panels must be recoverable (collapse-to-handle, never irrecoverable hides); ASK before assuming on ambiguous scope.

## 9. Live-probe snippets appendix

### 9.1 Calculator DOM probe (Batch A day one — TOP-frame console, hosted overlay question, Annotate ON, calc OPEN, exam-like mode)

```js
(async () => {
  const out = {};
  const frame = document.querySelector('.pl-scribble-overlay-frame');
  if (!frame) return console.error('no overlay frame on this page');
  const fr = frame.getBoundingClientRect();
  out.frame = { rect: fr.toJSON(), pointerEvents: getComputedStyle(frame).pointerEvents,
                scale1to1: Math.abs(fr.width - frame.offsetWidth) < 1 };  // false => transformed/scaled ancestor!

  // A) stacking-context ancestors (decides whether z-demotion could ever work)
  out.stackingAncestors = [];
  for (let n = frame.parentElement; n && n !== document.documentElement; n = n.parentElement) {
    const cs = getComputedStyle(n), why = [];
    if (cs.transform !== 'none') why.push('transform');
    if (cs.filter !== 'none') why.push('filter');
    if (cs.perspective !== 'none') why.push('perspective');
    if (cs.isolation === 'isolate') why.push('isolation');
    if (parseFloat(cs.opacity) < 1) why.push('opacity=' + cs.opacity);
    if (/paint|layout|strict|content/.test(cs.contain)) why.push('contain=' + cs.contain);
    if (cs.willChange !== 'auto') why.push('will-change=' + cs.willChange);
    if (cs.position !== 'static' && cs.zIndex !== 'auto') why.push('pos+z=' + cs.zIndex);
    if (why.length) out.stackingAncestors.push({ el: n.tagName + (n.id ? '#' + n.id : '') + (n.className ? '.' + String(n.className).trim().split(/\s+/).join('.') : ''), why });
  }

  // B) find the calculator: math-field OUTSIDE our wrap -> OUTERMOST positioned ancestor
  const mfs = [...document.querySelectorAll('math-field')].filter(m => !m.closest('.pl-scribble-wrap'));
  out.mathFieldsOutsideWrap = mfs.length;
  out.mathFieldsInsideWrap = document.querySelectorAll('.pl-scribble-wrap math-field').length; // false-positive check
  let panel = null;
  if (mfs[0]) for (let n = mfs[0].parentElement; n && n !== document.body; n = n.parentElement)
    if (getComputedStyle(n).position !== 'static') panel = n;
  if (!panel) { console.warn('PANEL NOT FOUND — is the calculator open? Report `out` anyway.'); return console.log(JSON.stringify(out, null, 2)); }
  const pcs = getComputedStyle(panel), pr = panel.getBoundingClientRect();
  out.panel = { tag: panel.tagName, id: panel.id, className: String(panel.className),
    selectorGuess: panel.id ? '#' + panel.id : panel.tagName.toLowerCase() + '.' + String(panel.className).trim().split(/\s+/).join('.'),
    position: pcs.position, zIndex: pcs.zIndex, display: pcs.display, rect: pr.toJSON(),
    mountParent: panel.parentElement.tagName + (panel.parentElement.id ? '#' + panel.parentElement.id : ''),
    isBodyChild: panel.parentElement === document.body,
    header: (panel.querySelector('h1,h2,h3,h4,h5,h6,[class*=header],[class*=title]')?.textContent || '').trim().slice(0, 50) };
  out.calcToggleCandidates = [...document.querySelectorAll('button,a,[role=button]')]
    .filter(e => /calc/i.test((e.textContent || '') + e.className + e.id + (e.getAttribute('aria-label') || '')))
    .map(e => e.tagName + '#' + e.id + '.' + String(e.className).trim().split(/\s+/).join('.')).slice(0, 5);

  // C) evenodd clip-path support
  const t = document.createElement('div');
  t.style.clipPath = 'polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 25% 25%, 75% 25%, 75% 75%, 25% 75%)';
  out.evenoddClipSupported = t.style.clipPath !== '';

  // D) hit-test proof: who wins at the keypad now, then punch the hole and re-test (needs Annotate ON)
  const cx = (pr.left + pr.right) / 2, cy = (pr.top + pr.bottom) / 2;
  const name = (e) => e && (e.tagName + '.' + String(e.className).trim().split(/\s+/).slice(0, 3).join('.'));
  out.hitBefore = name(document.elementFromPoint(cx, cy)); // expect: IFRAME.pl-scribble-overlay-frame (the bug)
  const p = (v) => Math.round(v) + 'px';
  const x0 = pr.left - fr.left - 6, y0 = pr.top - fr.top - 6, x1 = pr.right - fr.left + 6, y1 = pr.bottom - fr.top + 6;
  frame.style.clipPath = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, ${p(x0)} ${p(y0)}, ${p(x1)} ${p(y0)}, ${p(x1)} ${p(y1)}, ${p(x0)} ${p(y1)})`;
  out.hitAfterHole = name(document.elementFromPoint(cx, cy)); // expect: a calculator element (the fix, proven live)
  frame.style.clipPath = '';

  // E) lifecycle watch: NOW drag the calc, then close+reopen it (20s window)
  console.log('DRAG the calculator now, then CLOSE and REOPEN it. 20s...');
  out.lifecycle = await new Promise((res) => {
    const ev = [];
    const mo = new MutationObserver(ms => ms.forEach(m => ev.push('attr:' + m.attributeName + '=' + String(m.target.getAttribute(m.attributeName)).slice(0, 60))));
    mo.observe(panel, { attributes: true, attributeFilter: ['style', 'class'] });
    const mo2 = new MutationObserver(ms => ms.forEach(m => { if ([...m.removedNodes].includes(panel)) ev.push('REMOVED'); if ([...m.addedNodes].includes(panel)) ev.push('RE-ADDED'); }));
    mo2.observe(panel.parentElement, { childList: true });
    setTimeout(() => { mo.disconnect(); mo2.disconnect(); res(ev.slice(0, 40)); }, 20000);
  });
  console.log(JSON.stringify(out, null, 2));
})();
```

**Interpretation gates:** `hitBefore` = overlay frame AND `hitAfterHole` = calc element proves the architecture live before any product code; `scale1to1:false` or a transform stacking ancestor forces re-planning the coord mapping; `evenoddClipSupported:false` switches to the keyhole polygon; `lifecycle` decides which observers carry open/close vs drag.

### 9.2 Version check (first act of every live session)

```js
// In the OVERLAY IFRAME console (or standalone page):
console.log('APP_VERSION =', APP_VERSION);  // must match the deployed bump before judging ANYTHING
```

### 9.3 Reference-tool recon (Batch C0 — TOP-frame console on the live exam page)

```js
// 1) Right-click Lumetta's mt.pdf link -> Copy Link Address. Note the route shape
//    (/pl/course_instance/<ci>/assessment/<a>/clientFilesAssessment/... vs assessment_instance).
// 2) From a clientFilesCourse-served page (the scribble tool tab), prove the fetch:
fetch('<PASTE THE COPIED PATH>', { credentials: 'same-origin' })
  .then(r => console.log('status', r.status, 'type', r.headers.get('content-type'), 'size', r.headers.get('content-length')))
  .catch(e => console.error(e));
// 3) Validator-hole probes for C1 verification (each must yield a kind error + UNLOCKED UI):
//    ?file=..%2F..%2Fsecret.pdf   ?file=%2F%2Fevil.com%2Fx.pdf   ?file=https:%2F%2Fevil.com%2Fx.pdf
//    ?file=%2Fpl%2F..%2Fadmin%2Fx.pdf   ?file=%2Fpl%2F%2e%2e%2Fx.pdf   ?file=x.exe   ?file=a\..\b.pdf
```

### 9.4 Overlay-regression grep audits (Batch C2 review)

```sh
# Before/after the rename — counts must reconcile exactly against the MOVE table:
grep -c 'body\.overlay' scribble/web/style.css
grep -n 'body\.chrome-merged' scribble/web/style.css
# Gate widenings are exactly two; everything else stays 'overlay':
grep -n 'classList.contains("overlay")' scribble/web/app.js scribble/web/colorbar.js scribble/web/notes-dock.js
```

**Explicitly OPEN items (not papered over):** the calculator panel's exact selector/position/lifecycle (Batch A probe); the mt.pdf student-visible route shape (Batch C0); evenodd support in exam Chrome (probe); Batch B glyph choices (a)/(b); Batch C FOUC treatment + Save/Resume/Export split + Lumetta link coordination; Batch D confirm-dialog/auto-focus/caption/label calls; Batch E reset-timing + key-shape; Batch F item-12 parent-realm geometry and the flip go/no-go itself.
---

# ADDENDUM (2026-07-17, post-Batch-A review) — C15 ledger entries

- **C5/Batch-A deviation:** `dodgeEl` in app.js hardcodes the iframe realm (holes are frame-relative,
  compared against iframe-viewport rects, clamped by the iframe `window.innerWidth`) — the plan's
  `(el, win)` signature was deliberately NOT shipped because with `PHASE1_CHROME_REPARENT=false` the
  parameterized path would be untestable dead code. **Batch F must add the realm translation**
  (offset holes by `frameElement.getBoundingClientRect()`, clamp against `railWin`) when the rail
  reparents — the dodge becomes the parent-realm rail's ONLY calculator mitigation there (the clip
  no longer covers it).
- Batch A review outcome: C1 (evenodd ring closures — HIGH, fixed), C2 (late/replaced drawer
  re-observation — fixed via syncNow re-attach), C3 (clip-support read-back + annotate-aware
  pointer-events restore — fixed), C4 (`frame.isConnected` teardown — fixed), C6 (multi-hole
  candidate filter — fixed). Full report: session 26903fa6 task wluabw83r.
- **Batch B review F2 (C15 ledger):** chrome.css never received the #8 glyph swap — port style.css's
  .ico-min/.ico-expand swap rules (cbar + rail variants) re-scoped `.scribble-chrome`, add the
  `.fp-collapse svg` sizing rule, DELETE the stale rotate (chrome.css:229) and the `transform` term
  in its transition (chrome.css:221). Without this a Phase-1-reparented rail shows BOTH glyphs unsized.

---

# ADDENDUM 2 (2026-07-17, user sign-off session) — BINDING user decisions + state for the C2/C3 chat

**User decisions (supersede the plan/SDM where they differ):**
1. **C1 lock scope — hide EVERYTHING: Open, Resume, Save AND Export.** The locked reference tool is
   "merely a reference sheet": students scribble on it (ALL tools incl. shapes + snip) and **copy an
   image via snip** (snip→clipboard already ships) to paste into the PL question's notes (Batch D).
   No file actions at all. (Supersedes the SDM's Save/Export-visible split.) Notes pane in the
   reference tool: untouched (not a file action). Snip MUST stay visible — it is the copy path.
2. Affordance-only lock re-confirmed OK (bypassable by bare index.html).
3. C3 FOUC: ship the tiny 'self' sync script (SDM-recommended) — decided, do not re-ask.
4. Chat split: C1+D+E land in the sign-off session; **C2+C3 go to a FRESH chat** (this file is the
   contract); the deep audit (UI/UX, bugs, clean code, performance, etc.) is another fresh chat.

**Execution state as of this addendum:** v158 live-verified on hosted (icons, chip removal, Esc,
tool-restore OK). #13 calculator PARKED by the user: the clip mechanism + scroll-trigger work live;
the drawer class-flip MutationObserver and a synthetic parent-resize dispatch stay silent on hosted —
diagnostic notes in memory (scribble-vnext-15point-plan.md); debug it in the C2/C3 chat or its own.
