# Working notes for this project (read before changing anything)

This file is the standing checklist. The rules here are written down because
ignoring them has cost real time and broken-looking demos.

## 0. How to work here — plan → critique → execute (every time)

Before writing code for any non-trivial change:

1. **Roadmap.** Write the concrete steps, the files each touches, and how each
   piece will be verified.
2. **Critique it.** List what could break, the edge cases, simpler
   alternatives, the UX/discoverability angle (not just "does it function"),
   and the single riskiest assumption. Revise the plan in light of that.
3. **Execute** the revised plan, then verify live (rule 9) before claiming it
   works.

Skipping this has repeatedly caused rework. Plan first, even when the change
feels obvious. Also: **ASK before assuming** when scope is ambiguous — this is a
project rule, not a suggestion.

## Mistakes log — read before testing/shipping (do NOT repeat)

- **Stale cache while testing through the browser.** A plain navigate served a
  stale `index.html` (page loaded `app.js?v=13` when the file was already v14),
  which made a working change look broken. Always: (a) bump `APP_VERSION` and
  the index `?v=` together, (b) when driving the page via the Chrome extension,
  append a unique `?cb=<n>` to the URL to force a fresh `index.html`, and
  (c) verify the loaded `APP_VERSION` in the page **before** running any test.
- **Reading state right after an async render.** Tests read `#page-input`
  immediately after an async `goToPage`/render and got stale, self-contradictory
  values. Wait for the render to settle (poll until the canvas/scrollHeight is
  stable) or assert on a deterministic signal — never read UI state in the same
  tick as the async action that changes it.
- **Shipping a feature that worked but wasn't usable.** Continuous scroll first
  shipped with invisible (white) page gaps and an icon-only, non-discoverable
  toggle. Build for visual clarity and discoverability — visible page
  separation, labeled controls — and critique the UX before executing, not after
  the user complains.
- **Not planning first.** Jumped straight into implementation without a written,
  critiqued roadmap. Follow section 0.
