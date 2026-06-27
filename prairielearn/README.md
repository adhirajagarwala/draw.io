# Scribble in PrairieLearn

Embed the [Scribble](../scribble) annotation tool into a self-hosted PrairieLearn question.
**MVP = pure scratchpad** (nothing graded or saved server-side). See [integration-plan.md](integration-plan.md)
for the full architecture, the verified PrairieLearn facts, the upgrade path (saved → graded), and risks.

```
prairielearn/
├── integration-plan.md     ← the plan: architecture, verified facts, upgrade path, risks, open questions
├── deploy.sh               ← build the wasm bundle + copy it into a course's clientFilesCourse/scribble/
├── example-course/         ← a drop-in PrairieLearn course with the pl-scribble element + demo question
│   ├── elements/pl-scribble/   ← the custom element (srcdoc-iframe approach)
│   ├── questions/scratch-demo/ ← a demo question that uses <pl-scribble>
│   └── clientFilesCourse/scribble/ ← the deployed bundle (gitignored; run deploy.sh)
└── framing-probe/          ← (optional) a tiny local harness to test the framing path without Docker
```

## Prerequisites (one-time)
```sh
# Rust → wasm toolchain (match the wasm-bindgen crate pin in scribble/Cargo.toml = 0.2.100)
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.100
# A Docker runtime. On macOS without Docker Desktop:
brew install colima docker && colima start --cpu 4 --memory 6
```

## Run it
```sh
# 1. Build + deploy the compiled bundle into the demo course:
./prairielearn/deploy.sh

# 2. Run PrairieLearn with the demo course mounted (first pull is large):
docker run -d --name pl -p 3000:3000 \
  -v "$PWD/prairielearn/example-course:/course" \
  prairielearn/prairielearn

# 3. Open http://localhost:3000/pl  → SCRIBBLE 101 → Questions → "Scribble scratchpad demo" → Preview.
```

**Picking up changes** to course files (the element, question, or redeployed bundle): in the course,
go to **Sync → "Load from disk"** (local-dev re-reads the mount). If a change still isn't reflected,
`docker restart pl`.

## How the element works (the make-or-break detail)
PrairieLearn stamps `frame-ancestors 'none'` + `X-Frame-Options: DENY` on every `text/html` response,
so a plain `<iframe src=".../clientFilesCourse/scribble/index.html">` is **blocked by the browser**.
`elements/pl-scribble/pl-scribble.py` therefore reads the deployed `index.html`, injects
`<base href=".../clientFilesCourse/scribble/">`, and emits it as the iframe's **`srcdoc`** — `srcdoc`
content is parent-generated (no PL HTTP response carries those headers), so the framing block never
applies, the frame is same-origin with the page, and `<base>` resolves every relative asset URL
(app.js, the ES modules, `pkg/*.wasm`, `vendor/pdfjs`, `style.css`) to the bundle dir.

`clientFilesCourse` is served **same-origin** by PrairieLearn with no COOP/COEP/CORP, and PL imposes
**no** `script-src`/`worker-src` CSP — so single-threaded WASM + the PDF.js worker + `blob:`/`data:`
all work inside the frame.

## Upgrade path (later)
Scratchpad → **saved** (a hidden `<input>` in PL's form + `parse()`, mirroring PL's `pl-drawing`) →
**graded** (`grade()`). Scribble's `save_json`/`load_json` (Rust) already do the JSON round-trip with
hostile-input validation — **no Rust changes for "saved."** Details in [integration-plan.md](integration-plan.md) §5.
