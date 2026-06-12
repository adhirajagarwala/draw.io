# Scribble — progress update for review

A security-first, fully client-side PDF annotation tool (Rust → WebAssembly
core, thin JavaScript UI). This summarizes what changed since the last review,
split into (A) points you raised, (B) work we did on our own initiative, and
(C) the rationale for keeping PDF as the base format.

Status: 44 Rust unit tests passing; `clippy -D warnings`, `cargo fmt`, and
`cargo audit` clean; CI runs all of them on every push.

---

## A. Points from your review — addressed

1. **Colors + boxes / region tinting.** Added an outlined **Box** tool and a
   translucent **Highlight-box** that tints a whole region. Highlighter now
   uses marker-style tints (the old black/green highlights were unreadable).
2. **Split view with a working document.** A side-by-side **Notes pane** with
   a movable splitter (double-click to reset, button to hide).
3. **Select text / equations / images from the paper.** A **Snip tool**: drag
   a region and it captures *both* the image (PNG) and any underlying PDF text
   at once, into the notes; also a **Page-text tool** for selecting the PDF's
   own text. (See section C on why this is the right approach.)
4. **Inconsistent tooltips.** Every tooltip now reads "… (shortcut: X)" only
   when a shortcut actually exists; nothing else reuses that pattern.
5. **Keyboard shortcuts match Word/Docs.** Ctrl/Cmd+Z undo, **Ctrl/Cmd+Y** and
   Ctrl/Cmd+Shift+Z redo, **Ctrl/Cmd+S** save; V/P/H/T/E/S/I select tools.
6. **Contextual paging.** PageUp/PageDown scroll within a page, then cross to
   the previous/next page at the top/bottom edge (landing at the correct end);
   Home/End jump to first/last page.
7. **Export button styling.** Kept the emphasis but its tooltip now explains it
   is the final-output step.
8. **Loading work against the wrong PDF.** We now warn **before** loading (hash
   mismatch or extra pages) and let you cancel; nothing is silently discarded.
9. **Select / move / resize / delete.** A dedicated **Select tool** (no longer
   hidden inside other tools): move any annotation, corner-handle resize
   (uniform for strokes/text), Delete key, single-undo per edit.
10. **Editable readouts + zoom presets.** Page number is a type-and-Enter
    field; zoom is a dropdown with **Fit width / Fit page** plus presets that
    re-fit on window resize.
11. **Accessibility.** Marker tints fix invisible highlights; a **Large
    controls** toggle plus standard browser zoom (now lossless) covers toolbar
    sizing.
12. **Browser-zoom fuzziness.** Rendering is devicePixelRatio-aware, so pages
    stay crisp under browser zoom and on retina screens.
13. **Sanitization (the "bell character" critique).** Note/annotation text is
    now stripped of control characters **and** Unicode bidi overrides
    (U+202A–202E, the "pay 100 → pay 001" spoof), zero-width characters, and the
    BOM — on input and on file load — with adversarial tests, not a single
    cute case.
14. **Discoverable text editing.** Text notes are click-to-edit and draggable
    via the Select tool (previously the move code existed but had no UI).

---

## B. Work we did on our own initiative

1. **Draw on your notes.** Notes can now contain **blank sketch canvases**
   ("＋ Draw"). A sketch is a full annotation surface — the *same* pen,
   highlighter, shapes, text, eraser, select/move/resize/delete and undo work
   on it. Architecturally the engine treats PDF pages and note sketches as
   interchangeable "surfaces", so there is **no duplicated drawing logic**.
