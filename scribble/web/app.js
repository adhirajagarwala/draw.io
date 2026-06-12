// Scribble — thin JS glue layer. All annotation logic lives in Rust/WASM.
// No network calls except loading local static assets. No storage of student
// content outside explicit file downloads.

// Bump with index.html's ?v= references on every release (cache busting).
const APP_VERSION = "6";

import init, { App } from "./pkg/scribble.js?v=6";

// PDF.js is imported lazily so a load failure there can never break the UI.
let pdfjsLib = null;
async function getPdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = await import(`./vendor/pdfjs/pdf.min.mjs?v=${APP_VERSION}`);
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      `./vendor/pdfjs/pdf.worker.min.mjs?v=${APP_VERSION}`;
  }
  return pdfjsLib;
}

// Failures must never be silent: surface anything uncaught in the status
// toast so "it just stopped working" always has a visible reason.
window.addEventListener("error", (ev) => {
  status(`Unexpected error: ${ev.message || "see console"}`);
});
window.addEventListener("unhandledrejection", (ev) => {
  status(`Unexpected error: ${ev.reason?.message || ev.reason || "see console"}`);
});

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 100;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const FIT_MARGIN = 48; // px breathing room for fit modes

const $ = (id) => document.getElementById(id);
const els = {
  placeholder: $("placeholder"),
  wrap: $("page-wrap"),
  pdfCanvas: $("pdf-canvas"),
  annoCanvas: $("anno-canvas"),
  textInput: $("text-input"),
  filePdf: $("file-pdf"),
  fileJson: $("file-json"),
  pageInput: $("page-input"),
  pageCount: $("page-count"),
  zoomSelect: $("zoom-select"),
  viewer: $("viewer"),
  thumbs: $("thumbs"),
  notesPane: $("notes-pane"),
  notesList: $("notes-list"),
  splitter: $("splitter"),
  textLayer: $("text-layer"),
  status: $("status"),
  btn: {
    open: $("btn-open"), save: $("btn-save"), load: $("btn-load"),
    undo: $("btn-undo"), redo: $("btn-redo"),
    prev: $("btn-prev"), next: $("btn-next"),
    zoomIn: $("btn-zoom-in"), zoomOut: $("btn-zoom-out"),
    export: $("btn-export"),
    thumbs: $("btn-thumbs"), notes: $("btn-notes"),
    palette: $("btn-palette"), big: $("btn-big"),
    addNote: $("btn-add-note"),
  },
};

// Tools that exist only in the UI layer (the Rust core stays in a neutral
// tool while they're active).
const JS_TOOLS = new Set(["snip", "pagetext"]);
const activeTool = () =>
  document.querySelector("#toolbar .tool.active")?.dataset.tool;

let app;            // WASM App
let pdfDoc = null;  // PDF.js document
let pageNum = 0;    // 0-based current page
let drawing = false;
let renderTask = null;

// Zoom: a percentage, or a fit mode recomputed on resize.
let zoomMode = "1"; // option value from the zoom <select>
let currentScale = 1;   // effective CSS scale of the current page
let basePage = { w: 1, h: 1 }; // current page size in PDF points

const scale = () => currentScale;
const dpr = () => Math.max(1, Math.min(4, window.devicePixelRatio || 1));

// All PDF.js page renders (viewer, thumbnails, export) go through one lock.
// PDF.js rejects overlapping renders ("Cannot use the same canvas…"), and the
// rejection can land on the wrong caller and wedge an export mid-loop — so we
// serialize every render globally instead of relying on ad-hoc guards.
let renderChain = Promise.resolve();
const RENDER_WATCHDOG_MS = 20_000;

function withRenderLock(fn) {
  // Watchdog: a wedged PDF.js worker would otherwise hang every later render
  // silently. Failing loudly with advice beats an app that quietly dies.
  const guarded = () =>
    Promise.race([
      fn(),
      new Promise((_, rej) =>
        setTimeout(
          () => rej(new Error("PDF rendering stalled — please reload the page (Cmd+Shift+R)")),
          RENDER_WATCHDOG_MS,
        ),
      ),
    ]);
  const run = renderChain.then(guarded, guarded);
  // Keep the chain alive regardless of individual outcomes.
  renderChain = run.then(() => {}, () => {});
  return run;
}

function computeScale() {
  if (zoomMode === "fit-width") {
    return clampZoom((els.viewer.clientWidth - FIT_MARGIN) / basePage.w);
  }
  if (zoomMode === "fit-page") {
    return clampZoom(Math.min(
      (els.viewer.clientWidth - FIT_MARGIN) / basePage.w,
      (els.viewer.clientHeight - FIT_MARGIN) / basePage.h,
    ));
  }
  return clampZoom(parseFloat(zoomMode) || 1);
}

const clampZoom = (v) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));

let statusTimer;
function status(msg) {
  els.status.textContent = msg; // textContent only — never HTML
  els.status.classList.add("show");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => els.status.classList.remove("show"), 4000);
}

// ---------- rendering ----------

// ---------- selection ----------

let selectedId = -1;          // current selection (select tool)
const HANDLE_PX = 7;          // on-screen handle half-size (CSS px)

function setSelection(id) {
  selectedId = id;
  redrawAnnotations();
}

// Corner handle centers for a bbox, in page coordinates.
function handlePoints(bb) {
  return [
    [bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]],
  ];
}

