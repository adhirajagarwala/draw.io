# Scribble → PrairieLearn: Integration Plan

Status: **VALIDATED END-TO-END.** The WASM was built, deployed to `clientFilesCourse`, and run inside a
real self-hosted PrairieLearn instance (Docker via colima). The `pl-scribble` element synced with **zero
errors**, and a headless-browser check confirmed **Scribble's full UI boots inside the `srcdoc` frame and the
WASM initializes — no framing/CSP/wasm/worker errors.** Screenshot: `scribble-in-prairielearn.png`.

> **✅ Make-or-break risk RESOLVED.** The `srcdoc` approach defeats PL's `frame-ancestors 'none'` block
> exactly as predicted: the frame loads, is same-origin, `<base href>` resolves all assets, the 339 KB
> WASM instantiates, and Scribble's toolbar/canvas render. The only console output was 3 harmless
> "frame-ancestors in a `<meta>` is ignored" warnings (cosmetic). **No probe needed — the real thing ran.**
>
> Remaining work is **feature**, not **risk**: Scribble currently boots standalone ("Open a PDF or HTML
> file…"). To make it a usable scratchpad it needs (a) embed-mode trigger in `srcdoc` (the injected
> `window.__SCRIBBLE_EMBED` flag + a check in `embed.js`), and (b) a draw surface — see §3.

Decisions locked with the user (2026-06-25):
- **MVP = pure scratchpad** (not graded, not saved server-side). Later: saved-with-submission, then graded.
- **Self-hosted** PrairieLearn (full control of the box).
- Scribble **overlays whatever PL renders** — PL parameterises the question normally (server.py
  `generate()` + Mustache); Scribble needs no parameterisation of its own.
- Framing path **decided by a probe** (see below), not on paper.
- MVP scope = **draw-only** (no reading/snipping the question DOM in v1).

---

## 1. Verified facts (from PrairieLearn's actual source — high confidence)

| Fact | Evidence | Implication |
|---|---|---|
| `clientFilesCourse` is **same-origin** with the question page (Express `res.sendFile`, route `/pl/.../clientFilesCourse/*`, no CDN). No COOP/COEP/CORP. `.wasm` → `application/wasm` on modern Express. | `apps/prairielearn/src/pages/clientFilesCourse/clientFilesCourse.ts`, `lib/express/send-file.ts` | Single-threaded WASM + the PDF.js worker + `blob:`/`data:` work; a same-origin frame *can* read the question DOM (only needed for the future read/snip feature). |
| PL's **only** CSP is `frame-ancestors 'none'` + `X-Frame-Options: DENY` on every `text/html /pl/*` response (loosened to `frame-ancestors 'self'` **only** for `application/pdf`). There is **no** `script-src`/`worker-src`/`connect-src`. | `apps/prairielearn/src/middlewares/content-security-policy.ts` (comment: "we only use CSP to prevent PrairieLearn from being rendered in an iframe") | **A plain `<iframe src="…/clientFilesCourse/scribble/index.html">` is blocked by the browser** (framing). But in-page scripts, WASM, workers, blob/data all run with no CSP fight. |
| A custom element's `render()` may emit **raw inline `<script>`**; raw `<script>`/`<iframe>` in plain `question.html` is not allowed. | docs + `pl-drawing` precedent | The integration **must** be a course element (matches the meeting note "available to pl-elements"). |
| `pl-drawing` (`apps/prairielearn/elements/pl-drawing/`) loads JS via `info.json` `dependencies` and persists the drawing into `submitted_answers` via a hidden `<input>` + `parse()` → `json.loads` → rehydrate. | `pl-drawing.py`, `pl-drawing.mustache` | Proven precedent for the **saved/graded upgrade**. |

---

## 2. The make-or-break decision: how to get Scribble into the frame

`frame-ancestors 'none'` blocks the obvious `src=` iframe. Three viable paths, ranked by a 2-minute probe:

