// Scribble — thin JS glue layer. All annotation logic lives in Rust/WASM.
// No network calls except loading local static assets. No storage of student
// content outside explicit file downloads.

// Bump with index.html's ?v= references on every release (cache busting).
const APP_VERSION = "164";

// wasm-bindgen glue. Its ?v= is a MANUAL counter — bump it WITH APP_VERSION on every
// release (the glue is regenerated whenever the Rust/wasm changes; a stale glue cached
// against fresh JS — e.g. missing a newly-added export — is this project's most-repeated
// bug). See CLAUDE.md rule 2. The wasm binary itself is versioned at the init() call below.
import init, { App } from "./pkg/scribble.js?v=164";
import {
  bytesToB64,
  b64ToBlobUrl,
  autoGrow,
  looksLikeText,
  wrapLine,
  sha256Hex,
} from "./utils.js?v=164";
import { buildPdf, canvasJpegBytes } from "./pdf-writer.js?v=164";
import { initEmbed } from "./embed.js?v=164";
import { idbGet, idbPut, idbDelete, idbPrune } from "./idb.js?v=164";
import { htmlTextInRegion, overlayTextInRegion, pdfTextInRegion } from "./text-extract.js?v=164";
import { confirmOpenDialog, showClippingLightbox, confirmSnip, confirmDialog } from "./modals.js?v=164";
import { initColorBar, isCbarDocked, dockCbar, clampContextBar, setCbarCollapsed } from "./colorbar.js?v=164";
import { initNotesDock, isNotesFloating, floatNotes, clampNotes, setNotesCollapsed, isNotesCollapsed } from "./notes-dock.js?v=164";
import { makeFloating, clampFixed } from "./floating-panel.js?v=164";
import { initCalcDodge, calcHoles } from "./calc-dodge.js?v=164";
import { visibleBand, clampIntoBand, MARGIN } from "./visible-band.js?v=164";

// PrairieLearn read-only mode: a past submission is displayed but not editable.
// The srcdoc injects window.__SCRIBBLE_READONLY before this module runs (inline
// head script, ahead of the CSP meta). All edit entry points short-circuit on it.
const READONLY = !!window.__SCRIBBLE_READONLY;

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
  // "ResizeObserver loop … undelivered notifications" is a benign browser diagnostic (the layout just took
  // an extra frame to settle), not an app error — don't scare the user with it.
  if (typeof ev.message === "string" && ev.message.includes("ResizeObserver loop")) return;
  console.error(ev.error || ev.message); // keep the raw detail for debugging
  status("Something went wrong. Reload the page if this keeps happening.");
});
window.addEventListener("unhandledrejection", (ev) => {
  console.error(ev.reason);
  status("Something went wrong. Reload the page if this keeps happening.");
});

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 100;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const FIT_MARGIN = 48; // px breathing room for fit modes
const SKETCH_SCALE_MIN = 0.3, SKETCH_SCALE_MAX = 4; // user-dragged sketch zoom range

const $ = (id) => document.getElementById(id);
const els = {
  placeholder: $("placeholder"),
  wrap: $("page-wrap"),
  column: $("page-column"),
  pdfCanvas: $("pdf-canvas"),
  htmlFrame: $("html-frame"),
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
  contextBar: $("context-bar"),
  docControls: $("doc-controls"),
  widths: $("widths"),
  widthDivider: $("width-divider"),
  status: $("status"),
  persistAlert: $("persist-alert"),
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
  seg: { paged: $("seg-paged"), cont: $("seg-cont") },
};

// Tools that exist only in the UI layer (the Rust core stays in a neutral
// tool while they're active).
const JS_TOOLS = new Set(["snip"]);
// ⚠ PHASE 1 (toolbar reparent) IS PAUSED AND GATED OFF — DO NOT FLIP THIS ON without finishing + verifying it.
// It moves #rail out to the parent PL page so position:fixed follows the browser viewport. The code below is
// written and its first review round is fixed (7 bugs found: iframe-realm tool queries, an un-gated body.big
// that crushed the bar to 140px, a missing focus ring, the Larger toggle, and three $()-after-reparent nulls),
// but it has NEVER been verified in a real browser and step 1b (the notes pane) isn't started. With this false,
// every Phase-1 addition is inert: railHostDoc stays this document (identical to the old behaviour), chrome.css
// is never injected, and floating-panel's `win` defaults to this window. See memory: scribble-vnext-15point-plan.
const PHASE1_CHROME_REPARENT = false;
// The realm the tool rail lives in. Normally this iframe's document; when the Phase-1 reparent is enabled the
// rail lives in the parent page, so every tool/colour/width query must search THAT document — a plain
// `document.querySelector` would search the now-empty iframe. Set by the reparent; defaults to the iframe.
let railHostDoc = document;
let railHostEl = null; // the parent-realm .scribble-chrome host (for state classes like .big); null if not reparented
// SCOPED root for rail-NODE queries (B3-3). When reparented it is the per-instance host ELEMENT, so a page
// with two overlay questions never cross-matches the other's duplicated #rail/#colors/#more-popover ids;
// when NOT reparented it is `document` (the iframe), byte-identical to the old railHostDoc behaviour.
// railHostDoc stays the realm DOCUMENT (activeElement, parent-doc listeners); railRoot is the query root.
let railRoot = document;
const activeTool = () =>
  railRoot.querySelector(".tool.active")?.dataset.tool;

let app;            // WASM App
let pdfDoc = null;  // PDF.js document
let docMode = "pdf"; // "pdf" | "html" — what kind of document is open
let pageNum = 0;    // 0-based current page
let drawing = false;
// Touch/stylus: concurrent contacts (palm rejection + two-finger gestures).
const activePointers = new Map(); // pointerId -> pointerType
let penActive = false;            // a stylus is the current input → ignore touch (palm)
let drawingPointerId = null;      // which contact owns the in-progress stroke
let gesturePointerId = null;      // the ONE contact that owns ANY armed canvas gesture (draw/snip/marquee/drag)
let gestureCaptureEl = null;      // the canvas that captured it — a blur with capture still held is benign
let calcDodgeNudge = () => {};    // overlay boot swaps in the calc-hole dodge; no-op everywhere else
// Backstop: the canvas-bound pointerup/cancel handlers only fire when a pointer ends ON the canvas. A
// rejected 2nd touch (or a stroke ending over a floating panel) would otherwise leave its id in
// activePointers forever — and once >=2 stale ids accumulate, EVERY later stroke is rejected and the
// student can't draw until reload. Capture-phase window listeners guarantee cleanup wherever it ends.
function releaseTrackedPointer(ev) {
  activePointers.delete(ev.pointerId);
  if (ev.pointerType === "pen") penActive = [...activePointers.values()].includes("pen");
}
["pointerup", "pointercancel", "lostpointercapture"].forEach((t) =>
  window.addEventListener(t, releaseTrackedPointer, true));
const PALM_MAX_PX = 40;           // a contact wider/taller than this is a resting palm, not a fingertip
let renderTask = null;
let scrollMode = "paged"; // "paged" (one page at a time) | "continuous" (PDF only)

// Zoom: a percentage, or a fit mode recomputed on resize.
let zoomMode = "1"; // option value from the zoom <select>
let currentScale = 1;   // effective CSS scale of the current page
let basePage = { w: 1, h: 1 }; // current page size in PDF points

const scale = () => currentScale;
const dpr = () => Math.max(1, Math.min(4, window.devicePixelRatio || 1));

// Continuous scroll (PDF only): a VIRTUALIZED column of per-page sheets in
// #page-column. Each .cpage is a sized placeholder; its PDF raster + annotation
// canvases are mounted only while near the viewport (IntersectionObserver) and
// freed when far — so memory stays bounded and there is no single-canvas height
// ceiling, however long the document. See CLAUDE.md §10.
const cont = {
  pages: [],   // [{ el, pdfCanvas, annoCanvas, base:{w,h}, mounted }]
  io: null,    // IntersectionObserver that mounts/unmounts pages
  scale: 1,    // effective CSS scale of the column
  token: 0,    // bumped on each rebuild to drop stale async page renders
};
const CONT_MAX_BACKING = 16000; // safe single-canvas dimension ceiling (HTML page)
const MAX_CANVAS_DIM = 32767;   // browser hard per-axis canvas limit (over → silent blank)
// The on-screen backing ratio in use right now. Continuous pages render per-page
// at devicePixelRatio; only HTML caps its own ratio for very tall pages.
const curRatio = () => (docMode === "html" ? htmlRatio : dpr());
const isContinuous = () => scrollMode === "continuous" && docMode === "pdf";
// A drawable document (PDF or uploaded HTML) is currently open.
const docOpen = () => !!pdfDoc || (docMode === "html" && !els.wrap.hidden);

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
          () => rej(new Error("PDF rendering stalled — please reload the page.")),
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

// Persistent, high-attention alerts that must NOT auto-clear (unlike status()'s 4s toast) and must
// not be re-announced every tick. Keyed so independent conditions don't clobber each other; the
// highest-priority active message is shown. textContent only (§7). Rendered in a role="alert" node
// pinned near the top of the frame (the bottom-fixed #status is the WORST spot in a tall overlay).
const PERSIST_ALERTS = { "save-fail": { pri: 2, cls: "error" }, "cap": { pri: 1, cls: "warn" } };
const activePersistAlerts = new Map();
function setPersistAlert(key, message) {
  const el = els.persistAlert;
  if (!el) return; // null-safe: never throw out of the autosave flush
  if (message == null) activePersistAlerts.delete(key);
  else activePersistAlerts.set(key, message);
  let bestKey = null, bestPri = -1;
  for (const k of activePersistAlerts.keys()) {
    const p = (PERSIST_ALERTS[k] && PERSIST_ALERTS[k].pri) || 0;
    if (p > bestPri) { bestPri = p; bestKey = k; }
  }
  if (bestKey == null) { el.hidden = true; el.textContent = ""; el.className = "persist-alert"; return; }
  el.textContent = activePersistAlerts.get(bestKey); // fixed constant strings only — never interpolate errors
  el.className = "persist-alert " + ((PERSIST_ALERTS[bestKey] && PERSIST_ALERTS[bestKey].cls) || "");
  el.hidden = false;
}

// Client mirror of the server's parse() caps (pl-scribble.py MAX_ANNOTATION_BYTES / MAX_JSON_NODES). If a
// student builds a document past these, PrairieLearn's parse() rejects the WHOLE submission (nulls it) with
// only an out-of-iframe error — total silent loss. So we refuse to write an over-cap blob into the form input
// and keep the last-good value instead. The NODE axis is the binding constraint (dense strokes reach ~500k
// nodes well under the 16 MiB byte cap), so we count nodes, not just bytes. Headroom kept below the ceilings.
const SAVE_CAP_BYTES = 15_500_000;       // server nulls at 16 MiB decoded
const SAVE_CAP_NODES = 480_000;          // server nulls at 500k structural nodes
const SAVE_NODE_WALK_MIN_BYTES = 2_000_000; // light docs can't approach the cap — skip the walk

// Mirror of pl-scribble.py _within_structural_bounds: a small scalar tuple ([x,y], a rect) counts as ONE
// node; a large flat scalar array (a stroke's points) is counted by length; nested containers descend.
// Early-outs once over cap — the exact count past the ceiling doesn't matter.
function estimateJsonNodes(obj) {
  let n = 0;
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    n++;
    if (n > SAVE_CAP_NODES) return n;
    if (Array.isArray(cur)) {
      let hasContainer = false;
      for (const v of cur) {
        if (v && typeof v === "object") { hasContainer = true; stack.push(v); }
      }
      if (!hasContainer && cur.length > 8) n += cur.length;
    } else if (cur && typeof cur === "object") {
      for (const k in cur) if (Object.prototype.hasOwnProperty.call(cur, k)) stack.push(cur[k]);
    }
  }
  return n;
}

// ---------- selection ----------

let selectedId = -1;          // lone selection id (resize/hover path); -1 when 0 or >1 selected
let selectedIds = new Set();  // multi-selection membership on the ACTIVE page (source of truth)
let marquee = null;           // {x0,y0,x1,y1,page,add} rubber-band rect while box-selecting (page coords)
let groupDrag = null;         // {startX,startY,moved} while moving a multi-selection together
const HANDLE_PX = 7;          // on-screen handle half-size (CSS px)
// Bigger eraser hit on touch devices (fingertips are imprecise vs a mouse).
const COARSE_POINTER = !!window.matchMedia?.("(any-pointer: coarse)").matches;
const ERASE_RADIUS_PX = COARSE_POINTER ? 20 : 10; // eraser hit radius (CSS px; ÷ scale for page units)
const MOVE_THRESHOLD_PX = 3;  // a drag must exceed this before it counts as a move

// Selection is kept in TWO forms in lock-step: selectedIds (the set) is the truth;
// selectedId mirrors it ONLY when exactly one item is selected, so the resize/handle
// path (single-item only) keeps working unchanged. Zero or many selected → selectedId = -1.
function setSelection(id) {
  selectedId = id;
  selectedIds = id < 0 ? new Set() : new Set([id]);
  redrawAnnotations();
}
function setSelectionSet(ids) {
  selectedIds = new Set(ids);
  selectedId = selectedIds.size === 1 ? [...selectedIds][0] : -1;
  redrawAnnotations();
}

// Corner handle centers for a bbox, in page coordinates.
function handlePoints(bb) {
  return [
    [bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]],
  ];
}

// Draw a dashed selection box + corner handles around a page-space bbox, at the
// given content scale and backing ratio. Shared by the PDF view and sketches.
function drawSelectionBox(ctx, bb, corners, scl, ratio) {
  const k = scl * ratio;
  ctx.save();
  ctx.strokeStyle = "#2f5fde";
  ctx.lineWidth = 1.5 * ratio;
  ctx.setLineDash([5 * ratio, 4 * ratio]);
  const pad = 4 * ratio;
  ctx.strokeRect(bb[0] * k - pad, bb[1] * k - pad,
                 (bb[2] - bb[0]) * k + 2 * pad, (bb[3] - bb[1]) * k + 2 * pad);
  ctx.setLineDash([]);
  ctx.fillStyle = "#ffffff";
  const hs = HANDLE_PX * ratio;
  for (const [hx, hy] of corners) {
    ctx.beginPath();
    ctx.rect(hx * k - hs / 2, hy * k - hs / 2, hs, hs);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

// Dashed rubber-band rectangle for an in-progress marquee (page coords → device px).
function drawMarquee(ctx, m, scl, ratio) {
  const k = scl * ratio;
  const x = Math.min(m.x0, m.x1) * k, y = Math.min(m.y0, m.y1) * k;
  const w = Math.abs(m.x1 - m.x0) * k, h = Math.abs(m.y1 - m.y0) * k;
  ctx.save();
  ctx.strokeStyle = "#2f5fde";
  ctx.fillStyle = "rgba(47, 95, 222, 0.08)";
  ctx.lineWidth = 1 * ratio;
  ctx.setLineDash([4 * ratio, 3 * ratio]);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

function drawSelection(ctx) {
  // Rubber-band under the selection boxes (only on the page it started on).
  if (marquee && marquee.page === pageNum) drawMarquee(ctx, marquee, scale(), curRatio());
  if (selectedIds.size === 0) return;
  const single = selectedIds.size === 1;
  for (const id of [...selectedIds]) {
    const bb = app.item_bbox_of(pageNum, id);
    if (bb.length !== 4) { selectedIds.delete(id); continue; } // item gone (undo/delete) — drop it
    // Handles only for a lone selection; a group shows plain boxes (no group-resize).
    drawSelectionBox(ctx, bb, single ? handlePoints(bb) : [], scale(), curRatio());
  }
  // Keep the mirror honest if items were pruned above.
  selectedId = selectedIds.size === 1 ? [...selectedIds][0] : -1;
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
  if (isContinuous()) {
    // Repaint every mounted page's own annotation canvas. Offscreen pages are
    // unmounted (no backing store); they repaint when they next mount.
    for (let i = 0; i < cont.pages.length; i++) {
      if (cont.pages[i].mounted) contDrawAnnos(i);
    }
  } else {
    const ctx = els.annoCanvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, els.annoCanvas.width, els.annoCanvas.height);
    // Backing store is scale*ratio for crisp output at any devicePixelRatio
    // (including browser zoom); CSS shrinks it back to `scale`. curRatio() is
    // dpr() for PDFs and htmlRatio for HTML (which may be capped for tall pages).
    app.render(ctx, pageNum, scale() * curRatio());
    drawSelection(ctx);
    drawSnipMarquee(ctx);
  }
  els.btn.undo.disabled = !app.can_undo();
  els.btn.redo.disabled = !app.can_redo();
  scheduleThumbRefresh();
}

async function renderPage() {
  if (!pdfDoc) return;
  commitTextInput();
  contTeardown(); // leave virtualized continuous mode if it was active
  // Single-page PDF sheet styling; also clear any HTML-mode page sizing left
  // over from a previously-opened HTML document.
  els.wrap.hidden = false;
  els.wrap.classList.remove("htmlpage");
  els.wrap.style.width = "";
  els.wrap.style.height = "";
  els.htmlFrame.style.transform = "none";
  els.pdfCanvas.hidden = false;
  els.annoCanvas.hidden = false;
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
  redrawAnnotations();
  markActiveThumb();
}

// ---------- continuous scroll (virtualized, PDF only) ----------

// Tear down the virtualized column and stop observing. Safe to call anytime.
function contTeardown() {
  if (cont.io) { cont.io.disconnect(); cont.io = null; }
  cont.pages = [];
  els.column.hidden = true;
  els.column.textContent = "";
}

// Build the per-page column. Pages render lazily as they approach the viewport
// (contOnIntersect) and free their canvases when far — nothing is drawn up
// front, so memory is bounded and the document can be arbitrarily long.
async function renderContinuous() {
  if (!pdfDoc) return;
  const token = ++cont.token;
  commitTextInput();
  // Keep the reader on the same page across rebuilds (zoom / resize).
  const keep = cont.pages.length ? visiblePage() : pageNum;
  const bases = [];
  for (let i = 0; i < pdfDoc.numPages; i++) {
    const pg = await pdfDoc.getPage(i + 1);
    const v = pg.getViewport({ scale: 1 });
    bases.push({ w: v.width, h: v.height });
    app.ensure_page(i, v.width, v.height);
  }
  if (token !== cont.token) return;
  const maxW = Math.max(...bases.map((b) => b.w));
  cont.scale = (zoomMode === "fit-width" || zoomMode === "fit-page")
    ? clampZoom((els.viewer.clientWidth - FIT_MARGIN) / maxW)
    : clampZoom(parseFloat(zoomMode) || 1);
  currentScale = cont.scale;

  // Swap the single-page wrapper out for the virtualized column.
  if (cont.io) cont.io.disconnect();
  els.htmlFrame.hidden = true;
  els.wrap.hidden = true;
  els.column.hidden = false;
  els.column.textContent = "";
  cont.pages = [];
  cont.io = new IntersectionObserver(contOnIntersect, {
    root: els.viewer,
    rootMargin: "100% 0px", // mount when within ~1 viewport above/below
  });
  for (let i = 0; i < bases.length; i++) {
    const wCss = Math.round(bases[i].w * cont.scale);
    const hCss = Math.round(bases[i].h * cont.scale);
    const el = document.createElement("div");
    el.className = "cpage";
    el.dataset.page = String(i);
    el.style.width = `${wCss}px`;
    el.style.height = `${hCss}px`;
    el.style.containIntrinsicSize = `${wCss}px ${hCss}px`;
    const pdfCanvas = document.createElement("canvas");
    const annoCanvas = document.createElement("canvas");
    annoCanvas.className = "canno";
    el.append(pdfCanvas, annoCanvas);
    els.column.appendChild(el);
    const p = { el, pdfCanvas, annoCanvas, base: bases[i], mounted: false };
    cont.pages.push(p);
    // Same page-aware pointer pipeline as the single-page canvas.
    annoCanvas.addEventListener("pointerdown", onAnnoPointerDown);
    annoCanvas.addEventListener("pointermove", onAnnoPointerMove);
    annoCanvas.addEventListener("pointerup", endStroke);
    annoCanvas.addEventListener("pointercancel", onAnnoPointerCancel);
    annoCanvas.addEventListener("contextmenu", onAnnoContextMenu);
    cont.io.observe(el);
  }
  pageNum = Math.min(Math.max(0, keep), cont.pages.length - 1);
  basePage = cont.pages[pageNum].base;

  els.pageInput.max = String(pdfDoc.numPages);
  els.pageInput.value = String(pageNum + 1);
  els.pageCount.textContent = `/ ${pdfDoc.numPages}`;
  syncZoomSelect();
  els.btn.prev.disabled = pageNum === 0;
  els.btn.next.disabled = pageNum >= cont.pages.length - 1;
  markActiveThumb(pageNum);
  // Restore the reader's position and mount the visible pages SYNCHRONOUSLY.
  // Reading layout (offsetTop / getBoundingClientRect) forces a reflow, and
  // intent:"print" renders complete without requestAnimationFrame — so pages
  // render even when the tab isn't being painted (where rAF / the
  // IntersectionObserver never fire and pages would otherwise stay blank).
  if (pageNum > 0) scrollToContPage(pageNum); else els.viewer.scrollTop = 0;
  contMountVisible();
}

// Mount pages within ~1 viewport of the visible area and free the rest, by pure
// geometry — a reliable backstop for the IntersectionObserver.
function contMountVisible() {
  if (!cont.pages.length) return;
  const vr = els.viewer.getBoundingClientRect();
  const margin = els.viewer.clientHeight; // matches the observer's 100% rootMargin
  for (let i = 0; i < cont.pages.length; i++) {
    const r = cont.pages[i].el.getBoundingClientRect();
    const near = r.bottom >= vr.top - margin && r.top <= vr.bottom + margin;
    if (near) contMount(i); else contUnmount(i);
  }
}

// IntersectionObserver callback: mount pages entering the margin, free leaving.
function contOnIntersect(entries) {
  for (const e of entries) {
    const i = Number(e.target.dataset.page);
    if (e.isIntersecting) contMount(i);
    else contUnmount(i);
  }
}

// Allocate this page's canvases and render its raster + annotations.
async function contMount(i) {
  const p = cont.pages[i];
  if (!p || p.mounted) return;
  p.mounted = true;
  const token = cont.token;
  const ratio = dpr();
  const k = cont.scale * ratio;
  const wB = Math.max(1, Math.floor(p.base.w * k));
  const hB = Math.max(1, Math.floor(p.base.h * k));
  for (const c of [p.pdfCanvas, p.annoCanvas]) {
    c.width = wB; c.height = hB;
    c.style.width = "100%"; c.style.height = "100%";
  }
  try {
    const pg = await pdfDoc.getPage(i + 1);
    if (token !== cont.token || !p.mounted) return; // scrolled away during getPage
    const v = pg.getViewport({ scale: k });
    await withRenderLock(() => {
      if (token !== cont.token || !p.mounted) return Promise.resolve(); // bail before starting
      p.renderTask = pg.render({ canvasContext: p.pdfCanvas.getContext("2d"), viewport: v, intent: "print" });
      return p.renderTask.promise;
    });
  } catch (e) {
    if (e?.name !== "RenderingCancelledException") console.warn("cont render:", e);
    return;
  } finally {
    p.renderTask = null;
  }
  if (token !== cont.token || !p.mounted) return; // rebuilt or scrolled away
  contDrawAnnos(i);
}

// Free a page's canvases when it scrolls far away (keeps memory bounded).
function contUnmount(i) {
  const p = cont.pages[i];
  if (!p || !p.mounted) return;
  p.mounted = false;
  if (p.renderTask) { p.renderTask.cancel(); p.renderTask = null; } // stop an in-flight render so the chain doesn't back up
  for (const c of [p.pdfCanvas, p.annoCanvas]) { c.width = 0; c.height = 0; }
}

// Paint a mounted page's annotation canvas (marks + selection/snip if active).
function contDrawAnnos(i) {
  const p = cont.pages[i];
  if (!p || !p.mounted) return;
  const ratio = dpr();
  const k = cont.scale * ratio;
  const wB = Math.max(1, Math.floor(p.base.w * k));
  const hB = Math.max(1, Math.floor(p.base.h * k));
  if (p.annoCanvas.width !== wB || p.annoCanvas.height !== hB) {
    p.annoCanvas.width = wB; p.annoCanvas.height = hB;
    p.annoCanvas.style.width = "100%"; p.annoCanvas.style.height = "100%";
  }
  const ctx = p.annoCanvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, p.annoCanvas.width, p.annoCanvas.height);
  app.render(ctx, i, k);
  if (i === pageNum) { drawSelection(ctx); drawSnipMarquee(ctx); }
}

// The annotation canvas the pointer is currently working on (single-page or the
// active continuous page) — used by coord mapping, snip and the text editor.
function activeAnnoCanvas() {
  return isContinuous() ? cont.pages[pageNum]?.annoCanvas : els.annoCanvas;
}

// Scroll a continuous page sheet to the top of the viewer. We set scrollTop
// directly (each .cpage's offsetParent is #viewer) rather than via
// element.scrollIntoView. Jumps are instant: programmatic smooth scrolling
// silently no-ops inside this nested, content-visibility scroll container in
// some contexts, and a page jump that always lands beats one that sometimes
// doesn't move. (Free wheel/trackpad scrolling stays fully native — §10.)
function scrollToContPage(i) {
  const p = cont.pages[i];
  if (!p) return;
  els.viewer.scrollTop = Math.max(0, p.el.offsetTop - 8);
}

// Re-render whichever mode is active (used by zoom / resize / load).
function renderDoc() {
  if (docMode === "html") return renderHtmlPage();
  return isContinuous() ? renderContinuous() : renderPage();
}

// Which page sheet sits at the middle of the viewport right now.
function visiblePage() {
  if (!cont.pages.length) return 0;
  // At the very bottom, a short final page's top can sit below the midpoint, so the
  // top-vs-mid heuristic would report the second-to-last page. Snap to the last.
  if (els.viewer.scrollTop + els.viewer.clientHeight >= els.viewer.scrollHeight - 2) {
    return cont.pages.length - 1;
  }
  const mid = els.viewer.getBoundingClientRect().top + els.viewer.clientHeight / 2;
  let vis = 0;
  for (let i = 0; i < cont.pages.length; i++) {
    if (cont.pages[i].el.getBoundingClientRect().top <= mid) vis = i; else break;
  }
  return vis;
}

// In continuous mode the page readout + thumbnail highlight follow the scroll
// position; the *active* page for drawing is separate (it follows your press).
let scrollSyncTimer;
els.viewer.addEventListener("scroll", () => {
  if (!isContinuous()) return;
  clearTimeout(scrollSyncTimer);
  scrollSyncTimer = setTimeout(() => {
    const vis = visiblePage();
    els.pageInput.value = String(vis + 1);
    if (!els.thumbs.hidden) markActiveThumb(vis);
    els.btn.prev.disabled = vis === 0;
    els.btn.next.disabled = vis >= cont.pages.length - 1;
    contMountVisible(); // backstop in case the observer is throttled
  }, 60);
}, { passive: true });

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
  // The zoom buttons reflect the current zoom limits — keep them in sync here so
  // all three render paths get it for free.
  els.btn.zoomOut.disabled = currentScale <= ZOOM_MIN;
  els.btn.zoomIn.disabled = currentScale >= ZOOM_MAX;
}