function drawSelection(ctx) {
  if (selectedId < 0) return;
  const bb = app.item_bbox_of(pageNum, selectedId);
  if (bb.length !== 4) {
    selectedId = -1;
    return;
  }
  const k = scale() * dpr();
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = "#2f5fde";
  ctx.lineWidth = 1.5 * dpr();
  ctx.setLineDash([5 * dpr(), 4 * dpr()]);
  const pad = 4 * k / scale();
  ctx.strokeRect(bb[0] * k - pad, bb[1] * k - pad, (bb[2] - bb[0]) * k + 2 * pad, (bb[3] - bb[1]) * k + 2 * pad);
  ctx.setLineDash([]);
  ctx.fillStyle = "#ffffff";
  const hs = HANDLE_PX * dpr();
  for (const [hx, hy] of handlePoints(bb)) {
    ctx.beginPath();
    ctx.rect(hx * k - hs / 2, hy * k - hs / 2, hs, hs);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

// Which corner handle (0..3) is under (x, y) page coords, or -1.
function handleAt(x, y) {
  if (selectedId < 0) return -1;
  const bb = app.item_bbox_of(pageNum, selectedId);
  if (bb.length !== 4) return -1;
  const tol = (HANDLE_PX + 3) / scale();
  return handlePoints(bb).findIndex(
    ([hx, hy]) => Math.abs(x - hx) <= tol && Math.abs(y - hy) <= tol,
  );
}

function redrawAnnotations() {
  const ctx = els.annoCanvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, els.annoCanvas.width, els.annoCanvas.height);
  // Backing store is scale*dpr for crisp output at any devicePixelRatio
  // (including browser zoom); CSS shrinks it back to `scale`.
  app.render(ctx, pageNum, scale() * dpr());
  drawSelection(ctx);
  drawSnipMarquee(ctx);
  els.btn.undo.disabled = !app.can_undo();
  els.btn.redo.disabled = !app.can_redo();
  scheduleThumbRefresh();
}

async function renderPage() {
  if (!pdfDoc) return;
  commitTextInput();
  const page = await pdfDoc.getPage(pageNum + 1);
  const base = page.getViewport({ scale: 1 });
  basePage = { w: base.width, h: base.height };
  app.ensure_page(pageNum, base.width, base.height);
  currentScale = computeScale();
  const ratio = dpr();
  const vp = page.getViewport({ scale: currentScale * ratio });
  const w = Math.floor(vp.width), h = Math.floor(vp.height);
  for (const c of [els.pdfCanvas, els.annoCanvas]) {
    c.width = w;
    c.height = h;
    c.style.width = `${Math.floor(w / ratio)}px`;
    c.style.height = `${Math.floor(h / ratio)}px`;
  }
  if (renderTask) renderTask.cancel();
  try {
    await withRenderLock(async () => {
      // intent "print": completes without requestAnimationFrame, so renders
      // never stall in throttled background/occluded windows.
      renderTask = page.render({
        canvasContext: els.pdfCanvas.getContext("2d"),
        viewport: vp,
        intent: "print",
      });
      await renderTask.promise;
    });
  } catch (e) {
    if (e?.name !== "RenderingCancelledException") throw e;
    return;
  }
  renderTask = null;
  els.pageInput.value = String(pageNum + 1);
  els.pageInput.max = String(pdfDoc.numPages);
  els.pageCount.textContent = `/ ${pdfDoc.numPages}`;
  syncZoomSelect();
  els.btn.prev.disabled = pageNum === 0;
  els.btn.next.disabled = pageNum >= pdfDoc.numPages - 1;
  els.btn.zoomOut.disabled = currentScale <= ZOOM_MIN;
  els.btn.zoomIn.disabled = currentScale >= ZOOM_MAX;
  redrawAnnotations();
  markActiveThumb();
  // The selectable text layer is only built on demand (Page-text tool), so it
  // never competes with normal rendering or export for the PDF.js worker.
  if (activeTool() === "pagetext") buildTextLayer(page);
  else els.textLayer.textContent = "";
}

// Reflect the effective zoom in the dropdown, even for fit modes.
function syncZoomSelect() {
  const sel = els.zoomSelect;
  if (zoomMode === "fit-width" || zoomMode === "fit-page") {
    sel.value = zoomMode;
    const label = zoomMode === "fit-width" ? "Fit width" : "Fit page";
    sel.options[sel.selectedIndex].textContent =
      `${label} (${Math.round(currentScale * 100)}%)`;
  } else {
    const pct = `${Math.round(currentScale * 100)}%`;
    let opt = [...sel.options].find((o) => o.value === String(currentScale));
    if (!opt) {
      opt = sel.querySelector("option[data-custom]") || document.createElement("option");
      opt.dataset.custom = "1";
      opt.value = String(currentScale);
      opt.textContent = pct;
      sel.appendChild(opt);
    }
    sel.value = opt.value;
  }
}

// ---------- PDF loading ----------

async function sha256Hex(buf) {
  // crypto.subtle needs a secure context (https or localhost). Degrade
  // gracefully: without it we just skip the PDF-match check.
  if (!crypto?.subtle) return "";
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function openPdf(file) {
  if (file.size > MAX_PDF_BYTES) {
    status("PDF too large (max 50 MB).");
    return;
  }
  try {
    const lib = await getPdfjs();
    const buf = await file.arrayBuffer();
    const hash = await sha256Hex(buf);
    const doc = await lib.getDocument({
      data: new Uint8Array(buf),
      isEvalSupported: false,   // never eval PDF-embedded code paths
    }).promise;
    if (doc.numPages > MAX_PAGES) {
      status(`PDF has too many pages (max ${MAX_PAGES}).`);
      await doc.destroy();
      return;
    }
    if (pdfDoc) await pdfDoc.destroy();
    pdfDoc = doc;
    app = new App(); // fresh document per PDF
    if (hash) app.set_pdf_sha256(hash);
    pageNum = 0;
    zoomMode = "1";
    els.placeholder.hidden = true;
    els.wrap.hidden = false;
    els.btn.save.disabled = false;
    els.btn.load.disabled = false;
    els.btn.export.disabled = false;
    els.pageInput.disabled = false;
    els.zoomSelect.disabled = false;
    els.btn.thumbs.disabled = false;
    els.btn.notes.disabled = false;
    selectedId = -1;
    els.thumbs.textContent = "";
    // Show the page thumbnails by default for any multi-page document (they're
    // the primary way to see where your marks are and to jump around).
    els.thumbs.hidden = doc.numPages <= 1;
    els.btn.thumbs.classList.toggle("active", !els.thumbs.hidden);
    if (!els.thumbs.hidden) await buildThumbnails();
    renderNotes();
    await renderPage();
    status("PDF loaded. Scribble away!");
  } catch (e) {
    console.error("openPdf failed:", e);
    status(`Could not open PDF: ${e?.message || e}`);
  }
}

// ---------- pointer input ----------

function pageCoords(ev) {
  // Map through the on-screen rect rather than assuming CSS px == scale —
  // robust under devicePixelRatio changes and browser zoom.
  const r = els.annoCanvas.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return [0, 0];
  return [
    ((ev.clientX - r.left) / r.width) * basePage.w,
    ((ev.clientY - r.top) / r.height) * basePage.h,
  ];
}

const eraseRadius = () => 10 / scale();

// setPointerCapture can throw (e.g. the pointer is already gone) — never
// let that abort an input handler mid-state-change.
function capturePointer(ev) {
  try {
    els.annoCanvas.setPointerCapture(ev.pointerId);
  } catch {
    /* capture is an optimization, not a requirement */
  }
}

els.annoCanvas.addEventListener("pointerdown", (ev) => {
  if (!pdfDoc || ev.button !== 0) return;
  const tool = document.querySelector("#toolbar .tool.active")?.dataset.tool;
  const [x, y] = pageCoords(ev);
  if (tool === "snip") {
    ev.preventDefault();
    commitTextInput();
    snip = { x0: x, y0: y, x1: x, y1: y };
    capturePointer(ev);
    return;
  }
  if (tool === "select") {
    ev.preventDefault();
    commitTextInput();
    // Resize if a handle of the current selection was grabbed.
    const h = handleAt(x, y);
    if (h >= 0 && app.begin_item_drag(pageNum, selectedId, x, y)) {
      const bb = app.item_bbox_of(pageNum, selectedId);
      const opposite = handlePoints(bb)[(h + 2) % 4];
      resizeDrag = {
        anchor: opposite,
        startBB: bb,
        uniform: app.item_kind(pageNum, selectedId) !== "shape",
      };
      capturePointer(ev);
      return;
    }
    const id = app.find_item(pageNum, x, y);
    setSelection(id);
    if (id >= 0 && app.begin_item_drag(pageNum, id, x, y)) {
      itemDrag = { id, startX: x, startY: y, moved: false };
      capturePointer(ev);
    }
    return;
  }
  if (tool === "text") {
    // Prevent the click's default focus behavior from stealing focus
    // back from the text input (which would instantly commit/close it).
    ev.preventDefault();
    openTextEditor(x, y, "", null);
    return;
  }
  commitTextInput();
  capturePointer(ev);
  drawing = true;
  app.pointer_down(pageNum, x, y, eraseRadius());
  redrawAnnotations();
});

els.annoCanvas.addEventListener("pointermove", (ev) => {
  if (snip) {
    const [x, y] = pageCoords(ev);
    snip.x1 = x;
    snip.y1 = y;
    redrawAnnotations();
    return;
  }
  if (resizeDrag) {
    const [x, y] = pageCoords(ev);
    const [ax, ay] = resizeDrag.anchor;
    const bb = resizeDrag.startBB;
    // Scale factors from how far the dragged corner moved relative to anchor.
    const w0 = Math.max(1e-3, Math.abs(bb[2] - bb[0]));
    const h0 = Math.max(1e-3, Math.abs(bb[3] - bb[1]));
    let sx = Math.abs(x - ax) / w0;
    let sy = Math.abs(y - ay) / h0;
    if (resizeDrag.uniform) {
      // Strokes and text scale uniformly (stretching them looks broken).
      sx = sy = Math.max(sx, sy);
    }
    app.scale_dragged_item(ax, ay, sx, sy);
    redrawAnnotations();
    return;
  }
  if (itemDrag) {
    const [x, y] = pageCoords(ev);
    if (Math.hypot(x - itemDrag.startX, y - itemDrag.startY) > 3 / scale()) {
      itemDrag.moved = true;
    }
    if (itemDrag.moved) {
      app.drag_item(x, y);
      redrawAnnotations();
    }
    return;
  }
  // Hover feedback for the select tool.
  if (!drawing && pdfDoc && activeTool() === "select") {
    const [x, y] = pageCoords(ev);
    const h = handleAt(x, y);
    els.annoCanvas.style.cursor =
      h === 0 || h === 2 ? "nwse-resize"
      : h === 1 || h === 3 ? "nesw-resize"
      : app.find_item(pageNum, x, y) >= 0 ? "move"
      : "default";
  }
  if (!drawing) return;
  const events = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
  for (const e of events) {
    const [x, y] = pageCoords(e);
    app.pointer_move(x, y, eraseRadius());
  }
  redrawAnnotations();
});

function endStroke(ev) {
  if (ev.pointerId !== undefined && els.annoCanvas.hasPointerCapture(ev.pointerId)) {
    els.annoCanvas.releasePointerCapture(ev.pointerId);
  }
  if (snip) {
    const r = snip;
    snip = null;
    redrawAnnotations();
    finishSnip(r);
    return;
  }
  if (resizeDrag) {
    resizeDrag = null;
    app.end_item_drag();
    redrawAnnotations();
    return;
  }
  if (itemDrag) {
    const { id, moved } = itemDrag;
    itemDrag = null;
    app.end_item_drag();
    if (!moved && app.is_text(pageNum, id)) {
      // A plain click on a text note opens it for editing.
      const pos = app.text_pos(pageNum, id);
      if (pos.length === 2) {
        openTextEditor(pos[0], pos[1], app.text_content(pageNum, id), id);
      }
    }
    redrawAnnotations();
    return;
  }
  if (!drawing) return;
  drawing = false;
  app.pointer_up();
  redrawAnnotations();
}

els.annoCanvas.addEventListener("pointerup", endStroke);
els.annoCanvas.addEventListener("pointercancel", () => {
  drawing = false;
  itemDrag = null;
  resizeDrag = null;
  snip = null;
  app.pointer_cancel();
  redrawAnnotations();
});

// ---------- snip: copy a region (image + its text) into the notes ----------

let snip = null;       // {x0, y0, x1, y1} page coords while dragging
let resizeDrag = null; // {anchor, startBB, uniform}

// Chunked conversion — spreading a megabyte-sized array into fromCharCode
// overflows the call stack.
function bytesToB64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function drawSnipMarquee(ctx) {
  if (!snip) return;
  const k = scale() * dpr();
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = "#2f5fde";
  ctx.lineWidth = 1.5 * dpr();
  ctx.setLineDash([6 * dpr(), 4 * dpr()]);
  ctx.strokeRect(
    Math.min(snip.x0, snip.x1) * k,
    Math.min(snip.y0, snip.y1) * k,
    Math.abs(snip.x1 - snip.x0) * k,
    Math.abs(snip.y1 - snip.y0) * k,
  );
  ctx.restore();
}

async function finishSnip(r) {
  const x0 = Math.min(r.x0, r.x1), y0 = Math.min(r.y0, r.y1);
  const w = Math.abs(r.x1 - r.x0), h = Math.abs(r.y1 - r.y0);
  if (w < 4 || h < 4) {
    status("Drag a box to snip a region.");
    return;
  }
  try {
    // 1. Pixels: copy the region (page + annotations) from the live canvases.
    const k = scale() * dpr();
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(w * k));
    out.height = Math.max(1, Math.round(h * k));
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    for (const src of [els.pdfCanvas, els.annoCanvas]) {
      ctx.drawImage(src, x0 * k, y0 * k, w * k, h * k, 0, 0, out.width, out.height);
    }
    const blob = await new Promise((res) => out.toBlob(res, "image/png"));
    const b64 = bytesToB64(new Uint8Array(await blob.arrayBuffer()));

    // 2. Text: PDF text items whose anchor falls inside the region.
    let text = "";
    try {
      const page = await pdfDoc.getPage(pageNum + 1);
      const tc = await page.getTextContent();
      const parts = [];
      for (const item of tc.items) {
        if (!item.str) continue;
        const ix = item.transform[4];
        const iy = basePage.h - item.transform[5]; // flip to top-down
        if (ix >= x0 - 2 && ix <= x0 + w + 2 && iy >= y0 - 2 && iy <= y0 + h + 6) {
          parts.push(item.str + (item.hasEOL ? "\n" : " "));
        }
      }
      text = parts.join("").replace(/[ \t]+\n/g, "\n").trim();
    } catch { /* text extraction is best-effort */ }

    const caption = text ? text.slice(0, 280) : `from page ${pageNum + 1}`;
    app.add_clipping(b64, pageNum, caption);
    renderNotes();
    if (els.notesPane.hidden) toggleNotes(true);

    // Best-effort: also put the image on the system clipboard.
    try {
      if (navigator.clipboard?.write && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      }
    } catch { /* clipboard permission is optional */ }
    status(text ? "Snipped — image and text added to notes." : "Snipped to notes.");
  } catch (e) {
    console.error("snip failed:", e);
    status(`Snip failed: ${e?.message || e}`);
  }
}

// ---------- text notes (place / edit / drag) ----------

let pendingText = null; // {x, y, editId} in page coords
let itemDrag = null;    // {id, startX, startY, moved}

function openTextEditor(pageX, pageY, initial, editId) {
  commitTextInput();
  pendingText = { x: pageX, y: pageY, editId };
  // The input is positioned inside #page-wrap, which the canvas fills.
  els.textInput.style.left = `${pageX * scale()}px`;
  els.textInput.style.top = `${(pageY - 18) * scale()}px`;
  els.textInput.value = initial;
  els.textInput.hidden = false;
  // Defer focus until after the pointer event sequence settles.
  setTimeout(() => els.textInput.focus(), 0);
}

function commitTextInput() {
  if (els.textInput.hidden || !pendingText) {
    hideTextInput();
    return;
  }
  const { x, y, editId } = pendingText;
  const value = els.textInput.value; // .value only — never innerHTML
  try {
    if (editId !== null && editId !== undefined) {
      app.update_text(pageNum, editId, value); // empty value deletes the note
    } else if (value.trim()) {
      app.add_text(pageNum, x, y, value);
    }
  } catch (e) {
    status(String(e));
  }
  hideTextInput();
  redrawAnnotations();
}

function hideTextInput() {
  els.textInput.hidden = true;
  els.textInput.value = "";
  pendingText = null;
}

els.textInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") commitTextInput();
  if (ev.key === "Escape") hideTextInput();
  ev.stopPropagation();
});
els.textInput.addEventListener("blur", commitTextInput);