- **The browser caches `index.html` itself, so the USER sees stale code too.**
  `python -m http.server` sends no cache headers, so the browser may reuse a
  cached `index.html` on a normal reload — which still points at the OLD
  `app.js?v=`, so a correct `?v=` bump does nothing until a hard refresh. This
  showed up as the user reporting already-fixed features as "broken" (e.g. "you
  can't zoom HTML" when v29 zooms fine). Mitigation shipped: a
  `Cache-Control: no-store` meta in `index.html` so the document re-fetches each
  load. Still: when a user reports a fix "doesn't work," first confirm the loaded
  `APP_VERSION` matches the file, and tell them to hard-refresh.
- **Programmatic smooth scrolling silently no-ops in the virtualized viewer.**
  `element.scrollIntoView({behavior:'smooth'})` and `viewer.scrollTo({behavior:
  'smooth'})` do nothing inside `#viewer` (nested scroll container with
  `content-visibility` pages). Use instant `viewer.scrollTop = …` for page jumps
  (`scrollToContPage`). Native wheel/trackpad scrolling is unaffected.
- **A default `<canvas>` is 300×150, not 0×0.** Checking `canvas.width > 0` to
  mean "rendered/mounted" is wrong — an unrendered canvas reports 300×150. Test
  against the expected backing size instead.

## 1. ALWAYS HARD-REFRESH AFTER ANY CHANGE — Cmd+Shift+R

The dev server is `python3 -m http.server`, which sends **no cache headers**.
The browser will happily serve a **stale `app.js` / `style.css` / `.wasm`**, so
after editing anything in `scribble/web/` you MUST hard-refresh
(**Cmd+Shift+R** on macOS) before testing. A plain reload is not enough.

Symptoms of a stale cache (it has bitten us repeatedly):
- a new feature "doesn't work" or "isn't there"
- the console error references an **old `?v=` number** (e.g. `app.js?v=7` when
  the file is on v11) — this is the dead giveaway
- an uploaded file goes down the wrong code path (HTML opened as PDF, etc.)

If anything looks wrong, **hard-refresh first, then debug.**

## 2. Bump the cache version on EVERY web change

`index.html` references assets with `?v=N` and `app.js` has
`const APP_VERSION = "N"`. **Bump both together** on every change to
`app.js` / `style.css` / the wasm. They must match. This is what makes a normal
reload pick up changes for the user (and for the live tests).

Current version lives in `scribble/web/index.html` (`?v=`) and the top of
`scribble/web/app.js` (`APP_VERSION`).

**Don't forget the wasm-bindgen glue counter.** `app.js` imports the glue with a
**separate manual `?v=`** on `./pkg/scribble.js` (it is NOT interpolated from
`APP_VERSION`). Bump it together with `APP_VERSION`, **especially after a Rust
rebuild** — the glue is regenerated then, and a stale cached glue (missing a
newly-added export) against fresh JS is a real normal-reload break. The wasm
**binary** is versioned via `init({ module_or_path: \`./pkg/scribble_bg.wasm?v=${APP_VERSION}\` })`,
so it tracks `APP_VERSION` automatically — only the glue import needs hand-bumping.

## 3. Rebuild the WASM after ANY Rust change

Editing `scribble/src/*.rs` does nothing until you rebuild:

```sh
cd scribble
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen target/wasm32-unknown-unknown/release/scribble.wasm \
  --target web --out-dir web/pkg --no-typescript
```

Then bump the cache version (rule 2) and hard-refresh (rule 1). Forgetting the
rebuild = the browser runs the OLD wasm against NEW JS = confusing breakage.

## 4. Test ALL THREE modes after web changes, not just one

The app runs in three configurations and a change can silently break one:
- **Standalone PDF**: `localhost:8000/` → Open a PDF.
- **Standalone HTML**: `localhost:8000/` → Open an `.html` file.
- **Embedded**: `localhost:8000/embed/host-demo.html` (the full tool framed in
  a fake exam page, `?embed`).

Always sanity-check standalone after touching shared code; the user has twice
thought the whole tool was deleted when it was just the demo URL or a stale
cache.

## 5. The `docOpen()` invariant

A document is open and drawable when **PDF or HTML** is loaded. Anything that
gates interaction (pointer handlers, the contextual colour bar, hover cursors)
must use `docOpen()` — **never** `pdfDoc` directly — or HTML mode silently
can't draw. PDF-*only* machinery (page nav, thumbnails, PDF.js text layer, the
render lock, PDF export raster) may still check `pdfDoc`.

## 6. PDF.js rendering rules (these were hard-won)

- All `page.render()` calls go through `withRenderLock()` so two renders never
  overlap (overlap throws "Cannot use the same canvas…" and can wedge the
  worker).
- Use `intent: "print"` for renders so they complete without
  `requestAnimationFrame` (rAF is throttled to zero in occluded/background
  windows, which made renders hang forever).
- Do **not** re-add `disableAutoFetch` to `getDocument` — it caused page-2+
  renders to stall when the whole buffer is already in memory.

## 7. Security invariants — do not regress these

- Annotation/note text is **never** put into the DOM as HTML. On screen it is
  drawn with canvas `fillText`; in exports it is an escaped PDF string. UI
  messages use `textContent`. Keep it that way (no `innerHTML` of user content).
- Colours/fonts come from **closed Rust enums** — never build a colour/font
  string from user input.
- Loaded JSON is validated in Rust (`deny_unknown_fields`, finite/clamped
  numbers, caps, bidi/zero-width stripping) **before** anything is applied.
- Uploaded HTML renders in a sandboxed iframe with **no script permission**
  (`sandbox="allow-same-origin"`, no `allow-scripts`).
- `style-src` includes `'unsafe-inline'` **on purpose** (do NOT "tighten" it back).
  A `srcdoc` iframe inherits the page CSP, so without it the uploaded HTML's
  inline styles + `<style>` blocks are silently stripped — the page renders
  unstyled and the snip image (rendered from a *styled* SVG raster) no longer
  matches the on-screen selection. It's safe here: `script-src` stays `'self'`
  (no scripts, reinforced by the no-`allow-scripts` sandbox), and `default-src`/
  `img-src` stay `'self' blob: data:` so inline CSS still can't load anything
  external (no CSS exfiltration). Never add `'unsafe-inline'` to `script-src`.