// ---------- PDF loading ----------

// Reset the shared per-document state when a fresh PDF or HTML doc is opened.
function newDocument(mode) {
  app = new App();
  docMode = mode;
  document.body.classList.toggle("html-doc", mode === "html"); // hides inert page-nav controls
  htmlSavedHeightHydrated = false; // a fresh document re-enables image-load re-measure (F2)
  clearTimeout(htmlRemeasureTimer);
  dirtySinceFileSave = false;
  pageNum = 0;
  selectedId = -1;
  selectedIds = new Set();
  marquee = null;
  groupDrag = null;
  zoomMode = "fit-width"; // fill the viewer width; the page scales, never reflows
}

// Enable the document toolbar + controls shared by both open flows. `thumbs` and
// `pageNav` are PDF-only (HTML is a single, non-paged page).
function enableDocUI({ thumbs, pageNav }) {
  els.btn.save.disabled = false;
  els.btn.load.disabled = false;
  els.btn.export.disabled = false;
  els.btn.notes.disabled = false;
  els.zoomSelect.disabled = false;
  els.btn.thumbs.disabled = !thumbs;
  els.pageInput.disabled = !pageNav;
  els.docControls.hidden = false;
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
    els.htmlFrame.hidden = true;
    els.htmlFrame.srcdoc = "";
    els.pdfCanvas.hidden = false;
    newDocument("pdf"); // fresh document per PDF
    if (hash) app.set_pdf_sha256(hash);
    // Recover annotations autosaved for this exact PDF, if any (before the doc
    // is read for thumbnails/render below).
    const restored = await maybeRestoreAutosave(hash);
    // Default to continuous scroll for multi-page PDFs so "scroll = next page"
    // works natively out of the box (single page has nothing to scroll between,
    // so it opens paged). Either way the Page/Scroll switch is one click.
    scrollMode = doc.numPages > 1 ? "continuous" : "paged";
    setScrollEnabled(true);
    syncScrollUI();
    els.placeholder.hidden = true;
    els.wrap.hidden = false;
    enableDocUI({ thumbs: true, pageNav: true });
    updateContextBar(activeTool());
    els.thumbs.textContent = "";
    // Show the page thumbnails by default for any multi-page document (they're
    // the primary way to see where your marks are and to jump around).
    els.thumbs.hidden = doc.numPages <= 1;
    els.btn.thumbs.classList.toggle("active", !els.thumbs.hidden);
    if (!els.thumbs.hidden) await buildThumbnails();
    renderNotes();
    if (restored && app.notes_len() > 0 && els.notesPane.hidden) toggleNotes(true);
    if (isContinuous()) await renderContinuous(); else await renderPage();
    status(restored ? "Restored your autosaved annotations." : "PDF loaded. Scribble away!");
  } catch (e) {
    console.error("openPdf failed:", e);
    status(`Could not open PDF: ${e?.message || e}`);
  }
}

// ---------- HTML loading ----------

const MAX_HTML_BYTES = 5 * 1024 * 1024;
// HTML renders as a FIXED-layout page: it is laid out once at this width and
// never reflows, so annotations stay pinned to the content. Resize/zoom scale
// the whole page (like a PDF) rather than re-flowing it. ~US-Letter width.
const HTML_BASE_W = 816;
const HTML_MAX_PAGE_H = 20000; // matches the Rust page-dimension cap; warn beyond
let htmlRatio = 1;      // anno-canvas backing ratio for HTML (capped for tall pages)
let htmlTruncated = false; // measured content exceeded HTML_MAX_PAGE_H

async function openHtml(file) {
  if (file.size > MAX_HTML_BYTES) {
    status("HTML file too large (max 5 MB).");
    return false;
  }
  let text;
  try {
    text = await file.text();
  } catch {
    status("Couldn't read that file.");
    return false;
  }
  try {
    if (pdfDoc) { try { await pdfDoc.destroy(); } catch { /* ignore */ } pdfDoc = null; }
    contTeardown(); // drop any virtualized PDF column (+ its IntersectionObserver)
    newDocument("html");
    scrollMode = "paged"; // continuous scroll is PDF-only
    setScrollEnabled(false);
    syncScrollUI();
    currentScale = 1;

    // The uploaded HTML renders in a same-origin sandboxed iframe with NO
    // script permission, so embedded scripts never run — it shows as static
    // content and can't do anything. The annotation canvas sits on top.
    els.placeholder.hidden = true;
    els.wrap.hidden = false;
    els.pdfCanvas.hidden = true;
    els.htmlFrame.hidden = false;
    await new Promise((resolve) => {
      els.htmlFrame.onload = () => resolve();
      els.htmlFrame.srcdoc = text;
      // Fallback in case onload doesn't fire promptly.
      setTimeout(resolve, 1200);
    });

    // Let web fonts settle before measuring: a late font swap changes line
    // breaks and page height (which would drift every annotation already drawn,
    // and mismap the cached snip raster). Bounded so a CSP-blocked @font-face
    // can never wedge the open.
    try {
      const fonts = els.htmlFrame.contentDocument?.fonts;
      if (fonts?.ready) await Promise.race([fonts.ready, new Promise((r) => setTimeout(r, 800))]);
    } catch { /* same-origin guard / no FontFaceSet — proceed */ }

    measureHtmlHeight();
    renderHtmlPage();
    watchHtmlImages(); // re-measure once late-loading images settle

    enableDocUI({ thumbs: false, pageNav: false }); // single, non-paged page
    els.thumbs.hidden = true;
    els.btn.thumbs.classList.remove("active");
    els.pageInput.value = "1";
    els.pageCount.textContent = "/ 1";
    els.btn.prev.disabled = true;
    els.btn.next.disabled = true;
    updateContextBar(activeTool());
    renderNotes();
    status("HTML loaded. Scribble away!");
    return true;
  } catch (e) {
    console.error("openHtml failed:", e);
    status(`Could not open HTML: ${e?.message || e}`);
    return false;
  }
}

// Measure the uploaded HTML's natural height at the FIXED base width, so its
// internal layout is deterministic and independent of the window size. Called
// after load (and again when late images settle) — never on a plain resize, so
// the layout, and therefore annotation alignment, never shifts under the user.
function measureHtmlHeight() {
  const f = els.htmlFrame;
  f.style.transform = "none";        // measure unscaled
  f.style.width = `${HTML_BASE_W}px`;
  f.style.height = "200px";          // temp: force layout to the width first
  let h = 600;
  try {
    const d = f.contentDocument;
    if (d && d.body) {
      h = Math.max(d.body.scrollHeight, d.documentElement.scrollHeight, 200);
    }
  } catch { /* same-origin srcdoc; keep the default on the rare failure */ }
  htmlTruncated = h > HTML_MAX_PAGE_H;
  h = Math.min(h, HTML_MAX_PAGE_H);
  basePage = { w: HTML_BASE_W, h };
  app.ensure_page(0, HTML_BASE_W, h);
  htmlSnipCanvas = null; // page layout changed — drop the cached snip raster
}

// Render the uploaded HTML as a fixed-layout sheet: the iframe keeps its base
// width and is SCALED (CSS transform, never re-flowed) to the current zoom, so
// annotations stay pinned to the content at any size. Mirrors renderPage().
function renderHtmlPage() {
  if (docMode !== "html" || els.wrap.hidden) return;
  commitTextInput();
  els.wrap.classList.add("htmlpage");
  els.pdfCanvas.hidden = true;
  els.htmlFrame.hidden = false;
  els.annoCanvas.hidden = false;
  currentScale = computeScale();
  const s = currentScale;
  // Keep the annotation canvas backing store within the browser's safe single-
  // canvas height; drop the pixel ratio before scaling fidelity is lost.
  let ratio = dpr();
  while (ratio > 1 &&
         (basePage.h * s * ratio > CONT_MAX_BACKING ||
          basePage.w * s * ratio > CONT_MAX_BACKING)) ratio -= 1;
  htmlRatio = ratio;
  const cssW = Math.round(basePage.w * s);
  const cssH = Math.round(basePage.h * s);
  els.wrap.style.width = `${cssW}px`;
  els.wrap.style.height = `${cssH}px`;
  const f = els.htmlFrame;
  f.style.width = `${HTML_BASE_W}px`;
  f.style.height = `${basePage.h}px`;
  f.style.transformOrigin = "0 0";
  f.style.transform = `scale(${s})`;
  els.annoCanvas.width = Math.max(1, Math.floor(cssW * ratio));
  els.annoCanvas.height = Math.max(1, Math.floor(cssH * ratio));
  els.annoCanvas.style.width = `${cssW}px`;
  els.annoCanvas.style.height = `${cssH}px`;
  syncZoomSelect();
  redrawAnnotations();
  if (htmlTruncated) {
    status(`This HTML page is very tall — content past ${HTML_MAX_PAGE_H}px isn't shown or annotatable.`);
  }
}

// Option C (transparent overlay): set up an EMPTY drawable page sized to the live PL
// question that shows THROUGH the transparent layers behind #anno-canvas — no document is
// loaded, no clone. Width is LOCKED to HTML_BASE_W (816) so the fixed-width replay in
// hydrateAnnotations stays faithful; height comes from the host (measured in the parent).
// Bypasses measureHtmlHeight (the frame is empty → it would floor to 200) and forces
// zoomMode off "fit-width" (which would rescale the canvas on resize while the live
// question behind it does not).
// Overlay drawable width = the live card's width (the #stage spans the full host). Fill it instead of
// locking to HTML_BASE_W — on a wide screen the card is ~958px, so a fixed 816 left ~142px of the card
// un-drawable on the right. Clamped to a sane range; the caller keeps it grow-only so strokes never clip.
function overlayStageW() {
  const s = $("stage");
  const w = Math.round((s && (s.clientWidth || s.getBoundingClientRect().width)) || HTML_BASE_W);
  return Math.max(360, Math.min(w, 4000));
}

// The live question host. It's a SIBLING of our iframe (both children of .pl-scribble-overlay), NOT an
// ancestor — so frameElement.closest('.pl-scribble-host') is null; go up to the wrapper and back down.
function overlayHost() {
  const wrap = window.frameElement && window.frameElement.parentElement;
  if (!wrap) return null;
  return wrap.querySelector(":scope > .pl-scribble-host") || wrap.querySelector(".pl-scribble-host");
}

function openOverlay(measuredH) {
  if (pdfDoc) { try { pdfDoc.destroy(); } catch { /* ignore */ } pdfDoc = null; }
  contTeardown();
  newDocument("html");
  scrollMode = "paged";
  setScrollEnabled(false);
  syncScrollUI();
  zoomMode = "1"; // 1:1 — never rescale the canvas relative to the live question
  currentScale = 1;
  document.body.classList.add("overlay");
  // The <html> element carries an opaque --bg too (a body class can't reach it); make it
  // transparent so the live question behind the iframe isn't hidden behind grey.
  document.documentElement.style.background = "transparent";
  els.placeholder.hidden = true;
  els.wrap.hidden = false;     // keep #page-wrap mounted+visible — docOpen() gates drawing on it
  els.pdfCanvas.hidden = true;
  els.htmlFrame.hidden = true; // no clone, no srcdoc — the live question shows through
  const h = Math.min(Math.max(measuredH | 0, 200), HTML_MAX_PAGE_H);
  const w = overlayStageW(); // fill the card, don't lock to 816
  basePage = { w, h };
  app.ensure_page(0, w, h);
  htmlSnipCanvas = null;
  renderHtmlPage(); // sizes #anno-canvas + #page-wrap from basePage; #html-frame stays hidden
  enableDocUI({ thumbs: false, pageNav: false });
  els.thumbs.hidden = true;
  els.btn.prev.disabled = true;
  els.btn.next.disabled = true;
  updateContextBar(activeTool());
  return true;
}

// The live question can grow AFTER openOverlay (MathJax typeset, late images, feedback). The drawable page
// was sized once at boot, so the grown lower half would be un-annotatable. Grow the page to match — GROW-ONLY
// (never shrink below current, so existing strokes stay pinned) and never in read-only (saved height is
// authoritative). embed.js drives this from a ResizeObserver on the parent host + MathJax.startup.promise.
function resizeOverlay(measuredH) {
  if (READONLY || docMode !== "html" || !document.body.classList.contains("overlay")) return;
  // GROW-ONLY on BOTH axes: height grows as the question content grows; width grows if the card widens
  // (window resize). Never shrink — that would clip existing strokes; and same/smaller is a no-op so the
  // ResizeObserver doesn't loop. Width only re-fills a widened card, never chases it narrower.
  const h = Math.max(basePage.h, Math.min(measuredH | 0, HTML_MAX_PAGE_H));
  const w = Math.max(basePage.w, overlayStageW());
  if (h === basePage.h && w === basePage.w) return;
  basePage = { w, h };
  app.ensure_page(0, w, h);
  htmlSnipCanvas = null; // the page grew → the cached snip raster is stale (else post-grow snips are blank/misaligned)
  renderHtmlPage();
}

// Some HTML embeds images that finish loading after onload, changing the page
// height. Re-measure once they settle. A short debounce coalesces a burst of
// image loads; a hard timeout covers images that never resolve.
let htmlRemeasureTimer;
// Option-B writable: a prior submission's page height was restored (hydrateAnnotations) — a later image
// load must NOT re-measure over it, or restored strokes drift and, once the student edits, the clobbered
// height gets saved and read-only replay is permanently wrong. Set on hydrate, cleared on a new document.
let htmlSavedHeightHydrated = false;
function watchHtmlImages() {
  if (READONLY) return; // its deferred re-measure → ensure_page would clobber the hydrated saved height
  let d;
  try { d = els.htmlFrame.contentDocument; } catch { return; }
  if (!d) return;
  const pendingImgs = [...d.images].filter((im) => !im.complete);
  if (!pendingImgs.length) return; // measured height is already final
  const remeasure = () => {
    clearTimeout(htmlRemeasureTimer);
    htmlRemeasureTimer = setTimeout(() => {
      if (docMode !== "html" || htmlSavedHeightHydrated) return; // hydrated height is authoritative
      measureHtmlHeight();
      renderHtmlPage();
    }, 120);
  };
  for (const im of pendingImgs) {
    im.addEventListener("load", remeasure, { once: true });
    im.addEventListener("error", remeasure, { once: true });
  }
  setTimeout(remeasure, 1500); // safety: settle even if some images never fire
}

// ---------- pointer input ----------

function pageCoords(ev) {
  // Map through the on-screen rect of the active page's canvas — robust under
  // devicePixelRatio / browser zoom. Works for both the single-page canvas and
  // the active continuous page (each .cpage canvas is its own page surface).
  const canvas = activeAnnoCanvas();
  if (!canvas) return [0, 0];
  const r = canvas.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return [0, 0];
  return [
    ((ev.clientX - r.left) / r.width) * basePage.w,
    ((ev.clientY - r.top) / r.height) * basePage.h,
  ];
}

const eraseRadius = () => ERASE_RADIUS_PX / scale();

// setPointerCapture can throw (e.g. the pointer is already gone) — never
// let that abort an input handler mid-state-change. Captures on the canvas the
// event fired on (the single-page canvas, or the active continuous page).
function capturePointer(ev) {
  // Called exactly when a canvas gesture ARMS — record its owner so no other contact
  // (a hovering pen, a bumped mouse, a resting palm) can drive or cancel it.
  gesturePointerId = ev.pointerId;
  gestureCaptureEl = ev.currentTarget;
  try {
    ev.currentTarget.setPointerCapture(ev.pointerId);
  } catch {
    /* capture is an optimization, not a requirement */
  }
}

function onAnnoPointerDown(ev) {
  if (!docOpen() || READONLY || ev.button !== 0) return;
  // Touch while a stylus is the active input = a resting palm; ignore it entirely.
  if (ev.pointerType === "touch" && penActive) return;
  activePointers.set(ev.pointerId, ev.pointerType);
  if (ev.pointerType === "pen") penActive = true;
  // A second concurrent contact is a pinch/pan, not a stroke: cancel anything in
  // progress and don't draw (native gestures are off via touch-action:none, but at
  // minimum a two-finger gesture must never leave a stray stroke).
  if (activePointers.size >= 2) {
    // A second contact cancels ANY in-progress single-pointer op. pointer_cancel() reverts an
    // in-flight stroke, a single move/resize (item_drag) AND a group move to their pre-drag state,
    // and is a safe no-op when nothing is armed — so call it unconditionally. (Reverting only some
    // drag types left an interrupted single move half-applied and un-undoable.)
    drawing = false;
    app.pointer_cancel();
    snip = resizeDrag = itemDrag = groupDrag = marquee = null;
    redrawAnnotations();
    return;
  }
  // In continuous mode the page you press on becomes the active page for
  // hit-testing / drawing (scrolling alone never changes it).
  if (isContinuous()) {
    const cp = ev.currentTarget.closest(".cpage");
    if (cp) { pageNum = Number(cp.dataset.page); basePage = cont.pages[pageNum].base; }
  }
  const tool = activeTool();
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
    // Resize if a handle of the (single) current selection was grabbed.
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
    // Shift = additive: toggle a clicked item, or start an ADD marquee on empty space.
    if (ev.shiftKey) {
      if (id >= 0) {
        const next = new Set(selectedIds);
        if (next.has(id)) next.delete(id); else next.add(id);
        setSelectionSet([...next]);
      } else {
        marquee = { x0: x, y0: y, x1: x, y1: y, page: pageNum, add: true };
        capturePointer(ev);
      }
      return;
    }
    // Grabbing any member of a multi-selection drags the WHOLE group together.
    if (id >= 0 && selectedIds.size > 1 && selectedIds.has(id) &&
        app.begin_group_drag(pageNum, [...selectedIds], x, y)) {
      groupDrag = { startX: x, startY: y, moved: false };
      capturePointer(ev);
      return;
    }
    // Plain click on an item: select just it (and arm a single move).
    if (id >= 0) {
      setSelection(id);
      if (app.begin_item_drag(pageNum, id, x, y)) {
        itemDrag = { id, startX: x, startY: y, moved: false };
        capturePointer(ev);
      }
      return;
    }
    // Plain click/drag on empty space: clear, then rubber-band a replace-marquee.
    setSelection(-1);
    marquee = { x0: x, y0: y, x1: x, y1: y, page: pageNum, add: false };
    capturePointer(ev);
    return;
  }
  if (tool === "text") {
    // Prevent the click's default focus behavior from stealing focus
    // back from the text input (which would instantly commit/close it).
    ev.preventDefault();
    openTextEditor(x, y, "", null);
    return;
  }
  // A palm-sized lone touch on a drawing tool is a resting hand — don't draw.
  if (ev.pointerType === "touch" && Math.max(ev.width || 0, ev.height || 0) > PALM_MAX_PX) {
    activePointers.delete(ev.pointerId);
    return;
  }
  commitTextInput();
  hideRegionButton();
  capturePointer(ev);
  drawing = true;
  drawingPointerId = ev.pointerId;
  // Track the drag rectangle for Box/Shade so we can offer "add to notes".
  regionDraw = REGION_TOOLS.has(tool) ? { x0: x, y0: y, x1: x, y1: y } : null;
  app.pointer_down(pageNum, x, y, eraseRadius());
  redrawAnnotations();
}
els.annoCanvas.addEventListener("pointerdown", onAnnoPointerDown);