// ---------- save / load ----------

function downloadJson() {
  try {
    const json = app.save_json();
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.download = `annotations-${ts}.json`; // fixed sanitized pattern
    a.click();
    URL.revokeObjectURL(a.href);
    status("Annotations saved.");
  } catch (e) {
    status("Save failed.");
  }
}

async function loadJsonFile(file) {
  // Must match MAX_JSON_BYTES in the Rust model (30 MB — notes clippings).
  if (file.size > 30 * 1024 * 1024) {
    status("Work file too large.");
    return;
  }
  let text;
  try {
    text = await file.text();
  } catch {
    status("Could not read file.");
    return;
  }
  // Check for mismatches BEFORE loading, and let the user decide.
  // (Only two top-level fields are inspected; the real, strict parsing
  // and validation happen in Rust.)
  try {
    const peek = JSON.parse(text);
    const fileSha = typeof peek?.pdf_sha256 === "string" ? peek.pdf_sha256 : "";
    const filePages = Array.isArray(peek?.pages) ? peek.pages.length : 0;
    const currentSha = app.pdf_sha256();
    const warnings = [];
    if (fileSha && currentSha && fileSha !== currentSha.trim()) {
      warnings.push("• It was saved for a DIFFERENT PDF — annotations may not line up.");
    }
    if (pdfDoc && filePages > pdfDoc.numPages) {
      warnings.push(`• It has annotations on ${filePages} pages, but this PDF has only ` +
        `${pdfDoc.numPages}. Extra pages stay in the file but won't be shown.`);
    }
    if (warnings.length &&
        !window.confirm(`Before loading this work file:\n\n${warnings.join("\n")}\n\nLoad it anyway?`)) {
      status("Load cancelled.");
      return;
    }
  } catch {
    /* let the strict Rust parser produce the real error below */
  }
  const currentSha = app.pdf_sha256();
  try {
    app.load_json(text);
  } catch (e) {
    status(`Could not load annotations: ${e}`);
    return;
  }
  app.set_pdf_sha256(currentSha); // keep hash of the actually-open PDF
  status("Annotations loaded.");
  setSelection(-1);
  renderNotes();
  if (app.notes_len() > 0 && els.notesPane.hidden) toggleNotes(true);
  if (!els.thumbs.hidden) await buildThumbnails();
  await renderPage();
}

