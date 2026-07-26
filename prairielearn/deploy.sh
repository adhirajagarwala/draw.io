#!/usr/bin/env bash
# Build Scribble's WASM bundle and deploy the COMPILED output into a PrairieLearn
# course's clientFilesCourse/scribble/ (never the Rust source).
#
# Usage:  ./prairielearn/deploy.sh [COURSE_DIR]
#   COURSE_DIR defaults to this repo's demo course (prairielearn/example-course).
#
# Requires: rustup target add wasm32-unknown-unknown ; cargo install wasm-bindgen-cli --version 0.2.100
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
COURSE="${1:-$REPO/prairielearn/example-course}"

echo "→ building Scribble (release wasm)…"
cd "$REPO/scribble"
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen target/wasm32-unknown-unknown/release/scribble.wasm \
  --target web --out-dir web/pkg --no-typescript

DEST="$COURSE/clientFilesCourse/scribble"
echo "→ deploying compiled bundle → $DEST/"
mkdir -p "$DEST"
# NOTE: refs/ is COURSE-OWNED reference content (the ?file=<leaf> reference sheets), managed in the COURSE
# repo — NOT the tool source. Exclude it so a tool deploy's --delete can never wipe a course's reference PDFs.
# (The tool ships refs/ empty; drop your reference files into <course>/clientFilesCourse/scribble/refs/.)
rsync -a --delete \
  --exclude '* 2.js' --exclude '__*' --exclude '.gitignore' \
  --exclude 'embed/' --exclude '*.map' --exclude 'test/' --exclude 'refs/' \
  "$REPO/scribble/web/" "$DEST/"

echo "✓ deployed. Now in PrairieLearn: course → Sync → 'Load from disk', then preview the question."