// Drag the open snip marquee's far corner. Coalesce the repaint into ONE per frame — a raw pointermove
// can fire 100+/sec and each redrawAnnotations() re-renders every stroke (app.render), which is the
// snip-selection lag; rAF caps it to the display rate.
let snipRaf = 0;
function moveSnip(ev) {
  const [x, y] = pageCoords(ev);
  snip.x1 = x;
  snip.y1 = y;
  if (!snipRaf) snipRaf = requestAnimationFrame(() => { snipRaf = 0; if (snip) redrawAnnotations(); });
}

// Scale the selected item by how far the grabbed corner moved from its anchor.
// Corner-resize scale factors: how far the moving corner is from the fixed
// anchor, relative to the original bbox size (epsilon-guarded). `uniform` locks
// the aspect ratio (stretching strokes/text looks broken). Shared by the PDF view
// and sketches.
function resizeScale(bb, ax, ay, x, y, uniform) {
  const w0 = Math.max(1e-3, Math.abs(bb[2] - bb[0]));
  const h0 = Math.max(1e-3, Math.abs(bb[3] - bb[1]));
  let sx = Math.abs(x - ax) / w0;
  let sy = Math.abs(y - ay) / h0;
  if (uniform) sx = sy = Math.max(sx, sy);
  return [sx, sy];
}

function moveResize(ev) {
  const [x, y] = pageCoords(ev);
  const [ax, ay] = resizeDrag.anchor;
  const [sx, sy] = resizeScale(resizeDrag.startBB, ax, ay, x, y, resizeDrag.uniform);
  app.scale_dragged_item(ax, ay, sx, sy);
  redrawAnnotations();
}

// Move the selected item, but only once it's dragged past a small threshold
// (so a click that barely moves doesn't nudge it).
function moveItem(ev) {
  const [x, y] = pageCoords(ev);
  if (Math.hypot(x - itemDrag.startX, y - itemDrag.startY) > MOVE_THRESHOLD_PX / scale()) {
    itemDrag.moved = true;
  }
  if (itemDrag.moved) {
    app.drag_item(x, y);
    redrawAnnotations();
  }
}

// Hover feedback for the select tool: resize cursor on a handle, move cursor over
// an item, default otherwise (never changes the active page). Other tools clear
// any leftover select-hover cursor and fall back to the CSS crosshair.
function updateHoverCursor(ev) {
  if (READONLY) { ev.currentTarget.style.cursor = ""; return; }
  if (docOpen() && activeTool() === "select") {
    let hp = pageNum, hx, hy;
    if (isContinuous()) {
      const cp = ev.currentTarget.closest(".cpage");
      hp = cp ? Number(cp.dataset.page) : pageNum;
      const b = cont.pages[hp]?.base || basePage;
      const r = ev.currentTarget.getBoundingClientRect();
      hx = (ev.clientX - r.left) / r.width * b.w;
      hy = (ev.clientY - r.top) / r.height * b.h;
    } else {
      [hx, hy] = pageCoords(ev);
    }
    const h = hp === pageNum ? handleAt(hx, hy) : -1; // handles only on selected page
    ev.currentTarget.style.cursor =
      h === 0 || h === 2 ? "nwse-resize"
      : h === 1 || h === 3 ? "nesw-resize"
      : app.find_item(hp, hx, hy) >= 0 ? "move"
      : "default";
  } else {
    ev.currentTarget.style.cursor = "";
  }
}

// Feed a freehand/erase/shape drag to the core, coalescing batched moves so
// fast strokes stay smooth.
function moveDraw(ev) {
  const events = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
  for (const e of events) {
    const [x, y] = pageCoords(e);
    app.pointer_move(x, y, eraseRadius());
  }
  if (regionDraw) { const [x, y] = pageCoords(ev); regionDraw.x1 = x; regionDraw.y1 = y; }
  redrawAnnotations();
}

// Pointer-move dispatcher: one in-progress gesture at a time, else hover/draw.
function onAnnoPointerMove(ev) {
  if (drawing || snip || marquee || itemDrag || resizeDrag || groupDrag) {
    // Only the contact that ARMED the gesture may drive or end it — a hovering pen
    // (buttons=0) or a bumped second pointer must neither corrupt nor cancel it.
    if (ev.pointerId !== gesturePointerId) return;
    // The owning press ended somewhere we never heard about (tab switch, OS overlay) —
    // a move with no button down means the pointerup was swallowed. Cancel; don't keep drawing.
    if (!(ev.buttons & 1)) { onAnnoPointerCancel(ev); return; }
  }
  if (snip) { moveSnip(ev); return; }
  if (marquee) { moveMarquee(ev); return; }
  if (resizeDrag) { moveResize(ev); return; }
  if (groupDrag) { moveGroup(ev); return; }
  if (itemDrag) { moveItem(ev); return; }
  if (!drawing) { updateHoverCursor(ev); return; }
  moveDraw(ev);
}

// Rubber-band the marquee's far corner (coalesced to one repaint per frame).
let marqueeRaf = 0;
function moveMarquee(ev) {
  const [x, y] = pageCoords(ev);
  marquee.x1 = x; marquee.y1 = y;
  if (!marqueeRaf) marqueeRaf = requestAnimationFrame(() => { marqueeRaf = 0; if (marquee) redrawAnnotations(); });
}

// Move the whole multi-selection together, past the same small threshold as a single move.
function moveGroup(ev) {
  const [x, y] = pageCoords(ev);
  if (Math.hypot(x - groupDrag.startX, y - groupDrag.startY) > MOVE_THRESHOLD_PX / scale()) {
    groupDrag.moved = true;
  }
  if (groupDrag.moved) {
    app.drag_group(x, y);
    redrawAnnotations();
  }
}
els.annoCanvas.addEventListener("pointermove", onAnnoPointerMove);

function endStroke(ev) {
  // Contact bookkeeping runs for EVERY pointer unconditionally — palm-rejection accounting
  // breaks if a filtered-out pointer skips it (keep these lines above any gesture filter).
  activePointers.delete(ev.pointerId);
  if (ev.pointerType === "pen") penActive = false;
  // An up from a contact that didn't arm the gesture (a rejected palm, the second finger
  // of a pinch, a bumped mouse) must not end/commit it — any kind, not just drawing.
  if (drawing && ev.pointerId !== drawingPointerId) return;
  if ((snip || marquee || itemDrag || resizeDrag || groupDrag) && ev.pointerId !== gesturePointerId) return;
  if (ev.pointerId !== undefined && ev.currentTarget.hasPointerCapture?.(ev.pointerId)) {
    ev.currentTarget.releasePointerCapture(ev.pointerId);
  }
  if (snip) {
    const r = snip;
    snip = null;
    redrawAnnotations();
    finishSnip(r);
    return;
  }
  if (marquee) {
    const m = marquee;
    marquee = null;
    // A near-zero drag is a click, not a box-select: replace-mode already cleared on
    // pointerdown; add-mode (shift) leaves the current selection untouched.
    if (Math.abs(m.x1 - m.x0) < 3 && Math.abs(m.y1 - m.y0) < 3) {
      redrawAnnotations();
      return;
    }
    // Float64Array → plain number[] so Set/spread behave predictably.
    const ids = Array.from(app.items_in_rect(m.page, m.x0, m.y0, m.x1, m.y1));
    if (m.add) {
      const next = new Set(selectedIds);
      ids.forEach((i) => next.add(i));
      setSelectionSet([...next]);
    } else {
      setSelectionSet(ids); // replace (empty list clears)
    }
    return; // setSelectionSet already repainted
  }
  if (groupDrag) {
    groupDrag = null;
    app.end_group_drag();
    redrawAnnotations();
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
  // After drawing a Box/Shade, offer to snip that region into the notes.
  if (regionDraw) {
    const r = regionDraw;
    regionDraw = null;
    if (Math.abs(r.x1 - r.x0) > 8 && Math.abs(r.y1 - r.y0) > 8) showRegionButton(r);
  }
}

function onAnnoPointerCancel(ev) {
  if (ev) {
    activePointers.delete(ev.pointerId);
    if (ev.pointerType === "pen") penActive = false;
  } else {
    // No event = a swallowed pointerup (tab switch / OS overlay): the per-pointer cleanup and the
    // window backstop never fired for that dead contact. Reset the tracking wholesale — one stale
    // pen id would otherwise keep penActive on (all touch rejected) and trip the two-contact
    // cancel on every future stroke ("can't draw until reload").
    activePointers.clear();
    penActive = false;
  }
  gesturePointerId = null;
  gestureCaptureEl = null;
  drawingPointerId = null;
  drawing = false;
  itemDrag = null;
  resizeDrag = null;
  groupDrag = null;
  marquee = null;
  snip = null;
  app.pointer_cancel(); // reverts any in-flight single OR group move
  redrawAnnotations();
}
els.annoCanvas.addEventListener("pointerup", endStroke);
els.annoCanvas.addEventListener("pointercancel", onAnnoPointerCancel);

// ---------- snip: copy a region (image + its text) into the notes ----------

let snip = null;       // {x0, y0, x1, y1} page coords while dragging
let resizeDrag = null; // {anchor, startBB, uniform}

// ---------- Box/Shade → add region to notes (#11) ----------
const REGION_TOOLS = new Set(["rect", "fillrect"]);
let regionDraw = null; // drag rect of the box/shade being drawn
let regionBtn = null;  // floating "add to notes" button element

function hideRegionButton() {
  if (regionBtn) { regionBtn.remove(); regionBtn = null; }
}

// Show a floating "＋ Add to notes" button anchored to a region (page coords),
// inside the active page element so it tracks the page.
function showRegionButton(r) {
  hideRegionButton();
  const host = isContinuous() ? cont.pages[pageNum]?.el : els.wrap;
  if (!host) return;
  const x = Math.max(r.x0, r.x1), y = Math.max(r.y0, r.y1);
  const b = document.createElement("button");
  b.className = "region-add-btn";
  b.textContent = "＋ Add to notes";
  b.style.left = `${x * scale()}px`;
  b.style.top = `${y * scale() + 6}px`;
  b.addEventListener("pointerdown", (e) => e.stopPropagation());
  b.addEventListener("click", () => {
    hideRegionButton();
    finishSnip({ x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1),
                 x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1) });
  });
  host.appendChild(b);
  // Auto-dismiss if untouched (it also clears on the next pointer-down).
  setTimeout(() => { if (regionBtn === b) hideRegionButton(); }, 7000);
  regionBtn = b;
}

// Render the CURRENT page to a flat canvas (page content + annotations), so it can
// be copied or saved as a real image. The browser's native "Save/Copy image" can't:
// it only sees the transparent annotation canvas sitting on top of the page.
async function capturePageCanvas() {
  if (docMode === "html") {
    const page = await htmlPageToCanvas(); // styled raster of the HTML page
    const anno = els.annoCanvas;
    if (anno.width > 1) page.getContext("2d").drawImage(anno, 0, 0, page.width, page.height);
    return page;
  }
  const srcPdf = isContinuous() ? cont.pages[pageNum]?.pdfCanvas : els.pdfCanvas;
  const srcAnno = isContinuous() ? cont.pages[pageNum]?.annoCanvas : els.annoCanvas;
  if (!srcPdf || srcPdf.width < 2) return null;
  const out = document.createElement("canvas");
  out.width = srcPdf.width;
  out.height = srcPdf.height;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(srcPdf, 0, 0);                                   // the page (same backing size)
  if (srcAnno && srcAnno.width > 1) ctx.drawImage(srcAnno, 0, 0, out.width, out.height);
  return out;
}

// A small right-click menu offering "Copy image" / "Save image" of the page.
let pageMenu = null;
function hidePageMenu() {
  if (pageMenu) {
    document.removeEventListener("pointerdown", pageMenu._onAway, true);
    pageMenu.remove();
    pageMenu = null;
  }
}
function showPageImageMenu(clientX, clientY) {
  hidePageMenu();
  const capture = async (fn, busy) => {
    status(busy);
    const canvas = await capturePageCanvas();
    if (!canvas) { status("Couldn't capture the page."); return; }
    canvas.toBlob((blob) => blob ? fn(blob) : status("Couldn't capture the page."), "image/png");
  };
  const menu = document.createElement("div");
  menu.className = "page-ctx-menu";
  menu.style.left = `${clientX}px`;
  menu.style.top = `${clientY}px`;
  const item = (label, onPick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", () => { hidePageMenu(); onPick(); });
    menu.appendChild(b);
  };
  item("Copy image", () => capture(async (blob) => {
    try { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); status("Page image copied to the clipboard."); }
    catch { status("Couldn't copy — the browser blocked clipboard access."); }
  }, "Capturing the page…"));
  item("Save image", () => capture((blob) => downloadBlob(blob, `page-${fileStamp()}.png`), "Capturing the page…"));
  menu._onAway = (e) => { if (!menu.contains(e.target)) hidePageMenu(); };
  document.body.appendChild(menu);
  pageMenu = menu;
  setTimeout(() => document.addEventListener("pointerdown", menu._onAway, true), 0);
}

// Right-click: on a shape (box/shade) add its region to the notes; otherwise offer
// to copy/save the page as an image (the native menu only grabs the empty overlay).
function onAnnoContextMenu(ev) {
  if (!docOpen()) return;
  if (isContinuous()) {
    const cp = ev.currentTarget.closest(".cpage");
    if (cp) { pageNum = Number(cp.dataset.page); basePage = cont.pages[pageNum].base; }
  }
  const [x, y] = pageCoords(ev);
  const id = app.find_item(pageNum, x, y);
  if (id >= 0 && app.item_kind(pageNum, id) === "shape") {
    const bb = app.item_bbox_of(pageNum, id);
    if (bb.length === 4) {
      ev.preventDefault();
      showRegionButton({ x0: bb[0], y0: bb[1], x1: bb[2], y1: bb[3] });
      return;
    }
  }
  ev.preventDefault();
  showPageImageMenu(ev.clientX, ev.clientY);
}
els.annoCanvas.addEventListener("contextmenu", onAnnoContextMenu);

