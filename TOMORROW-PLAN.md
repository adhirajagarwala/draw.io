# TOMORROW-PLAN — Scribble (v160 live)

*Assembled from three research passes; every anchor below re-grepped against the current tree on 2026-07-19. READ-ONLY plan — no code was changed producing it.*

---

## 1. STATE OF THE WORLD

**Live:** `APP_VERSION = "160"` (`scribble/web/app.js:6`). Class repo `pl-uiuc-ece498sl` at Batch-1 (`5b10696`).

- **Batch 1 — DONE, live-verified.** Shipped and confirmed on hosted PL.
- **C1 (reference `?file=` two-tier validator + affordance lock) — DONE, live at v159, intact.** `refFileRequest()` at `app.js:2353`, `openReferenceFile()` at `2384` (adds `body.locked` pre-await), Open-handler guard at `2314`, `autoOpenIfRequested()` at `2410`, boot dispatch at `app.js:4188` (`… else autoOpenIfRequested()`). Per Addendum-2 #1 the lock hides ALL file actions — `body.locked` hide rules live at `style.css:1571-1575` (`#btn-open/save/load/export/paste-img`).
- **#3 attribution — effectively DONE.** `about-wrap` ⓘ popover (`index.html:52`) + `#help-about` footer (`index.html:341`). The always-visible chip was added then RETIRED — no `#about-line` exists. It rides the C3 merge for free (`buildMergedBar` consumes `about-wrap`).
- **Phase 1 (chrome-reparent) — CODE COMPLETE + adversarially reviewed, but INERT and HELD IN SOURCE (Draw.io repo only, not deployed).** Gate `const PHASE1_CHROME_REPARENT = false` (`app.js:116`); the reparent block is gated at `app.js:3900`. Block 2 chrome.css hand-port (`45892fe`), Block 3 realm audit (`9849685` + `6e07ec8`; findings L-1/R-1/R-2/R-3/N-1 fixed). Card-aligned geometry `alignRailToCard()` at `app.js:3971-3980` is the active path. `chrome.css` is deploy-excluded (`prairielearn/deploy.sh:25`) and ABSENT from both course bundles — **a flip today would 404 the parent `<link>` and render the rail unstyled.** Flip DEFERRED to a between-semester window (D2).

**Remaining 15-point items:** **#13 calculator** (main-tool bounded debug, known live finding) and **#11 reference-UI merge** (Batch C2 + C3). C2/C3 are UNSTARTED — grep confirms `chrome-merged`, `buildMergedBar`, `mergedChrome` do NOT exist anywhere in `scribble/web/`.

---

## 2. RECOMMENDED ORDER FOR TOMORROW

1. **#13 CALCULATOR FIRST.** It is the *main tool* (user priority), a bounded debug with a decisive live finding already in hand (the dead trigger is a single realm bug), and it ships behind no external blocker. Instrument → fix → verify in one day.
2. **#11 REFERENCE MERGE second (C2 → C3).** Lower priority, larger surface, and **externally blocked**: nothing is user-visible until Prof. Lumetta appends `?file=<mt.pdf path>` to the exam-page link. Land the code + coordinate the link edit at ship; a fresh tab shows the unchanged classic UI until he does.
3. **PHASE-1 FLIP — STAYS DEFERRED.** No exam-free window is open; do not start flip-prep tomorrow. Section 5 preserves the checklist for when the window opens.

---

## 3. #13 CALCULATOR — dead open/close trigger

### The live finding (question 9670198, 2026-07-19)
The clip mechanism, the OUR-realm rAF (`calc-dodge.js:148`), and the parent-target capture-phase **scroll** listener (`calc-dodge.js:178`) all work — the hole catches up on first scroll (graceful degradation). The **one dead trigger** is the drawer open/close class-flip. `#calculatorDrawer` is a single PERSISTENT `SECTION.calculator-drawer` whose `open` class toggles (sameNode true both ways) — so the old "PL re-renders the drawer subtree" hypothesis is REFUTED and the late/re-attach machinery is not needed here. The **only** bug: `mo = new MutationObserver(sync)` is constructed in the IFRAME realm (`calc-dodge.js:165`) but observes the PARENT drawer node (`calc-dodge.js:84`); that cross-realm iframe-observer-of-a-parent-node never fires on hosted PL. A PARENT-realm MO run from the parent console DID fire on the flips. By the same mechanism the ResizeObserver at `calc-dodge.js:185` (iframe-realm, observing `window.frameElement`) is likely silently dead too, so the frame-resize trigger is probably also non-functional.