// ---------- export annotated PDF ----------
// Builds a PDF from scratch (one JPEG image per page) with no extra libraries.
// Output contains only flattened page images — nothing executable.

const EXPORT_SCALE = 2;
const JPEG_QUALITY = 0.9;

async function canvasJpegBytes(canvas) {
  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", JPEG_QUALITY));
  if (!blob) throw new Error("could not encode page image");
  return new Uint8Array(await blob.arrayBuffer());
}

function buildPdf(pages) {
  // pages: [{ w, h, ops, images: [{jpeg, pxW, pxH, x, y, w, h}] }] — page
  // coords in PDF points (x, y = bottom-left of the placed image). `ops` is
  // Rust-generated vector content (annotations stay crisp vectors; text is
  // real, selectable PDF text). Paper pages have one full-page image; notes
  // pages have any number of clipping images.
  const enc = new TextEncoder();
  const chunks = [];
  let offset = 0;
  const offsets = [];
  const push = (data) => {
    const b = typeof data === "string" ? enc.encode(data) : data;
    chunks.push(b);
    offset += b.length;
  };
  let nextObj = 1;
  const obj = (body) => {
    const n = nextObj++;
    offsets[n] = offset;
    push(`${n} 0 obj\n${body}\nendobj\n`);
    return n;
  };
  const streamObj = (head, bytes) => {
    const n = nextObj++;
    offsets[n] = offset;
    push(`${n} 0 obj\n${head}\nstream\n`);
    push(bytes);
    push("\nendstream\nendobj\n");
    return n;
  };

  push("%PDF-1.4\n");
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker

  const fontName = app.text_font_name();
  const gsName = app.highlight_gstate_name();
  // Fixed low object numbers so forward references in pages are simple.
  const catalogN = obj("<< /Type /Catalog /Pages 2 0 R >>"); // 1
  const pagesN = nextObj++; // 2, body written after pages exist
  offsets[pagesN] = -1;
  const fontN = obj(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const gsN = obj("<< /Type /ExtGState /CA 0.35 /ca 0.35 /BM /Multiply >>");

  const pageObjNumbers = [];
  for (const p of pages) {
    const w = p.w.toFixed(2), h = p.h.toFixed(2);
    const imageNs = p.images.map((im) =>
      streamObj(
        `<< /Type /XObject /Subtype /Image /Width ${im.pxW} /Height ${im.pxH} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.jpeg.length} >>`,
        im.jpeg));
    let stream = "";
    p.images.forEach((im, k) => {
      stream += `q ${im.w.toFixed(2)} 0 0 ${im.h.toFixed(2)} ` +
        `${im.x.toFixed(2)} ${im.y.toFixed(2)} cm /Im${k} Do Q\n`;
    });
    stream += p.ops || "";
    const bytes = enc.encode(stream);
    const contentN = streamObj(`<< /Length ${bytes.length} >>`, bytes);
    const xobjects = imageNs.map((n, k) => `/Im${k} ${n} 0 R`).join(" ");
    pageObjNumbers.push(obj(
      `<< /Type /Page /Parent ${pagesN} 0 R /MediaBox [0 0 ${w} ${h}] /Resources << ` +
      `/XObject << ${xobjects} >> /Font << /${fontName} ${fontN} 0 R >> ` +
      `/ExtGState << /${gsName} ${gsN} 0 R >> >> /Contents ${contentN} 0 R >>`));
  }

  // Pages object, written after its kids (out-of-order objects are legal —
  // the xref table is what locates them).
  offsets[pagesN] = offset;
  push(`${pagesN} 0 obj\n<< /Type /Pages /Kids [${pageObjNumbers
    .map((n) => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>\nendobj\n`);

  const count = nextObj;
  const xrefAt = offset;
  push(`xref\n0 ${count}\n`);
  push("0000000000 65535 f \n");
  for (let n = 1; n < count; n++) {
    push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${count} /Root ${catalogN} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  return new Blob(chunks, { type: "application/pdf" });
}

// ---------- notes pages for export ----------

const NOTE_PAGE = { w: 612, h: 792, margin: 54, size: 11, leading: 14.85 };

function wrapLine(text, cols) {
  const out = [];
  for (const raw of text.split("\n")) {
    let line = raw;
    while (line.length > cols) {
      let cut = line.lastIndexOf(" ", cols);
      if (cut <= 0) cut = cols;
      out.push(line.slice(0, cut));
      line = line.slice(cut).trimStart();
    }
    out.push(line);
  }
  return out;
}

async function pngB64ToJpeg(b64) {
  const url = b64ToBlobUrl(b64);
  try {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error("bad clipping image"));
      img.src = url;
    });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0);
    return { jpeg: await canvasJpegBytes(c), pxW: c.width, pxH: c.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Lay the note blocks out across as many letter-size pages as needed.
async function buildNotesPages() {
  const total = app.notes_len();
  if (total === 0) return [];
  const { w, h, margin, size, leading } = NOTE_PAGE;
  const contentW = w - 2 * margin;
  const cols = Math.floor(contentW / (size * 0.5)); // conservative wrap
  const pages = [];
  let cur = { w, h, ops: "", images: [] };
  let yTop = margin; // distance consumed from the top
  const newPage = () => {
    pages.push(cur);
    cur = { w, h, ops: "", images: [] };
    yTop = margin;
  };
  // Push the current accumulation page only if it holds real content.
  const flush = () => {
    if (cur.images.length || yTop > margin + 1) {
      pages.push(cur);
      cur = { w, h, ops: "", images: [] };
      yTop = margin;
    }
  };
  const remaining = () => h - margin - yTop;

  cur.ops += app.note_text_block_ops("Notes", margin, h - margin, 16) ;
  yTop += 30;

  for (let i = 0; i < total; i++) {
    const kind = app.note_kind(i);
    if (kind === "sketch") {
      // A sketch exports as its own full page in its own coordinate space;
      // its annotations are crisp PDF vectors (no rasterization).
      const dims = app.sketch_size(i);
      if (dims.length === 2) {
        flush();
        pages.push({ w: dims[0], h: dims[1], ops: app.sketch_export_ops(i), images: [] });
      }
    } else if (kind === "text") {
      const lines = wrapLine(app.note_text(i), cols);
      let idx = 0;
      while (idx < lines.length) {
        const fit = Math.max(1, Math.floor(remaining() / leading));
        if (fit < 1 || (remaining() < leading && yTop > margin)) {
          newPage();
          continue;
        }
        const slice = lines.slice(idx, idx + fit);
        cur.ops += app.note_text_block_ops(
          slice.join("\n"), margin, h - yTop - size, size);
        yTop += slice.length * leading + 6;
        idx += slice.length;
      }
    } else if (kind === "clipping") {
      let im;
      try {
        im = await pngB64ToJpeg(app.note_png(i));
      } catch {
        continue; // unrenderable clipping: skip rather than fail the export
      }
      let drawW = Math.min(contentW, im.pxW / 2); // snips are 2x resolution
      let drawH = drawW * (im.pxH / im.pxW);
      const maxH = h - 2 * margin - 20;
      if (drawH > maxH) {
        drawH = maxH;
        drawW = drawH * (im.pxW / im.pxH);
      }
      if (drawH + 16 > remaining() && yTop > margin) newPage();
      cur.images.push({
        ...im,
        x: margin,
        y: h - yTop - drawH,
        w: drawW,
        h: drawH,
      });
      yTop += drawH + 4;
      const caption = app.note_caption(i);
      if (caption) {
        const capLines = wrapLine(caption, cols + 10).slice(0, 4);
        cur.ops += app.note_text_block_ops(
          capLines.join("\n"), margin, h - yTop - 9, 9);
        yTop += capLines.length * 12;
      }
      yTop += 10;
    }
  }
  flush();
  return pages;
}

async function exportPdf() {
  if (!pdfDoc) return;
  commitTextInput();
  clearTimeout(thumbTimer); // don't contend with exports for page renders
  els.btn.export.disabled = true;
  try {
    const pages = [];
    for (let i = 0; i < pdfDoc.numPages; i++) {
      status(`Exporting page ${i + 1} of ${pdfDoc.numPages}…`);
      const page = await pdfDoc.getPage(i + 1);
      const base = page.getViewport({ scale: 1 });
      app.ensure_page(i, base.width, base.height);
      const vp = page.getViewport({ scale: EXPORT_SCALE });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      const ctx = canvas.getContext("2d");
      // intent "print": runs to completion without requestAnimationFrame, so
      // exports work even in throttled background/occluded windows.
      await withRenderLock(() =>
        page.render({ canvasContext: ctx, viewport: vp, intent: "print" }).promise);
      // Annotations are NOT rasterized — they are exported as vector
      // operators generated by the Rust core (crisp at any zoom).
      pages.push({
        w: base.width, h: base.height,
        ops: app.export_pdf_ops(i),
        images: [{
          jpeg: await canvasJpegBytes(canvas),
          pxW: canvas.width, pxH: canvas.height,
          x: 0, y: 0, w: base.width, h: base.height,
        }],
      });
    }
    if (app.notes_len() > 0) {
      status("Adding your notes pages…");
      pages.push(...await buildNotesPages());
    }
    const blob = buildPdf(pages);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.download = `annotated-${ts}.pdf`;
    a.click();
    URL.revokeObjectURL(a.href);
    status("Annotated PDF exported.");
  } catch (e) {
    console.error("export failed:", e);
    status(`Export failed: ${e?.message || e}`);
  } finally {
    els.btn.export.disabled = false;
  }
}

// ---------- toolbar wiring ----------

els.btn.open.addEventListener("click", () => els.filePdf.click());
els.btn.save.addEventListener("click", downloadJson);
els.btn.load.addEventListener("click", () => els.fileJson.click());
els.btn.export.addEventListener("click", exportPdf);

els.filePdf.addEventListener("change", () => {
  const f = els.filePdf.files[0];
  els.filePdf.value = "";
  if (f) openPdf(f);
});

els.fileJson.addEventListener("change", () => {
  const f = els.fileJson.files[0];
  els.fileJson.value = "";
  if (f) loadJsonFile(f);
});

for (const b of document.querySelectorAll("#toolbar .tool")) {
  b.addEventListener("click", () => {
    commitTextInput();
    const name = b.dataset.tool;
    if (JS_TOOLS.has(name)) {
      app.set_tool("select"); // neutral: core draws nothing on pointer events
    } else if (!app.set_tool(name)) {
      return;
    }
    document.querySelectorAll("#toolbar .tool").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    document.body.classList.toggle("textselect", name === "pagetext");
    if (name !== "select") setSelection(-1);
    els.annoCanvas.style.cursor = name === "snip" ? "crosshair" : "";
    // Build/tear down the selectable text layer as the tool toggles.
    if (name === "pagetext" && pdfDoc) {
      pdfDoc.getPage(pageNum + 1).then(buildTextLayer);
    } else {
      els.textLayer.textContent = "";
    }
  });
}

for (const b of document.querySelectorAll("#widths .width")) {
  b.addEventListener("click", () => {
    if (!app.set_pen_width(b.dataset.width)) return;
    document.querySelectorAll("#widths .width").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
  });
}

for (const s of document.querySelectorAll("#colors .swatch")) {
  s.addEventListener("click", () => {
    if (!app.set_color(s.dataset.color)) return;
    document.querySelectorAll("#colors .swatch").forEach((x) => x.classList.remove("active"));
    s.classList.add("active");
  });
}

els.btn.undo.addEventListener("click", () => { app.undo(); redrawAnnotations(); });
els.btn.redo.addEventListener("click", () => { app.redo(); redrawAnnotations(); });
function goToPage(n, scrollTo = "top") {
  if (!pdfDoc) return;
  const clamped = Math.min(Math.max(0, n), pdfDoc.numPages - 1);
  if (clamped === pageNum) {
    els.pageInput.value = String(pageNum + 1);
    return;
  }
  pageNum = clamped;
  renderPage().then(() => {
    els.viewer.scrollTop = scrollTo === "bottom" ? els.viewer.scrollHeight : 0;
  });
}

els.btn.prev.addEventListener("click", () => goToPage(pageNum - 1));
els.btn.next.addEventListener("click", () => goToPage(pageNum + 1));

// Trackpad / wheel paging: scroll past the bottom of a page to advance, past
// the top to go back. Within a tall (zoomed) page, normal scrolling works and
// only the edges flip pages. A cooldown stops one momentum flick from skipping
// several pages; Ctrl/Cmd+wheel is left to the browser (pinch-zoom).
let lastWheelFlip = 0;
els.viewer.addEventListener("wheel", (ev) => {
  if (!pdfDoc || ev.ctrlKey || ev.metaKey) return;
  if (Math.abs(ev.deltaY) < 4) return;
  const v = els.viewer;
  const atBottom = v.scrollTop + v.clientHeight >= v.scrollHeight - 2;
  const atTop = v.scrollTop <= 2;
  const now = Date.now();
  if (now - lastWheelFlip < 550) return; // one flick = one page
  if (ev.deltaY > 0 && atBottom && pageNum < pdfDoc.numPages - 1) {
    lastWheelFlip = now;
    goToPage(pageNum + 1, "top");
  } else if (ev.deltaY < 0 && atTop && pageNum > 0) {
    lastWheelFlip = now;
    goToPage(pageNum - 1, "bottom");
  }
}, { passive: true });

els.pageInput.addEventListener("change", () => {
  const n = parseInt(els.pageInput.value, 10);
  if (Number.isFinite(n)) goToPage(n - 1);
  else els.pageInput.value = String(pageNum + 1);
});
els.pageInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") els.pageInput.blur();
  ev.stopPropagation();
});