function drawSnipMarquee(ctx) {
  if (!snip) return;
  const r = curRatio();
  const k = scale() * r;
  ctx.save();
  ctx.strokeStyle = "#2f5fde";
  ctx.lineWidth = 1.5 * r;
  ctx.setLineDash([6 * r, 4 * r]);
  ctx.strokeRect(
    Math.min(snip.x0, snip.x1) * k,
    Math.min(snip.y0, snip.y1) * k,
    Math.abs(snip.x1 - snip.x0) * k,
    Math.abs(snip.y1 - snip.y0) * k,
  );
  // Live W×H readout (screen px) pinned to the dragged corner, so the box can be
  // aimed precisely. Esc cancels the drag (see the keydown handler).
  const wPx = Math.round(Math.abs(snip.x1 - snip.x0) * scale());
  const hPx = Math.round(Math.abs(snip.y1 - snip.y0) * scale());
  if (wPx > 6 || hPx > 6) {
    const fs = 12 * r, pad = 4 * r;
    ctx.font = `${fs}px system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = "top";
    const label = `${wPx} × ${hPx}`;
    const tw = ctx.measureText(label).width, bh = fs + pad * 2;
    let lx = snip.x1 * k + 8 * r, ly = snip.y1 * k + 8 * r;
    if (lx + tw + pad * 2 > ctx.canvas.width) lx = ctx.canvas.width - tw - pad * 2;
    if (ly + bh > ctx.canvas.height) ly = snip.y1 * k - bh - 8 * r;
    ctx.fillStyle = "rgba(20, 24, 28, 0.85)";
    ctx.fillRect(lx, ly, tw + pad * 2, bh);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, lx + pad, ly + pad);
  }
  ctx.restore();
}

// Trim a caption to a sane length on a word/line boundary, leaving room for the
// ellipsis so the result never exceeds `max` (the Rust core hard-caps captions
// at MAX_CAPTION_LEN=300 with a blind char chop — clamp to that so the word
// boundary actually holds and isn't re-cut mid-word).
function clampCaption(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const brk = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(" "));
  return (brk > max * 0.5 ? cut.slice(0, brk) : cut).trimEnd() + "…";
}

// True if an <img> overlapping the region failed to load (e.g. a CSP-blocked
// external image) — it'll be blank in the raster, so we warn the user.
function regionHasBrokenImage(x0, y0, x1, y1) {
  try {
    for (const im of els.htmlFrame.contentDocument.images) {
      if (im.complete && im.naturalWidth === 0) {
        const r = im.getBoundingClientRect();
        if (r.right >= x0 && r.left <= x1 && r.bottom >= y0 && r.top <= y1) return true;
      }
    }
  } catch { /* same-origin guard */ }
  return false;
}

// Surface the notes after a snip: show it if hidden, and expand it if it's minimised to a strip (overlay)
// — otherwise a clip lands out of sight in the collapsed strip.
// R1: float the notes pane at the TOP of the visible band (just below the toolbar) — never below the fold in
// the question-tall overlay iframe. Preserves the student's chosen size; only the position resets to band-top.
function placeNotesAtBandTop() {
  const stage = $("stage"), sr = stage.getBoundingClientRect(), b = visibleBand();
  const CLEAR = 64; // clear the top toolbar (rail ~52 + a gap)
  const DEFW = 400, DEFH = 340; // small default (user pref): a compact floating textbox, NOT full-width
  const left = Math.max(8, Math.round(b.left - sr.left + 8));
  const top = Math.round(b.top - sr.top + CLEAR);
  const pane = els.notesPane;
  const w = Math.round(parseFloat(pane.style.width) || Math.min(DEFW, sr.width - 16)); // keep the student's resized width if any
  const h = Math.max(150, Math.min(Math.round(parseFloat(pane.style.height) || DEFH), Math.round(b.bottom - b.top - CLEAR - 16)));
  floatNotes(left, top, w, h); // floatNotes -> clampNotes keeps it in-band
}

function revealNotes() {
  if (els.notesPane.hidden) { toggleNotes(true); return; } // hidden → toggleNotes brings it to the band top (R1)
  if (!document.body.classList.contains("overlay")) return;
  if (isNotesCollapsed()) { setNotesCollapsed(false); savePrefs(); } // expand a strip, then fall through to the band check
  // Visible + expanded (incl. a just-expanded low strip whose body now extends below the fold): a snip must
  // never reveal the pane off-screen — if its header is out of the band OR its body runs past the bottom,
  // bring it to the band top so the new clip is on-screen.
  const pane = els.notesPane, pr = pane.getBoundingClientRect(), b = visibleBand();
  if (pr.top < b.top || pr.top > b.bottom - 36 || pr.bottom > b.bottom) { placeNotesAtBandTop(); savePrefs(); }
}

async function finishSnip(r) {
  // Snapshot the document identity up front: the async awaits below (raster, text extraction, toBlob)
  // yield, and a scroll can reassign pageNum/basePage meanwhile — the clipping must still be attributed
  // to THIS page/mode/base.
  const snipPage = pageNum;
  const snipMode = docMode;
  // Snapshot the base size too: basePage is reassigned on scroll, and the text
  // extraction below must use the page the snip started on (snapshot invariant).
  const snipBase = isContinuous() ? (cont.pages[snipPage]?.base || basePage) : basePage;
  const snipScale = scale(); // snapshot: the on-screen size the region occupied when boxed (page-units × scale)
  const x0 = Math.min(r.x0, r.x1), y0 = Math.min(r.y0, r.y1);
  const w = Math.abs(r.x1 - r.x0), h = Math.abs(r.y1 - r.y0);
  if (w < 4 || h < 4) {
    status("Drag a box to snip a region.");
    return;
  }
  try {
    // 1. Pixels + 2. Text — captured differently for HTML vs PDF.
    let out = null, text = "", hadMath = false;
    if (snipMode === "html") {
      // High-DPI raster of the HTML region (the iframe can't be drawn to a
      // canvas directly) + reliable DOM text extraction. If the raster fails
      // we keep going — the text alone is still worth saving.
      try { out = await snipHtmlRegion(x0, y0, w, h); }
      catch (e) { console.warn("snip raster failed:", e); }
      if (document.body.classList.contains("overlay")) {
        ({ text, hadMath } = overlayTextInRegion(overlayHost(), x0, y0, w, h));
      } else {
        ({ text, hadMath } = htmlTextInRegion(els.htmlFrame, x0, y0, w, h));
      }
    } else {
      // Copy the region from the active page's live canvases (single page, or
      // the active continuous page).
      const k = scale() * curRatio();
      const srcPdf = isContinuous() ? cont.pages[snipPage]?.pdfCanvas : els.pdfCanvas;
      const srcAnno = isContinuous() ? cont.pages[snipPage]?.annoCanvas : els.annoCanvas;
      out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(w * k));
      out.height = Math.max(1, Math.round(h * k));
      const octx = out.getContext("2d");
      octx.fillStyle = "#ffffff";
      octx.fillRect(0, 0, out.width, out.height);
      for (const src of [srcPdf, srcAnno]) {
        if (src) octx.drawImage(src, x0 * k, y0 * k, w * k, h * k, 0, 0, out.width, out.height);
      }
      text = await pdfTextInRegion(pdfDoc, snipPage, snipBase, x0, y0, w, h);
    }

    // Keep recovered equations and DOM text even when symbol-heavy: the dingbat
    // filter is only meant for broken-font PDF glyphs, not real HTML/TeX. Cap on
    // a word boundary so a long caption never cuts mid-word.
    const usable = (hadMath || looksLikeText(text))
      ? clampCaption(text, snipMode === "html" ? 300 : 280) : "";
    // Auto-include the recovered text as the clipping's caption — it lands in an editable,
    // deletable textarea, which IS the take-back. One gesture instead of a blocking confirm.
    const finalText = usable;

    // When the image can't be captured, keep the recovered text as a note rather
    // than lose the snip entirely (and if there's no text either, just report).
    const saveTextOnly = (reason) => {
      if (finalText) {
        app.add_text_note(finalText);
        renderNotes();
        revealNotes();
        status(`Snipped text only — ${reason}.`);
      } else {
        status("Couldn't capture that region.");
      }
    };
    // The HTML raster failed (iframe → canvas can fail); save the text instead.
    if (!out) { saveTextOnly("the image couldn't be captured"); return; }

    const blob = await new Promise((res) => out.toBlob(res, "image/png"));
    // PNG encode can return null (e.g. canvas over the encode limit).
    if (!blob) { saveTextOnly("the image was too large to capture"); return; }
    const b64 = bytesToB64(new Uint8Array(await blob.arrayBuffer()));
    // Preview the clip + let the student see what was grabbed and choose whether to keep the recognised
    // text as its caption, before it lands in the notes. (Revoke the preview URL either way.)
    const previewUrl = URL.createObjectURL(blob);
    let choice;
    try { choice = await confirmSnip(previewUrl, finalText); }
    finally { URL.revokeObjectURL(previewUrl); }
    if (!choice.add) { status("Snip discarded."); return; }
    const keepText = choice.includeText && !!finalText;
    const caption = keepText ? finalText : ""; // "image only" → no caption text under the clip
    // Store the on-screen CSS-px size the region occupied so the note renders at SOURCE size, not the
    // 2-4x high-DPI raster (which made snips render ~2x too big).
    app.add_clipping(b64, snipPage, caption, Math.round(w * snipScale), Math.round(h * snipScale));
    renderNotes();
    revealNotes();

    // Best-effort: also put the image on the system clipboard.
    try {
      if (navigator.clipboard?.write && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      }
    } catch { /* clipboard permission is optional */ }
    // Overlay drops cross-origin question images from the raster (regionHasBrokenImage is a no-op there,
    // since Scribble's own iframe is empty) — use the raster's own drop-count instead.
    const imgWarn = (snipMode === "html" && (document.body.classList.contains("overlay")
      ? overlaySnipDropped > 0 : regionHasBrokenImage(x0, y0, x0 + w, y0 + h)))
      ? " (some external images couldn't be captured)" : "";
    status((keepText ? "Snipped — image and text added to notes." : "Snipped — image added to notes.") + imgWarn);
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
  // Capture the page NOW: in continuous mode onAnnoPointerDown reassigns the live
  // pageNum to the clicked page, so committing against pageNum later would land the
  // note (or an edit) on the wrong page. The note belongs to the page it opened on.
  const page = pageNum;
  pendingText = { x: pageX, y: pageY, editId, page };
  // Position the input inside its page's element so it tracks that page. In
  // continuous mode that's the active .cpage; otherwise the single #page-wrap.
  const host = isContinuous() ? cont.pages[page]?.el || els.wrap : els.wrap;
  if (els.textInput.parentElement !== host) host.appendChild(els.textInput);
  els.textInput.style.left = `${pageX * scale()}px`;
  els.textInput.style.top = `${(pageY - 18) * scale()}px`;
  // Scale the editing box's font WITH the zoom so the text you type matches the size/position it will
  // render at once committed (the canvas draws the note at page-size × scale). The CSS base is 15px, which
  // matches the rendered note at scale 1; multiplying by scale() keeps them aligned at any zoom. (In the
  // overlay scale is locked to 1, so this is a no-op there; it fixes standalone/embed zoom drift.)
  els.textInput.style.fontSize = `${15 * scale()}px`;
  els.textInput.value = initial;
  els.textInput.hidden = false;
  autoGrow(els.textInput);
  // Defer focus until after the pointer event sequence settles.
  setTimeout(() => els.textInput.focus(), 0);
}

function commitTextInput() {
  if (els.textInput.hidden || !pendingText) {
    hideTextInput();
    return;
  }
  const { x, y, editId, page } = pendingText;
  const value = els.textInput.value; // .value only — never innerHTML
  try {
    if (editId !== null && editId !== undefined) {
      app.update_text(page, editId, value); // empty value deletes the note
    } else if (value.trim()) {
      app.add_text(page, x, y, value);
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
  // Enter places the note; Shift+Enter inserts a newline (multi-line notes).
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    commitTextInput();
  } else if (ev.key === "Escape") {
    hideTextInput();
  }
  ev.stopPropagation();
});
els.textInput.addEventListener("input", () => autoGrow(els.textInput));
els.textInput.addEventListener("blur", commitTextInput);

// ---------- save / load ----------

function downloadJson() {
  try {
    const json = app.save_json();
    const blob = new Blob([json], { type: "application/json" });
    downloadBlob(blob, `annotations-${fileStamp()}.json`);
    dirtySinceFileSave = false; // work is now in a file the user controls
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
    if (fileSha && currentSha && fileSha.toLowerCase() !== currentSha.trim().toLowerCase()) {
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
  dirtySinceFileSave = false; // matches the file the user just chose
  status("Annotations loaded.");
  setSelection(-1);
  renderNotes();
  if (app.notes_len() > 0 && els.notesPane.hidden) toggleNotes(true);
  if (!els.thumbs.hidden) await buildThumbnails();
  await renderDoc(); // re-render the CURRENT mode (HTML / continuous / paged)
}

// ---------- PrairieLearn persistence (embed mode) ----------
// The serialized annotation document is carried as UTF-8-safe base64 (btoa alone
// throws on non-ASCII note text). Encode the UTF-8 bytes; decode them back.

// Returns base64(save_json()) when there are unsaved edits, else null. MUST resolve the
// CURRENT `app` — openHtml → newDocument reassigns it, so embed.js calls this instead of
// holding its own (soon-stale) app reference. save_json clears the Rust dirty flag.
// Returns { b64, decodedBytes, nodes } when there are unsaved edits, else null. The caller (embed.js flush)
// applies the cap policy — it must NOT write an over-cap blob into the form input (see SAVE_CAP_*). Parses the
// save_json output ONCE: to strip notes and to estimate the node count the server will see.
function serializeAnnotations() {
  if (!app || !app.is_dirty()) return null;
  // Notes are SCRATCH: the PL submission persists ONLY the annotations drawn on the question, never the
  // notes/clippings. Strip the notes array from the blob before it lands in the form input. (save_json clears
  // the Rust dirty flag; the app keeps its notes in-session — only what's SAVED drops them.)
  const raw = app.save_json();
  let json = raw, parsed = null;
  try {
    parsed = JSON.parse(raw);
    if (Array.isArray(parsed.notes) && parsed.notes.length) { parsed.notes = []; json = JSON.stringify(parsed); }
  } catch { parsed = null; /* unparseable — save as-is rather than lose the annotations */ }
  const bytes = new TextEncoder().encode(json);
  // Count nodes on the notes-STRIPPED object (what the server actually receives). Skip for light docs.
  let nodes = 0;
  if (parsed && bytes.length > SAVE_NODE_WALK_MIN_BYTES) {
    try { nodes = estimateJsonNodes(parsed); } catch { nodes = 0; }
  }
  // Decide over-cap HERE, against the single source of truth (SAVE_CAP_*), so the caller never
  // re-derives ceilings (a duplicated cap in embed.js could drift and silently disable the guard).
  const overCap = bytes.length > SAVE_CAP_BYTES || nodes > SAVE_CAP_NODES;
  return { b64: bytesToB64(bytes), decodedBytes: bytes.length, nodes, overCap };
}

// Restore a base64-encoded annotation document over the already-open question (the
// PL question content was openHtml()'d first). Returns true on success. Mirrors the
// proven loadJsonFile sequence, and re-syncs the HTML page box from the saved height.
function hydrateAnnotations(b64) {
  if (!b64 || !b64.trim()) return false; // blank scratchpad — load_json("") would throw
  let json, savedH, savedW;
  try {
    json = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const p0 = JSON.parse(json)?.pages?.[0];
    savedH = p0?.height; savedW = p0?.width;
  } catch { status("Couldn't restore saved work."); return false; }
  try {
    app.load_json(json); // Rust validates + replaces the doc wholesale; throws on bad input (doc untouched)
  } catch (e) {
    status("Couldn't restore saved work: " + (e?.message || e));
    return false;
  }
  app.set_pdf_sha256(""); // HTML mode has no PDF hash
  // The doc is already replaced (load_json succeeded); a failure PAST here is only a render hiccup. Guard it
  // so hydrate can NEVER throw out of the synchronous overlay boot — an unguarded throw here would propagate
  // through initEmbed and skip the toolbar merge + notes setup, leaving a raw, unresponsive bar (real bug).
  try {
    if (docMode === "html" && savedH > 0) {
      // Overlay: fill the current card, but never below the saved width (else strokes near the old right
      // edge would clip). Option-B keeps the fixed 816 HTML-clone width.
      const isOverlay = document.body.classList.contains("overlay");
      const w = isOverlay ? Math.max(Math.round(savedW || 0), overlayStageW()) : HTML_BASE_W;
      basePage = { w, h: savedH };
      if (isOverlay) app.ensure_page(0, w, savedH); // reconcile the Rust page width with the render
      htmlSavedHeightHydrated = true;           // lock it: a later image re-measure must not clobber savedH (F2)
      clearTimeout(htmlRemeasureTimer);
      renderHtmlPage();
    } else {
      renderDoc();
    }
    renderNotes();
    if (app.notes_len() > 0 && els.notesPane.hidden) toggleNotes(true);
  } catch (e) {
    console.warn("hydrate render failed (doc loaded, will re-render on next paint):", e);
    status("Restored your work — refreshing the view…");
    return false;
  }
  return true;
}

// ---------- export annotated PDF ----------
// Builds a PDF from scratch (one JPEG image per page) with no extra libraries.
// Output contains only flattened page images — nothing executable.

const EXPORT_SCALE = 2;

// ---------- notes pages for export ----------

const NOTE_PAGE = { w: 612, h: 792, margin: 54, size: 11, leading: 14.85 };

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

// Running layout state for the export notes pages: the accumulated pages, the
// current page being filled, and the vertical cursor — plus the page-break
// helpers. Keeping cur/yTop as object fields (not closure-captured lets) lets the
// per-kind emitters below share and advance the same cursor.
function makeNotesLayout() {
  const { w, h, margin, size, leading } = NOTE_PAGE;
  const contentW = w - 2 * margin;
  const cols = Math.floor(contentW / (size * 0.5)); // conservative wrap
  const L = {
    w, h, margin, size, leading, contentW, cols,
    pages: [],
    cur: { w, h, ops: "", images: [] },
    yTop: margin, // distance consumed from the top
    remaining() { return L.h - L.margin - L.yTop; },
    newPage() {
      L.pages.push(L.cur);
      L.cur = { w: L.w, h: L.h, ops: "", images: [] };
      L.yTop = L.margin;
    },
    // Push the current accumulation page only if it holds real content.
    flush() {
      if (L.cur.images.length || L.yTop > L.margin + 1) L.newPage();
    },
  };
  return L;
}

// A sketch exports as its own full page in its own coordinate space; its
// annotations are crisp PDF vectors (no rasterization).
function emitSketchPage(L, i) {
  const dims = app.sketch_size(i);
  if (dims.length === 2) {
    L.flush();
    L.pages.push({ w: dims[0], h: dims[1], ops: app.sketch_export_ops(i), images: [] });
  }
}

// Wrap a text note across as many notes pages as it needs.
function emitTextNote(L, i) {
  const lines = wrapLine(app.note_text(i), L.cols);
  let idx = 0;
  while (idx < lines.length) {
    const fit = Math.max(1, Math.floor(L.remaining() / L.leading));
    if (fit < 1 || (L.remaining() < L.leading && L.yTop > L.margin)) {
      L.newPage();
      continue;
    }
    const slice = lines.slice(idx, idx + fit);
    L.cur.ops += app.note_text_block_ops(slice.join("\n"), L.margin, L.h - L.yTop - L.size, L.size);
    L.yTop += slice.length * L.leading + 6;
    idx += slice.length;
  }
}

// Place a clipping image (scaled to fit) plus its wrapped caption.
async function emitClippingNote(L, i) {
  let im;
  try {
    im = await pngB64ToJpeg(app.note_png(i));
  } catch {
    return; // unrenderable clipping: skip rather than fail the export
  }
  // Use the stored on-screen size if present; else fall back to the old "snips are 2x resolution" guess
  // (older files without disp_w — this was wrong for 3-4x standalone snips).
  const dispW = app.note_disp_w(i);
  let drawW = Math.min(L.contentW, dispW > 0 ? dispW : im.pxW / 2);
  let drawH = drawW * (im.pxH / im.pxW);
  const maxH = L.h - 2 * L.margin - 20;
  if (drawH > maxH) {
    drawH = maxH;
    drawW = drawH * (im.pxW / im.pxH);
  }
  if (drawH + 16 > L.remaining() && L.yTop > L.margin) L.newPage();
  L.cur.images.push({ ...im, x: L.margin, y: L.h - L.yTop - drawH, w: drawW, h: drawH });
  L.yTop += drawH + 4;
  const caption = app.note_caption(i);
  if (caption) {
    const capLines = wrapLine(caption, L.cols + 10).slice(0, 4);
    L.cur.ops += app.note_text_block_ops(capLines.join("\n"), L.margin, L.h - L.yTop - 9, 9);
    L.yTop += capLines.length * 12;
  }
  L.yTop += 10;
}

// Lay the note blocks out across as many letter-size pages as needed.
async function buildNotesPages() {
  const total = app.notes_len();
  if (total === 0) return [];
  const L = makeNotesLayout();
  L.cur.ops += app.note_text_block_ops("Notes", L.margin, L.h - L.margin, 16);
  L.yTop += 30;
  for (let i = 0; i < total; i++) {
    const kind = app.note_kind(i);
    if (kind === "sketch") emitSketchPage(L, i);
    else if (kind === "text") emitTextNote(L, i);
    else if (kind === "clipping") await emitClippingNote(L, i);
  }
  L.flush();
  return L.pages;
}

// Rasterize the uploaded HTML page (same-origin sandboxed iframe) to a canvas
// via an SVG <foreignObject>, at `ratio`x the page's CSS-pixel size. Self-
// contained content only — external resources are blocked by the CSP anyway.
// Used for HTML export and high-DPI HTML snipping.
function htmlPageToCanvas(ratio = EXPORT_SCALE) {
  const f = els.htmlFrame;
  const doc = f.contentDocument;
  if (!doc) throw new Error("no HTML content to render");
  const w = Math.max(1, Math.round(basePage.w));
  const h = Math.max(1, Math.round(basePage.h));
  const clone = doc.documentElement.cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  clone.querySelectorAll("script").forEach((s) => s.remove()); // belt & suspenders
  const xhtml = new XMLSerializer().serializeToString(clone);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<foreignObject x="0" y="0" width="${w}" height="${h}">${xhtml}</foreignObject></svg>`;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      // Clamp so neither axis exceeds the browser's hard ~32767px canvas limit
      // (beyond it the canvas silently yields a blank image). No-op for normal
      // pages; only bites pathologically tall ones — shared by snip + export.
      const safe = Math.max(1, Math.min(ratio, MAX_CANVAS_DIM / Math.max(w, h)));
      c.width = Math.max(1, Math.round(w * safe));
      c.height = Math.max(1, Math.round(h * safe));
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      resolve(c);
    };
    img.onerror = () => reject(new Error("could not rasterize the HTML page"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}

// Rasterize the LIVE PrairieLearn question (rendered in the PARENT page, behind the transparent overlay)
// so a student can snip a region of it into their notes. The parent is same-origin, so we clone the
// question host, bake COMPUTED styles inline (robust no matter where PL's CSS is served from), inline
// same-origin images as data-URLs (a data: SVG can't fetch anything external), drop scripts + the overlay
// iframe, then reuse the same <foreignObject> raster path. Aligned 1:1 with page coords — the canvas
// overlays the host, so page (0,0) is the host's top-left.
const OVERLAY_SNIP_PROPS = ("display position top left right bottom float clear box-sizing overflow width height " +
  "min-width min-height max-width max-height margin-top margin-right margin-bottom margin-left " +
  "padding-top padding-right padding-bottom padding-left border-top-width border-right-width border-bottom-width " +
  "border-left-width border-top-style border-right-style border-bottom-style border-left-style border-top-color " +
  "border-right-color border-bottom-color border-left-color border-top-left-radius border-top-right-radius " +
  "border-bottom-left-radius border-bottom-right-radius color background-color background-image background-position " +
  "background-size background-repeat font-family font-size font-weight font-style font-variant line-height " +
  "letter-spacing text-align text-decoration text-transform text-indent white-space word-spacing vertical-align " +
  "list-style-type list-style-position opacity visibility flex-direction flex-wrap justify-content align-items " +
  "align-content gap flex-grow flex-shrink flex-basis transform transform-origin box-shadow outline-width " +
  "outline-style outline-color outline-offset text-shadow text-overflow word-break overflow-wrap direction " +
  "border-collapse border-spacing table-layout object-fit object-position font-feature-settings tab-size").split(" ");

// Count of question images the last raster had to drop (cross-origin / fetch failure) — surfaced as a
// "some external images couldn't be captured" warning after a snip, since the raster leaves a blank gap.
let overlaySnipDropped = 0;

async function overlayHostToCanvas(ratio = EXPORT_SCALE) {
  const host = overlayHost();
  if (!host) throw new Error("no question to render");
  overlaySnipDropped = 0;
  const w = Math.max(1, Math.round(basePage.w));
  const h = Math.max(1, Math.round(basePage.h));
  const clone = host.cloneNode(true);
  // Bake computed styles inline, walking original + clone in lockstep (identical structure pre-removal).
  const src = [host, ...host.querySelectorAll("*")];
  const dst = [clone, ...clone.querySelectorAll("*")];
  const count = Math.min(src.length, dst.length);
  for (let i = 0; i < count; i++) {
    const cs = getComputedStyle(src[i]);
    let decl = "";
    for (const p of OVERLAY_SNIP_PROPS) { const v = cs.getPropertyValue(p); if (v) decl += `${p}:${v};`; }
    dst[i].setAttribute("style", decl);
  }
  clone.querySelectorAll("iframe, script, noscript, canvas").forEach((el) => el.remove()); // can't render in a data: SVG
  // Inline same-origin images; cross-origin can't be inlined without tainting the canvas → drop them.
  await Promise.all([...clone.querySelectorAll("img")].map(async (im) => {
    try {
      const s = im.getAttribute("src");
      if (!s || s.startsWith("data:")) return;
      const u = new URL(s, location.href);
      if (u.origin !== location.origin) { im.remove(); overlaySnipDropped++; return; }
      const blob = await (await fetch(u.href)).blob();
      im.setAttribute("src", await new Promise((res, rej) => {
        const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob);
      }));
    } catch { im.remove(); overlaySnipDropped++; }
  }));
  // Render the host standalone at the page width from its top-left; kill the full-bleed negative margin,
  // give it an opaque white page (the live host is transparent so the question shows through).
  clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  clone.style.width = `${w}px`;
  clone.style.maxWidth = "none";
  clone.style.margin = "0";
  clone.style.background = "#ffffff";
  const xhtml = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<foreignObject x="0" y="0" width="${w}" height="${h}">${xhtml}</foreignObject></svg>`;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      const safe = Math.max(1, Math.min(ratio, MAX_CANVAS_DIM / Math.max(w, h)));
      c.width = Math.max(1, Math.round(w * safe));
      c.height = Math.max(1, Math.round(h * safe));
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      resolve(c);
    };
    img.onerror = () => reject(new Error("could not rasterize the question"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}

// Snip raster resolution for the uploaded HTML page: match the CURRENT view
// (zoom × DPR) so a magnified region stays crisp, clamped to a sane range. The
// full-page raster is cached and rebuilt only when the effective ratio changes
// (e.g. after a zoom) or the page is re-measured.
const SNIP_RATIO_MIN = 2, SNIP_RATIO_MAX = 4;
let htmlSnipCanvas = null;   // full-page raster reused across snips until re-render
let htmlSnipCanvasRatio = 0; // the ratio it was built at

function htmlSnipRatio() {
  return Math.max(SNIP_RATIO_MIN, Math.min(SNIP_RATIO_MAX, Math.round(scale() * dpr())));
}

// Crop a region (page coords) out of a crisp full-page HTML raster, with the
// annotation overlay composited on top. Fixes blurry / empty HTML snips.
async function snipHtmlRegion(x0, y0, w, h) {
  const ratio = htmlSnipRatio();
  if (!htmlSnipCanvas || htmlSnipCanvasRatio !== ratio) {
    htmlSnipCanvas = await (document.body.classList.contains("overlay")
      ? overlayHostToCanvas(ratio) : htmlPageToCanvas(ratio));
    htmlSnipCanvasRatio = ratio;
  }
  const full = htmlSnipCanvas;
  const sc = full.width / basePage.w; // actual raster px per page unit (post-cap)
  // Pixel-snap the source rect to integer raster px and draw it 1:1 so the crop
  // is never bilinear-softened.
  const sx = Math.round(x0 * sc), sy = Math.round(y0 * sc);
  const sw = Math.max(1, Math.round(w * sc)), sh = Math.max(1, Math.round(h * sc));
  const out = document.createElement("canvas");
  out.width = sw;
  out.height = sh;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, sw, sh);
  ctx.drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh); // 1:1 — crisp, no resample
  // annotations live on the on-screen anno canvas at its own backing scale
  const anno = els.annoCanvas;
  if (anno.width > 1) {
    const a = anno.width / basePage.w;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(anno, x0 * a, y0 * a, w * a, h * a, 0, 0, sw, sh);
  }
  return out;
}

// One export page for the uploaded HTML: the page rasterized to an image, with
// annotations carried as crisp vector operators (not rasterized).
async function htmlPaperPages() {
  status("Rendering the page…");
  const canvas = await htmlPageToCanvas();
  return [{
    w: basePage.w, h: basePage.h,
    ops: app.export_pdf_ops(0),
    images: [{
      jpeg: await canvasJpegBytes(canvas),
      pxW: canvas.width, pxH: canvas.height,
      x: 0, y: 0, w: basePage.w, h: basePage.h,
    }],
  }];
}

// One export page per PDF page: the page raster at EXPORT_SCALE plus its
// annotations as crisp vectors (never rasterized).
async function pdfPaperPages() {
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
  return pages;
}

// Filesystem-safe timestamp (e.g. 2026-06-22T13-40-05) for download filenames.
function fileStamp() { return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); }

// Trigger a browser download of a blob under `filename`.
function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  a.click();
  // Defer the revoke — revoking in the same task as click() can cancel/zero-byte
  // the download in Firefox/Safari (a documented anti-pattern).
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function exportPdf() {
  if (!docOpen()) return;
  commitTextInput();
  clearTimeout(thumbTimer); // don't contend with exports for page renders
  els.btn.export.disabled = true;
  try {
    const pages = docMode === "html" ? await htmlPaperPages() : await pdfPaperPages();
    if (app.notes_len() > 0) {
      status("Adding your notes pages…");
      pages.push(...await buildNotesPages());
    }
    const blob = buildPdf(pages, {
      fontName: app.text_font_name(),
      gsName: app.highlight_gstate_name(),
    });
    downloadBlob(blob, `annotated-${fileStamp()}.pdf`);
    status("Annotated PDF exported.");
  } catch (e) {
    console.error("export failed:", e);
    status(`Export failed: ${e?.message || e}`);
  } finally {
    els.btn.export.disabled = false;
  }
}

// ---------- toolbar wiring ----------

els.btn.open.addEventListener("click", async () => {
  if (document.body.classList.contains("locked")) return; // #15: no file actions in the locked reference tool
  // Opening replaces the current document — guard unsaved work with a choice.
  if (docOpen() && (dirtySinceFileSave || app?.is_dirty())) {
    const choice = await confirmOpenDialog();
    if (choice === "cancel") return;
    // Open the new file in a fresh tab (this one keeps its work). The new tab lands
    // on ?open and pops the file picker for you (autoOpenIfRequested).
    if (choice === "newtab") { window.open(`${location.pathname}?open`, "_blank"); return; }
    if (choice === "save") downloadJson();
    // "discard" and "save" both fall through to the picker.
  }
  els.filePdf.click();
});
els.btn.save.addEventListener("click", downloadJson);
els.btn.load.addEventListener("click", () => els.fileJson.click());
els.btn.export.addEventListener("click", exportPdf);

// Open a picked file as HTML or PDF (by extension/MIME, HTML otherwise PDF).
function routeOpen(f) {
  if (/\.html?$/i.test(f.name) || f.type === "text/html") openHtml(f);
  else openPdf(f);
}

els.filePdf.addEventListener("change", () => {
  const f = els.filePdf.files[0];
  els.filePdf.value = "";
  if (f) routeOpen(f);
});

// ---- #15: reference-tool auto-open + lock (?file=) ----
// The exam page links this tool with ?file=<same-origin PL path> (e.g. /pl/course_instance/…/
// assessment/…/clientFilesAssessment/mt.pdf — route shape confirmed live). The path is passed
// WHOLE so PrairieLearn stays the single access-control authority over the exam file (nothing is
// copied to a course-wide-readable location). The lock is AFFORDANCE-ONLY by accepted design:
// typing the bare index.html URL yields the normal tool; PL still gates the file itself. The
// locked tool is a pure reference sheet (user decision): every drawing tool + snip-to-clipboard
// work, but Open/Resume/Save/Export are all hidden — snip-to-clipboard, then paste into the PL
// question's notes, carries reference material across as IN-SESSION scratch (notes are NOT saved
// with the answer — serializeAnnotations strips them; true note-persistence is a separate batch).
function refFileRequest() {
  const raw = new URLSearchParams(location.search).get("file");
  if (!raw) return null;
  const LEAF = /^[A-Za-z0-9_.\-]+\.(pdf|html?)$/i;
  // Tier 2: bare filename → a standing reference shipped in the bundle's refs/ folder.
  if (!raw.includes("/") && !raw.includes("%") && LEAF.test(raw)) {
    return { url: new URL(`refs/${raw}`, location.href).href, name: raw };
  }
  // Tier 1: a full same-origin PL path. Every step is mandatory; any failure → null (the caller
  // shows a kind message and leaves the normal, unlocked tool).
  try {
    if (!raw.startsWith("/") || raw.startsWith("//")) return null; // kills schemes + protocol-relative
    const u = new URL(raw, location.origin);
    if (u.origin !== location.origin) return null;
    // Traversal checks run on the RAW pathname AND its decoded form: %252e%252e survives one
    // decode as a literal %2e%2e (no ".." to find) while the server decodes again. decodeURIComponent
    // throwing (malformed escapes) is itself a rejection.
    for (const p of [u.pathname, decodeURIComponent(u.pathname)]) {
      if (!p.startsWith("/pl/") || p.includes("\\")) return null;
      // Segments after the leading slash: no "..", no ".", no empties ("//" or a trailing slash).
      if (p.split("/").slice(1).some((seg) => seg === ".." || seg === "." || seg === "")) return null;
    }
    if (!/\/clientFiles(Course|Assessment|Question)\//.test(u.pathname)) return null;
    const leaf = decodeURIComponent(u.pathname.split("/").pop());
    if (!LEAF.test(leaf)) return null;
    return { url: u.href, name: leaf };
  } catch {
    return null;
  }
}

async function openReferenceFile() {
  const req = refFileRequest();
  if (!req) {
    status("That reference link isn't valid — you can open a file yourself with the Open button.");
    return;
  }
  document.body.classList.add("locked"); // before any await: no flash of the soon-hidden file actions
  try {
    status(`Loading ${req.name}…`);
    const r = await fetch(req.url); // same-origin credentialed — PL enforces its own access windows
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { httpStatus: r.status });
    const blob = await r.blob();
    const fallbackType = /\.html?$/i.test(req.name) ? "text/html" : "application/pdf";
    routeOpen(new File([blob], req.name, { type: blob.type || fallbackType }));
  } catch (e) {
    // A dead locked tool would strand the student mid-exam — unlock and fall back to the normal UI.
    document.body.classList.remove("locked");
    status(e?.httpStatus === 403
      ? "That reference isn't available yet — it may unlock when the assessment opens."
      : "The reference file couldn't be loaded — you can open a file yourself with the Open button.");
  }
}

// "Open in a new tab" lands here on ?open: pop the file picker immediately. A fresh
// tab may need a click before the browser will show a file dialog — if so, the Open
// button is focused and pulsing as an obvious one-click fallback.
function autoOpenIfRequested() {
  if (document.body.classList.contains("locked")) return; // the locked reference tool has no picker
  if (!new URLSearchParams(location.search).has("open")) return;
  history.replaceState({}, "", location.pathname); // don't re-trigger on reload
  els.btn.open.focus();
  els.btn.open.classList.add("attention");
  els.btn.open.addEventListener("click", () => els.btn.open.classList.remove("attention"), { once: true });
  try { els.filePdf.click(); } catch { /* file dialog needs a user gesture in some browsers */ }
}

els.fileJson.addEventListener("change", () => {
  const f = els.fileJson.files[0];
  els.fileJson.value = "";
  if (document.body.classList.contains("locked")) return; // #15: the JSON picker is hidden; belt for stragglers
  if (f) loadJsonFile(f);
});

// Mirror the visual selected/toggled state into aria-pressed so assistive tech
// announces these controls as toggle buttons that are on or off. Called after
// any change to the toolbar / view toggles / segmented control.
function syncAria() {
  const set = (el, on) => el && el.setAttribute("aria-pressed", on ? "true" : "false");
  railRoot.querySelectorAll(".tool").forEach((t) => set(t, t.classList.contains("active")));
  railRoot.querySelectorAll("#colors .swatch").forEach((s) => set(s, s.classList.contains("active")));
  railRoot.querySelectorAll("#widths .width").forEach((w) => set(w, w.classList.contains("active")));
  set(els.btn.palette, els.btn.palette.classList.contains("active"));
  set(els.btn.big, document.body.classList.contains("big"));
  set(els.btn.thumbs, !els.thumbs.hidden);
  set(els.btn.notes, !els.notesPane.hidden); // the toolbar Notes button reflects shown vs fully hidden
  set(els.seg.paged, els.seg.paged.classList.contains("active"));
  set(els.seg.cont, els.seg.cont.classList.contains("active"));
}

for (const b of document.querySelectorAll(".tool")) {
  b.addEventListener("click", () => {
    if (!b.dataset.tool) return; // not a mode (e.g. the Undo/Redo rail actions reuse .tool styling)
    commitTextInput();
    const name = b.dataset.tool;
    if (JS_TOOLS.has(name)) {
      app.set_tool("select"); // neutral: core draws nothing on pointer events
    } else if (!app.set_tool(name)) {
      return;
    }
    railRoot.querySelectorAll(".tool").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    hideRegionButton();
    if (name !== "select") setSelection(-1);
    els.annoCanvas.style.cursor = name === "snip" ? "crosshair" : "";
    updateContextBar(name);
    syncAria();
  });
}

// About closers exposed at MODULE scope so the Phase-1 reparent (B3-4) can ALSO register them in the
// PARENT realm — post-flip, About clicks/keys fire on the parent document, not the iframe. No-ops until
// the block below assigns them.
let closeAbout = () => {};
let closeAboutOnOutsideClick = () => {};
let closeAboutOnEscape = () => {};
// ---- About ("i"): a small anchored disclosure, NOT the Help modal — the modal centres in the full
// (question-tall) iframe and can open below the fold on a long overlay question. Plain aria-expanded
// (no aria-haspopup, which would announce a menu); outside-click + Escape close, focus returns.
{
  const aboutBtn = $("btn-about"), aboutPop = $("about-popover");
  closeAbout = () => {
    if (!aboutPop || aboutPop.hidden) return;
    const hadFocus = aboutPop.contains(railHostDoc.activeElement); // B3-4: realm-correct (iframe OR parent post-flip)
    aboutPop.hidden = true;
    aboutBtn.setAttribute("aria-expanded", "false");
    if (hadFocus) aboutBtn.focus();
  };
  if (aboutBtn && aboutPop) {
    // No stopPropagation: the click must reach the document closers so opening About
    // auto-closes the More popover (each closer already excludes its own button).
    aboutBtn.addEventListener("click", () => {
      const open = aboutPop.hidden;
      aboutPop.hidden = !open;
      aboutBtn.setAttribute("aria-expanded", String(open));
    });
    closeAboutOnOutsideClick = (e) => {
      if (!aboutPop.hidden && !aboutPop.contains(e.target) && !aboutBtn.contains(e.target)) closeAbout();
    };
    // Consume the Escape that closes the popover (this listener registers before the main keydown
    // handler): dismissing About must not ALSO clear the selection / cancel an armed snip (C10).
    // helpOverlay.hidden guard: with the Help modal OPEN above a forgotten popover, Esc must close
    // the modal (main's branch), not invisibly eat the keypress here. (helpOverlay is declared later
    // in the module — fine: this body only runs on keypresses, long after module evaluation.)
    closeAboutOnEscape = (e) => {
      if (e.key === "Escape" && !aboutPop.hidden && helpOverlay.hidden) { closeAbout(); e.stopImmediatePropagation(); }
    };
    document.addEventListener("click", closeAboutOnOutsideClick);
    document.addEventListener("keydown", closeAboutOnEscape);
  }
}

// Tools that use a colour. Width applies to freehand + stroked shapes only
// (not the text note, which has its own size, nor the solid shade box).
const MARKING_TOOLS = new Set([
  "pen", "highlighter", "text", "tick", "cross", "circle", "arrow", "rect", "fillrect",
]);
const WIDTH_TOOLS = new Set(["pen", "highlighter", "tick", "cross", "circle", "arrow", "rect"]);

// Show the contextual colour/thickness bar only when a marking tool is active
// and a document is open — so it never distracts during select/snip/etc.
function updateContextBar(tool) {
  // Overlay folds the colour strip into the one merged tool bar → keep it persistent (no reflow
  // as tools change). Docked behaves the same; floating stays contextual to the marking tools.
  const overlay = document.body.classList.contains("overlay");
  const show = docOpen() && (overlay || isCbarDocked() || MARKING_TOOLS.has(tool));
  els.contextBar.hidden = !show;
  // The colorblind-safe palette toggle now lives inside this bar, so it shows
  // and hides with it automatically (only relevant while choosing colours).
  if (show) {
    const w = overlay || WIDTH_TOOLS.has(tool); // keep the width chips' slot fixed in overlay (no reflow)
    els.widths.style.display = w ? "flex" : "none";
    els.widthDivider.style.display = w ? "" : "none";
    if (!overlay) clampContextBar(); // ensure a dragged bar is on-screen now that it's visible
  }
}

for (const b of document.querySelectorAll("#widths .width")) {
  b.addEventListener("click", () => {
    if (!app.set_pen_width(b.dataset.width)) return;
    railRoot.querySelectorAll("#widths .width").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    syncAria();
  });
}

for (const s of document.querySelectorAll("#colors .swatch")) {
  s.addEventListener("click", () => {
    if (!app.set_color(s.dataset.color)) return;
    railRoot.querySelectorAll("#colors .swatch").forEach((x) => x.classList.remove("active"));
    s.classList.add("active");
    syncAria();
  });
}

els.btn.undo.addEventListener("click", () => { app.undo(); redrawAnnotations(); });
els.btn.redo.addEventListener("click", () => { app.redo(); redrawAnnotations(); });
function goToPage(n, scrollTo = "top") {
  if (!pdfDoc) return;
  const clamped = Math.min(Math.max(0, n), pdfDoc.numPages - 1);
  if (isContinuous()) {
    // Scroll that page sheet into view; the scroll-sync updates readout/thumb.
    scrollToContPage(clamped);
    els.pageInput.value = String(clamped + 1);
    return;
  }
  if (clamped === pageNum) {
    els.pageInput.value = String(pageNum + 1);
    return;
  }
  pageNum = clamped;
  renderPage().then(() => {
    els.viewer.scrollTop = scrollTo === "bottom" ? els.viewer.scrollHeight : 0;
  });
}

const navFrom = () => (isContinuous() ? visiblePage() : pageNum);
els.btn.prev.addEventListener("click", () => goToPage(navFrom() - 1));
els.btn.next.addEventListener("click", () => goToPage(navFrom() + 1));

// NB: we deliberately do NOT intercept the wheel to flip pages. Hijacking the
// wheel ("scroll-jacking") fights the trackpad's native momentum/acceleration
// and breaks the "I scroll, the page moves" contract — it was the root cause of
// the bad scroll feel. Single-page mode changes pages only through real
// controls (prev/next, the page input, thumbnails, PageUp/Down); for fluid
// reading there is the continuous-scroll mode, which scrolls natively. See
// CLAUDE.md section 10.

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
  renderDoc();
}
els.btn.zoomIn.addEventListener("click", () => nudgeZoom(ZOOM_STEP));
els.btn.zoomOut.addEventListener("click", () => nudgeZoom(1 / ZOOM_STEP));
els.zoomSelect.addEventListener("change", () => {
  zoomMode = els.zoomSelect.value;
  renderDoc();
});

// Trackpad pinch / Ctrl+wheel zooms; a plain wheel stays fully native (never scroll-jack, §10).
els.viewer.addEventListener("wheel", (ev) => {
  // Overlay is locked at 1:1 (the live question behind it can't zoom with us; zooming would misalign the
  // canvas + break snip coordinate mapping). The zoom UI is already CSS-hidden there.
  if (!docOpen() || document.body.classList.contains("overlay") || !(ev.ctrlKey || ev.metaKey)) return;
  ev.preventDefault();
  nudgeZoom(ev.deltaY < 0 ? 1.08 : 1 / 1.08);
}, { passive: false });

// Single-page <-> continuous scroll (PDF only) via a labelled segmented
// control. Default is single-page. The active segment is highlighted.
function syncScrollUI() {
  const on = scrollMode === "continuous";
  els.seg.paged.classList.toggle("active", !on);
  els.seg.cont.classList.toggle("active", on);
  syncAria();
}
function setScrollEnabled(enabled) {
  els.seg.paged.disabled = !enabled;
  els.seg.cont.disabled = !enabled;
}
async function setScrollMode(mode) {
  if (docMode !== "pdf" || !pdfDoc || mode === scrollMode) return;
  commitTextInput();
  setSelection(-1);
  if (mode === "continuous") {
    scrollMode = "continuous";
    syncScrollUI();
    await renderContinuous();
    goToPage(pageNum);          // bring the page you were on into view
  } else {
    pageNum = visiblePage();    // keep the page you were reading
    scrollMode = "paged";
    syncScrollUI();
    await renderPage();
  }
}
els.seg.paged.addEventListener("click", () => setScrollMode("paged"));
els.seg.cont.addEventListener("click", () => setScrollMode("continuous"));

// Re-render on resize: fit modes track the window, and devicePixelRatio
// changes (browser zoom) re-rasterize so the page never goes fuzzy.
// Re-fit the document whenever the viewer AREA changes size — not just on a window
// resize, but also when the notes-pane splitter is dragged or the notes/thumbnails
// panels are toggled. A ResizeObserver on #stage catches them all: #stage is a flex
// sibling of the notes pane, so it grows/shrinks as the pane does, and the page
// re-scales to the new width instead of spilling behind the divider. HTML only
// recomputes its scale (annotations stay aligned); PDFs re-render for fit modes /
// dpr. Coalesced to one re-fit per frame, never overlapping a PDF render, so a
// live splitter drag tracks smoothly without thrashing.
let refitPending = false;
function scheduleRefit() {
  if (refitPending) return; // a re-fit is already queued / in flight — coalesce
  refitPending = true;
  requestAnimationFrame(async () => {
    try {
      if (docOpen()) { await renderDoc(); clampContextBar(); }
    } finally {
      refitPending = false;
    }
  });
}
new ResizeObserver(scheduleRefit).observe($("stage"));

const TOOL_KEYS = {
  v: "select", p: "pen", h: "highlighter", t: "text", e: "eraser",
  s: "snip",
};

// B3-5: named so the Phase-1 reparent can mirror it onto the PARENT document (post-flip, shortcut keys
// fire there when focus is on a parent-side rail button). Events don't cross the iframe boundary, so the
// two registrations never double-fire. The typing-field early-return below also ignores PL's own inputs.
const mainKeydown = (ev) => {
  // Never hijack keys while the user is typing in any field (incl. notes). DUCK-TYPE, not `instanceof
  // Element` (review R-1): this handler is mirrored onto the PARENT document (B3-5), where a PL input's
  // target is a parent-realm Element that fails the iframe's `instanceof Element` — which would silently
  // skip this guard and hijack PL's own answer fields (Ctrl+Z, "?", Backspace, tool-letter keys).
  if (ev.target && typeof ev.target.matches === "function" &&
      ev.target.matches("input, textarea, select, [contenteditable]")) {
    return;
  }
  if (READONLY) return; // no tool/edit/undo shortcuts when viewing a saved submission
  // When the shortcuts overlay is open, it captures Esc / ? and suppresses the
  // rest so nothing fires behind the modal.
  if (!helpOverlay.hidden) {
    if (ev.key === "Escape" || ev.key === "?") {
      ev.preventDefault();
      // Consume: the later-registered More closers would otherwise ALSO close their popover on the
      // same press when Help was opened via "?" over an open menu — one layer per Escape (C10).
      ev.stopImmediatePropagation();
      toggleHelp(false);
    }
    return;
  }
  // A pop-up dialog (clipping lightbox, unsaved-work prompt) owns the keyboard
  // while open — its own handlers take Enter/Esc/Tab; don't let
  // shortcuts, deletes or page-nav fire on the document behind it.
  if (document.querySelector(".modal-overlay:not([hidden])")) return;
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
    // In embed mode the work saves with the PL submission, not to a downloaded file.
    // Intercept the reflexive Cmd/Ctrl+S so it doesn't litter Downloads with a junk .json.
    if (document.body.classList.contains("embedded")) {
      status("Your marks on the question are saved with your answer; notes are scratch and aren't saved.");
    } else if (document.body.classList.contains("locked")) {
      // Only PDF references autosave (by sha, restored on reopen); HTML has no stable identity, so
      // don't promise persistence there — point the student at snipping into their answer instead.
      status(docMode === "pdf"
        ? "This reference sheet keeps your scribbles automatically — nothing to save."
        : "Scribble here as scratch — snip a region to copy it, then paste into your answer's notes.");
    } else if (!els.btn.save.disabled) {
      downloadJson();
    }
  } else if ((ev.key === "Delete" || ev.key === "Backspace")) {
    if (selectedIds.size > 0) {
      ev.preventDefault();
      // One item → the plain path; a multi-selection → one batched (single-undo) delete.
      if (selectedIds.size === 1) app.delete_item(pageNum, [...selectedIds][0]);
      else app.delete_items(pageNum, [...selectedIds]);
      setSelection(-1);
    } else if (activeSketch && activeSketch.selected >= 0) {
      ev.preventDefault();
      activeSketch.remove();
    }
  } else if (ev.key === "Escape") {
    // An open More popover owns this Escape — its closer (registered after this handler) will
    // dismiss it; acting here too would also clear the selection / cancel an armed snip (C10).
    // (railHostDoc: the popover lives in the parent document once Phase 1 reparents the rail.)
    const morePop = railRoot.querySelector("#more-popover");
    if (morePop && !morePop.hidden) return;
    if (snip) { snip = null; redrawAnnotations(); } // cancel an in-progress snip
    if (marquee) { marquee = null; redrawAnnotations(); } // cancel an in-progress marquee
    if (selectedIds.size > 0) setSelection(-1);
    if (activeSketch && activeSketch.selected >= 0) {
      activeSketch.selected = -1;
      activeSketch.draw();
    }
  } else if (!mod && ev.key === "?") {
    ev.preventDefault();
    toggleHelp(true);
  } else if (!mod && TOOL_KEYS[key]) {
    const btn = railRoot.querySelector(`[data-tool="${TOOL_KEYS[key]}"]`);
    if (btn && btn.offsetParent !== null) btn.click(); // skip tools hidden in this mode (e.g. Snip in overlay)
  } else if (ev.key === "PageDown" || ev.key === "PageUp") {
    if (!pdfDoc || isContinuous()) return; // continuous: let the browser scroll
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
};
document.addEventListener("keydown", mainKeydown);

window.addEventListener("beforeunload", (ev) => {
  // Warn only about un-serialized changes. Standalone: unsaved drawing (is_dirty) or unsaved-to-file
  // (dirtySinceFileSave). Embed: the 1.5s save loop writes strokes into the hidden form input and
  // clears is_dirty, after which PrairieLearn's OWN unsaved-form warning takes over — so we do NOT
  // add a second, iframe-level warning that could never be cleared from inside the iframe.
  if (READONLY) return; // a read-only submission view has nothing to lose
  if (dirtySinceFileSave || app?.is_dirty()) {
    ev.preventDefault();
    ev.returnValue = "";
  }
});

// ---------- notes pane (working document) ----------
// Blocks live in the Rust document; this renders them. Text uses textareas
// (native undo); clippings render via blob: URLs (never HTML from content).

function blockActions(i, total) {
  const wrap = document.createElement("div");
  wrap.className = "block-actions";
  // Always render ↑ ↓ ✕ in the same slots (disable the ones that don't apply at
  // the ends) so a given control never jumps position between blocks.
  const mk = (label, title, fn, disabled) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    b.disabled = !!disabled;
    if (!disabled) b.addEventListener("click", fn);
    wrap.appendChild(b);
  };
  mk("↑", "Move up", () => { app.move_note(i, -1); renderNotes(); }, i === 0);
  mk("↓", "Move down", () => { app.move_note(i, 1); renderNotes(); }, i === total - 1);
  // E5: deleting a whole block is outside the undo stack (and clears sketch history) — unrecoverable.
  // Confirm before removing a NON-EMPTY block; empty blocks delete with no nag.
  mk("✕", "Delete block", async () => {
    if (noteDeleteNeedsConfirm(i)) {
      const ok = await confirmDialog({
        title: "Delete this note block?",
        body: "This removes the block and can't be undone.",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
    }
    app.remove_note(i);
    renderNotes();
  }, false);
  return wrap;
}

// A note block is worth a delete confirm only when it actually holds work: a clipping (has an image),
// a sketch with any drawn item (sketch_export_ops is empty for a blank sketch), or non-empty text.
function noteDeleteNeedsConfirm(i) {
  const kind = app.note_kind(i);
  if (kind === "clipping") return true;
  if (kind === "sketch") return app.sketch_export_ops(i) !== "";
  if (kind === "text") return app.note_text(i).trim() !== "";
  return false;
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
    this.userScale = null; // null = auto-fit; otherwise the user's drag-resized scale
    this.layout();
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", (e) => this.up(e));
    // Filtered like down/up: a rejected second contact's cancel must not revert the owner's stroke.
    canvas.addEventListener("pointercancel", (e) => { if (!this.state || e.pointerId === this.state.pid) this.cancel(); });
    this.wireResize(canvas.parentElement.querySelector(".sketch-resize"));
    this.draw();
  }

  layout() {
    const avail = Math.max(120, els.notesList.clientWidth - 28);
    const auto = Math.min(avail / this.w, 2);
    // A user-dragged scale overrides the auto-fit (clamped to a sane range).
    this.scale = this.userScale ? Math.max(SKETCH_SCALE_MIN, Math.min(SKETCH_SCALE_MAX,this.userScale)) : auto;
    const r = dpr();
    this.canvas.width = Math.round(this.w * this.scale * r);
    this.canvas.height = Math.round(this.h * this.scale * r);
    this.canvas.style.width = `${Math.round(this.w * this.scale)}px`;
    this.canvas.style.height = `${Math.round(this.h * this.scale)}px`;
  }

  // Drag the corner handle to resize the sketch on screen (display scale; the
  // drawing's own coordinate space is unchanged).
  wireResize(handle) {
    if (!handle) return;
    let rz = null;
    handle.addEventListener("pointerdown", (e) => {
      if (rz) return; // one resize at a time — a second contact must not reassign it
      rz = { pid: e.pointerId, x: e.clientX, w: this.w * this.scale };
      // ?. only guards the method's existence — setPointerCapture throws NotFoundError for an
      // already-gone pointer, which would abort the handler mid-state-change.
      try { handle.setPointerCapture(e.pointerId); } catch { /* capture is an optimization */ }
      e.preventDefault();
      e.stopPropagation();
    });
    handle.addEventListener("pointermove", (e) => {
      if (!rz || e.pointerId !== rz.pid) return;
      if (!(e.buttons & 1)) { rz = null; return; } // owning press ended unseen — stop resizing
      this.userScale = Math.max(SKETCH_SCALE_MIN, Math.min(SKETCH_SCALE_MAX,(rz.w + (e.clientX - rz.x)) / this.w));
      this.layout();
      this.draw();
    });
    const end = (e) => { if (rz && e.pointerId === rz.pid) rz = null; };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
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
      if (bb.length === 4) drawSelectionBox(ctx, bb, handlePoints(bb), this.scale, dpr());
    }
  }

  handleAt(x, y) {
    if (this.selected < 0) return -1;
    const bb = app.item_bbox_of_sketch(this.note, this.selected);
    if (bb.length !== 4) return -1;
    const tol = (HANDLE_PX + 3) / this.scale;
    return handlePoints(bb).findIndex(([hx, hy]) => Math.abs(x - hx) <= tol && Math.abs(y - hy) <= tol);
  }

  down(ev) {
    if (ev.button !== 0 || READONLY) return; // read-only: sketch notes are not editable either
    // Palm rejection, mirroring the main canvas (app.js onAnnoPointerDown): without it a palm that
    // lands FIRST arms the gesture and the one-at-a-time guard below then blocks the pen entirely.
    if (ev.pointerType === "touch" && (penActive || Math.max(ev.width || 0, ev.height || 0) > PALM_MAX_PX)) return;
    if (this.state) return; // one gesture at a time — a second contact must not reassign it mid-stroke
    activeSketch = this;       // Delete/Escape route here
    setSelection(-1);          // clear any PDF selection
    const tool = activeTool();
    const [x, y] = this.coords(ev);
    try { this.canvas.setPointerCapture(ev.pointerId); } catch { /* pointer already gone — capture is an optimization */ }
    if (tool === "text") {
      ev.preventDefault();
      this.openText(ev, x, y, "", -1);
      return;
    }
    if (tool === "select") {
      const h = this.handleAt(x, y);
      if (h >= 0 && app.begin_item_drag_sketch(this.note, this.selected, x, y)) {
        const bb = app.item_bbox_of_sketch(this.note, this.selected);
        this.state = { mode: "resize", pid: ev.pointerId, anchor: handlePoints(bb)[(h + 2) % 4], bb,
                       uniform: app.item_kind_sketch(this.note, this.selected) !== "shape" };
        return;
      }
      const id = app.find_item_sketch(this.note, x, y);
      this.selected = id;
      if (id >= 0 && app.begin_item_drag_sketch(this.note, id, x, y)) {
        this.state = { mode: "move", pid: ev.pointerId, id, sx: x, sy: y, moved: false };
      }
      this.draw();
      return;
    }
    // drawing tools (snip is PDF-only and ignored on sketches)
    if (tool === "snip") return;
    this.state = { mode: "draw", pid: ev.pointerId };
    app.pointer_down_sketch(this.note, x, y, ERASE_RADIUS_PX / this.scale);
    this.draw();
  }

  move(ev) {
    if (!this.state) return;
    if (ev.pointerId !== this.state.pid) return; // only the arming contact drives the sketch gesture
    if (!(ev.buttons & 1)) { this.cancel(); return; } // owning press ended unseen — cancel, don't keep inking
    const [x, y] = this.coords(ev);
    if (this.state.mode === "resize") {
      const [ax, ay] = this.state.anchor;
      const [sx, sy] = resizeScale(this.state.bb, ax, ay, x, y, this.state.uniform);
      app.scale_dragged_item(ax, ay, sx, sy);
    } else if (this.state.mode === "move") {
      if (Math.hypot(x - this.state.sx, y - this.state.sy) > MOVE_THRESHOLD_PX / this.scale) this.state.moved = true;
      if (this.state.moved) app.drag_item(x, y);
    } else if (this.state.mode === "draw") {
      app.pointer_move(x, y, ERASE_RADIUS_PX / this.scale);
    }
    this.draw();
  }

  up(ev) {
    this.canvas.releasePointerCapture?.(ev.pointerId);
    if (this.state && ev.pointerId !== this.state.pid) return; // only the arming contact ends the gesture
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
    if (READONLY) return; // no text editing on a saved submission (covers the dblclick-to-edit path)
    const input = document.createElement("textarea");
    input.rows = 1;
    input.maxLength = 500;
    input.value = initial;
    input.className = "sketch-text-input";
    input.style.left = `${x * this.scale}px`;
    input.style.top = `${y * this.scale - 18}px`;
    this.canvas.parentElement.appendChild(input);
    autoGrow(input);
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
    input.addEventListener("input", () => autoGrow(input));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
      else if (e.key === "Escape") input.remove();
      e.stopPropagation();
    });
    input.addEventListener("blur", commit);
  }
}

