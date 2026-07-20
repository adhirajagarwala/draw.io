# Toolbar Resize + Overflow Trial — Implementation Plan (v166)

## 1. Chosen approach and why

**Hybrid: Design A's skeleton, with B's clamp fix and C's preset derivation grafted on.**

Concretely:

| Element | Taken from | Rationale |
|---|---|---|
| Width lives in a `--rail-w` custom property, never `style.width` | A / B / C (unanimous) | `floating-panel.js:71` does `el.style.width = ""` on every lift (review fix R-3). A custom property is untouched by that write, by `d.preW` restore (`floating-panel.js:102`), and by `alignRailToCard`'s inline width (`app.js:4029`). Zero edits to the drag engine's width handling. |
| Free drag handle **and** presets | A / B (requirement A says *both*) | C's snap-to-3-stops is a requirement miss: the user explicitly asked for a drag handle **and** presets, and the interesting zone for judging wrap-vs-More is exactly the width where the last chip tips into overflow — a 3-stop snap cannot reach it. |
| Presets **derived from measured content width**, not fixed px | **C** | This is C's one genuinely superior idea. A's hardcoded 360/560px can fail to overflow on a wide card (making the whole A/B comparison unrunnable) or exceed a narrow one. Deriving Compact/Medium from `shellW + scroll.scrollWidth` *guarantees* both stops overflow. |
| `.ov-wrap` = pure CSS, `.ov-more` = one JS pass, live toggle, deletable | A | A's `RAIL_OVERFLOW_TRIAL` flag makes "pick a winner, delete the loser" a contained diff. Ship both, decide, excise. |
| Demotion at **`.rail-group` granularity**, not per-tool | A | B splits `#colors`/`#widths` into separate chips. That breaks `.rail-scroll > .rail-group + .rail-group` hairlines (`style.css:842-845`) mid-group and multiplies the oscillation surface. After the overlay hide rules (`style.css:707-718`, `968-970`) there are only **5** candidates anyway. |
| `clampFixed` handleH clamp | **B** | B is the only design that caught it. `floating-panel.js:25` passes `r.height` as `handleH`; at a wrapped ~100px bar that makes `top_min = by0 − 44` (`visible-band.js:51`), letting a moved+wrapped bar hide its first tool row above the fold. See §5.4. |
| `RAIL_CLEAR` becomes a **pushed** value, not a measuring getter | *neither* — improvement | A proposes `railClear()` measuring live, then has to cache it at lift to avoid a per-frame flush and special-case the reparented realm. Pushing `setRailClear(px)` from app.js on the (rare) height change removes both problems: notes-dock never measures, never reaches cross-realm, and the drag path stays a plain constant read. |
| Wrapping happens **inside `.rail-scroll`**, not on `#rail` | *neither* — improvement | A and B both put `flex-wrap:wrap` on `#rail`. That drops `.rail-actions` (`margin-left:auto`, `style.css:926`) onto row 2 and makes the grip/collapse/resize shell reflow. Wrapping only the scroller keeps the entire shell — grip, Notes, More, collapse, resize handle — pinned on one line at **any** width, which is the irrecoverability guard. |

**Why not B outright:** B moves all markup construction into JS and owns bar width from a measurement cache. That is more machinery for the same result, and its finer chip granularity is a regression risk against the hairline system. **Why not C:** it declines free resize, which the user asked for by name.

**Non-negotiable invariant this design preserves:** `.rail-scroll { overflow-x: auto }` (`style.css:959` / `chrome.css:376`) stays untouched in `.ov-more` as the last-resort residue handler. Combined with the never-demote-Draw rule and the pinned shell, **no width and no mode can make a tool unreachable.**

---

## 2. Markup (`index.html`)

Only one authored addition. The preset and mode groups must be JS-built because `#more-popover` itself is JS-built (`app.js:3896-3903`).

Insert immediately **after** `#rail-collapse` (currently `index.html:164`), still inside `<nav id="rail">`:

```html
<!-- Overlay-only free-resize handle. MUST stay a <button> element: DRAG_EXCLUDE
     (floating-panel.js:38) matches it by TAG, which is the only reason a resize
     press cannot lift the whole bar. Changing this to a <div> silently breaks
     the drag engine. Hidden in standalone / Option-B by CSS, same as .fp-grip. -->
<button id="rail-resize" class="fp-resize" type="button"
        role="separator" aria-orientation="vertical"
        aria-label="Toolbar width" title="Drag to resize the toolbar (double-click to reset)"
        aria-valuemin="0" aria-valuemax="100" aria-valuenow="100" aria-valuetext="Full width"
        tabindex="0"></button>
```