const ZOOM_STEP = 1.25;
function nudgeZoom(factor) {
  zoomMode = String(clampZoom(currentScale * factor));
  renderPage();
}
els.btn.zoomIn.addEventListener("click", () => nudgeZoom(ZOOM_STEP));
els.btn.zoomOut.addEventListener("click", () => nudgeZoom(1 / ZOOM_STEP));
els.zoomSelect.addEventListener("change", () => {
  zoomMode = els.zoomSelect.value;
  renderPage();
});

// Re-render on resize: fit modes track the window, and devicePixelRatio
// changes (browser zoom) re-rasterize so the page never goes fuzzy.
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderPage(), 150);
});

const TOOL_KEYS = {
  v: "select", p: "pen", h: "highlighter", t: "text", e: "eraser",
  s: "snip", i: "pagetext",
};

document.addEventListener("keydown", (ev) => {
  // Never hijack keys while the user is typing in any field (incl. notes).
  if (ev.target instanceof Element &&
      ev.target.matches("input, textarea, select, [contenteditable]")) {
    return;
  }
  const mod = ev.ctrlKey || ev.metaKey;
  const key = ev.key.toLowerCase();
  // Word/Docs-style: Ctrl+Z undo, Ctrl+Y or Ctrl+Shift+Z redo, Ctrl+S save.
  if (mod && key === "z") {
    ev.preventDefault();
    if (ev.shiftKey) app.redo(); else app.undo();
    redrawAnnotations();
  } else if (mod && key === "y") {
    ev.preventDefault();
    app.redo();
    redrawAnnotations();
  } else if (mod && key === "s") {
    ev.preventDefault();
    if (!els.btn.save.disabled) downloadJson();
  } else if ((ev.key === "Delete" || ev.key === "Backspace")) {
    if (selectedId >= 0) {
      ev.preventDefault();
      app.delete_item(pageNum, selectedId);
      setSelection(-1);
    } else if (activeSketch && activeSketch.selected >= 0) {
      ev.preventDefault();
      activeSketch.remove();
    }
  } else if (ev.key === "Escape") {
    if (selectedId >= 0) setSelection(-1);
    if (activeSketch && activeSketch.selected >= 0) {
      activeSketch.selected = -1;
      activeSketch.draw();
    }
  } else if (!mod && TOOL_KEYS[key]) {
    document.querySelector(`#toolbar [data-tool="${TOOL_KEYS[key]}"]`)?.click();
  } else if (ev.key === "PageDown" || ev.key === "PageUp") {
    if (!pdfDoc) return;
    const v = els.viewer;
    const atBottom = v.scrollTop + v.clientHeight >= v.scrollHeight - 2;
    const atTop = v.scrollTop <= 2;
    if (ev.key === "PageDown" && atBottom && pageNum < pdfDoc.numPages - 1) {
      ev.preventDefault();
      goToPage(pageNum + 1, "top");
    } else if (ev.key === "PageUp" && atTop && pageNum > 0) {
      ev.preventDefault();
      goToPage(pageNum - 1, "bottom");
    } // otherwise let the browser scroll within the page
  } else if (ev.key === "Home" && pdfDoc) {
    ev.preventDefault();
    goToPage(0);
  } else if (ev.key === "End" && pdfDoc) {
    ev.preventDefault();
    goToPage(pdfDoc.numPages - 1);
  }
});