## 8. After Rust changes, the checks that must pass

```sh
cd scribble
cargo test                              # currently 44 tests
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

CI runs these plus `cargo audit` on every push.

## 9. Don't claim it works without seeing it work

Verify in the actual browser (or a headless Node check for pure logic like the
PDF writer). Screenshot the result. "It should work" is not "it works" — most
of the painful moments here came from shipping unverified UI.

## 10. Scrolling — how to make it good (researched, do it this way)

The bad scroll feel came from one root cause: **scroll-jacking**. The
single-page wheel handler intercepts the wheel event and decides when to flip
pages. Every UX/engineering source says don't: it breaks the user's muscle
memory ("I scroll, the page moves"), fights trackpad momentum/acceleration, and
breaks keyboard, touch, and reduced-motion. Tuning thresholds/cooldowns can't
fix it — the interception **is** the problem.

Rules going forward:

1. **Never hijack wheel/touch to drive paging.** Don't `preventDefault()` a
   wheel/touch event to change pages. Let the browser scroll natively — its
   momentum, acceleration, rubber-band, keyboard and touch handling are already
   perfect and accessible. (This is why continuous scroll feels right and the
   page-flip heuristic never will.) Page changes come from real controls:
   buttons, page input, thumbnail clicks, PageUp/Down, and arrow keys.
2. **Continuous mode should be virtualized, not one giant canvas.** Real PDF
   viewers (PDF.js, Nutrient, EmbedPDF) render only the pages in/near the
   viewport and use sized placeholders for the rest — constant memory, smooth at
   any length, and no canvas-height ceiling. The current single tall canvas
   renders *every* page up front and caps out at ~16000px; fine for short exam
   papers, but the real fix is **per-page placeholder divs + lazy canvas render
   via `IntersectionObserver`** (render when within ~1 viewport, clear the
   canvas when far away).
3. **Lean on CSS the browser already optimizes:**
   - `content-visibility: auto` + `contain-intrinsic-size: <w> <h>` on each page
     wrapper → the browser skips rendering offscreen pages (web.dev measured ~7x
     faster initial render) and the intrinsic size keeps the scrollbar stable.
     `contain-intrinsic-size: auto <h>` remembers the last real size.
   - `overscroll-behavior: contain` on `#viewer` → no scroll-chaining / accidental
     browser back-swipe.
   - `scroll-behavior: smooth` for go-to-page / thumbnail jumps — but gate it on
     `prefers-reduced-motion`.
   - Optional `scroll-snap-type: y proximity` per page for a gentle snap that
     **never** fights the user (proximity, not mandatory).
4. **Keep the main thread free at 60fps:** passive listeners (`{passive:true}`)
   on any scroll/wheel/touch listener; never do layout work directly in a scroll
   handler — coalesce in `requestAnimationFrame` and separate reads from writes
   (no layout thrash). Prefer `IntersectionObserver` over a scroll handler for
   "which page is visible" (drives the page readout/thumbnail) — it avoids
   per-event geometry reads entirely.
5. **Crisp but bounded canvas:** render visible page canvases at
   `devicePixelRatio` for sharpness, but only the visible ones; clear/recycle
   far-offscreen canvases so memory stays bounded (a scanned-PDF memory blowup is
   a known PDF.js failure mode).

Sources to re-read if needed: scroll-jacking is bad UX (codeless.co,
webdesignerdepot, beamtic); PDF.js/virtualized viewers (mozilla/pdf.js,
nutrient.io, embedpdf.com); web.dev `content-visibility`; MDN
`overscroll-behavior`, `scroll-snap-type`, `scroll-behavior`; web.dev passive
listeners + rAF for scroll.

## Layout / where things live

- `scribble/src/` — Rust core (model, history, export ops, wasm API).
- `scribble/web/` — the app: `index.html`, `app.js`, `style.css`, `pkg/`
  (built wasm), `vendor/pdfjs/` (pinned, local).
- `scribble/web/embed/host-demo.html` — embedded-mode test harness.
- `SECURITY.md` — threat model. `ROADMAP.md`, `PROGRESS.md` — direction/status.