`aria-value*` are expressed as a **percentage of the available band width** so the announced value is meaningful without the SR reading raw pixels.

Version bumps in the same file: `style.css?v=165` → `166` (`index.html:18`), `app.js?v=165` → `166` (`index.html:348`).

> **a11y fallback (pre-committed):** if a real screen-reader pass shows `role="separator"` on a `<button>` announcing badly, drop the `role`/`aria-value*` and keep a plain `<button aria-label="Toolbar width">` plus the debounced `status()` announcement. Do **not** change the element type.

### JS-built controls, prepended into `#more-popover`

Built in the overlay merge block beside `menuLabel` (`app.js:3888-3903`). All labels via `textContent` (matching `menuLabel` at `app.js:3888`) — no `innerHTML` of anything but the static `moreBtn` SVG that already exists.

```
<div id="more-overflow"     role="group" aria-label="Tools moved here">…</div>   ← .ov-more parking bay
<div class="more-sec-head">Toolbar</div>                                         ← textContent
<div id="rail-width-group"  role="group" aria-label="Toolbar width">
   [Compact] [Medium] [Full]            ← 3 buttons, aria-pressed
</div>
<div id="rail-ovmode-group" role="group" aria-label="When the toolbar is too narrow">
   [Wrap to a 2nd row] [Hide extras in More]   ← 2 buttons, aria-pressed
</div>
<hr class="more-sep">                    ← then the existing Larger / Help / palette rows
```

The mode group is rendered only when `RAIL_OVERFLOW_TRIAL === true` (new const beside `PHASE1_CHROME_REPARENT`, `app.js:117`). After the verdict, flip it false and `RAIL_OVERFLOW_DEFAULT` fixes the winner.

**One required edit to existing wiring — `app.js:3920`:**

```js
// was: morePop.addEventListener("click", (e) => { if (e.target.closest("button")) closeMore(); });
morePop.addEventListener("click", (e) => {
  if (e.target.closest("button") &&
      !e.target.closest("#rail-width-group, #rail-ovmode-group, #more-overflow")) closeMore();
});
```