let sketchViews = [];
let activeSketch = null; // most-recently-interacted sketch (for Delete/Escape)

// Move a note from one index to another via the ±1 move_note primitive.
function reorderNote(from, to) {
  if (from === to || from < 0 || to < 0) return;
  let f = from;
  if (to > from) while (f < to) { app.move_note(f, 1); f++; }
  else while (f > to) { app.move_note(f, -1); f--; }
  renderNotes();
}

// A grip that makes its parent .note-block draggable only while grabbed (so the
// text fields inside stay normally selectable).
function dragHandle(block) {
  const h = document.createElement("div");
  h.className = "drag-handle";
  h.title = "Drag to reorder";
  h.textContent = "⠿";
  h.addEventListener("mousedown", () => {
    block.draggable = true;
    // Clear draggable once the mouse is released even if no drag happened,
    // otherwise a plain grip-click would leave the block draggable and break
    // text selection inside it. (A real drag also clears via dragend below.)
    const reset = () => { block.draggable = false; document.removeEventListener("mouseup", reset); };
    document.addEventListener("mouseup", reset);
  });
  block.addEventListener("dragend", () => { block.draggable = false; });
  return h;
}

let dragFromIndex = -1;

// The draggable wrapper shared by every note block (reorder handlers included).
function newNoteBlock(i) {
  const div = document.createElement("div");
  div.className = "note-block";
  div.dataset.idx = String(i);
  div.appendChild(dragHandle(div));
  div.addEventListener("dragstart", (e) => {
    dragFromIndex = i;
    div.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  div.addEventListener("dragend", () => {
    div.classList.remove("dragging");
    els.notesList.querySelectorAll(".note-block.drop-before,.note-block.drop-after")
      .forEach((b) => b.classList.remove("drop-before", "drop-after"));
  });
  return div;
}

// A sketch note: a resizable scratch canvas. Returns the canvas so the caller
// creates its SketchView AFTER the block is attached to the DOM (it measures the
// live element).
function buildSketchBlock(div) {
  const holder = document.createElement("div");
  holder.className = "sketch-holder";
  const canvas = document.createElement("canvas");
  canvas.className = "sketch-canvas";
  const grip = document.createElement("div");
  grip.className = "sketch-resize";
  grip.title = "Drag to resize the canvas";
  holder.append(canvas, grip);
  div.appendChild(holder);
  return canvas;
}

// A text note: an auto-growing editable textarea bound to the note text.
function buildTextBlock(div, i) {
  const ta = document.createElement("textarea");
  ta.value = app.note_text(i);
  ta.readOnly = READONLY; // a saved submission's notes are not locally editable
  ta.placeholder = "Write a note…";
  ta.addEventListener("input", () => {
    app.update_note_text(i, ta.value);
    autoGrow(ta);
  });
  div.appendChild(ta);
  queueMicrotask(() => autoGrow(ta));
}

// A clipping note: the snipped image (click to jump to its source page) plus an
// auto-growing caption.
// Copy a notes clipping (its blob-URL PNG) to the system clipboard, with brief
// in-button feedback. Needs a secure context (localhost / https) and a user gesture.
async function copyImageToClipboard(src, btn) {
  const label = btn && btn.textContent;
  try {
    const blob = await fetch(src).then((r) => r.blob());
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    if (btn) { btn.textContent = "Copied ✓"; setTimeout(() => { btn.textContent = label; }, 1400); }
  } catch {
    status("Couldn't copy the image — the browser blocked clipboard access.");
  }
}

// ---- #12: paste an image INTO the notes — the landing side of the reference-tab snip flow ----
// Security (§7): blob-only, decoded to pixels and re-encoded by OUR canvas (strips EXIF/polyglots);
// clipboard text/html flavors are never parsed; Rust re-validates the PNG on insert and on load.
const PASTE_B64_MAX = 2 * 1024 * 1024;   // mirror of Rust's MAX_CLIPPING_B64 — friendly-message the cap here
const PASTE_BLOB_MAX = 32 * 1024 * 1024; // absurd-input early guard before any decode work
const PASTE_EDGE_START = 2000;           // long-edge target for the first encode attempt

async function pasteBlobToNotes(blob) {
  if (!docOpen() || READONLY) return;
  if (!blob || !/^image\//.test(blob.type)) {
    status("No image on the clipboard — snip something in the reference tab first.");
    return;
  }
  if (blob.size > PASTE_BLOB_MAX) {
    status("That image is too large to paste — crop it smaller and try again.");
    return;
  }
  let bitmap = null, imgUrl = null;
  try {
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      // <img>-decode fallback (also rasterizes SVG): scriptless, blob-URL only, revoked in finally.
      imgUrl = URL.createObjectURL(blob);
      bitmap = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error("decode"));
        im.src = imgUrl;
      });
    }
    const w0 = bitmap.naturalWidth || bitmap.width, h0 = bitmap.naturalHeight || bitmap.height;
    if (!(w0 > 0 && h0 > 0)) throw new Error("decode");
    // Downscale ladder: long edge 2000px, then ×0.7 steps until the PNG fits the per-clipping cap
    // (a retina screenshot exceeds it on the first try). Floor at ~300px — below that, tell the
    // student to crop instead of pasting mush.
    let edge = Math.min(PASTE_EDGE_START, Math.max(w0, h0));
    for (;;) {
      const scale = edge / Math.max(w0, h0);
      const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
      const b64 = canvas.toDataURL("image/png").split(",")[1];
      if (b64.length <= PASTE_B64_MAX) {
        app.add_pasted_clipping(b64, "", w, h); // display at the encoded size (CSS px at scale 1)
        renderNotes();
        revealNotes();
        status("Image pasted into your notes.");
        return;
      }
      if (edge <= 300) {
        status("That image is too detailed to paste — snip or crop a smaller region.");
        return;
      }
      edge = Math.round(edge * 0.7);
    }
  } catch (e) {
    // Rust rejections (notes full, bad PNG) surface here too — show its message, not a stack.
    status(typeof e === "string" ? e
      : e?.message === "decode" ? "Couldn't read that image."
      : `Couldn't paste: ${e?.message || e}`);
  } finally {
    bitmap?.close?.();
    if (imgUrl) URL.revokeObjectURL(imgUrl);
  }
}

