# Instructions: Classroom PDF Annotation Tool ("Scribble")

A web-based tool for students to scribble on question papers, add text blurbs, highlight, and mark answers. Core logic in Rust compiled to WebAssembly. Designed to be **as safe, non-vulnerable, and simple as possible**.

## 1. Decisions already made (do not re-ask)

- **Stack:** Rust → WASM in the browser. No backend logic — the server only serves static files.
- **Paper input:** Student uploads a question-paper **PDF**.
- **PDF rendering:** **PDF.js** (Mozilla) renders pages to canvas. Rust/WASM owns all annotation state and logic.
- **Hosting:** Online hosted (static hosting is fine: GitHub Pages, Netlify, nginx). Still vendor PDF.js locally — no CDN.
- **Save/load:** **JSON annotation file** (small, transparent, easy to validate). Student re-opens the same PDF and loads the JSON. Store the PDF's SHA-256 hash in the JSON and warn on mismatch.
- **Features, phased:**
  - **Phase 1 (MVP):** pen (freehand), highlighter (semi-transparent), basic color palette (black, red, blue, green, yellow), eraser (stroke-level), undo/redo, text blurbs, save/load JSON, multi-page navigation.
  - **Phase 2:** shapes — circle/ellipse, arrow, tick, cross; stroke width control; export annotated pages to PNG/PDF.

## 2. Architecture

```
Browser (everything client-side, no data ever sent to a server)
├── index.html + minimal JS glue
├── PDF.js (vendored locally) → renders PDF page to a background <canvas>
├── Annotation <canvas> layered on top (pointer events captured here)
└── Rust → WASM module (wasm-bindgen)
    ├── Document model: pages → annotations (strokes, texts, shapes)
    ├── Tool state machine (pen / highlighter / eraser / text / select)
    ├── Undo/redo: command stack (bounded, e.g. 200 entries)
    ├── Hit testing for eraser/select
    ├── Serialization: serde JSON (save) + strict validation (load)
    └── Render command list → JS draws onto annotation canvas
```

- **Coordinates:** store annotations in PDF-page coordinates (not screen pixels) so zoom/resize doesn't break them.
- **Rendering split:** Rust computes *what* to draw (stroke points, colors, transforms); a thin JS layer issues Canvas2D calls. Avoid passing large data per frame — use a dirty-flag + full-page redraw of the current page (simple and fast enough).
- **JS kept minimal:** file input, canvas setup, pointer event forwarding (pointerdown/move/up with page coords + pressure if available), toolbar buttons calling exported WASM functions, triggering file downloads.

## 3. Data model (Rust)

```rust
struct Document { version: u32, pdf_sha256: String, pages: Vec<Page> }
struct Page { index: u32, width: f32, height: f32, items: Vec<Item> }
enum Item {
    Stroke { tool: PenKind, color: Color, width: f32, points: Vec<(f32, f32)> },
    Text   { pos: (f32, f32), content: String, color: Color, size: f32 },
    Shape  { kind: ShapeKind, rect: Rect, color: Color, width: f32 }, // phase 2
}
enum PenKind { Pen, Highlighter }       // highlighter = alpha 0.35, multiply blend
enum Color { Black, Red, Blue, Green, Yellow } // closed enum, no arbitrary CSS strings
```

Each item gets a monotonically increasing u64 id for undo/eraser targeting.

## 4. Security requirements (the priority)

**Threat model:** untrusted inputs are (a) the uploaded PDF, (b) the loaded JSON annotation file, (c) text typed into blurbs. There is no server-side attack surface — keep it that way.

1. **No backend, no data exfiltration.** App is purely static. Zero fetch/XHR to any API. No analytics, no telemetry, no cookies, no localStorage of student content (in-memory only; explicit save = file download).
2. **Strict CSP** via meta tag and server header:
   `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' blob:; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`
   No inline scripts, no eval. Serve over HTTPS with `X-Content-Type-Options: nosniff`.