### Recommended fix (instrument-first, then a two-part realm fix)
- **(A) Construct the observers in the PARENT realm:** `calc-dodge.js:165` `new MutationObserver(sync)` → `new pw.MutationObserver(sync)`; `calc-dodge.js:185` `new ResizeObserver(sync)` → `new pw.ResizeObserver(sync)` (the `pw`/feature guard already exists). Callback stays the iframe-realm `sync`, whose only job is to schedule the proven OUR-realm rAF — no cross-realm object crosses (`sync` ignores its `MutationRecord` args).
- **(B) Add a realm-proven capture-phase click listener** on `pdoc` reusing `scrollOpts` (`calc-dodge.js:177`): `pdoc.addEventListener("click", sync, scrollOpts)` + a matching `cleanupFns.push(...)`. Capture hears `#calculatorFab` / `#calculatorDrawerToggle` / `#calculatorDrawerClose` even if PL stops propagation; the click fires *before* PL flips the class, but `sync`'s rAF defers `syncNow` to the next frame — after the flip — so `findPanels()` reads the settled class.

Redundant triggers are safe: `sync` is rAF-coalesced (`if (raf) return`, `calc-dodge.js:144`), so click + parent-MO + scroll collapse to one `syncNow` per frame. Also update the now-misleading comment at `calc-dodge.js:162-164`: the refined lesson is *rAF must stay OUR-realm (rendering lifecycle), but OBSERVERS must be constructed in the observed node's (parent) realm.* Do NOT add polling (CLAUDE.md §10).

### Anchors
- `calc-dodge.js:84` — `mo?.observe(d, {attributeFilter:["class","style"]})` (the parent node observed)
- `calc-dodge.js:144` — rAF coalescing guard · `:148` — `raf = requestAnimationFrame(… syncNow())`
- `calc-dodge.js:165` — `mo = new MutationObserver(sync)` (fix to `pw.MutationObserver`)
- `calc-dodge.js:177-179` — `scrollOpts` + proven parent scroll listener (add click beside it)
- `calc-dodge.js:185` — `ro = new ResizeObserver(sync)` (fix to `pw.ResizeObserver`)
- Version bump on ship: `app.js:6` (APP_VERSION), the `./pkg/scribble.js` glue `?v=` and `./calc-dodge.js` import `?v=` in `app.js`, `index.html` `?v=` — no Rust/wasm change (bundle-only).

### Step ladder
- **S1 — Instrument on hosted (example-course only).** Temp `[calc-dodge]`-prefixed logs. **The decisive probe:** a temp `new pw.MutationObserver(() => console.log("[calc-dodge] parent-MO(iframe-cb) fired"))` on `#calculatorDrawer` with `attributeFilter:['class']` — this tests whether a PARENT-constructed observer invokes an IFRAME-realm callback (unproven; the console probe in the finding used a parent-realm callback). Plus: wrap the existing `mo` callback to confirm it never fires; a capture-phase `pdoc` click log (candidate B); a `pw.ResizeObserver` vs the existing `ro`; and log `holes.length` + `findPanels()[0]?.classList.contains("open")` in `syncNow`. **Decision gate:** if `parent-MO(iframe-cb) fired` logs on every open/close path → (A) is the robust catch-all; if not → lean on (B) + keydown.
- **S2 — Apply (A)+(B)** per the fix above.
- **S3 — Keyboard/programmatic gap (conditional on S1).** If (A) fires, it already observes the class flip for click/Escape/programmatic — nothing more needed. If (A) does NOT fire with an iframe callback, add a capture-phase `pdoc` **keydown** → `sync` for Escape, and accept that a purely programmatic close degrades gracefully (catches up on next scroll/resize — the v158 behaviour).
- **S4 — Strip all temp logs, bump cache version (S4 anchors above), three-mode sanity** (standalone PDF + standalone HTML + embedded host-demo boot clean; calc-dodge is inert outside overlay), then the full hosted pass.