1. **`srcdoc` iframe with `<base href>`** — *recommended primary.* The element's `render()` reads the
   deployed `index.html` from `client_files_course_path`, injects `<base href="{{client_files_course_url}}/scribble/">`,
   and emits it as the iframe's `srcdoc`. Because `srcdoc` content is **parent-generated (not a PL HTTP
   response)**, `frame-ancestors`/`X-Frame-Options` never apply — the framing block is sidestepped. A
   non-sandboxed `srcdoc` iframe is **same-origin with the parent**, and `<base href>` makes every relative
   asset URL (app.js, the ES modules, pkg/*.wasm, vendor/pdfjs, css) resolve to the `clientFilesCourse/scribble/`
   dir deterministically. **Portable (no server patch).** Risk retired by Probe B in the harness.
2. **In-page mount** (no iframe) — *fallback.* `info.json` lists the bundle in `clientFilesCourseScripts`;
   Scribble initialises inside the question document. PL's minimal CSP allows it. Risk = CSS/ID collisions
   (Scribble assumes it owns `document`); needs scoping work.
3. **Plain `src=`** — *only if you patch the box.* Extend the `application/pdf` branch in
   `content-security-policy.ts` to emit `frame-ancestors 'self'` for `clientFilesCourse` HTML → the simple
   `src=` iframe works with **zero Scribble changes**. Cleanest *client* code, but **not portable** (re-apply
   on every PL upgrade; won't work on managed PL). Reasonable for a box you fully own.

**Use the local harness (`framing-probe/`) to choose before standing up Docker.** Then the real PL probe
(`docs has the snippet`) confirms on the live box.

---

## 3. The honest scope (what's actually net-new)

The earlier draft called the MVP "basically CSS + a one-line element." Deeper analysis says that's
optimistic. Net-new work, smallest → largest:

- **Element + serving (small):** the `pl-scribble` element (see `example-course/elements/pl-scribble/`) +
  staging the compiled bundle into `clientFilesCourse/scribble/`.
- **Embed-mode trigger in `srcdoc` (small Scribble change):** Scribble enters embed mode from `?embed` in the
  URL. A `srcdoc` iframe has **no URL/query**, so we must trigger embed mode another way — inject
  `<script>window.__SCRIBBLE_EMBED = true</script>` before `app.js` and have Scribble check that flag in
  addition to `?embed`. ~3 lines in `app.js`/`embed.js`.
- **The "draw-only scratchpad" surface (the real design question):** Scribble draws on a *document* (PDF/HTML
  it opens). It has no "blank canvas / transparent overlay" mode today. Options:
  - **(a) Render the question inside Scribble** — feed the PL-rendered question HTML into Scribble's existing
    `openHtml()` so the student annotates a faithful copy with full tools. *Best fit for Scribble's strengths;
    perfect alignment; but renders the question twice (hide PL's panel or sit beside it).* **Recommended for v1.**
  - **(b) Transparent overlay** — a transparent Scribble canvas positioned over the live PL question (shows
    through), pointer-events gated. Most "annotate in place," but a genuinely new Scribble mode + alignment work.
  - **(c) Blank scratchpad** — Scribble opens a blank page to scribble on. Simplest, but least tied to the question.
  This choice is **open** — see §6.
- **Layout (medium):** dock tools right, notes below the question, floatable/resizable panel — gated on
  `body.embedded`. Real front-end work; prototype + critique discoverability first (CLAUDE.md §0).

---

## 4. Build & deploy (you run this)

```sh
# 1. Build Scribble (CLAUDE.md §3 — needs the wasm toolchain, NOT available in the agent env)
cd scribble
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen target/wasm32-unknown-unknown/release/scribble.wasm --target web --out-dir web/pkg --no-typescript
# 2. Deploy the COMPILED bundle into the course (see prairielearn/deploy.sh)
./prairielearn/deploy.sh ~/pl-scribble-course
# 3. Run PL (see prairielearn/README.md), Sync/Load-from-disk, preview the question, run the probe.
```

---

## 5. Upgrade path (additive — no rewrite, no Rust changes for "saved")

Scribble already has `save_json()`/`load_json()` (`scribble/src/lib.rs`) with hostile-input validation —
these map 1:1 to pl-drawing's `JSON.stringify` write / `parse()`→`json.loads`→rehydrate. **Stub three seams
in `embed.js` now** (MVP no-ops): **emit** (debounced `save_json()` → host callback), **hydrate**
(`load_json()` on init if the host injected initial state), **identity** (stamp PL `variant`/submission id on
the render() container — the HTML-mode analogue of Scribble's PDF-hash autosave key, which is inert here).
**Saved (v2):** add one `<input type="hidden" name="…">` inside PL's `<form>` in the render() container (never
inside the iframe); fill the emit/hydrate callbacks; add `pl-scribble.py parse()` mirroring pl-drawing.
**Graded (v3):** add `grade()`.

> ⚠️ Scribble's existing IndexedDB autosave is **hard-gated to `docMode === "pdf"`** and keyed on the PDF
> hash — it is **completely inert** in the HTML overlay. The save upgrade *replaces* the persistence
> substrate with the hidden-input bridge; it does not "turn on" existing autosave.

---

## 6. Risks & open questions

**Risks (confidence):** framing path (med — *retired by the harness*) · PDF.js worker under `worker-src 'self'`
with no `blob:` (med — only bites on PDF questions; fix = add `blob:` to Scribble's CSP meta) · `.wasm` MIME on
the deployed Express (med — Network-tab check; needs streaming→ArrayBuffer fallback in `pkg/scribble.js`) ·
overlay swallowing PL answer clicks (high — `pointer-events:none` except Draw mode) · layout = real UI, not
config (high).

**Open questions for the user:**
- **Draw-only surface (§3):** render-question-inside-Scribble (a, recommended) vs transparent-overlay (b) vs
  blank-scratchpad (c)?
- **Framing:** confirm "decide by probe" → run `framing-probe/` then the live probe; or pre-commit to the
  CSP patch if you want the simplest client code on your own box.

## What's NOT done here (you must do)
- Build the WASM bundle (toolchain not in the agent env).
- Stand up PrairieLearn (Docker) and add the course.
- Run the framing probe (browser, on the live box — or the local harness first).
