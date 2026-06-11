# Security model

Scribble is a fully client-side tool. There is no server, no account, no
database, and no network call after the initial page load. This document
states the threat model, the defenses, and the residual risks honestly.

## Threat model

The program runs untrusted inputs in three places:

1. **The uploaded PDF** — an attacker-controlled binary parsed by PDF.js.
2. **A loaded work file** (`.json`) — attacker-controlled structured data,
   including base64 image clippings and free text.
3. **Typed text** — note text, captions, and on-page text annotations.

There is no server-side surface to attack: the only "backend" is a static
file host. The goals are therefore (a) no code execution from any input,
(b) no data exfiltration, and (c) no corruption of the user's other data.

## Defenses

### No network egress, no persistence of content
No `fetch`/`XHR` to any origin; no analytics, cookies, or `localStorage` of
user content. The app holds everything in memory; the only outputs are files
the user explicitly downloads (Save → JSON, Export → PDF). A global error
handler surfaces failures in-app rather than failing silently.

### Strict Content-Security-Policy
Set in `index.html` (mirror it as an HTTP header when hosting):

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self';
img-src 'self' blob:; style-src 'self'; object-src 'none'; base-uri 'none';
form-action 'none'; frame-ancestors 'none'
```

No inline scripts, no `eval`, no remote script origins, no framing, no form
submission. `img-src` allows `blob:` only (for locally generated clipping
previews). This is the primary backstop against script injection.

### Vendored dependencies, pinned
PDF.js 4.10.38 (legacy build) is committed in `web/vendor/pdfjs/` — no CDN,
so there is no runtime supply-chain or tracking vector. SHA-256 of the
vendored files is recorded in `scribble/README.md`. The build pins
`wasm-bindgen` to an exact version and commits `Cargo.lock`.

### PDF parsing
PDF.js runs with `isEvalSupported: false`, so PDF-embedded function streams
are never JIT-compiled via `eval` (which the CSP also forbids). PDFs are
capped at 50 MB and 100 pages before parsing; a malformed PDF degrades to a
friendly message instead of a crash. All page rendering is serialized through
one lock and uses `intent: "print"` so a render can never stall the worker.

### Work-file (JSON) loading — treated as hostile
Loaded JSON is size-capped (30 MB), then parsed strictly in Rust with
`#[serde(deny_unknown_fields)]` and closed enums, then **fully validated**
before any of it is applied:

- every coordinate/size must be finite and is clamped to surface bounds;
- per-surface item counts, points-per-stroke, text length, and note-block
  counts are bounded;
- item ids must be unique across all surfaces;
- base64 clipping payloads are charset- and length-checked (and never decoded
  in Rust — the browser renders them as images);
- text and captions are rejected if they contain forbidden characters.

On any violation the load is rejected atomically; the current document is
left untouched. A mismatched-PDF or extra-pages work file prompts the user
**before** loading rather than silently discarding data.

### Text is structurally incapable of injection
Annotation/note text is **never** inserted into the DOM as HTML. On screen it
is drawn with canvas `fillText`; in exports it is written as a PDF literal
string through an escaper (`( ) \` escaped, Latin-1 octal-escaped, other code
points become `?`). UI messages use `textContent` only. This makes HTML/JS
injection and PDF content-stream injection structurally impossible, not just
filtered. Tests feed `<script>…`, `) Tj ET Q /evil (`, NUL/ESC/DEL controls,
Unicode bidi overrides (U+202A–202E, the classic "pay 100 → pay 001" spoof),
zero-width characters, and the BOM, and assert they are stripped or escaped.

### Colors and fonts come from closed enums
The palette and colors are Rust enums mapped to fixed CSS/RGB strings; no
user input ever becomes a color or font string. The colorblind-safe palette
is purely a display choice — files store the semantic color *name*, so a file
made in one palette renders correctly in the other.

### Rust core
`#![forbid(unsafe_code)]`; every public WASM method validates its inputs
(ids crossing the boundary as `f64` are checked as non-negative integers in
range; non-finite coordinates are ignored). 44 unit tests; CI runs
`cargo test`, `clippy -D warnings`, `cargo fmt --check`, a release WASM build,
and `cargo audit` on every push.

## Residual risks (stated honestly)

- **PDF.js is the largest trusted component.** It parses attacker-controlled
  PDFs. It is Mozilla's widely-used, fuzzed library, kept local and pinned,
  and run with eval disabled under a strict CSP — but a hypothetical PDF.js
  vulnerability is the most plausible way to attack this app. Mitigation:
  update the vendored copy periodically.
- **Denial of service, not compromise.** A pathological (but valid-within-
  caps) file could still be slow to render. Caps bound this; it cannot
  escalate beyond the tab.
- **The exported PDF embeds page images.** Anyone you share the export with
  sees the original paper plus your marks — same as handing over a marked-up
  printout. Nothing secret is added.

## Reporting

This is a course project; open an issue on the repository for any concern.