3. **Vendor all dependencies locally** (PDF.js, fonts, CSS). No CDNs — eliminates supply-chain-at-runtime and tracking. Pin PDF.js to a current release and record its hash.
4. **PDF handling:** PDF.js with `isEvalSupported: false` and JavaScript-in-PDF disabled (`enableScripting: false`). Cap file size (e.g. 50 MB) and page count (e.g. 100) before parsing. Wrap loading in try/catch; a malformed PDF must fail gracefully with a user message.
5. **JSON load validation (treat as hostile):** parse with serde into the strict schema — unknown fields rejected (`deny_unknown_fields`), enums closed, all numbers checked finite and range-clamped (coords within page bounds, width 0.5–30, points per stroke ≤ 10,000, items per page ≤ 5,000, file ≤ 10 MB). Reject on any violation; never partially apply.
6. **Text blurbs / XSS:** never insert annotation text into the DOM as HTML. Render text via `canvas.fillText` (no HTML at all) — this makes XSS structurally impossible. The text input box itself uses `.value` only. Cap blurb length (e.g. 500 chars).
7. **Rust safety:** `#![forbid(unsafe_code)]`. No panics across the WASM boundary — all exported fns return `Result`-mapped errors; use `catch_unwind`-safe patterns / validate before indexing. Run `cargo clippy -D warnings` and `cargo audit` in CI.
8. **Dependency minimalism:** only `wasm-bindgen`, `serde`, `serde_json`, `js-sys`/`web-sys` (feature-gated to exactly what's used), `sha2`. Commit `Cargo.lock`.
9. **Filenames:** generated downloads use a fixed sanitized pattern (`annotations-<timestamp>.json`); never reflect user-supplied names into the DOM.
10. **No URLs/links rendered as clickable** anywhere from user content.

## 5. UI spec (keep it simple)

- Top toolbar: tool buttons (Pen, Highlighter, Text, Eraser), 5 color swatches, undo/redo, page prev/next + page indicator, zoom −/＋, Open PDF, Save, Load.
- Single centered page view with the two stacked canvases. Highlighter renders below pen visually is NOT required — draw in insertion order (simpler).
- Text tool: click → small input appears at click point → Enter commits, Esc cancels → rendered with fillText.
- Eraser: tap/drag deletes whole strokes it touches (stroke-level, not pixel-level — far simpler and undoable).
- Keyboard: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z redo. Touch + stylus + mouse via Pointer Events.
- Unsaved-changes warning via `beforeunload`.

## 6. Project layout & build

```
scribble/
├── Cargo.toml            # crate-type = ["cdylib"], forbid unsafe
├── src/lib.rs            # wasm-bindgen exports
├── src/model.rs, tools.rs, history.rs, serialize.rs, validate.rs
├── web/index.html, app.js, style.css
├── web/vendor/pdfjs/     # pinned PDF.js build
└── tests/                # native unit tests for model/validation
```

- Build with `wasm-pack build --target web --release`. Output copied into `web/pkg/`.
- Serve locally for dev: `python3 -m http.server` (WASM needs http, not file://).
- CI: `cargo test`, `cargo clippy -D warnings`, `cargo audit`, `wasm-pack build`.

## 7. Implementation order

1. Scaffold crate + wasm-pack build + blank canvas rendering loop.
2. PDF.js integration: open PDF, render page 1, page navigation, zoom.
3. Pen strokes (model + draw + pointer events), colors.
4. Highlighter (alpha), eraser (hit-test), undo/redo command stack.
5. Text blurbs.
6. Save/load JSON with full validation + PDF hash check.
7. Security pass: CSP, caps, fuzz the JSON loader with bad files, clippy/audit clean.
8. Phase 2: shapes, stroke width, PNG/PDF export.

## 8. Acceptance checklist

- [ ] Annotate a 10-page PDF smoothly on a laptop and a tablet (stylus).
- [ ] Save → reload page → load JSON restores everything; wrong PDF triggers hash warning.
- [ ] Malformed/hostile JSON and PDF inputs are rejected with a friendly error, never a crash.
- [ ] `<script>alert(1)</script>` typed in a blurb renders as literal text on canvas.
- [ ] CSP violations: zero in devtools console. No network requests after initial page load.
- [ ] `cargo audit` and `clippy` clean; `unsafe_code` forbidden.