Without this the popover shuts on every preset click and the width/mode A/B is unusable. The original reason for the auto-close (Help's modal opening *behind* the trapped popover) is untouched — Help is outside all three exempt groups. `#more-overflow` is exempted too so activating a demoted tool doesn't yank the menu shut mid-comparison.

---

## 3. CSS (`style.css`, mirrored into `chrome.css`)

### 3.1 Width plumbing (edit existing lines in place — source order is load-bearing)

| File:line | From | To |
|---|---|---|
| `style.css:689` | `width: calc(100% - 8px);` | `width: var(--rail-w, calc(100% - 8px));` |
| `style.css:798` | `.fp-moved { width: max-content; …}` | `width: var(--rail-w, max-content); max-width: calc(100vw - 8px);` |
| `style.css:819` | `.fp-collapsed { width: auto; }` | **UNCHANGED** |
| `chrome.css:245` | same as 689 | same edit |
| `chrome.css:265` | same as 798 | same edit |
| `chrome.css:268` | `.fp-collapsed { width: auto }` | **UNCHANGED** |

Cascade proof: `.fp-moved` (`style.css:798`) and `.fp-collapsed` (`style.css:819`) are both specificity **(1,2,1)**; collapsed is later in source, so `width:auto` still wins and the collapsed handle stays a handle at any chosen width. Identical ordering holds in `chrome.css` (265 → 268). The Hairline+ shell rule (`style.css:835-839` / `chrome.css:271-275`) sets no `width`, so it never interferes.

With `--rail-w` unset, both rules render **byte-identical to today**. Full = literally a no-op.

### 3.2 The resize handle

```css
/* standalone / Option-B never show these — extend the existing hide list */
#rail .fp-grip, #rail .fp-collapse, #rail .fp-resize,        /* style.css:763 */
#topbar .fp-grip, #topbar .fp-collapse { display: none; }

body.overlay #rail .fp-resize {
  display: block; position: absolute; right: 0; top: 6px; bottom: 6px; width: 12px;
  padding: 0; border: 0; background: transparent; cursor: ew-resize;
  touch-action: none;                 /* touch-action does NOT inherit from #rail's `none` (style.css:814) */
  border-radius: 0 11px 11px 0;
}
body.overlay #rail .fp-resize::before {          /* the visible 2px grab line */
  content: ""; position: absolute; left: 5px; top: 25%; bottom: 25%;
  width: 2px; background: var(--line); border-radius: 1px;
}
body.overlay #rail .fp-resize:hover::before,
body.overlay #rail .fp-resize:focus-visible::before { background: var(--accent); }
body.overlay #rail .fp-resize:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
/* resizing a handle is meaningless — hide with the rest of the collapsed body (style.css:818) */
body.overlay #rail.fp-collapsed :is(.rail-group, #context-bar, .rail-actions, .fp-resize) { display: none; }
```

`#rail` is `position:fixed` and therefore the handle's containing block — absolute placement is deliberate: a flow handle would be pushed around by a wrapped scroller.

**Padding change:** `style.css:836` / `chrome.css:272` `padding: 5px 7px` → `padding: 5px 14px 5px 7px`, so the 12px strip lives entirely inside the right padding and never steals a pixel of the 30px collapse button's hit area.

### 3.3 The two overflow modes

```css
/* ---- .ov-wrap : PURE CSS. Wrap the SCROLLER, never #rail — the shell
       (grip / actions / collapse / resize) must stay pinned on one line. ---- */
body.overlay #rail.ov-wrap { height: auto; min-height: 52px; }        /* (1,2,1) beats style.css:836 */
body.overlay.big #rail.ov-wrap { min-height: 60px; }                  /* (1,3,1) beats style.css:1234 */
body.overlay #rail.ov-wrap .rail-scroll {
  flex-wrap: wrap; row-gap: 4px; column-gap: 10px;
  overflow-x: visible; overflow-y: visible;   /* BOTH — see note */
  touch-action: none;                         /* no h-scroll left; let a finger drag the bar */
}
/* row-start hairlines read as stray ticks once items wrap; the column-gap replaces them */
body.overlay #rail.ov-wrap .rail-scroll > .rail-group + .rail-group,
body.overlay #rail.ov-wrap .rail-scroll > #context-bar { border-left: 0; margin-left: 0; padding-left: 0; }
```

> **Both axes, not just `overflow-x`.** `style.css:959` sets `overflow-y: hidden`. Per spec, when one axis is `visible` and the other is not, **`visible` computes to `auto`** — so setting only `overflow-x: visible` leaves a scroll container and *nothing ever wraps*. All three candidate designs got this wrong. Verify live with `getComputedStyle(scroll).overflowX === "visible"`.

```css
/* ---- .ov-more : JS moves whole .rail-group / #context-bar nodes into the popover ---- */
body.overlay #rail #more-popover {                                     /* style.css:935-940 */
  min-width: 190px; max-width: min(300px, calc(100vw - 16px));
  max-height: min(60vh, 440px); overflow-y: auto; overscroll-behavior: contain;
}
/* the popover's menu-row styling only covers .btn today — widen 5 selectors at style.css:943-954 */
body.overlay #rail #more-popover :is(.btn, .tool) { /* …unchanged declarations… */ }
body.overlay #rail #more-popover :is(.btn, .tool) svg { … }
body.overlay #rail #more-popover :is(.btn, .tool) span { … }
body.overlay #rail #more-popover :is(.btn, .tool):hover { … }
body.overlay #rail #more-popover :is(.btn, .tool):is(.active, [aria-pressed="true"]) { … }

#more-overflow .rail-group { flex-direction: column; align-items: stretch; border: 0; margin: 0; padding: 0; }
#more-overflow #context-bar { flex-direction: row; flex-wrap: wrap; padding: 6px 4px; gap: 6px; }
/* undo the bar-only "Text" glyph swap (style.css:864-867) — a menu row wants the real label */
#more-overflow .tool[data-tool="text"] span { font-size: 12.5px; }
#more-overflow .tool[data-tool="text"] span::after { content: none; }
/* the demoted-active-tool cue, so an armed tool that left the bar is still visibly armed */
body.overlay #rail #btn-more.has-active { background: var(--accent-soft); border-color: #c9d6f7; color: var(--accent); }
.more-badge { font-size: 10px; font-weight: 700; line-height: 1; padding: 1px 4px; border-radius: 7px;
              background: var(--accent); color: #fff; margin-left: 2px; }
```

The `.rail-scroll > .rail-group + .rail-group` divider rules (`style.css:842-845`) need **no** override for `.ov-more`: they are child-combinator-scoped and simply stop applying once a node leaves. One guard is worth adding — `body.overlay #rail .rail-scroll > *:first-child { border-left: 0; margin-left: 0; padding-left: 0; }` — so `#context-bar` doesn't carry a dangling hairline if it becomes the first surviving child.

Segmented styling for `#rail-width-group` / `#rail-ovmode-group` reuses the existing `.seg-group`/`.seg` visual language (`style.css:1288+`), plus a `.more-sec-head` (11px, uppercase, `var(--muted)`).

### 3.4 What a 2-row bar does to height consumers

| Consumer | Effect | Action |
|---|---|---|
| `restickRail` (`app.js:4073-4083`) | **None.** It re-measures `r` each call and asks for `band.top + MARGIN`; `clampIntoBand`'s top bound is `[by0 − (handleH − gy), by1 − gy]`, and `by0` is always inside that range. Lands at band top at any height. | No edit. *State this explicitly — a reviewer will assume it broke.* |
| `clampFixed` (`floating-panel.js:25`) and the live drag (`:87`) | **Breaks.** `handleH = r.height ≈ 100` ⇒ `top_min = by0 − 44`; a moved+wrapped bar can hide row 1 above the fold. | Clamp `handleH` to `GRAB`. §5.4. |
| `RAIL_CLEAR = 64` (`notes-dock.js:16`, used at `:111` and `:216`) | **Breaks.** Notes can be placed/dragged *behind* an opaque 2-row bar — the exact occlusion the constant exists to prevent. | Push a measured value. §4.4. |
| `pl-scribble.py:183` `padding: 52px 10px 14px` | Server-rendered; cannot know a client-side wrap. Row 2 covers the question's first prose line. | `syncHostPad()` writes `overlayHost().style.paddingTop` from the measured rail height. §4.5. |
| `.big` (`style.css:1234` `height:60px`) | 52→60 base; `.ov-wrap`'s `min-height` override is specificity-matched at `body.overlay.big #rail.ov-wrap` (1,3,1). | Rule above. |
| calc-dodge `dodgeEl` (`app.js:4154`) | Reads the rect fresh per call. | No edit. |

### 3.5 chrome.css mirror (exact, non-optional)

Every rule above lands twice. `chrome.css:4` states the sync requirement, and post-Phase-1 `.scribble-chrome` is the **only** stylesheet the real hosted student sees (`app.js:3973`). Mirror targets: `chrome.css:245` (width var), `:265` (fp-moved var), `:267` (collapsed hide-list + `.fp-resize`), `:272` (padding), `:351-356` (popover min/max), `:358-367` (`:is(.btn,.tool)`), `:376` (`.rail-scroll`), `:395` (`.big` min-height), plus new `.fp-resize` / `.ov-wrap` / `#more-overflow` blocks. **All new blocks go AFTER the base-big block**, per the equal-specificity source-order warning at `chrome.css:387-391`.

---

## 4. JavaScript

### 4.1 `rail-resize.js` (new, ~120 lines)

```js
import { visibleBand } from "./visible-band.js?v=166";

export function makeResizable(el, { handle, win = window, getMinW, onLive, onChange, announce })
  // → { setWidth(px|null), getWidth(), maxW(), syncAria() }
```

- **`setWidth(px|null)`** — the *only* writer of bar width. `null` ⇒ `el.style.removeProperty("--rail-w")` (Full). Otherwise clamp to `[getMinW(), band.right − band.left − 8]` from `visibleBand(win)`, then `el.style.setProperty("--rail-w", w + "px")`, `syncAria()`, `onLive()`.
- **Pointer drag** — `pointerdown` reads `el.getBoundingClientRect()` **once** and caches the band (mirroring `floating-panel.js:78`); `pointermove` computes `w = ev.clientX − r.left + grabDx` and commits inside a **single rAF**, one write, no reads (CLAUDE.md §10 rule 4). `setPointerCapture`, and bail on `!(ev.buttons & 1)` exactly as `floating-panel.js:61` does.
- **`pointerup`** → `clampFixed(el, win)` → `onChange()` (`savePrefs()` + `calcDodgeNudge()`, matching `app.js:4008`).
- **Keyboard** — `ArrowLeft/Right` ±16, `Shift+Arrow` ±64, `Home` = min, `End` = max, `Escape` mid-drag = restore start width. Announcement via `announce()` is **debounced 300ms** — never per keystroke.
- **`dblclick`** → `setWidth(null)`.
- No CSS `transition` on width (it would fight the rAF write; `style.css:985-992` would neutralize it anyway).

### 4.2 `rail-overflow.js` (new, ~150 lines)

```js
export function makeOverflow({ rail, scroll, popover, moreBtn, bay, win, announce })
  // → { setMode("wrap"|"more"), getMode(), reflow(), promoteAll(), measureContent(), shellW() }
```

- **Stamping (once, right after `railScroll` is filled — `app.js:3929-3932`):** `c.dataset.railOrder = i` (DOM index) and `c.dataset.railPrio` from a fixed table.
  **Priority (first to leave → last):** `snip 1 → undo/redo 2 → #context-bar 3 → select 4 → draw ∞ (never)`.
  Undo/Redo before the colour strip because Ctrl+Z/Ctrl+Y fully cover them; the Draw group never leaves, so Pen/Highlight/Text/Erase are always on the bar.
- **Restore in original order:** `const o = +n.dataset.railOrder; scroll.insertBefore(n, [...scroll.children].find(c => +c.dataset.railOrder > o) || null);` — O(n) over ≤5 children, exact original order regardless of demotion sequence.
- **Demote loop:** `while (scroll.scrollWidth > scroll.clientWidth + 1 && candidates.length) demote(lowestPrio)`. Cache `n.dataset.railW = rect.width` **at demotion time**.
- **Promote gate (hysteresis):** promote back only when `scroll.clientWidth − scroll.scrollWidth >= +n.dataset.railW + 8`. Never trial-promote — that is the classic demote↔promote flicker and it costs a layout flush per attempt.
- **Never demote the active tool's group** — skip it, take the next candidate; if it is the last one, stop and let `.rail-scroll{overflow-x:auto}` carry the residue. Losing sight of the tool you are holding is the hidden-irrecoverable-control failure class.
- **Measure loop:** one `ResizeObserver` **on `#rail`, never on `.rail-scroll`.** `#rail`'s width comes from `--rail-w`/CSS, so demotion cannot resize it and the observer cannot self-trigger; `.rail-scroll` is `flex:1 1 auto` and *would* loop. Constructed as `new (rail.ownerDocument.defaultView).ResizeObserver(...)` and coalesced through **that realm's** `requestAnimationFrame` (matching `scheduleAlign`, `app.js:4043`). Add an explicit `// DO NOT observe .rail-scroll` comment at the `observe()` call and a `lastW/lastH` early-out.
- **Every measurement guards `rail.getClientRects().length`** (mirroring `floating-panel.js:21`) — the annotate gate (`style.css:736`) and `syncRailVis` (`app.js:4056`) can have the bar at `display:none`, where it measures 0.
- **Focus rescue:** before moving a node, `if (n.contains(rail.ownerDocument.activeElement)) moreBtn.focus()` — realm-correct, mirroring the read at `app.js:3907`.
- **`setMode("wrap")`** calls `promoteAll()` first, then swaps the class. `setMode("more")` swaps then `reflow()`.
- **a11y:** `moreBtn.setAttribute("aria-label", n ? \`More tools, ${n} hidden here\` : "More tools")`, a `.more-badge` span (`textContent`, integer only), `moreBtn.classList.toggle("has-active", activeIsDemoted)`, and a 300ms-debounced sentence into `#status` (`role="status" aria-live="polite"`, `index.html:291`). Demoted tools keep their keyboard shortcuts: `mainKeydown` resolves via `railRoot.querySelector` and `.click()` fires on a node inside a `hidden` container.
- **Popover below-fold flip:** `#more-popover` is `position:absolute` under a viewport-fixed bar with no clamp (`style.css:935-940`) — pre-existing, but a tall parked popover makes it acute. On open, measure and switch to `bottom: calc(100% + 6px)` when `rect.bottom > visibleBand(railWin).bottom − 4`. Reuses the shared helper; no new clamp logic.

### 4.3 `app.js` call sites

| Location | Change |
|---|---|
| `:6`, `:12`, `:27`, `:28`, `:30` | `APP_VERSION = "166"`; bump the **manual** `./pkg/scribble.js?v=` glue counter and every module `?v=` (CLAUDE.md §2). No Rust change ⇒ no wasm rebuild. |
| `:117` | Add `const RAIL_OVERFLOW_TRIAL = true;` and `const RAIL_OVERFLOW_DEFAULT = "more";` beside `PHASE1_CHROME_REPARENT`. |
| `:3580` `applyBig` | Add `railLayout?.invalidate()` — `.big` changes every tool width (`style.css:1234-1245`) and the 52→60px height, so both the preset derivation and the fit are stale. Fires in both realms (`railHostEl` mirror at `:3582`). |
| `:3744-3751` `savePrefs` | Extend `railFloat2` (§6). |
| `:3888-3903` | Build `#more-overflow`, `#rail-width-group`, `#rail-ovmode-group` into `morePop`. |
| `:3920` | The auto-close exemption (§2). |
| `:3929-3932` | Stamp `railOrder` / `railPrio` while filling `railScroll`. |
| after `:4008`, inside `if (!READONLY)` | `makeResizable(...)` + `makeOverflow(...)`. **Must stay inside the READONLY gate** (`:3936`) — a read-only submission must never write layout prefs (R7). |
| `:4012-4013` | Restore `ovMode` then `width` **before** `alignRailToCard()`/`clampFixed()` at `:4033-4034`, so the clamp measures final geometry. |
| `:4029` | Guard the inline width write (§5.3). |
| `:4035` `onRailResize` | Append `railLayout.reflow()`. |
| `:4117-4128` (annotate-ON) | Add `railLayout.reflow()` after `syncRailVis()` — the bar was `display:none` and measured 0. |

Every new node lookup goes through `railRoot` / `railEl`, never `$()` or `document.querySelector` (B3-3, `app.js:3977`) — otherwise a page with two overlay questions has question 2's resizer driving question 1's bar.

### 4.4 `notes-dock.js` — pushed clearance

```js
// notes-dock.js:16
let railClear = 64;            // was: const RAIL_CLEAR = 64
export function setRailClear(px) { railClear = Math.max(64, px | 0); }
```
Rename the two reads (`:111`, `:216`). The drag path at `:216` keeps reading a **plain module variable**, so there is still no per-frame measurement — that is the whole point of pushing rather than measuring. app.js calls `setRailClear(railEl.getBoundingClientRect().height + 12)` from the `#rail` ResizeObserver callback and from `setMode`. Height is realm-independent, so the reparented case needs no branch.

### 4.5 `syncHostPad()` (wrap mode only)

Using the existing `overlayHost()` (`app.js:956`): `host.style.paddingTop = Math.max(52, railH + 4) + "px"`, reset to `""` on switch back to `.ov-more`, skipped while `.fp-moved`. ~6 lines, no Python redeploy. **Land it in the same build as the toggle** — without it, wrap is judged as "covers the question" when the real defect is "unpadded", and the comparison is corrupted.

---

## 5. Reconciliation — what each existing mechanism must now do

**5.1 `.fp-moved { width: max-content }` (`style.css:798` / `chrome.css:265`)**
Becomes `width: var(--rail-w, max-content)`. **Unset** ⇒ `max-content`, today's exact behaviour: a moved bar is content-sized and never wraps (`max-content` sizes to the unwrapped line — intentional, and it must be documented or it reads as a bug). **Set** ⇒ the same px in both the pinned and moved states, so dragging a resized bar preserves its width instead of snapping to `max-content`. The `max-width: calc(100vw - 8px)` cap still forces degradation on a very narrow viewport.

**5.2 The drag lift clearing inline width (`floating-panel.js:71`, review R-3)**
**Unchanged — and must stay unchanged.** It clears the `width` *longhand*, which is `alignRailToCard`'s card-span (`app.js:4029`) and exactly what should be dropped on lift. A custom property is a different declaration and is untouched. Likewise `d.preW` (`:54`, `:102`) captures/restores `style.width` only — always `""` in the overlay today — so a **cancelled** drag also keeps the chosen width, correct by construction with zero engine edits.

**5.3 `alignRailToCard` (`app.js:4022-4032`)**
Dead today (bails at `:4025` when `railWin === window`, and `PHASE1_CHROME_REPARENT` is `false`). Guard **only the width write** at `:4029`:
```js
if (!railEl.style.getPropertyValue("--rail-w")) railEl.style.width = `${Math.round(Math.max(0, fr.width - 8))}px`;
```
`left` and `top` keep updating unconditionally, so a resized default bar still tracks the question card horizontally on parent scroll (`:4043-4049`). A blanket bail at `:4025` would freeze the bar's left edge — wrong.

**5.4 `clampFixed` / `clampIntoBand` — the one required engine edit**
`floating-panel.js:25` passes `r.height` as `handleH`; `:87` passes `drag.ph`. `visible-band.js:43` documents the assumption that the handle is the top strip and `GRAB(56) ≥ every header height` — which is what makes `top_min = by0` (R1). A wrapped ~100px bar violates it: `top_min = by0 − 44`. Fix at both sites:

```js
import { visibleBand, clampIntoBand, GRAB } from "./visible-band.js?v=166";
// :25  …, r.width, r.height, Math.min(r.height, GRAB), band);
// :87  …, drag.pw, drag.ph, Math.min(drag.ph, GRAB), drag.band);
```
At today's 52px bar `min(52, 56) = 52` — **byte-identical**, zero regression. The bottom bound is unaffected (`gy = min(56, handleH)` = 56 either way). `visible-band.js` itself needs **no** change; `notes-dock.js` passes `headH` explicitly and is untouched.

`clampIntoBand`'s horizontal guarantee needs nothing: `gx = min(56, w)`, and `MIN_W ≥ 240`, so 56px of width always stays in-band on both edges — **no width can strand the bar.** For a MOVED bar the post-resize `clampFixed` is load-bearing, not decorative: a bar at `left:-300` with `width:400` (100px visible) shrunk to `width:150` has its right edge at −150, fully off-screen; `clampIntoBand`'s lower bound `bx0 − (w − gx)` pulls it back.

**5.5 `.fp-collapsed` right-anchor (`floating-panel.js:133-151`)**
**Unchanged and width-agnostic by construction.** It captures `preRight`, then inside a rAF re-solves `left = right − newWidth` from a fresh post-class-change measurement — a 360px bar collapses and re-expands to the same right edge as a 900px one. The CSS `width:auto` still wins (§3.1), so the collapsed handle is a handle at any `--rail-w`. Idempotent collapse/expand (v164) is preserved. Add `.fp-resize` to the collapsed hide-list (`style.css:818`) so the handle doesn't sit over the collapse button.

**5.6 `restickRail` (`app.js:4073-4083`)**
**No edit.** It writes only `top`, re-measures `r` each call, and `band.top + MARGIN` is always inside `clampIntoBand`'s top range at any bar height or width. The sticky default bar keeps a CSS-owned left/width; a moved bar is skipped at `:4075`.

**5.7 `calcDodgeNudge` / `dodgeEl` (`app.js:4154-4194`)**
No edit — the rect is read fresh per call. `setWidth`'s `onChange` calls it (matching `app.js:4008`) so a resize that parks the bar in a calculator hole self-corrects.

---

## 6. Persistence

Extend the existing versioned `railFloat2` sub-key (`app.js:3744-3751`) — **not** a sibling key. One carry-forward path, per-question via `PREFS_KEY` (`app.js:3684`), and the tolerant reader already ignores unknown fields, so a v165 pref object loads on v166 and vice-versa.

```js
railFloat2: overlay && railRoot.querySelector("#rail")
  ? (() => {
      const r = railRoot.querySelector("#rail");
      return {
        left:      r.classList.contains("fp-moved") ? r.style.left : "",
        top:       r.classList.contains("fp-moved") ? r.style.top  : "",
        collapsed: r.classList.contains("fp-collapsed"),
        width:     r.style.getPropertyValue("--rail-w") || "",   // "" = Full
        ovMode:    r.classList.contains("ov-wrap") ? "wrap" : "more",
      };
    })()
  : (prev.railFloat2 || {}),
```

**Restore** at `app.js:4012-4013`, ordered: `setMode` → `setWidth` → `floatTo` → `alignRailToCard()` → `clampFixed()` → rAF → `reflow()`.

Validation (localStorage is writable by anything in the origin; a `NaN` or `99999px` must never strand the bar):
```js
const w = parseFloat(rp.width);
if (Number.isFinite(w) && w > 0) railResize.setWidth(w);   // setWidth re-clamps to the CURRENT band
railLayout.setMode(rp.ovMode === "wrap" ? "wrap" : "more"); // allowlist, default RAIL_OVERFLOW_DEFAULT
```
Because `setWidth` re-clamps against `visibleBand(railWin)` at apply time, a 900px width saved on a desktop restores as ~500px inside a narrow PL card. Collapsed state is still **not** re-applied on load (R4, `app.js:4014-4017`) — unchanged.

---

## 7. Test matrix

Per the standing rule: hosted PL in the user's Chrome, **iframe clearly <900px wide**, and confirm the loaded `APP_VERSION === "166"` in the page *before* asserting anything.

**Grid A — core (must all pass).** `{Full, Medium, Compact, free-min, free-max}` × `{wrap, more}` × `{default, moved, collapsed}` = 30 cells. Per cell:
1. every tool reachable (on the bar, in More, or via the `.rail-scroll` residue scroller);
2. grip/Notes/More/collapse/resize all visible and hit-testable;
3. no horizontal page scrollbar; the bar never exceeds the band.

**Grid B — the 4 edges.** For each of `{Compact, Full}` × `{wrap, more}`: drag the bar hard past **left, right, top, bottom**, release. Assert ≥56px of width in-band horizontally and the top edge **never above `band.top`** (this is the §5.4 fix — do it with a *wrapped* bar, which is the only case that used to fail).

**Grid C — state interactions.**
- Collapse → expand at each preset: same right edge, expands back to the same rows (v164/v165 idempotency).
- Resize *while* collapsed: handle hidden; no width change leaks.
- Free-drag width → then bar-drag → then release: width **survives** (this is the R-3 reconciliation, §5.2).
- Cancel a bar-drag (Esc / tab-away) mid-lift: width survives.
- `.big` on/off in both modes at Compact: presets re-derived, no clip, no gap.
- Toggle wrap↔more 10× at a fixed width: identical layout each time, no drift, no orphan in `#more-overflow`.
- Sweep the handle slowly across the demotion threshold in `.ov-more`: **zero flicker** (the hysteresis gate).
- Active tool = Snip at Compact: Snip is not demoted; force it (activate Draw, demote Snip, then keyboard-`S`) and confirm the shortcut still arms it.
- Notes open + `.ov-wrap`: the notes header cannot be dragged behind row 2 (`setRailClear`).
- Calculator drawer open under a resized moved bar: dodge still fires.
- More popover open with the bar parked low in the band: flips above, scrolls internally.

**Grid D — persistence.** Set each of `{Compact/wrap, Medium/more, free-437px/wrap}`, reload, assert width + mode restored and clamped. Then reload at a **narrower** window and assert the width clamps down without stranding. Then hand-corrupt `railFloat2.width` to `"NaN"` and `"99999px"` and assert a sane bar.

**Grid E — no-regression sweep (CLAUDE.md §4).** Standalone PDF, standalone HTML, `embed/host-demo.html`, and the read-only submission view: the handle and both groups are **absent**, and nothing about the bar changed. Read-only additionally: no pref write (watch `localStorage`).

---

## 8. The single riskiest assumption

**That `scroll.scrollWidth > scroll.clientWidth + 1` is a real, monotonic, non-oscillating overflow signal for `.rail-scroll`.**

Everything in `.ov-more` rests on it. The reasoning says it holds — `.rail-group` is a flex item of `.rail-scroll` with default `min-width:auto`, so it floors at min-content and genuinely overflows rather than crushing — but that reasoning also depends on `.tool { width:auto; min-width:0 }` (`style.css:713`), `white-space:nowrap` on the labels (`:860`), the `#context-bar` sub-flex, and the `padding: 2px 0; margin: -2px 0` (`:959`) that offsets the box. If items silently shrink instead of overflowing, the demote loop never fires and `.ov-more` ships as a no-op that *looks* correct in review. If they overflow non-monotonically, it ships as a flickering toolbar. Both are exactly the class of thing this project's mistakes log says must be **seen**, not reasoned about.

**De-risk before wiring any UI** — a ~15-line harness in `embed/host-demo.html`:

```js
// sweep --rail-w from full down to MIN_W in 4px steps; log per step:
//   { w, scrollWidth, clientWidth, overflowing, demotedSet }
// assert: (1) `overflowing` flips false→true exactly once across the sweep;
//         (2) demotedSet is monotonically non-decreasing as w shrinks and the
//             mirror-image is identical on the way back up (no hysteresis leak);
//         (3) no step produces more than one demote/promote transition.
```

Run it at `.big` on and off, and at both `.ov-wrap` and `.ov-more`. It is cheap, it is deterministic, and it fails loudly on the exact defect that would otherwise reach the hosted verification pass.

**Second-order risks worth naming, with their mitigations:**
- **`chrome.css` drift.** Every rule lands twice, and the mirror is inert today (`PHASE1_CHROME_REPARENT = false`, `app.js:117`), so a mistake in it surfaces at the Phase-1 flip — the worst possible time. Mitigation: do the two files in one edit pass, rule for rule, and add a `// mirror: style.css:<line>` comment on each new `chrome.css` block. Note that CLAUDE.md's deploy excludes `chrome.css` from the class-repo rsync.
- **Merge collision with the in-flight Annotate/Done pill (requirement C).** Both touch the More-popover build (`app.js:3888-3903`) and `savePrefs`. **Sequence them; do not develop in parallel.**
- **The trial ships dead code by design.** Set an explicit expiry on the verdict, or the codebase permanently carries two overflow strategies plus a toggle. Deletion is contained: `.ov-wrap` is one CSS block per file plus `syncHostPad`; `.ov-more` is `rail-overflow.js`'s demote half, `#more-overflow`, and its call sites.
- **Judging bias.** Whichever mode ships as default accumulates usage and skews the verdict. Ship `.ov-more` (it holds the bar at 52px and leaves every height consumer at today's values), then evaluate both **at the same preset**, on a question with prose in its first two lines, at iframe width <900px.