### FIRST ACTION (#13)
Build the temp-logging `calc-dodge.js` for **S1** — load-bearing piece is the S1c probe (`new pw.MutationObserver(() => console.log("[calc-dodge] parent-MO(iframe-cb) fired"))` on `#calculatorDrawer`) alongside the S1d capture-phase `pdoc` click log. Deploy ONLY to `prairielearn/example-course` via `deploy.sh`, sync, then on hosted **question 9670198** (iframe forced **<900px**) assert `APP_VERSION` in-console FIRST, and toggle open/close via `#calculatorFab` / `#calculatorDrawerToggle` / `#calculatorDrawerClose` / Escape while watching the console. Ship (A)+(B) if the parent-MO probe fires on every path; ship (B)+S3 keydown if it does not.

---

## 4. #11 REFERENCE-UI MERGE (Batch C2 → C3)

**Mechanism today:** the reference tool is a plain NON-embedded standalone page (no `body.embedded`, no `body.overlay`) rendering the CLASSIC three-part UI (vertical 116px `#rail` + `#topbar` header + floating contextual colour bar). The merge code (`app.js:3822-4130`) is gated on `body.embedded && body.overlay` and never runs for it. **External blocker:** the merged UI only activates on a valid `?file=`, which needs Prof. Lumetta to append `?file=<mt.pdf same-origin path>` to the exam-page link. Nothing is user-visible until he does.

**Stale-plan reconciliations to apply at kickoff (v154 anchors have DRIFTED — trust the C2-2 STAY contract, not the old MOVE table):**
- Reference More menu = **Larger/Help/palette only.** The old `buildMergedBar({fileActions:true})` + "migrate save/load/export into More" is DEAD — the locked reference hides all file actions (`body.locked`, `style.css:1571-1575`). Snip stays visible (copy-to-notes path).
- `#about-line` rename is DEAD (id retired). #3 attribution rides the merge for free.
- The old MOVE range would have swept the shape/mark-*hiding* rules (now `style.css:707-709, 716-718`) — those must STAY overlay or the reference tool loses shapes it must keep.

### C2 — CSS split (the mechanical safety net)

- **C2-1 (keystone, zero-risk) — FIRST ACTION for #11.** `scribble/web/app.js:970`: change `document.body.classList.add("overlay");` → `document.body.classList.add("overlay", "chrome-merged");`. `openOverlay` is the ONLY site that adds `overlay` (grep-verified), so every overlay now carries BOTH classes — any rule renamed `body.overlay`→`body.chrome-merged` in C2-2 still matches the overlay unchanged. Do this BEFORE the rename so overlay is never momentarily unstyled. No rule references `chrome-merged` yet → no visual change.
- **C2-2 — Rename the pure merged-VISUAL (MOVE) rules in place** `body.overlay` → `body.chrome-merged`, preserving source order + specificity (both are 0,1,1). MOVE: rail shell `686-694`, `#context-bar` static `698-700`, `#topbar:none` `701`, rail-group divider `702`, `#rail .tool` `710-713`, `#context-bar` flatten `723-728`, the Hairline+ block `832-878` (keep `879-880` on overlay), flat colour-bar cluster `882-951`, `.rail-scroll` `956`, and `.big` `1231-1242`. **STAY contract — DO NOT rename (these encode overlay-only policy; the review contract is the STAY list, since MOVE is provably safe):** `626`, `649-653` (transparency — reference is OPAQUE), `663-675`, **`676` `#html-frame:none` (reference HTML needs the frame VISIBLE)**, `677`, **`678` `#doc-controls:none` (THE policy split — reference KEEPS zoom/page-nav/scroll-mode)**, `707-709`+`716-718` (shape/mark hiding), `729-731`, **`736` annotate gate (reference has none — renaming hides its rail+notes forever)**, `766-820` + `879-880`/`953-954`/`957-959` (floatability suite), `802`. Leave `763-764` (base grip/collapse hide, not overlay-scoped) alone.
  - *Verify:* `grep -c 'body\.overlay' style.css` before/after and reconcile the delta against the MOVE count; `grep -n 'body\.chrome-merged'` to eyeball every rename; confirm `676`/`678`/`736` + the `649-653` transparency block UNCHANGED; pixel-compare overlay at <900px (identical); host-demo + standalone unchanged.