2. **Page thumbnails sidebar** that overlays your annotations, so you can see
   at a glance which pages have marks; click to jump. (Chosen over continuous
   scroll: ~15% of the cost, and it shows mark locations, which scroll doesn't.)
3. **Colorblind-safe palette toggle** (Okabe–Ito: green→brown, red→vermillion).
   Files store the semantic colour *name*, so a file made in one palette renders
   correctly in the other; marks also differ by **shape** (tick vs cross) so
   meaning never rides on hue alone.
4. **Vector PDF export.** On export, the page is embedded as an image but every
   annotation is written as **native PDF vector operators** (crisp at any zoom),
   and text notes export as **real, selectable PDF text**. Notes — text,
   clippings, and each sketch — are laid out as additional pages after the paper.
5. **Reliability hardening** (this was the bulk of recent work):
   - root-caused intermittent render hangs to PDF.js's reliance on
     `requestAnimationFrame` (which the browser throttles to zero in
     occluded/background windows) and switched all rendering to a completion-
     based path; all renders are serialized through one lock so they can't
     overlap and wedge the shared worker;
   - **cache-busting** version stamps on every asset (a stale cached script
     against a fresh WebAssembly module was a recurring "it broke after an
     update" cause);
   - a render **watchdog** and global error handlers so failures surface in the
     UI instead of hanging silently;
   - fixed the `favicon.ico` 404 on load.
6. **Save / Resume work files** (small JSON) with a SHA-256 check that the file
   matches the open PDF.
7. **Security write-up.** A full `SECURITY.md`: threat model, every defense
   (strict CSP, no network egress, vendored/pinned PDF.js with eval disabled,
   strict Rust validation of all loaded data, text that is structurally
   incapable of HTML/PDF injection), and honestly-stated residual risks.
8. **Engineering hygiene.** `#![forbid(unsafe_code)]`, exact-pinned
   dependencies, committed lockfile, and CI (test + clippy + fmt + audit).

---

## C. Why we kept PDF as the base format (and the text/equation question)

Your concern — that a PDF-as-image base risks losing the real text and
equations — is well founded, but the key point is **where** the loss happens:

- A PDF is a page-description: "draw glyph #45 of font F at (x, y); draw this
  line; place this image." Recovering **text** requires the fonts to carry a
  ToUnicode map. For body prose this is usually present — and we **do** extract
  it (text layer + Snip's text capture).
- For **equations** it usually is **not**: math is set from symbol fonts whose
  glyphs frequently have no Unicode mapping, and much of an equation (fraction
  bars, radicals, integral signs) is literal vector strokes, not characters.
  The semantic structure ("an integral from a to b") essentially never exists
  in a PDF. **That loss happens at PDF-creation time, upstream of our tool** —
  we do not degrade it, and we cannot recover what the source already discarded.

So the question becomes: is there a better import format? The honest trade-off
is **fidelity-to-the-printed-page vs. semantic richness**, and they conflict:

- HTML+MathML / LaTeX / DOCX preserve equation structure well — but papers are
  almost never distributed that way, you rarely have the source, and they
  **reflow**, so there is no fixed page to annotate. Importing them would mean
  re-typesetting the paper and annotating the re-typeset version, which won't
  match what students received.
- Plain images / scans are strictly **worse** than PDF (no text at all).

**Conclusion:** for a tool whose job is to annotate the *exact* document
students receive, PDF is the correct base — its limitations are inherited from
the source, not introduced by us. We mitigate them the right way: render the
page faithfully (fixed layout), pull the embedded text wherever the fonts
allow, and let Snip capture **both** the image and any underlying text of a
region. The one genuinely better capability — turning a snipped equation into
*structured* math (LaTeX/MathML) — is an **OCR feature layered on a snip**
(Mathpix-style), not a reason to change the base format. We've left it as an
explicit future option because the good math-OCR engines are cloud services,
and calling one would break our current "nothing leaves your machine"
guarantee unless bundled as an offline model.

---

## Questions for you

1. Does keeping PDF as the base, with Snip capturing image + text, match how
   you'd actually use it — or do you want structured equation capture
   (math-OCR) enough to accept either an offline model or a network call?
2. Is the thumbnails sidebar sufficient for long papers, or do you still want
   true continuous scroll?
3. Anything in the notes/sketch workflow that feels off in practice?
