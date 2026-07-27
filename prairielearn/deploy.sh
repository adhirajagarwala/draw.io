#!/usr/bin/env bash
# Build Scribble's WASM bundle and deploy the COMPILED output + the pl-scribble ELEMENT into BOTH PrairieLearn
# course copies in ONE run, then assert the two deployed trees are byte-identical (Fable roadmap #5: kill the
# drift risk from two hand-run rsyncs with different excludes + a hand-copied element — the v166 stale-button
# incident was exactly that). Never touches the Rust source.
#
# Usage:  ./prairielearn/deploy.sh [CLASS_COURSE_DIR]
#   CLASS_COURSE_DIR defaults to the sibling class repo (../pl-uiuc-ece498sl).
#
# Requires: rustup target add wasm32-unknown-unknown ; cargo install wasm-bindgen-cli --version 0.2.100
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEMO="$REPO/prairielearn/example-course"                       # in-repo demo course (bundle gitignored, element tracked)
CLASS="${1:-$(cd "$REPO/.." && pwd)/pl-uiuc-ece498sl}"         # the hosted class repo (sibling of this repo)
ELEMENT_SRC="$DEMO/elements/pl-scribble"                       # single source of truth for the element

echo "→ building Scribble (release wasm)…"
cd "$REPO/scribble"
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen target/wasm32-unknown-unknown/release/scribble.wasm \
  --target web --out-dir web/pkg --no-typescript

# VERSION GATE (v187): every ?v=<N> in the web bundle must equal app.js's APP_VERSION. Hand-bumping ~20
# references (index.html + each module's cross-imports) is easy to get wrong, and a single stray old ?v= is a
# silent normal-reload break (a fresh JS against a cached old module). Fail the deploy on any drift.
echo "→ version gate…"
WEB="$REPO/scribble/web"
APPV="$(grep -oE 'APP_VERSION = "([0-9]+)"' "$WEB/app.js" | grep -oE '[0-9]+')"
[ -n "$APPV" ] || { echo "::error:: could not read APP_VERSION from app.js"; exit 1; }
GREP_OPTS=(--include='*.js' --include='*.html' --exclude-dir=vendor --exclude-dir=pkg --exclude-dir=embed --exclude-dir=test)
STRAY="$(grep -rhoE '\?v=[0-9]+' "$WEB" "${GREP_OPTS[@]}" 2>/dev/null | grep -oE '[0-9]+' | sort -u | grep -vx "$APPV" || true)"
if [ -n "$STRAY" ]; then
  echo "::error:: version drift — APP_VERSION=$APPV but found stale ?v= referencing: $(echo $STRAY | tr '\n' ' ')"
  grep -rnE '\?v=[0-9]+' "$WEB" "${GREP_OPTS[@]}" | grep -vE "\?v=$APPV([^0-9]|$)"
  exit 1
fi
echo "  ✓ all ?v= match APP_VERSION=$APPV"

# Deploy the compiled bundle into a course's clientFilesCourse/scribble/. Since v172: NO chrome.css exclude
# (the reparented toolbar loads it in the parent). Since v182: --exclude 'refs/' — refs/ is COURSE-OWNED
# reference content, so a tool deploy's --delete must never wipe a course's reference sheets.
deploy_bundle() {
  local dest="$1/clientFilesCourse/scribble"; mkdir -p "$dest"
  rsync -a --delete \
    --exclude '* 2.js' --exclude '__*' --exclude '.gitignore' \
    --exclude 'embed/' --exclude '*.map' --exclude 'test/' --exclude 'refs/' \
    "$REPO/scribble/web/" "$dest/"
}

echo "→ deploying bundle → demo ($DEMO)…"
deploy_bundle "$DEMO"

echo "→ deploying bundle + element → class ($CLASS)…"
[ -d "$CLASS" ] || { echo "::error:: class course dir not found: $CLASS (pass it as arg 1)"; exit 1; }
deploy_bundle "$CLASS"
# The demo course's element is the source of truth; sync it into the class repo so the two never drift.
mkdir -p "$CLASS/elements/pl-scribble"
rsync -a "$ELEMENT_SRC/" "$CLASS/elements/pl-scribble/"

# DRIFT GATE: the two deployed bundles + the two elements must be identical (refs/ is course-owned, excluded).
echo "→ drift gate: comparing the two deployed trees…"
diff -r --exclude refs "$DEMO/clientFilesCourse/scribble" "$CLASS/clientFilesCourse/scribble" >/dev/null \
  && echo "  ✓ bundles identical" || { echo "::error:: deployed bundles DIFFER (drift!)"; exit 1; }
diff -r "$ELEMENT_SRC" "$CLASS/elements/pl-scribble" >/dev/null \
  && echo "  ✓ pl-scribble element identical" || { echo "::error:: pl-scribble element DIFFERS (drift!)"; exit 1; }

echo "✓ deployed to BOTH courses (bundle + element), trees verified identical."
echo "  Next: commit both repos, then YOU 'git push' the class repo and Sync course in PrairieLearn."