### C3 — Merged UI wiring

- **C3-1 — Extract `buildMergedBar(opts = {})`** from the shared body (`app.js:3823-3885`) at module scope; it MUST `return { moreBtn, morePop, closeMore }` because the overlay continuation (`3886-4130`) and its gated Phase-1 reparent block (`3900-3953`) close over those (used `3934-3935`). Overlay branch becomes `const { moreBtn, morePop, closeMore } = buildMergedBar(); updateContextBar(activeTool());` then runs `3886-4130` unchanged. `about-wrap` is already consumed into `.rail-actions` → attribution free. Keep `PHASE1_CHROME_REPARENT` (`app.js:116`) false and the reparent path compiling.
- **C3-2 — Add `mergedChrome()` and widen EXACTLY two colour-bar gates.** `const mergedChrome = () => document.body.classList.contains("overlay") || document.body.classList.contains("chrome-merged");`. Replace `app.js:2517` `const overlay = document.body.classList.contains("overlay")` → `const overlay = mergedChrome()` (keep the local name). In `colorbar.js:70` change `if (document.body.classList.contains("overlay")) return;` → add the `|| …contains("chrome-merged")` (inline; `colorbar.js` is a separate module). **Leave every other `overlay` gate as-is** — notably `app.js:2607` (Ctrl+scroll ZOOM LOCK — reference KEEPS zoom), `app.js:3651` (savePrefs layout fields), `notes-dock.js:17`. *Verify:* `grep 'classList.contains("overlay")'` shows only those two sites changed.
- **C3-3 — New reference branch** parallel to the `if (body.embedded)` block (~`app.js:4131`): cache `const REF_FILE = refFileRequest();` once (reuse at `4188`), then `else if (REF_FILE) { document.body.classList.add("chrome-merged"); buildMergedBar({ thumbs: true }); updateContextBar(activeTool()); }`. In `buildMergedBar`, honour `opts.thumbs` by migrating `#btn-thumbs` (`index.html:37`, `#topbar .topbar-right`) onto the row. Do NOT call `makeFloating`/`clampFixed`, do NOT attach the annotate observer, do NOT `initCalcDodge` — skip the entire `3886-4130` continuation. Reference More = Larger/Help/palette (NO save/export). Null `REF_FILE` falls through to classic standalone unchanged. Adding `chrome-merged` here releases the C3-5 FOUC guard.
- **C3-4 — Author `body.chrome-merged:not(.overlay)` layout block** (new, near `style.css:678`/`1575`). The reference bar is `position:fixed` (inherited from moved `686-694`), so `#main` collapses to `[#stage]`; add `body.chrome-merged:not(.overlay) #main { padding-top: ~60px (68px under .big); }` so `#stage` clears it. `#doc-controls` lives inside `#stage` (`index.html:218`), NOT `#topbar`, so hiding `#topbar` doesn't hide it — but verify placement/visibility in the new layout. `body.locked` hides already exist globally (`1571-1575`) — do NOT duplicate. *This block is the real design work of C3 — a rename can't produce it.*
- **C3-5 — FOUC guard (Addendum-2 #3, decided).** `app.js` is a deferred module (`index.html:348`) → classic layout paints ~160ms before the reference branch builds. CSP `script-src 'self'` forbids inline head script → ship EXTERNAL `scribble/web/head-boot.js` (NEW) that synchronously does `if (new URLSearchParams(location.search).has("file")) document.documentElement.classList.add("ref-pending");`, referenced by `<script src="head-boot.js?v=…">` in `<head>` (render-blocking). Add CSS `html.ref-pending body:not(.chrome-merged) { visibility: hidden; }` (mirrors the overlay `html.pl-overlay` pattern at `style.css:658-659`). **Mandatory failsafe:** remove `ref-pending` on the invalid-`?file=` path (null `REF_FILE`) AND at boot-end, so a fetch failure never leaves a blank page. `deploy.sh` rsyncs `web/` and only excludes `chrome.css`/`embed/`/maps, so `head-boot.js` ships automatically; it no-ops when `?file=` is absent.
- **C3-6 — Version bump, deploy BOTH courses, coordinate Lumetta.** Bump `APP_VERSION` (`app.js:6`) + every `?v=` in `index.html` (style.css `18`, app.js `348`, module imports, the hand-bumped `./pkg/scribble.js` glue counter) + the new `head-boot.js` `?v=` together. Pure JS/CSS/HTML — no wasm rebuild. Deploy via `./prairielearn/deploy.sh` then the mirrored rsync into `pl-uiuc-ece498sl/clientFilesCourse/scribble/` (`chrome.css` stays excluded). Commit both repos (sole author, no co-author trailer); `git fetch`/rebase the class repo FIRST. STOP — the USER pushes + Syncs. **Flag the Lumetta link edit at ship.**

### FIRST ACTION (#11)
Start **C2-1**: in `scribble/web/app.js:970` change `document.body.classList.add("overlay");` → `document.body.classList.add("overlay", "chrome-merged");` (the zero-risk keystone that makes the whole rename provably non-regressive). Take a `grep -c 'body\.overlay' style.css` snapshot first, then begin the C2-2 rename working strictly from the STAY contract — never touching `676` (`#html-frame`), `678` (`#doc-controls`), `736` (annotate gate), or the `649-653` transparency block.

---

## 5. PHASE-1 FLIP-PREP (DEFERRED — do NOT start tomorrow)

Not tomorrow's work. Gate `PHASE1_CHROME_REPARENT = false` (`app.js:116`) and provably inert. Blocks 2 & 3 are code-complete + reviewed + committed inert in Draw.io only (`45892fe`, `9849685`, `6e07ec8`); both user decisions (D1 card-aligned geometry `alignRailToCard()` `app.js:3971-3980`, D2 flip deferred) are implemented in source. What remains: Block 1 packaging/CSP/deploy + Block 4 matrix + the one-line flip. Live NO-GO rows still blocking: #6 (undeployed/404 — `chrome.css` absent from both bundles, `deploy.sh:25` still excludes it), #7 (CSP unverified on UIUC), #18 (stale baseline), #19 (hosted <900px both instances), plus N-2/V7 calc coexistence.

**Flip-window checklist (preserve verbatim):**
- **F0 — Open the window (precondition).** Confirm the ECE 498SL CBTF exam is NOT live. Re-baseline the then-current version hosted on BOTH instances (example-course + UIUC) at iframe **<900px**, APP_VERSION confirmed in-console (no inherited stale pass, NO-GO #18). `git fetch`/rebase the class repo FIRST.
- **F1 — Deploy the INERT refactor first (gate still false), isolate packaging risk.** Drop only the `--exclude 'chrome.css'` token at `deploy.sh:25` (KEEP `embed/` + `*.map`; note `rsync --delete` now governs chrome.css). Deploy both courses; bump `APP_VERSION` + `index.html ?v=` + hand-bumped `./pkg/scribble.js` glue together. Verify `chrome.css` lands in BOTH `clientFilesCourse/scribble/` (200 at the new `?v=`) and behaviour is byte-identical to v160 (gate off → `railRoot === document`).
- **F2 — Re-verify the CSP `<link>` injection on the HOSTED UIUC instance (THE gate; riskiest assumption).** `app.js:3902-3905` injects a parent-realm `<link id=pl-scribble-chrome-css>`, but only an inline `<style>` was ever probe-validated and CSP stripping of a `<link>` is SILENT. On UIUC top-frame console, overlay open, assert `getComputedStyle` on a **chrome.css-ONLY** rail property — never absence-of-console-error, never a property `style.css` also sets. If it fails, merge the `<link>`→inline-`<style>` fallback (B1-2) and re-assert. A nonce-based `style-src` would strip both → hard NO-GO.
- **F3 — Flip the one line, version-bump, deploy, user syncs.** `app.js:116` `false → true`. Confirm review findings applied and D1 (`alignRailToCard`, `app.js:3971`) active. Do NOT bundle with any other change — keep it a single-line back-out. `git fetch` class repo first; STOP — USER pushes + Syncs.
- **F4 — Run the full V1-V11 matrix on hosted, BOTH instances, <900px** (PHASE1-PLAN.md §6), APP_VERSION confirmed. Key rows: V1-V3 standalone/host-demo unaffected; V4 primary (rail viewport-pinned, glyph swap, More+About both realms, Larger no 140px crush, shortcuts after a parent-side tool click); V6 two-overlay host namespacing; V7 calculator coexistence (F5); V9 `railFloat→railFloat2` prefs migration (`app.js:3964`); V10 stale-parent-cache (chrome.css refetch on `?v=`); V11 touch drag/collapse/dodge. Any single NO-GO row true → revert F3.
- **F5 — N-2 / V7: default un-dragged bar's calc-dodge.** `dodgeChromeFromCalc` only dodges when the rail is `fp-moved` (`app.js:4115`), and the reparented default bar ESCAPES the iframe clip — so the card-aligned bar (pinned `top:4px`, `app.js:3971-3980`) has neither dodge nor clip. PL's calculator is bottom-anchored, so they *likely* never overlap. On hosted UIUC, open the calculator on a long overlay question at <900px and observe whether the drawer ever reaches y≈4px. If never → document N-2 as by-design (no code). If yes → extend `dodgeEl` to the un-dragged reparented bar (drop the `fp-moved` gate for that case).

**FIRST ACTION when the window opens:** F0 — confirm no live CBTF exam, re-baseline both instances hosted at <900px (APP_VERSION in-console), `git fetch` the class repo — before touching `deploy.sh:25` or the gate at `app.js:116`.

---

## 6. PROCESS REMINDERS (per batch — CLAUDE.md §0.1)

1. **Plan → XHIGH critique → implement → adversarial review.** Run the multi-agent Workflow pipeline at XHIGH; adversarially verify every finding. Reviewers are **READ-ONLY** — the main loop applies fixes; never let a review agent edit the shared tree.
2. **Deploy to BOTH course copies:** `./prairielearn/deploy.sh` (`example-course`) then the mirrored rsync into `pl-uiuc-ece498sl/clientFilesCourse/scribble/`. **Keep `chrome.css` excluded (`deploy.sh:25`) until the Phase-1 flip window.** For #13 instrumentation, deploy the temp build to **example-course ONLY**.
3. **Bump the cache version on every web change (CLAUDE.md §2):** `APP_VERSION` (`app.js:6`) + every `index.html ?v=` + the hand-bumped `./pkg/scribble.js` glue `?v=` (+ `head-boot.js ?v=` once it exists) **together**. C2/C3 and #13 are bundle-only — **no wasm rebuild.**
4. **Commit in both repos:** short one-line message, sole author, **no co-author trailer**. `git fetch`/rebase the class repo FIRST (the prof pushes the same `main`).
5. **STOP — the USER runs `git push` and clicks Sync. Never push.**
6. **Live-verify on hosted PL in the user's Chrome, iframe forced <900px, and confirm the loaded `APP_VERSION` in-console BEFORE asserting anything** (stale-cache false-negatives are the recurring failure). Never claim verified without the hosted pass. The user then confirms.