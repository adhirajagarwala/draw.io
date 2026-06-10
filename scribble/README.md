# Scribble — classroom PDF annotation tool

Students open a question paper (PDF), scribble with a pen, highlight, drop text
blurbs, erase, undo/redo, and save/load their annotations as a small JSON file.
All logic runs client-side in Rust → WebAssembly; the server only ever serves
static files.

## Run it

The app is pre-built (`web/pkg/` contains the WASM). Just serve `web/` over HTTP:

```sh
cd scribble/web
python3 -m http.server 8000
# open http://localhost:8000
```

(WASM cannot load from `file://` — any static server or static host works:
GitHub Pages, Netlify, nginx. Serve over HTTPS in production; the PDF hash
feature uses WebCrypto, which requires a secure context — localhost counts.)

## Usage

New in this version: a **Select tool (V)** with move/resize (corner handles;
strokes and text scale uniformly) and Delete; a **Snip tool (S)** that copies
any dragged region — image *and* the PDF text inside it — into a side-by-side
**Notes pane** (movable splitter) whose blocks export as extra pages in the
final PDF; a **Page-text tool (I)** for selecting the PDF's own text; a page
**thumbnails sidebar** showing your marks; a **colorblind-safe palette**
toggle (green→brown, red→vermillion; files store color names, not pixels);
and a **larger-controls** toggle.


- **Open PDF** → pick the question paper.
- Tools: Pen (P), Highlighter (H), Text (T), Eraser (E), plus tick, cross,
  circle, and arrow markers (click to place, or drag to size). 5 colors,
  3 line thicknesses.
- Text tool: click the page, type, press Enter (Esc cancels). With the text
  tool active, click an existing note to edit it (clearing the text deletes
  it) or drag it to move it — moves and edits are single undo steps.
- Eraser removes whole strokes/notes/marks it touches; everything is undoable
  (Ctrl/Cmd+Z, Shift for redo).
- **Save work** downloads `annotations-<timestamp>.json`. **Resume** restores
  it after re-opening the same PDF (a SHA-256 check warns if the PDF differs).
- **Export PDF** produces the final annotated paper. Each page is embedded as
  a high-resolution image, while all annotations are written as native PDF
  vector operators — crisp at any zoom — and text notes are real, selectable
  PDF text (Helvetica/WinAnsi; unsupported glyphs become `?`).

## Rebuild from source

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.100   # must match Cargo.toml
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen target/wasm32-unknown-unknown/release/scribble.wasm \
  --target web --out-dir web/pkg --no-typescript
```

Checks: `cargo test` (21 tests), `cargo clippy --all-targets -- -D warnings`,
`cargo fmt --check`, `cargo audit` (all run in CI).

## Security design

- **No backend, no data leaves the machine**: no fetch/XHR, analytics,
  cookies, or localStorage. Saving = explicit file download.
- **Strict CSP** (meta tag in `index.html`; mirror it as an HTTP header when
  hosting): `default-src 'self'`, no inline scripts, no eval,
  `object-src 'none'`, `frame-ancestors 'none'`.
- **Vendored dependencies**: PDF.js 4.10.38 is bundled locally in
  `web/vendor/pdfjs/` — no CDNs. SHA-256 of the vendored files:
  - `pdf.min.mjs` `27fc2a057a00f92a4334ad06e17dbd7259912954e9fb7f76400bcca5fd190a9c`
  - `pdf.worker.min.mjs` `1baa1844c89c80a5b2797c916e75ab29254be46d8e9cb53cb6364d7aad84be36`
- **Hostile-input handling**: PDFs capped at 50 MB / 100 pages, parsed with
  `isEvalSupported: false`, failures degrade to a friendly message. Annotation
  JSON is size-capped (10 MB), strictly parsed (`deny_unknown_fields`, closed
  enums), and fully validated (finite numbers, range clamps, item/point caps,
  duplicate-id rejection) — on any violation the load is rejected atomically.
- **XSS structurally impossible**: blurb text is drawn with canvas `fillText`,
  never inserted as HTML; UI messages use `textContent` only; colors/fonts come
  from closed Rust enums, never user strings.
- **Rust**: `#![forbid(unsafe_code)]`, no panicking paths across the WASM
  boundary, minimal dependency set (wasm-bindgen, serde, serde_json, web-sys
  with one feature).

## Layout

```
scribble/
├── Cargo.toml
├── src/lib.rs        # WASM API: tools, input, undo/redo, render, save/load
├── src/model.rs      # document model + strict validation (+ tests)
├── src/history.rs    # bounded undo/redo command stack
├── src/export.rs     # vector PDF operator generation (+ injection tests)
└── web/
    ├── index.html    # CSP, toolbar, layered canvases
    ├── app.js        # thin glue: PDF.js, pointer events, file I/O, PDF writer
    ├── style.css
    ├── pkg/          # built WASM (scribble.js + scribble_bg.wasm)
    └── vendor/pdfjs/ # pinned PDF.js (legacy build, broad browser support)
```

The PDF exporter writes the file from scratch in ~100 lines of JS (objects,
xref, trailer) with content streams generated in Rust — no PDF library is
needed, and the output contains nothing executable. Text written into notes
is escaped before entering the operator stream (see `export.rs` tests for the
injection attempt cases).