// Button path: clipboard.read() must be called SYNCHRONOUSLY in the click handler — WebKit
// consumes the user activation at the first await, and the permission prompt needs it.
$("btn-paste-img")?.addEventListener("click", () => {
  if (!docOpen() || READONLY) return;
  if (!navigator.clipboard?.read) {
    status("This browser can't read the clipboard from a button — click the notes and press Ctrl/⌘+V instead.");
    return;
  }
  navigator.clipboard.read().then(async (items) => {
    for (const item of items) {
      const type = item.types.find((t) => t === "image/png") || item.types.find((t) => /^image\//.test(t));
      if (type) { await pasteBlobToNotes(await item.getType(type)); return; }
    }
    status("No image on the clipboard — snip something in the reference tab first.");
  }).catch(() => {
    status("Clipboard access was blocked — click the notes and press Ctrl/⌘+V instead.");
  });
});

// Ctrl/⌘+V accelerator. A text paste into a caption/text field stays native (no preventDefault);
// an IMAGE paste is ours wherever it lands — even in a textarea, where native would no-op anyway.
document.addEventListener("paste", (e) => {
  if (!docOpen() || READONLY) return;
  if (document.querySelector(".modal-overlay:not([hidden])")) return; // a dialog owns the keyboard
  const items = [...(e.clipboardData?.items || [])];
  const imgItem = items.find((it) => it.kind === "file" && /^image\//.test(it.type));
  const inTextField = e.target && typeof e.target.matches === "function" &&
    e.target.matches("input, textarea, select, [contenteditable]"); // duck-type (review R-1, realm-safe)
  if (inTextField && items.some((it) => it.kind === "string" && it.type === "text/plain")) return;
  if (!imgItem) return;
  e.preventDefault();
  pasteBlobToNotes(imgItem.getAsFile());
});

function buildClippingBlock(div, i) {
  const img = document.createElement("img");
  img.src = b64ToBlobUrl(app.note_png(i));
  img.dataset.blob = "1";
  img.alt = "clipping";
  // Render at the SOURCE on-screen size (stored disp width), not the 2-4x high-DPI raster's natural size,
  // so a snipped line looks the size it was on the page. Absent (old files / -1) → natural size + the caps.
  const dispW = app.note_disp_w(i);
  if (dispW > 0) img.style.width = `${dispW}px`;
  const srcPage = app.note_source_page(i);
  img.style.cursor = "zoom-in";
  img.tabIndex = 0;
  img.setAttribute("role", "button");
  const enlargeLabel = (srcPage >= 0 && docMode === "pdf")
    ? `Enlarge clipping (snipped from page ${srcPage + 1})` : "Enlarge clipping";
  img.title = enlargeLabel;
  img.setAttribute("aria-label", enlargeLabel);
  // Give the lightbox its OWN blob URL (not the notes-list img.src) so a
  // renderNotes() that revokes the list URLs can't blank the open lightbox.
  const openLightbox = () => showClippingLightbox(b64ToBlobUrl(app.note_png(i)), srcPage, docMode, goToPage);
  img.addEventListener("click", openLightbox);
  img.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openLightbox(); }
  });
  // Caption wraps to fit the width (auto-growing) rather than truncating.
  const cap = document.createElement("textarea");
  cap.className = "caption";
  cap.readOnly = READONLY; // a saved submission's captions are not locally editable
  cap.maxLength = 300;
  cap.rows = 1;
  cap.placeholder = "Caption…";
  cap.value = app.note_caption(i);
  cap.addEventListener("input", () => { app.update_note_caption(i, cap.value); autoGrow(cap); });
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "clip-copy";
  copy.textContent = "Copy image";
  copy.title = "Copy this image to the clipboard";
  copy.addEventListener("click", () => copyImageToClipboard(img.src, copy));
  // Wrap the image so a small "×" can remove JUST the image (keeping the caption as a text note) — for when
  // the student only wanted the recognised text, not the picture. Editable views only.
  const imgWrap = document.createElement("div");
  imgWrap.className = "clip-img-wrap";
  imgWrap.appendChild(img);
  if (!READONLY) {
    const rmImg = document.createElement("button");
    rmImg.type = "button";
    rmImg.className = "clip-rm-img";
    rmImg.textContent = "×"; // × glyph (UI text, never innerHTML)
    rmImg.title = "Remove the image (keep the caption text)";
    rmImg.setAttribute("aria-label", "Remove the image, keep the caption");
    rmImg.addEventListener("click", async () => {
      // With a caption, remove_clipping_image converts the block to a text note in place (keeps the
      // caption) — non-destructive, no confirm. With NO caption it removes the WHOLE block one-click
      // and can't be undone (like remove_note) — confirm that case (E5).
      if (app.note_caption(i).trim() === "") {
        const ok = await confirmDialog({
          title: "Remove this image?",
          body: "This removes the image block and can't be undone.",
          confirmLabel: "Remove",
          danger: true,
        });
        if (!ok) return;
      }
      app.remove_clipping_image(i);
      renderNotes();
    });
    imgWrap.appendChild(rmImg);
  }
  div.append(imgWrap, cap, copy);
  queueMicrotask(() => autoGrow(cap));
}

function renderNotes() {
  // Revoke old blob URLs before rebuilding.
  for (const img of els.notesList.querySelectorAll("img[data-blob]")) {
    URL.revokeObjectURL(img.src);
  }
  sketchViews = [];
  activeSketch = null; // the views are about to be rebuilt — drop the stale reference
  els.notesList.textContent = "";
  const total = app.notes_len();
  for (let i = 0; i < total; i++) {
    try {
      const kind = app.note_kind(i);
      const div = newNoteBlock(i);
      let sketchCanvas = null;
      if (kind === "sketch") sketchCanvas = buildSketchBlock(div);
      else if (kind === "text") buildTextBlock(div, i);
      else if (kind === "clipping") buildClippingBlock(div, i);
      div.appendChild(blockActions(i, total));
      els.notesList.appendChild(div);
      if (sketchCanvas) sketchViews.push(new SketchView(i, sketchCanvas));
    } catch (e) {
      console.warn("note block render failed:", i, e); // one bad block must not abort the list
    }
  }
}

// Drag-and-drop reordering: highlight the insertion point and reorder on drop.
els.notesList.addEventListener("dragover", (e) => {
  if (dragFromIndex < 0) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const over = e.target.closest(".note-block");
  els.notesList.querySelectorAll(".drop-before,.drop-after")
    .forEach((b) => b.classList.remove("drop-before", "drop-after"));
  if (!over || over.classList.contains("dragging")) return;
  const r = over.getBoundingClientRect();
  over.classList.add(e.clientY < r.top + r.height / 2 ? "drop-before" : "drop-after");
});
els.notesList.addEventListener("drop", (e) => {
  if (dragFromIndex < 0) return;
  e.preventDefault();
  const over = e.target.closest(".note-block");
  const from = dragFromIndex;
  dragFromIndex = -1;
  if (!over) return;
  let to = Number(over.dataset.idx);
  const r = over.getBoundingClientRect();
  const after = e.clientY >= r.top + r.height / 2;
  if (after && to < from) to += 1;
  if (!after && to > from) to -= 1;
  reorderNote(from, to);
});

function toggleNotes(show) {
  const visible = show ?? els.notesPane.hidden;
  els.notesPane.hidden = !visible;
  els.splitter.hidden = !visible || isNotesFloating(); // the splitter stays hidden while the notes float
  els.btn.notes.classList.toggle("active", visible);
  syncAria();
  if (visible) {
    if (isNotesCollapsed()) setNotesCollapsed(false); // re-opening from fully-hidden → expand, not to a strip
    renderNotes();
    if (isNotesFloating()) {
      if (document.body.classList.contains("overlay")) {
        // R1: if the pane would open above OR below the visible band, bring it to the band top; otherwise keep
        // the student's in-band position. Either way it opens fully on-screen — never needing a scroll to find.
        const pr = els.notesPane.getBoundingClientRect(), b = visibleBand();
        if (pr.top < b.top || pr.top > b.bottom - 36) placeNotesAtBandTop();
        else clampNotes();
      } else clampNotes(); // non-overlay: re-fit a restored floating window to the live stage
    }
  }
}

// The toolbar Notes button fully HIDES/SHOWS the pane (tuck it away while annotating; re-open it here —
// it's labelled + shows an active state, so it's never lost). The notes header's own button does the
// lighter minimise-to-a-strip. Re-showing restores the pane expanded at its last position.
els.btn.notes.addEventListener("click", () => { toggleNotes(); savePrefs(); });
// ✕ on the notes header: fully tuck the notes away (distinct from Minimise, which only collapses to a strip).
// Reopens from the toolbar Notes button. Overlay-only affordance (hidden elsewhere via CSS).
$("btn-notes-hide")?.addEventListener("click", () => { toggleNotes(false); savePrefs(); });
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