window.addEventListener("beforeunload", (ev) => {
  if (app?.is_dirty()) {
    ev.preventDefault();
    ev.returnValue = "";
  }
});

// ---------- notes pane (working document) ----------
// Blocks live in the Rust document; this renders them. Text uses textareas
// (native undo); clippings render via blob: URLs (never HTML from content).

function b64ToBlobUrl(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
}

function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight}px`;
}

function blockActions(i, total) {
  const wrap = document.createElement("div");
  wrap.className = "block-actions";
  const mk = (label, title, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", fn);
    wrap.appendChild(b);
  };
  if (i > 0) mk("↑", "Move up", () => { app.move_note(i, -1); renderNotes(); });
  if (i < total - 1) mk("↓", "Move down", () => { app.move_note(i, 1); renderNotes(); });
  mk("✕", "Delete block", () => { app.remove_note(i); renderNotes(); });
  return wrap;
}

// A self-contained drawing surface for a sketch note. It reuses the SAME
// Rust annotation engine as the PDF view via the `*_sketch` API — only the
// thin pointer→engine wiring is local here, so it cannot affect the PDF path.
class SketchView {
  constructor(noteIdx, canvas) {
    this.note = noteIdx;
    this.canvas = canvas;
    const dims = app.sketch_size(noteIdx); // [w, h] in points
    this.w = dims[0] || 400;
    this.h = dims[1] || 300;
    this.selected = -1;
    this.state = null; // {mode, ...}
    this.scale = 1;
    this.layout();
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", (e) => this.up(e));
    canvas.addEventListener("pointercancel", () => this.cancel());
    this.draw();
  }

  layout() {
    const avail = Math.max(120, els.notesList.clientWidth - 28);
    this.scale = Math.min(avail / this.w, 2);
    const r = dpr();
    this.canvas.width = Math.round(this.w * this.scale * r);
    this.canvas.height = Math.round(this.h * this.scale * r);
    this.canvas.style.width = `${Math.round(this.w * this.scale)}px`;
    this.canvas.style.height = `${Math.round(this.h * this.scale)}px`;
  }

  coords(ev) {
    const r = this.canvas.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return [0, 0];
    return [((ev.clientX - r.left) / r.width) * this.w,
            ((ev.clientY - r.top) / r.height) * this.h];
  }

  draw() {
    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    app.render_sketch(ctx, this.note, this.scale * dpr());
    // selection box + handles (same look as the PDF view)
    if (this.selected >= 0) {
      const bb = app.item_bbox_of_sketch(this.note, this.selected);
      if (bb.length === 4) {
        const k = this.scale * dpr();
        ctx.save();
        ctx.strokeStyle = "#2f5fde";
        ctx.lineWidth = 1.5 * dpr();
        ctx.setLineDash([5 * dpr(), 4 * dpr()]);
        ctx.strokeRect(bb[0] * k - 4, bb[1] * k - 4, (bb[2] - bb[0]) * k + 8, (bb[3] - bb[1]) * k + 8);
        ctx.setLineDash([]);
        ctx.fillStyle = "#fff";
        const hs = 7 * dpr();
        for (const [hx, hy] of this.corners(bb)) {
          ctx.beginPath(); ctx.rect(hx * k - hs / 2, hy * k - hs / 2, hs, hs); ctx.fill(); ctx.stroke();
        }
        ctx.restore();
      }
    }
    scheduleSketchExportRefresh();
  }

  corners(bb) { return [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]]; }

  handleAt(x, y) {
    if (this.selected < 0) return -1;
    const bb = app.item_bbox_of_sketch(this.note, this.selected);
    if (bb.length !== 4) return -1;
    const tol = (7 + 3) / this.scale;
    return this.corners(bb).findIndex(([hx, hy]) => Math.abs(x - hx) <= tol && Math.abs(y - hy) <= tol);
  }

  down(ev) {
    if (ev.button !== 0) return;
    activeSketch = this;       // Delete/Escape route here
    setSelection(-1);          // clear any PDF selection
    const tool = activeTool();
    const [x, y] = this.coords(ev);
    this.canvas.setPointerCapture?.(ev.pointerId);
    if (tool === "text") {
      ev.preventDefault();
      this.openText(ev, x, y, "", -1);
      return;
    }
    if (tool === "select") {
      const h = this.handleAt(x, y);
      if (h >= 0 && app.begin_item_drag_sketch(this.note, this.selected, x, y)) {
        const bb = app.item_bbox_of_sketch(this.note, this.selected);
        this.state = { mode: "resize", anchor: this.corners(bb)[(h + 2) % 4], bb,
                       uniform: app.item_kind_sketch(this.note, this.selected) !== "shape" };
        return;
      }
      const id = app.find_item_sketch(this.note, x, y);
      this.selected = id;
      if (id >= 0 && app.begin_item_drag_sketch(this.note, id, x, y)) {
        this.state = { mode: "move", id, sx: x, sy: y, moved: false };
      }
      this.draw();
      return;
    }
    // drawing tools (snip is PDF-only and ignored on sketches)
    if (tool === "snip" || tool === "pagetext") return;
    this.state = { mode: "draw" };
    app.pointer_down_sketch(this.note, x, y, 10 / this.scale);
    this.draw();
  }

  move(ev) {
    if (!this.state) return;
    const [x, y] = this.coords(ev);
    if (this.state.mode === "resize") {
      const [ax, ay] = this.state.anchor, bb = this.state.bb;
      const w0 = Math.max(1e-3, Math.abs(bb[2] - bb[0])), h0 = Math.max(1e-3, Math.abs(bb[3] - bb[1]));
      let sx = Math.abs(x - ax) / w0, sy = Math.abs(y - ay) / h0;
      if (this.state.uniform) sx = sy = Math.max(sx, sy);
      app.scale_dragged_item(ax, ay, sx, sy);
    } else if (this.state.mode === "move") {
      if (Math.hypot(x - this.state.sx, y - this.state.sy) > 3 / this.scale) this.state.moved = true;
      if (this.state.moved) app.drag_item(x, y);
    } else if (this.state.mode === "draw") {
      app.pointer_move(x, y, 10 / this.scale);
    }
    this.draw();
  }

  up(ev) {
    this.canvas.releasePointerCapture?.(ev.pointerId);
    const s = this.state;
    this.state = null;
    if (!s) return;
    if (s.mode === "draw") app.pointer_up();
    else if (s.mode === "move") {
      app.end_item_drag();
      if (!s.moved && app.is_text_sketch(this.note, s.id)) {
        const pos = app.text_pos_sketch(this.note, s.id);
        if (pos.length === 2) this.openText(ev, pos[0], pos[1], app.text_content_sketch(this.note, s.id), s.id);
      }
    } else if (s.mode === "resize") app.end_item_drag();
    this.draw();
  }

  cancel() { this.state = null; app.pointer_cancel(); this.draw(); }

  remove() {
    if (this.selected >= 0) { app.delete_item_sketch(this.note, this.selected); this.selected = -1; this.draw(); }
  }

  openText(ev, x, y, initial, editId) {
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 500;
    input.value = initial;
    input.className = "sketch-text-input";
    const r = this.canvas.getBoundingClientRect();
    input.style.left = `${x * this.scale}px`;
    input.style.top = `${y * this.scale - 18}px`;
    this.canvas.parentElement.appendChild(input);
    setTimeout(() => input.focus(), 0);
    const commit = () => {
      const v = input.value;
      try {
        if (editId >= 0) app.update_text_sketch(this.note, editId, v);
        else if (v.trim()) app.add_text_sketch(this.note, x, y, v);
      } catch (e) { status(String(e)); }
      input.remove();
      this.draw();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      else if (e.key === "Escape") input.remove();
      e.stopPropagation();
    });
    input.addEventListener("blur", commit);
  }
}

// Sketches change the export's notes pages; refresh that lazily is unneeded,
// but we keep a hook for symmetry with the PDF thumbnail refresh.
function scheduleSketchExportRefresh() { /* exports read live state on demand */ }

let sketchViews = [];
let activeSketch = null; // most-recently-interacted sketch (for Delete/Escape)

function renderNotes() {
  // Revoke old blob URLs before rebuilding.
  for (const img of els.notesList.querySelectorAll("img[data-blob]")) {
    URL.revokeObjectURL(img.src);
  }
  sketchViews = [];
  els.notesList.textContent = "";
  const total = app.notes_len();
  for (let i = 0; i < total; i++) {
    const kind = app.note_kind(i);
    const div = document.createElement("div");
    div.className = "note-block";
    if (kind === "sketch") {
      const holder = document.createElement("div");
      holder.className = "sketch-holder";
      const canvas = document.createElement("canvas");
      canvas.className = "sketch-canvas";
      holder.appendChild(canvas);
      div.appendChild(holder);
      div.appendChild(blockActions(i, total));
      els.notesList.appendChild(div);
      sketchViews.push(new SketchView(i, canvas));
      continue;
    }
    if (kind === "text") {
      const ta = document.createElement("textarea");
      ta.value = app.note_text(i);
      ta.placeholder = "Write a note…";
      ta.addEventListener("input", () => {
        app.update_note_text(i, ta.value);
        autoGrow(ta);
      });
      div.appendChild(ta);
      queueMicrotask(() => autoGrow(ta));
    } else if (kind === "clipping") {
      const img = document.createElement("img");
      img.src = b64ToBlobUrl(app.note_png(i));
      img.dataset.blob = "1";
      img.alt = "clipping";
      const srcPage = app.note_source_page(i);
      if (srcPage >= 0) {
        img.title = `Snipped from page ${srcPage + 1} — click to jump there`;
        img.style.cursor = "pointer";
        img.addEventListener("click", () => goToPage(srcPage));
      }
      const cap = document.createElement("input");
      cap.className = "caption";
      cap.maxLength = 300;
      cap.placeholder = "Caption…";
      cap.value = app.note_caption(i);
      cap.addEventListener("input", () => app.update_note_caption(i, cap.value));
      div.append(img, cap);
    }
    div.appendChild(blockActions(i, total));
    els.notesList.appendChild(div);
  }
}

function toggleNotes(show) {
  const visible = show ?? els.notesPane.hidden;
  els.notesPane.hidden = !visible;
  els.splitter.hidden = !visible;
  if (visible) renderNotes();
}

els.btn.notes.addEventListener("click", () => toggleNotes());
els.btn.addNote.addEventListener("click", () => {
  try {
    app.add_text_note("");
    renderNotes();
    els.notesList.querySelector(".note-block:last-child textarea")?.focus();
  } catch (e) {
    status(String(e));
  }
});

$("btn-add-sketch").addEventListener("click", () => {
  try {
    // A4-ish portrait canvas; it scales to fit the notes pane.
    app.add_sketch_note(420, 560);
    renderNotes();
    els.notesList.scrollTop = els.notesList.scrollHeight;
    status("Blank canvas added — draw on it with any tool.");
  } catch (e) {
    status(String(e));
  }
});

// Re-fit sketch canvases when the notes pane width changes.
let sketchRelayoutTimer;
function relayoutSketches() {
  clearTimeout(sketchRelayoutTimer);
  sketchRelayoutTimer = setTimeout(() => {
    for (const v of sketchViews) { v.layout(); v.draw(); }
  }, 120);
}
window.addEventListener("resize", relayoutSketches);

// Splitter: drag to resize the notes pane; double-click to reset.
let splitDrag = null;
els.splitter.addEventListener("pointerdown", (ev) => {
  splitDrag = { startX: ev.clientX, startW: els.notesPane.offsetWidth };
  els.splitter.setPointerCapture(ev.pointerId);
});
els.splitter.addEventListener("pointermove", (ev) => {
  if (!splitDrag) return;
  const w = splitDrag.startW + (splitDrag.startX - ev.clientX);
  els.notesPane.style.width = `${Math.max(220, Math.min(window.innerWidth * 0.6, w))}px`;
  relayoutSketches();
});
els.splitter.addEventListener("pointerup", () => { splitDrag = null; });
els.splitter.addEventListener("dblclick", () => { els.notesPane.style.width = ""; });

// ---------- thumbnails sidebar ----------

const THUMB_SCALE_WIDTH = 220; // backing px; CSS shrinks for sharpness

async function buildThumbnails() {
  els.thumbs.textContent = "";
  if (!pdfDoc) return;
  for (let i = 0; i < pdfDoc.numPages; i++) {
    const btn = document.createElement("button");
    btn.className = "thumb";
    btn.title = `Go to page ${i + 1}`;
    const canvas = document.createElement("canvas");
    const tag = document.createElement("span");
    tag.className = "pageno";
    tag.textContent = String(i + 1);
    btn.append(canvas, tag);
    btn.addEventListener("click", () => goToPage(i));
    els.thumbs.appendChild(btn);
    await renderThumb(i); // sequential keeps memory low
  }
  markActiveThumb();
}

// PDF.js forbids two render() calls on one canvas at once, so thumbnail
// renders are serialized per page (a re-request while busy queues one rerun).
const thumbState = new Map(); // i -> {busy, again}

async function renderThumb(i) {
  const st = thumbState.get(i) || { busy: false, again: false };
  thumbState.set(i, st);
  if (st.busy) {
    st.again = true;
    return;
  }
  st.busy = true;
  try {
    const canvas = els.thumbs.children[i]?.querySelector("canvas");
    if (!canvas || !pdfDoc) return;
    const page = await pdfDoc.getPage(i + 1);
    const base = page.getViewport({ scale: 1 });
    const s = THUMB_SCALE_WIDTH / base.width;
    const vp = page.getViewport({ scale: s });
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext("2d");
    await withRenderLock(() =>
      page.render({ canvasContext: ctx, viewport: vp, intent: "print" }).promise);
    app.ensure_page(i, base.width, base.height);
    app.render(ctx, i, s); // annotations visible in the overview
  } catch (e) {
    console.warn("thumb render:", e);
  } finally {
    st.busy = false;
    if (st.again) {
      st.again = false;
      renderThumb(i);
    }
  }
}

function markActiveThumb() {
  [...els.thumbs.children].forEach((el, i) =>
    el.classList.toggle("active", i === pageNum));
}

// Refresh the current page's thumbnail shortly after edits settle.
let thumbTimer;
function scheduleThumbRefresh() {
  if (els.thumbs.hidden) return;
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => renderThumb(pageNum), 800);
}

els.btn.thumbs.addEventListener("click", async () => {
  els.thumbs.hidden = !els.thumbs.hidden;
  els.btn.thumbs.classList.toggle("active", !els.thumbs.hidden);
  if (!els.thumbs.hidden && els.thumbs.childElementCount === 0) {
    await buildThumbnails();
  }
});

// ---------- PDF.js text layer (Page-text tool) ----------

let textLayerTask = null;

async function buildTextLayer(page) {
  els.textLayer.textContent = "";
  if (textLayerTask?.cancel) textLayerTask.cancel();
  try {
    const lib = await getPdfjs();
    if (typeof lib.TextLayer !== "function") return; // not in this build
    const vp = page.getViewport({ scale: scale() });
    els.textLayer.style.setProperty("--scale-factor", String(scale()));
    textLayerTask = new lib.TextLayer({
      textContentSource: page.streamTextContent(),
      container: els.textLayer,
      viewport: vp,
    });
    await textLayerTask.render();
  } catch (e) {
    if (e?.name !== "AbortException") console.warn("text layer:", e);
  }
}

// ---------- accessibility toggles ----------

els.btn.big.addEventListener("click", () => {
  const on = document.body.classList.toggle("big");
  els.btn.big.classList.toggle("active", on);
});

els.btn.palette.addEventListener("click", () => {
  const safe = !els.btn.palette.classList.contains("active");
  app.set_palette(safe ? "safe" : "standard");
  els.btn.palette.classList.toggle("active", safe);
  // Swatches reflect the active palette (colors come from the Rust enum).
  for (const s of document.querySelectorAll("#colors .swatch")) {
    s.style.background = app.color_css(s.dataset.color);
  }
  redrawAnnotations();
  if (!els.thumbs.hidden) renderThumb(pageNum);
  status(safe ? "Colorblind-safe palette on (green→brown, red→vermillion)."
              : "Standard palette.");
});

// ---------- boot ----------

// Read-only debug handle, opt-in via ?debug (used by tests; harmless: the
// page is fully client-side and the user already owns all state).
if (new URLSearchParams(location.search).has("debug")) {
  Object.defineProperty(window, "__app", { get: () => app });
  Object.defineProperty(window, "__pdf", { get: () => pdfDoc });
}

init()
  .then(() => {
    app = new App();
  })
  .catch((e) => {
    console.error("WASM init failed:", e);
    status(`Failed to start: ${e?.message || e}`);
  });
