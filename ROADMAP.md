# Roadmap — deferred items from review

Each item: what it is, the conventional approach, the approach we actually
plan to take (and why), and an effectiveness/cost judgement.

---

## 1. Split view with a working document

**Ask.** Paper on one side, your own document on the other, movable divider.

**Conventional approach.** Embed a rich-text editor (ProseMirror, Quill, or a
home-grown contenteditable). Heavy: a rich-text editor is its own project,
drags in big dependencies (against this project's security posture), and its
document model has nothing in common with ours.

**Planned approach — notes as blocks, not a word processor.** The working
document becomes a third section of our existing JSON model:

```
notes: Vec<NoteBlock>
NoteBlock = Text { content: String }        // plain text / markdown-ish
          | Clipping { png: bytes, source_page: u32, caption: String }
```

The pane renders as a simple vertical list — a `<textarea>` per text block
(auto-grown), an `<img>` per clipping. No contenteditable, no HTML from user
content, nothing new to sanitize beyond what `sanitize_text` already does.
Clippings arrive via the Snip tool (item 2). Undo/redo reuses the existing
command stack with two new commands. Save/Resume reuses the same JSON file
(size caps extended; PNG bytes base64-capped per clipping and in total).
Export appends rendered notes pages after the annotated paper using the same
PDF writer.

The splitter itself is trivial: CSS flex + a 6 px drag handle that adjusts
`flex-basis`; double-click resets 50/50; collapse button hides the pane.

**Why this works.** It deliberately refuses to be Word. For the actual
workflow — "read the paper, accumulate quotes/equations/figures with my own
comments between them" — an ordered list of text-and-clipping blocks is the
honest data structure, and it keeps the attack surface unchanged.

**Effectiveness: high (transforms the tool). Cost: ~3–4 days. Risk: low.**

---

## 2. Selecting text / equations / images from the PDF

**Ask.** Select a sentence, an equation, or a figure in the paper and drop it
into the working document.

**Conventional approach.** PDF.js text layer: transparent, absolutely
positioned `<span>`s over each text run, giving native browser selection.
Right for prose — and we will add it (it is nearly free from PDF.js) — but it
fails exactly where the reviewer's workflow lives: equations are emitted as
scrambled glyph soup, and figures aren't text at all.

**Planned approach — one Snip tool instead of three extractors.** A Snip tool
(S): drag a rectangle on the page, and we capture **both** representations of
that region at once:

- the **pixels** — copy the region from the already-rendered canvas at
  export resolution → a crisp PNG (works for equations, figures, tables,
  anything);
- the **text** — `page.getTextContent()` filtered to items whose boxes fall
  inside the rectangle, joined in reading order → real text when the region
  is prose.

Both go into a clipping block in the notes pane (PNG always, text attached
when non-empty); the system clipboard gets the PNG + plain text via the async
clipboard API. The user never has to know whether a region is "text" or
"image" — the unconventional move is refusing to classify content and just
taking both. The text layer is added separately, only active in Select mode
(annotation canvas gets `pointer-events: none` there), for ordinary
copy-to-elsewhere selection.

**Effectiveness: very high — this was the reviewer's core worry about a
PDF-as-image design, dissolved without rearchitecting. Cost: ~2 days for
Snip, ~1 day for the text layer. Risk: text extraction order can be imperfect
(PDF text order is famously unreliable); the PNG fallback bounds the damage.**

---

## 3. Select / move / **resize**

**Ask.** Full object manipulation (move shipped already; resize remains).

**Planned approach.** In Select mode, the active item shows a dashed
bounding box with **four corner handles only** — deliberately not the
conventional eight. Corner drags scale uniformly for strokes and text
(distorted handwriting and stretched glyphs look broken; uniform scale about
the opposite corner always looks right) and freely for boxes/circles/arrows,
where stretching is meaningful. Rust gets one new operation,
`resize_item(id, anchor, sx, sy)`: strokes scale their points, text scales
font size (clamped to existing min/max), shapes scale their rect — one
`Replace` command, so a whole resize is one undo step. Delete key removes the
selected item (existing `Remove` command). Selection visuals (dashed box) are
drawn by the canvas renderer, not DOM, so they cost nothing new.

**Effectiveness: high (completes the editing model users expect).
Cost: ~1–2 days. Risk: low — the geometry helpers (bbox, rigid translate)
already exist and resize is the same pattern.**

---

## 4. Resizable toolbar

**Ask.** A drag handle to make the toolbar bigger (accessibility).

**Planned approach — mostly already solved, finish with a toggle.** The
DPI-aware rendering shipped for fuzziness means **browser zoom now scales the
entire UI, toolbar included, with no quality loss** — that *is* OS-standard
UI scaling, with standard shortcuts (Ctrl/Cmd +/−), persistence per site, and
zero custom code to maintain. We document it, and add one cheap "Large
controls" toggle (a root CSS class bumping button/icon sizes ~25%) for users
who want a bigger toolbar without magnifying the page.

**Effectiveness: high for the actual need. Cost: hours.** A custom drag-to-
resize toolbar would be slower to build, fight browser zoom, and add a
settings surface — engineering a worse version of a feature browsers ship.

---

## 5. Colorblind-safe palette

**Ask.** Red/green is the most common confusion pair; maybe brown.

**Planned approach.** Two layers. (a) Marks already differ by **shape**
(tick vs cross), so meaning never rides on hue alone — keep that invariant as
new features land. (b) Add a palette toggle: default palette vs an
[Okabe–Ito](https://jfly.uni-koeln.de/color/)-based safe palette (vermillion,
sky blue, bluish green→brown, etc.). Implementation stays a **closed Rust
enum** — the toggle switches between two fixed `css()/rgb()` tables, so the
"user input can never inject a color string" property is untouched. Saved
files store the semantic color name, so a file made in one palette renders
correctly in the other.

**Effectiveness: medium-high (real accessibility win, cheap).
Cost: < 1 day. Risk: none.**

---

## 6. Page navigation at scale (continuous scroll?)

**Ask (implied).** PageUp/Down behavior hints at document-viewer
expectations; long papers need better wayfinding.

**Conventional approach.** Continuous vertical scroll of all pages with
virtualization — significant renderer complexity (multiple live canvases,
annotation hit-testing across page boundaries, memory management).

**Planned approach — thumbnails first.** A collapsible sidebar of low-res
page thumbnails (PDF.js renders them cheaply at ~0.2 scale, cached), with
annotation overlays drawn on top so you can *see which pages have marks* —
something continuous scroll doesn't even give you. Click to jump. This solves
wayfinding at ~15% of the cost and keeps the single-page invariant that the
whole input model relies on. Continuous scroll stays on the list, but only if
thumbnails prove insufficient in real use.

**Effectiveness: high per unit cost. Cost: ~1 day. Risk: low.**

---

## Suggested order

1. **Resize + selection visuals + Delete** (completes existing model, small)
2. **Snip tool** (biggest reviewer concern, unlocks clippings)
3. **Split pane + block-based notes** (uses Snip output)
4. **Thumbnails sidebar**
5. **Colorblind palette + large-controls toggle**
6. **PDF.js text layer** (native prose selection)

Items 1–2 are a weekend; 1–6 is roughly two weeks of part-time work.