// Splitter: drag to resize the notes pane; double-click to reset. In embedded
// (PrairieLearn) mode the notes pane sits BELOW the document, so the splitter is
// horizontal and resizes its HEIGHT — drag up to grow the notes over the question.
let splitDrag = null;
els.splitter.addEventListener("pointerdown", (ev) => {
  if (isNotesFloating()) return; // the splitter is inert while the notes float (it's display:none too)
  splitDrag = document.body.classList.contains("embedded")
    ? { id: ev.pointerId, vertical: true, startY: ev.clientY, startH: els.notesPane.offsetHeight }
    : { id: ev.pointerId, startX: ev.clientX, startW: els.notesPane.offsetWidth };
  try { els.splitter.setPointerCapture(ev.pointerId); } catch { /* pointer already gone — drag still works while over the splitter */ }
  ev.preventDefault(); // a touch-drag must resize, not select text / scroll (with touch-action:none in CSS)
});
els.splitter.addEventListener("pointermove", (ev) => {
  if (!splitDrag || ev.pointerId !== splitDrag.id) return; // only the owning contact drives the resize
  if (!(ev.buttons & 1)) { splitDrag = null; savePrefs(); return; } // press ended unseen — finish, don't chase
  if (splitDrag.vertical) {
    const h = splitDrag.startH + (splitDrag.startY - ev.clientY); // drag up → taller
    $("main").style.setProperty("--notes-h", `${Math.max(80, Math.min(window.innerHeight * 0.82, h))}px`);
  } else {
    const w = splitDrag.startW + (splitDrag.startX - ev.clientX);
    els.notesPane.style.width = `${Math.max(220, Math.min(window.innerWidth * 0.6, w))}px`;
  }
  relayoutSketches();
});
els.splitter.addEventListener("pointerup", () => { splitDrag = null; savePrefs(); });
els.splitter.addEventListener("pointercancel", () => { splitDrag = null; savePrefs(); });
els.splitter.addEventListener("dblclick", () => {
  if (document.body.classList.contains("embedded")) $("main").style.removeProperty("--notes-h");
  else els.notesPane.style.width = "";
  savePrefs();
});

// A tab switch / OS overlay can swallow the pointerup for ANY in-progress canvas/sketch gesture or
// the splitter drag — cancel so no zombie survives the return. (The floating panels register their
// own equivalents in their modules.) BLUR needs care in the overlay: the "window" is the iframe, so
// ANY tap on the parent PL page blurs it — but a gesture whose canvas still HOLDS pointer capture
// keeps receiving events across a focus change, so it's alive and must not be killed. Only cancel
// on blur when capture is gone; visibility:hidden is a real tab switch and cancels unconditionally.
function cancelCanvasGestures(fromBlur) {
  const held = (el, id) => fromBlur && id != null && el?.hasPointerCapture?.(id);
  if (splitDrag && !held(els.splitter, splitDrag.id)) { splitDrag = null; savePrefs(); }
  if ((drawing || snip || marquee || itemDrag || resizeDrag || groupDrag) &&
      !held(gestureCaptureEl, gesturePointerId)) onAnnoPointerCancel(null);
  for (const v of sketchViews) if (v.state && !held(v.canvas, v.state.pid)) v.cancel();
}
window.addEventListener("blur", () => cancelCanvasGestures(true));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") cancelCanvasGestures(false);
});

// ---------- thumbnails sidebar ----------

const THUMB_SCALE_WIDTH = 220; // backing px; CSS shrinks for sharpness

async function buildThumbnails() {
  els.thumbs.textContent = "";
  thumbState.clear(); // drop any in-flight render state from the previous document
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

function markActiveThumb(active = pageNum) {
  [...els.thumbs.children].forEach((el, i) =>
    el.classList.toggle("active", i === active));
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
  syncAria();
  if (!els.thumbs.hidden && els.thumbs.childElementCount === 0) {
    await buildThumbnails();
  }
});

// ---------- accessibility toggles ----------

function applyBig(on) {
  document.body.classList.toggle("big", on);
  railHostEl?.classList.toggle("big", on); // mirror onto the reparented rail (chrome.css .scribble-chrome.big)
  els.btn.big.classList.toggle("active", on);
  syncAria();
  clampContextBar(); // larger controls shrink the toolbar gap → re-fit a docked bar
}
els.btn.big.addEventListener("click", () => {
  applyBig(!document.body.classList.contains("big"));
  savePrefs();
});

// Swatch tooltips track the colour-blind palette so they never lie about the
// ink that will actually be drawn.
function swatchTitle(color, safe) {
  const base = { black: "Black", red: "Red", blue: "Blue", green: "Green", yellow: "Yellow" };
  if (safe && color === "green") return "Green — drawn as brown in colour-safe mode";
  if (safe && color === "red") return "Red — drawn as vermillion in colour-safe mode";
  return base[color] || color;
}

// Apply the standard or colorblind-safe palette. Shared by the toggle and the
// boot-time preference restore. Colors still come from the closed Rust enum.
function applyPalette(safe, announce = false) {
  app.set_palette(safe ? "safe" : "standard");
  els.btn.palette.classList.toggle("active", safe);
  els.btn.palette.title = safe
    ? "Colour-blind-safe palette: on — click to return to standard colours"
    : "Colour-blind-safe palette: off — click to recolour (green→brown, red→vermillion)";
  for (const s of railRoot.querySelectorAll("#colors .swatch")) {
    s.style.background = app.color_css(s.dataset.color);
    s.title = swatchTitle(s.dataset.color, safe);
  }
  if (docOpen()) {
    redrawAnnotations();
    if (!els.thumbs.hidden) renderThumb(pageNum);
  }
  syncAria();
  if (announce) {
    status(safe ? "Colorblind-safe palette on (green→brown, red→vermillion)."
                : "Standard palette.");
  }
}
els.btn.palette.addEventListener("click", () => {
  applyPalette(!els.btn.palette.classList.contains("active"), true);
  savePrefs();
});

// ---------- movable / collapsible / dockable colour bar (#4) ----------
// The engine lives in colorbar.js; inject the handles it needs and wire its
// listeners. It calls back savePrefs/status; app.js calls the imported dockCbar /
// isCbarDocked / clampContextBar / setCbarCollapsed from prefs, resize and tools.
initColorBar({ els, $, status, savePrefs });

// ---------- keyboard-shortcuts overlay ----------

const helpOverlay = $("help-overlay");
function toggleHelp(show) {
  const open = show ?? helpOverlay.hidden;
  helpOverlay.hidden = !open;
  // #btn-help rides inside the rail's More menu, which the overlay REPARENTS into the parent page —
  // so look it up in the rail's realm ($() would search this iframe and return null there).
  railRoot.querySelector("#btn-help")?.classList.toggle("active", open);
  if (!open) return;
  // Band-place the card in the VISIBLE part of the (possibly question-tall) overlay iframe — else the flex
  // centring lands it in the middle of the full iframe height, off-screen below the fold (the reported bug).
  // Standalone: window.frameElement is null → the try is skipped → the CSS-centred layout stays (correct).
  const card = $("help-card");
  helpOverlay.style.alignItems = ""; card.style.marginTop = ""; card.style.maxHeight = ""; // reset to centred, then re-measure
  try {
    const fr = window.frameElement && window.frameElement.getBoundingClientRect();
    const pvh = window.parent && window.parent.innerHeight;
    if (fr && pvh) {
      const visTop = Math.max(0, -fr.top);
      const band = Math.min(pvh - fr.top, fr.height) - visTop;
      if (band > 160) {
        helpOverlay.style.alignItems = "flex-start";
        card.style.maxHeight = `${Math.round(band - 32)}px`;
        card.style.marginTop = `${Math.max(8, Math.round(visTop + band / 2 - card.offsetHeight / 2 - 20))}px`;
      }
    }
  } catch { /* cross-frame — keep the centred layout */ }
  $("help-close").focus();
}
$("btn-help").addEventListener("click", () => toggleHelp());
$("help-close").addEventListener("click", () => toggleHelp(false));
// Click the dimmed backdrop (but not the card) to dismiss.
helpOverlay.addEventListener("click", (ev) => {
  if (ev.target === helpOverlay) toggleHelp(false);
});

// ---------- persistence: UI prefs (localStorage) + autosave recovery (IndexedDB) ----------
//
// Two independent layers, both best-effort (private-mode / disabled storage just
// degrades silently):
//   • UI prefs — palette, larger-controls, notes-pane width — survive reloads.
//   • Autosave — the annotation document is snapshotted to IndexedDB keyed by the
//     open PDF's hash, so a crash/accidental close can be recovered when the same
//     PDF is reopened. Nothing leaves the machine; it's the same local-only data.

// Namespace LAYOUT prefs per PL element so two overlay questions on one page don't clobber each other.
// Per-question prefs: the element passes a qid (path under /questions/, dot-joined) so panel layouts
// stop leaking across questions that all share the default answers-name. Missing qid (older element,
// deploy-order skew) → the legacy shared key; standalone keeps the bare key. A11Y_KEY stays shared.
const PREFS_KEY = "scribble.prefs.v1" + (() => {
  const pl = window.__SCRIBBLE_PL;
  if (!pl) return "";
  const parts = [pl.qid, pl.name].filter(Boolean);
  return parts.length ? "." + parts.join(".") : "";
})();
// USER-level accessibility prefs (Larger controls, colourblind-safe palette) are NOT per-question — a shared,
// un-namespaced key so enabling them on one question applies to every question (they serve the users who
// most need consistency).
const A11Y_KEY = "scribble.a11y.v1";

function savePrefs() {
  try {
    const cb = els.contextBar;
    const embedded = document.body.classList.contains("embedded");
    const overlay = document.body.classList.contains("overlay"); // overlay ⊂ embedded — gate its layout fields
    // Prefs share one key across embed + standalone. The embed-only layout fields
    // (notesFloat, and a floating notesWidth) must NOT be overwritten from the other
    // mode, or a standalone save wipes the embed float layout and a float width leaks
    // onto the standalone column — so carry the prior value forward across modes.
    let prev = {};
    try { prev = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {}; } catch { /* ignore */ }
    // Accessibility prefs go in the shared, un-namespaced key (not per-question).
    localStorage.setItem(A11Y_KEY, JSON.stringify({
      palette: els.btn.palette.classList.contains("active") ? "safe" : "standard",
      big: document.body.classList.contains("big"),
    }));
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      // The STANDALONE right-column width only; never capture the embed grid / float width.
      notesWidth: (embedded || isNotesFloating()) ? (prev.notesWidth || "") : (els.notesPane.style.width || ""),
      cbar: {
        docked: isCbarDocked(),
        dockLeft: isCbarDocked() ? cb.style.left : "",
        left: !isCbarDocked() && cb.classList.contains("moved") ? cb.style.left : "",
        top: !isCbarDocked() && cb.classList.contains("moved") ? cb.style.top : "",
        collapsed: cb.classList.contains("collapsed"),
      },
      // Embed-only; in standalone carry the saved value forward untouched. While collapsed, the pane's
      // inline width/height are cleared (stashed in dataset.expW/expH), so persist the EXPANDED size from
      // there — else a collapse+reload would lose the student's chosen notes size to the default.
      notesFloat: embedded
        ? (isNotesFloating()
          ? { on: true, left: els.notesPane.style.left, top: els.notesPane.style.top,
              width: (isNotesCollapsed() ? els.notesPane.dataset.expW : els.notesPane.style.width)
                || (prev.notesFloat && prev.notesFloat.width) || "",
              height: (isNotesCollapsed() ? els.notesPane.dataset.expH : els.notesPane.style.height)
                || (prev.notesFloat && prev.notesFloat.height) || "" }
          : { on: false })
        : (prev.notesFloat || { on: false }),
      // (notesCollapsed/notesHidden were written here but never read back — the overlay boot always
      // starts with the notes hidden by design. Dropped; the tolerant reader ignores stale fields.)
      // Overlay-only merged-toolbar layout; carry forward in every other mode (overlay ⊂ embedded,
      // so gate on !overlay, not !embedded — else an Option-B save would wipe the overlay layout).
      // (No topbarFloat: in overlay the topbar is merged into #rail, not a separate floating bar.)
      // Look the rail up in ITS realm: the overlay reparents it into the parent page, where $() (getElementById
      // on this iframe) returns null — which would silently stop the toolbar's position ever persisting.
      // B3-7: railFloat2 — position:fixed coords whose ORIGIN differs by realm (iframe-viewport today,
      // parent-viewport post-flip). Version the sub-key so a v160 iframe-realm railFloat isn't restored as
      // parent-realm coords post-flip (which could strand the rail off-viewport). Old railFloat carried
      // forward untouched below for rollback. (Query via railRoot — scoped to this instance's rail. B3-3.)
      railFloat2: overlay && railRoot.querySelector("#rail")
        ? (() => {
          const r = railRoot.querySelector("#rail");
          return { left: r.classList.contains("fp-moved") ? r.style.left : "",
                   top: r.classList.contains("fp-moved") ? r.style.top : "",
                   collapsed: r.classList.contains("fp-collapsed") };
        })()
        : (prev.railFloat2 || {}),
      railFloat: prev.railFloat || {}, // carry the legacy iframe-realm key forward untouched (rollback safety)
    }));
  } catch { /* storage unavailable — non-fatal */ }
}

function applyPrefs() {
  let p = {}, a11y = {};
  try { p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {}; } catch { /* ignore */ }
  try { a11y = JSON.parse(localStorage.getItem(A11Y_KEY) || "{}") || {}; } catch { /* ignore */ }
  // Larger controls: honor an explicit choice; otherwise (pref unset) default ON for a
  // touch-only device, where the tiny icon targets are hardest to hit.
  if (a11y.big !== undefined) {
    if (a11y.big) applyBig(true);
  } else if (window.matchMedia?.("(any-pointer: coarse) and (not (any-pointer: fine))").matches) {
    applyBig(true);
  }
  if (p.notesWidth) els.notesPane.style.width = p.notesWidth;
  const cb = p.cbar || {};
  if (cb.docked) {
    dockCbar(parseFloat(cb.dockLeft) || 12);
  } else if (cb.left && cb.top) {
    els.contextBar.classList.add("moved");
    els.contextBar.style.left = cb.left;
    els.contextBar.style.top = cb.top;
  }
  if (cb.collapsed) setCbarCollapsed(true);
  applyPalette(a11y.palette === "safe"); // also paints the swatches for the active palette
  return p;
}

// "Dirty since the last save to a FILE." Autosave calls save_json(), which
// clears the Rust dirty flag, so is_dirty() alone can't tell whether the work
// has actually been written somewhere durable. We track file-saves in JS and OR
// the two for the unload guard. Reset whenever a document is freshly opened.
let dirtySinceFileSave = false;

// Snapshot the current annotations to IndexedDB under the open PDF's hash.
// PDF-only: HTML uploads have no stable identity to key on.
async function autosaveTick() {
  try {
    if (docMode !== "pdf" || !app || !app.is_dirty()) return;
    const key = app.pdf_sha256();
    if (!key) return; // no hash (e.g. insecure context) — can't key recovery
    const json = app.save_json(); // NB: clears the Rust dirty flag
    dirtySinceFileSave = true;
    try {
      await idbPut(key, { json, savedAt: Date.now(), pages: pdfDoc?.numPages || 0 });
    } catch (e) {
      app.mark_dirty(); // the write was lost (quota/eviction) — re-mark so the next tick retries
      idbPrune(15); // best-effort: free space (old snapshots) so the retry can land
      throw e;
    }
  } catch (e) {
    console.warn("autosave failed:", e);
  }
}
setInterval(autosaveTick, 4000);

// On opening a PDF, offer to recover annotations autosaved for that exact file.
// Returns true if the user restored a snapshot (so the caller can react).
async function maybeRestoreAutosave(hash) {
  if (!hash) return false;
  let saved;
  try { saved = await idbGet(hash); } catch { return false; }
  if (!saved || !saved.json) return false;
  const when = (() => { try { return new Date(saved.savedAt).toLocaleString(); } catch { return "earlier"; } })();
  if (!window.confirm(
    `Found unsaved annotations for this PDF (autosaved ${when}).\n\nRestore them?`)) {
    try { await idbDelete(hash); } catch { /* ignore */ } // fresh start: don't ask again
    return false;
  }
  try {
    app.load_json(saved.json);
    app.set_pdf_sha256(hash);
    dirtySinceFileSave = true; // restored work isn't in a file yet
    return true;
  } catch (e) {
    status(`Couldn't restore autosave: ${e}`);
    return false;
  }
}

// ---------- boot ----------

// Read-only debug handle, opt-in via ?debug and always available in embed mode (the
// srcdoc carries no query string). Harmless: the page is fully client-side, the user
// already owns all annotation state, and PrairieLearn re-validates everything on save.
if (new URLSearchParams(location.search).has("debug") || window.__SCRIBBLE_EMBED) {
  Object.defineProperty(window, "__app", { get: () => app });
  Object.defineProperty(window, "__pdf", { get: () => pdfDoc });
}

// Pass a versioned wasm URL so a normal reload re-fetches the binary too (the glue's
// default carries no ?v=, so the wasm would otherwise cache path-stable and need a hard
// refresh — a fresh glue against a stale wasm is a binding mismatch waiting to happen).
// Resolve against import.meta.url (this module's own location), NOT a relative string: the
// glue fetch()es a string against the DOCUMENT base, which in PL srcdoc mode hinges on
// pl-scribble.py's injected <base href>. new URL(..., import.meta.url) is base-independent.
init({ module_or_path: new URL(`pkg/scribble_bg.wasm?v=${APP_VERSION}`, import.meta.url) })
  .then(() => {
    app = new App();
    const prefs = applyPrefs();
    if (READONLY) document.body.classList.add("readonly"); // hides edit chrome (CSS) — JS gates already block edits
    updateContextBar(activeTool()); // hide the colour UI (and palette) until a doc opens
    // NEVER let an embed-setup failure skip the toolbar merge + notes setup below (which would leave a raw,
    // unresponsive bar). openOverlay/openHtml run first inside initEmbed, so by the time anything risky runs,
    // the doc + body.overlay are already set and the merge can still build correctly.
    try {
      initEmbed({
        app, els, status, toggleNotes, renderNotes, openHtml, openOverlay, resizeOverlay,
        hydrateAnnotations, serializeAnnotations, setPersistAlert,
      });
    } catch (e) {
      console.error("initEmbed failed (continuing to build the toolbar):", e);
    }
    // Option B docks the colour bar in the toolbar. Overlay MERGES all three bars into ONE: the
    // colour/width strip and the Notes/Larger/Help actions fold into the tool rail, so only
    // [tool bar] + [notes] remain. The whole bar is one floating (grip) + hideable (collapse) unit.
    if (document.body.classList.contains("embedded")) {
      if (document.body.classList.contains("overlay")) {
        const railEl = $("rail");
        // Clear any restored colour-bar float/dock state, then fold it into the rail as a static child.
        document.body.classList.remove("cbar-docked");
        els.contextBar.classList.remove("moved", "collapsed");
        els.contextBar.style.left = ""; els.contextBar.style.top = "";
        railEl.appendChild(els.contextBar); // colour/width strip now flows inside the rail
        const actions = document.createElement("div");
        actions.className = "rail-actions"; // pushed to the right edge via CSS margin-left:auto
        actions.append(els.btn.notes); // Notes stays on the bar (the primary action)
        const aboutWrap = $("about-wrap"); // attribution "i" rides along (wrapper carries its popover)
        if (aboutWrap) actions.append(aboutWrap);
        // "More" menu: tuck the low-frequency controls (Larger / Help / colour-blind palette) behind a ⋯
        // button so the main row breathes. The moved buttons keep their handlers (bound by id / listener).
        const palette = $("btn-palette");
        const paletteDiv = palette.previousElementSibling; // its leading divider would dangle once it moves
        if (paletteDiv && paletteDiv.classList.contains("bar-divider")) paletteDiv.remove();
        const menuLabel = (el, text) => { if (!el.querySelector("span")) { const s = document.createElement("span"); s.textContent = text; el.append(s); } };
        menuLabel(els.btn.big, "Larger controls");
        menuLabel($("btn-help"), "Keyboard shortcuts");
        menuLabel(palette, "Colour-blind-safe palette"); // match #btn-palette's aria-label (WCAG 2.5.3)
        const moreBtn = document.createElement("button");
        moreBtn.id = "btn-more"; moreBtn.type = "button"; moreBtn.className = "btn labeled";
        moreBtn.title = "More tools"; moreBtn.setAttribute("aria-haspopup", "true"); moreBtn.setAttribute("aria-expanded", "false");
        moreBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>More';
        const morePop = document.createElement("div");
        // A labelled popover of plain buttons — NOT role="menu" (that would demand menuitem roles + a full
        // arrow-key model, and it invalidates the children's aria-pressed / aria-haspopup).
        morePop.id = "more-popover"; morePop.hidden = true;
        morePop.append(els.btn.big, $("btn-help"), palette);
        actions.append(moreBtn);
        railEl.appendChild(actions);
        railEl.appendChild(morePop); // sibling of actions; CSS positions it under the More button
        railEl.appendChild($("rail-collapse")); // keep the collapse chevron LAST, after the appended children
        const closeMore = () => {
          if (morePop.hidden) return;
          const hadFocus = morePop.contains(railHostDoc.activeElement); // B3-4: realm-correct (iframe OR parent post-flip)
          morePop.hidden = true; moreBtn.setAttribute("aria-expanded", "false");
          if (hadFocus) moreBtn.focus(); // don't drop focus to <body> on Escape / item-activate
        };
        // No stopPropagation: letting the click reach the document closers means opening
        // More auto-closes the About popover (the More closer excludes moreBtn itself).
        moreBtn.addEventListener("click", () => {
          const open = morePop.hidden;
          morePop.hidden = !open;
          moreBtn.setAttribute("aria-expanded", String(open));
        });
        // Activating any item (Larger / Help / palette) dismisses the menu — else Help's modal opens
        // BEHIND the still-open popover (the popover is trapped in the rail's low stacking context).
        morePop.addEventListener("click", (e) => { if (e.target.closest("button")) closeMore(); });
        document.addEventListener("click", (e) => {
          if (!morePop.hidden && !morePop.contains(e.target) && !moreBtn.contains(e.target)) closeMore();
        });
        document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMore(); });
        // U1: wrap tools+colours in a horizontally-scrollable middle so a narrow card can't clip the
        // grip/actions/collapse off-screen — those stay pinned; only the middle scrolls.
        const railScroll = document.createElement("div");
        railScroll.className = "rail-scroll";
        [...railEl.children].forEach((c) => {
          if (c.classList.contains("rail-group") || c.id === "context-bar") railScroll.appendChild(c);
        });
        railEl.insertBefore(railScroll, actions);
        updateContextBar(activeTool()); // colours are persistent in the merged bar
        // ONE grip + ONE collapse govern the whole merged bar — editable view only: a read-only submission's
        // toolbar is inert, and making it draggable would let a read-only view write layout prefs (R7).
        if (!READONLY) {
          // --- Phase 1 (step 1a): REPARENT the merged toolbar out to the PL PAGE so position:fixed follows the
          //     real browser viewport (like the Done button already does), instead of the question-tall iframe
          //     where "fixed" pins to the question and scrolls away. The srcdoc iframe is same-origin, so we can
          //     move the #rail node into the parent + inject a SCOPED copy of its CSS (chrome.css, .scribble-chrome).
          //     If not same-origin (host-demo embed), we leave it in the iframe (degrades to the old behaviour).
          let railWin = window;
          // B3-6: parent-realm cleanups, run on `pagehide` so a PL Save&Grade iframe swap doesn't orphan the
          // reparented host/listeners in the parent doc (only populated when we actually reparent).
          const railTeardowns = [];
          try {
            const P = window.parent;
            if (PHASE1_CHROME_REPARENT && P && P !== window && P.document && P.document.body) {
              const pdoc = P.document;
              if (!pdoc.getElementById("pl-scribble-chrome-css")) { // inject the scoped toolbar stylesheet once
                const link = pdoc.createElement("link");
                link.id = "pl-scribble-chrome-css"; link.rel = "stylesheet";
                link.href = new URL(`chrome.css?v=${APP_VERSION}`, import.meta.url).href;
                pdoc.head.appendChild(link);
              }
              // B3-3: per-instance host id (qid+name, like PREFS_KEY) so a page with TWO overlay questions
              // doesn't append the 2nd rail into the 1st's host — that would duplicate #rail/#colors/
              // #more-popover/#about-* ids in the parent doc. The .pl-scribble-chrome-host CLASS stays (the
              // teardown gates the shared <link> removal on "no host of that class remains").
              const plCfg = window.__SCRIBBLE_PL || {};
              const hostSuffix = [plCfg.qid, plCfg.name].filter(Boolean).join("-").replace(/[^A-Za-z0-9_-]/g, "-");
              const hostId = "pl-scribble-chrome-host" + (hostSuffix ? "-" + hostSuffix : "");
              let host = pdoc.getElementById(hostId);
              if (!host) { // one host div (position:relative) carries the scope class + the rail
                host = pdoc.createElement("div");
                host.id = hostId;
                host.className = "scribble-chrome pl-scribble-chrome-host";
                // B3-8: z BELOW the Done FAB (2147483000, py:142) so the rail never covers the exit affordance;
                // ABOVE the overlay frame/calc (2147482000) and the Annotate launch pill (2147482500).
                host.style.cssText = "position:relative;z-index:2147482900;";
                pdoc.body.appendChild(host); // B3-9: plain body child (a transformed card ancestor re-pins fixed)
              }
              host.appendChild(railEl); // #rail lives in the parent now; ".scribble-chrome #rail" styles it
              railWin = P;
              railHostDoc = pdoc;  // realm document (activeElement, parent-doc listeners)
              railHostEl = host;   // for mirroring state classes (e.g. .big "Larger") onto the reparented rail
              railRoot = host;     // B3-3: scope rail-node queries to THIS instance's host
              host.classList.toggle("big", document.body.classList.contains("big")); // B3-2: applyBig ran pre-reparent
              // MF-B / B3-4: the More AND About popovers' outside-click / Escape must ALSO be heard in the
              // PARENT realm now (the rail's clicks fire there). The iframe-document listeners stay too, so a
              // click on either side closes them. Named handlers → removable on teardown (B3-6).
              const pMoreClick = (e) => { if (!morePop.hidden && !morePop.contains(e.target) && !moreBtn.contains(e.target)) closeMore(); };
              const pMoreKey = (e) => { if (e.key === "Escape") closeMore(); };
              // Match the IFRAME listener order so Escape layering (C10) is identical in the parent realm:
              // About-closer (consuming) → mainKeydown (defers to an open More) → More-closer. mainKeydown MUST
              // precede pMoreKey (review R-2), else pMoreKey closes More first and mainKeydown then also clears
              // the selection on the same Escape.
              pdoc.addEventListener("click", closeAboutOnOutsideClick);
              pdoc.addEventListener("click", pMoreClick);
              pdoc.addEventListener("keydown", closeAboutOnEscape);
              pdoc.addEventListener("keydown", mainKeydown); // B3-5: tool/undo/save/Escape shortcuts in the parent realm
              pdoc.addEventListener("keydown", pMoreKey);
              railTeardowns.push(
                () => pdoc.removeEventListener("click", pMoreClick),
                () => pdoc.removeEventListener("keydown", pMoreKey),
                () => pdoc.removeEventListener("click", closeAboutOnOutsideClick),
                () => pdoc.removeEventListener("keydown", closeAboutOnEscape),
                () => pdoc.removeEventListener("keydown", mainKeydown),
                () => { host.remove(); // gate the shared <link> removal on "no other host remains" (2nd question)
                        if (!pdoc.querySelector(".pl-scribble-chrome-host")) pdoc.getElementById("pl-scribble-chrome-css")?.remove(); },
              );
            }
          } catch { /* cross-origin / no parent — keep the rail in the iframe */ }
          // NB: query the grip/collapse THROUGH railEl, not $() — $() is getElementById on the IFRAME document,
          // and the rail may have just been reparented into the parent (so $("rail-collapse") would be null).
          // onChange also nudges the bar out of an active calculator hole (a drag can park it under
          // the drawer, where it would render half-clipped — the irrecoverable-panel class of bug).
          const railFP = makeFloating(railEl, { collapse: railEl.querySelector("#rail-collapse"), onChange: () => { savePrefs(); calcDodgeNudge(); }, onSettle: () => restickRail(), win: railWin });
          // B3-7 + review L-1: prefer railFloat2, but when NOT reparented fall back to the legacy railFloat —
          // gate-off coords are still iframe-realm (same realm v160 saved them in), so a v160 student who dragged
          // their toolbar isn't reset. Only the parent-realm (post-flip) path ignores the legacy key.
          const rp = (prefs && (prefs.railFloat2 || (railWin === window && prefs.railFloat))) || {};
          if (rp.left && rp.top) railFP.floatTo(parseFloat(rp.left), parseFloat(rp.top));
          // R4: the toolbar always loads EXPANDED. A persisted collapsed state is kept live within the
          // session (the collapse button still works + saves), but NOT re-applied on reload — a bar that
          // reloaded collapsed-and-off-screen was un-findable. A restored MOVED position (above) is pulled
          // into the visible band by clampFixed below, so it can never load off-screen either.
          // Card-aligned geometry (Decision 1): the reparented bar spans the QUESTION CARD's horizontal
          // extent (the overlay iframe), viewport-fixed vertically — NOT the full browser width over PL's
          // own header. Applies only to the DEFAULT (un-dragged) bar; a dragged (fp-moved) bar keeps its spot.
          // No-op (chrome.css full-width fallback) if the frame rect is unreadable, or when not reparented.
          const alignRailToCard = () => {
            // A collapsed bar shrinks to its right-anchored handle (chrome.css .fp-collapsed:not(.fp-moved));
            // re-applying inline left/width here would defeat that, so bail while collapsed too.
            if (railWin === window || railEl.classList.contains("fp-moved") || railEl.classList.contains("fp-collapsed")) return;
            try {
              const fr = window.frameElement.getBoundingClientRect(); // iframe position in the parent viewport
              railEl.style.left = `${Math.round(fr.left + 4)}px`;
              railEl.style.width = `${Math.round(Math.max(0, fr.width - 8))}px`;
              railEl.style.top = "4px";
            } catch { /* cross-frame — leave the chrome.css full-width fallback */ }
          };
          alignRailToCard();
          clampFixed(railEl, railWin);
          const onRailResize = () => { alignRailToCard(); clampFixed(railEl, railWin); restickRail(); };
          railWin.addEventListener("resize", onRailResize);
          if (railWin !== window) {
            // Parent-realm listeners → tear down on the iframe swap (B3-6). Re-align on parent scroll / iframe
            // grow (resizeOverlay), rAF-coalesced (CLAUDE.md §10 — no layout work directly in the handler).
            railTeardowns.push(() => railFP.dispose()); // review N-1: remove makeFloating's parent-window blur listener
            railTeardowns.push(() => railWin.removeEventListener("resize", onRailResize));
            let alignRaf = 0;
            const scheduleAlign = () => { if (alignRaf) return; alignRaf = railWin.requestAnimationFrame(() => { alignRaf = 0; alignRailToCard(); }); };
            railWin.addEventListener("scroll", scheduleAlign, { passive: true });
            railTeardowns.push(() => railWin.removeEventListener("scroll", scheduleAlign));
            if (railWin.ResizeObserver && window.frameElement) {
              const ro = new railWin.ResizeObserver(scheduleAlign);
              ro.observe(window.frameElement);
              railTeardowns.push(() => { try { ro.disconnect(); } catch { /* ignore */ } if (alignRaf) railWin.cancelAnimationFrame(alignRaf); });
            }
            window.addEventListener("pagehide", () => { for (const t of railTeardowns) { try { t(); } catch { /* ignore */ } } }, { once: true });
          }
          // MF-F: the iframe's `display:none` annotate-gate (style.css) can't reach a reparented rail, so drive
          // its visibility from HERE off the same annotate-active signal (the parent toggles that class on OUR
          // iframe body). Hidden until the student clicks Annotate. No-op when the rail stayed in the iframe.
          const syncRailVis = () => {
            if (railWin !== window) railEl.style.display = document.body.classList.contains("annotate-active") ? "" : "none";
          };
          syncRailVis();
          // The VISIBLE band of this (possibly question-tall) iframe, in the rail's realm. visibleBand /
          // clampIntoBand now live in visible-band.js (shared with the rail engine + notes). railBand() keys
          // it on railWin, so it's the iframe band today and the whole parent viewport once reparented.
          const railBand = () => visibleBand(railWin);
          // On show (Annotate), pull a dragged/restored rail into the band the student can actually see.
          // clampFixed is now band-aware on BOTH axes and no-ops a non-moved bar, so this is a thin call;
          // the reparented realm is handled by visibleBand(window.parent) inside clampFixed.
          const clampRailOnShow = () => { clampFixed(railEl, railWin); };
          // R1/R4: keep the DEFAULT (un-dragged, in-iframe) toolbar glued to the top of the visible band as the
          // parent scrolls, so a tall question's tools never scroll off-screen exactly when they're needed. A
          // MOVED bar is left to clampFixed (it may drift on scroll but stays recoverable); a reparented bar is
          // already viewport-fixed. Gated: RAIL_VIEWPORT_STICKY=false leaves pure band-clamp (still meets R1-R4).
          const RAIL_VIEWPORT_STICKY = true;
          const restickRail = () => {
            if (railWin !== window || !RAIL_VIEWPORT_STICKY) return;                 // reparented is already viewport-fixed
            if (railEl.classList.contains("fp-moved") || railEl.classList.contains("fp-dragging")) return; // moved/drag own their bounds
            if (!document.body.classList.contains("annotate-active") || !railEl.getClientRects().length) return; // hidden
            const band = railBand();
            const r = railEl.getBoundingClientRect();
            const { top } = clampIntoBand(parseFloat(railEl.style.left) || r.left, band.top + MARGIN,
                                          r.width, r.height, r.height, band); // default bar: CSS owns left/width; we own top
            const t = `${Math.round(top)}px`;
            if (railEl.style.top !== t) railEl.style.top = t;                        // write only on change (no restyle churn)
          };
          // Realm-proven trigger (the calc-dodge mechanism, verified live): capture-phase passive scroll on the
          // PARENT document (hears PL's inner scroller too) + parent resize, coalesced into OUR-realm rAF (a
          // parent rAF with an iframe callback is the v155/#13 failure mode). Torn down on the PL iframe swap.
          if (RAIL_VIEWPORT_STICKY && railWin === window) {
            try {
              const pwin = window.parent;
              if (pwin && pwin !== window && pwin.document) {
                let sraf = 0;
                const onStickScroll = () => { if (sraf) return; sraf = requestAnimationFrame(() => { sraf = 0; restickRail(); }); };
                const stickOpts = { capture: true, passive: true };
                pwin.document.addEventListener("scroll", onStickScroll, stickOpts);
                pwin.addEventListener("resize", onStickScroll, { passive: true });
                window.addEventListener("pagehide", () => {
                  pwin.document.removeEventListener("scroll", onStickScroll, stickOpts);
                  pwin.removeEventListener("resize", onStickScroll);
                  if (sraf) cancelAnimationFrame(sraf);
                }, { once: true });
              }
            } catch { /* cross-origin parent — no sticky; the on-show band clamp still holds */ }
          }
          // "Done" (the parent's Annotate toggle) removes annotate-active from our body → drop the tool
          // to Select (a clean click-through "finished" state) but REMEMBER the drawing tool: without a
          // restore, every re-entry stayed in Select — off the toolbar the cursor read as a plain arrow
          // and drags drew a marquee instead of ink (Lumetta's "cursor keeps disappearing").
          const RESUME_TOOLS = new Set(["pen", "highlighter", "text"]); // eraser/snip/select never surprise-restore
          let lastDrawTool = "pen";
          let wasAnnotating = document.body.classList.contains("annotate-active");
          new MutationObserver(() => {
            const now = document.body.classList.contains("annotate-active");
            if (wasAnnotating && !now) {
              const cur = railRoot.querySelector(".tool.active")?.dataset.tool;
              if (RESUME_TOOLS.has(cur)) lastDrawTool = cur;
              railRoot.querySelector('.tool[data-tool="select"]')?.click();
            } else if (!wasAnnotating && now) {
              // C14: make the reparented rail displayable BEFORE clampRailOnShow measures it — a
              // display:none rail reports height 0 and the band-clamp garbage-places its top.
              syncRailVis();
              // Unconditional click — an offsetParent-style visibility guard would silently skip
              // exactly when the rail is collapsed, and the Select trap would survive there.
              railRoot.querySelector(`.tool[data-tool="${lastDrawTool}"]`)?.click();
              clampRailOnShow();
              restickRail(); // land the default bar at the band top even if the page was scrolled at Annotate-time
              clampNotes(); // the pane re-appears with the chrome — never at an off-frame position
              calcDodgeNudge(); // the chrome may be re-appearing straight under an open calculator
            }
            syncRailVis(); // show/hide the reparented rail with annotate-active (hide branch; idempotent on show)
            wasAnnotating = now;
          }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
          // If Annotate was pressed BEFORE wasm init finished, the ON transition already happened and
          // the observer will never see it — run the show-clamps once for that first showing. (No
          // Select trap in this path: pen is both the markup default and lastDrawTool's default.)
          if (wasAnnotating) { clampRailOnShow(); restickRail(); clampNotes(); calcDodgeNudge(); }

          // ---- #13: PL's Calculator drawer must win its own clicks. calc-dodge punches a clip-path
          // hole in the overlay frame wherever the OPEN drawer overlaps it (clicks fall through, ink
          // stops painting over it); here we also one-shot-nudge our floating chrome out of the hole
          // so a half-clipped rail/notes never strands. Triggers: hole changes, annotate-ON, and
          // chrome drag-ends — never scroll-coupled.
          const holeOverlap = (L, T, W, H, h) => {
            const w = Math.min(L + W, h.left + h.width) - Math.max(L, h.left);
            const v = Math.min(T + H, h.top + h.height) - Math.max(T, h.top);
            return w > 0 && v > 0 ? w * v : 0;
          };
          // Move el to the nearest clear spot beside the hole (inside the visible band); >50%
          // covered triggers, nowhere-to-go leaves it (the clip wins and the panel stays reachable).
          // B3-8/C5: calcHoles() are FRAME-relative. A reparented rail lives in the PARENT doc (its rect is in
          // parent-viewport coords) and ESCAPES the iframe clip, so translate holes into parent coords (add the
          // frame's rect, read FRESH each call — it grows via resizeOverlay) and clamp against the parent
          // viewport. The notes pane stays in the iframe → identical iframe-realm behaviour as before. The realm
          // is derived from el.ownerDocument, so this needs no railWin in scope.
          const dodgeEl = (el, apply) => {
            const r = el.getBoundingClientRect();
            if (!(r.width > 0)) return;
            const parentRealm = el.ownerDocument !== document;
            const win = parentRealm ? window.parent : window;
            const fo = parentRealm ? (window.frameElement?.getBoundingClientRect() || { left: 0, top: 0 }) : { left: 0, top: 0 };
            const xlate = (h) => ({ left: h.left + fo.left, top: h.top + fo.top, width: h.width, height: h.height });
            const band = parentRealm ? { top: 0, bottom: win.innerHeight } : visibleBand();
            for (const h of calcHoles().map(xlate)) {
              if (holeOverlap(r.left, r.top, r.width, r.height, h) <= r.width * r.height * 0.5) continue;
              const cx = (x) => Math.max(4, Math.min(win.innerWidth - r.width - 4, x));
              const cy = (y) => Math.max(band.top + 4, Math.min(Math.max(band.top + 4, band.bottom - r.height - 4), y));
              const cands = [
                [cx(r.left), cy(h.top - r.height - 8)],
                [cx(r.left), cy(h.top + h.height + 8)],
                [cx(h.left - r.width - 8), cy(r.top)],
                [cx(h.left + h.width + 8), cy(r.top)],
              ].filter(([x, y]) => calcHoles().map(xlate).every((hh) => holeOverlap(x, y, r.width, r.height, hh) <= r.width * r.height * 0.5));
              if (!cands.length) return;
              const [bx, by] = cands.reduce((a, c) =>
                Math.hypot(c[0] - r.left, c[1] - r.top) < Math.hypot(a[0] - r.left, a[1] - r.top) ? c : a);
              apply(Math.round(bx), Math.round(by));
              return;
            }
          };
          const dodgeChromeFromCalc = () => {
            if (!calcHoles().length || !document.body.classList.contains("annotate-active")) return;
            if (railEl.classList.contains("fp-moved")) { // the full-width pinned bar is layout, not a position
              dodgeEl(railEl, (x, y) => { railEl.style.left = `${x}px`; railEl.style.top = `${y}px`; });
            }
            if (!els.notesPane.hidden && isNotesFloating()) {
              const sr = $("stage").getBoundingClientRect(); // pane coords are stage-relative
              dodgeEl(els.notesPane, (x, y) => {
                els.notesPane.style.left = `${Math.round(x - sr.left)}px`;
                els.notesPane.style.top = `${Math.round(y - sr.top)}px`;
              });
            }
          };
          let dodgeTimer = 0; // debounce: hole updates stream during drawer animation/scroll
          const scheduleDodge = () => { clearTimeout(dodgeTimer); dodgeTimer = setTimeout(dodgeChromeFromCalc, 200); };
          calcDodgeNudge = scheduleDodge;
          initCalcDodge({ frame: window.frameElement, pw: window.parent, onHoleChange: scheduleDodge });
        }
      } else {
        dockCbar(12);
      }
      els.notesPane.style.width = ""; // the grid drives width in embed; drop any standalone width from prefs
    }
    // Wire the floating notes window (embed-only — must run AFTER initEmbed sets body.embedded),
    // then stage its geometry: overlay always offers notes as a floating panel (revealed by the
    // Notes button); B/standalone restore the saved floating position from prefs.
    // savePrefs is wrapped so every committed notes move/resize also nudges the pane out of an
    // active calculator hole (calcDodgeNudge is a no-op outside the armed overlay).
    initNotesDock({ els, $, savePrefs: () => { savePrefs(); calcDodgeNudge(); }, relayoutSketches });
    if (document.body.classList.contains("overlay")) {
      // Notes: a scratch area below the question, open by default. Restore the size/position the
      // student last left it at (persisted via savePrefs on drag/resize); else the full-width default.
      const stage = $("stage");
      const sw = stage.offsetWidth || 360, sh = stage.offsetHeight || 520;
      if (!READONLY) {
        // R1/R4: editable notes always stage at the TOP of the visible band. A saved DRAG position is
        // intentionally NOT restored — a spot saved under a taller/scrolled question loaded off-screen (the
        // reported bug). Notes are scratch, so nothing needs to persist; they open at the band top anyway, and
        // toggleNotes re-verifies the band on every open. This is just the staged geometry for that first open.
        placeNotesAtBandTop();
      } else {
        // READONLY (graded inline view): anchor the strip below the question prose (measured on the parent
        // host) — a saved editing-drag spot could land it mid-prose. Stage-y aligns 1:1 with host-y.
        let proseBottom = 0;
        try {
          const host = overlayHost();
          if (host) {
            const hb = host.getBoundingClientRect();
            for (const c of host.children) {
              const r = c.getBoundingClientRect();
              if (r.height > 0) proseBottom = Math.max(proseBottom, r.bottom - hb.top);
            }
          }
        } catch { /* not same-origin / no host — fall through to the fixed default */ }
        let top = proseBottom > 0 ? proseBottom + 12 : Math.max(8, sh - 330);
        top = Math.min(Math.max(8, top), sh - 160); // always leave room for the pane itself
        floatNotes(8, top, Math.max(280, sw - 16), Math.max(150, sh - top - 8));
      }
      // Notes default HIDDEN. They're SCRATCH (never saved), so there's nothing to restore, and popping them
      // up on load — especially on a long, multi-screen question — was intrusive. The student opens them with
      // the Notes button, and a snip auto-reveals them (revealNotes); the position is already staged above for
      // when they do. Read-only submissions carry no saved notes, so there's nothing to show either.
      toggleNotes(false);
    } else {
      const nf = (prefs && prefs.notesFloat) || {};
      if (nf.on && document.body.classList.contains("embedded")) {
        floatNotes(parseFloat(nf.left) || 12, parseFloat(nf.top) || 48,
                   parseFloat(nf.width) || 340, parseFloat(nf.height) || 320);
      }
    }
    // #15: any ?file= present routes to the reference opener (which shows a kind message and leaves
    // the normal Open UI if the value is invalid); the ?open picker-popper runs only when ?file is
    // absent. Branch on PRESENCE, not validity, so a malformed link still gets feedback.
    if (new URLSearchParams(location.search).has("file")) openReferenceFile();
    else autoOpenIfRequested(); // "Open in a new tab" → pop the file picker here
    idbPrune(); // bound the autosave store (keep the most-recent snapshots)
  })
  .catch((e) => {
    console.error("WASM init failed:", e);
    status(`Failed to start: ${e?.message || e}`);
  });
