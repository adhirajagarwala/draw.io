// Scribble — thin JS glue layer. All annotation logic lives in Rust/WASM.
// No network calls except loading local static assets. No storage of student
// content outside explicit file downloads.

// Bump with index.html's ?v= references on every release (cache busting).
const APP_VERSION = "190";
// Boot-evaluation stamp AND single-boot guard (v175 review A1, blocker). The parent-side watchdog may
// re-inject this module's script tag into a wedged document. It injects the SAME URL, so the module map's
// evaluate-at-most-once rule already makes double-boot structurally impossible — this guard is the belt for
// any OTHER path that ever evaluates a second copy in a booted realm (two apps on one canvas = two save
// loops racing one hidden input = student data corruption). It must run BEFORE any listener registration;
// the window error filter below swallows the marker so no student-visible banner appears. History: the v173
// IN-IFRAME reload watchdog was an outage (about:srcdoc reloads land blank) — recovery is parent-side only.
if (window.__scribbleBooted) throw new Error("scribble-duplicate-boot-suppressed");
window.__scribbleBooted = true;

// wasm-bindgen glue. Its ?v= is a MANUAL counter — bump it WITH APP_VERSION on every
// release (the glue is regenerated whenever the Rust/wasm changes; a stale glue cached
// against fresh JS — e.g. missing a newly-added export — is this project's most-repeated
// bug). See CLAUDE.md rule 2. The wasm binary itself is versioned at the init() call below.
import init, { App } from "./pkg/scribble.js?v=190";
import {
  bytesToB64,
  b64ToBlob,
  b64ToBlobUrl,
  autoGrow,
  looksLikeText,
  wrapLine,
  sha256Hex,
} from "./utils.js?v=190";
import { buildPdf, canvasJpegBytes } from "./pdf-writer.js?v=190";
import { initEmbed } from "./embed.js?v=190";
import { idbGet, idbPut, idbDelete, idbPrune } from "./idb.js?v=190";
import { htmlTextInRegion, overlayTextInRegion, pdfTextInRegion } from "./text-extract.js?v=190";
import { confirmOpenDialog, showClippingLightbox, confirmSnip, confirmDialog } from "./modals.js?v=190";
import { initColorBar, isCbarDocked, dockCbar, clampContextBar, setCbarCollapsed } from "./colorbar.js?v=190";
import { initNotesDock, isNotesFloating, floatNotes, clampNotes, setNotesCollapsed, isNotesCollapsed, setRailClear } from "./notes-dock.js?v=190";
import { makeFloating, clampFixed } from "./floating-panel.js?v=190";
import { computeOverlayPE } from "./overlay-pe.js?v=190";
import { makeResizable } from "./rail-resize.js?v=190";
import { makeOverflow } from "./rail-overflow.js?v=190";
import { initCalcDodge, calcHoles } from "./calc-dodge.js?v=190";
import { visibleBand, clampIntoBand, MARGIN } from "./visible-band.js?v=190";

// PrairieLearn read-only mode: a past submission is displayed but not editable.
// The srcdoc injects window.__SCRIBBLE_READONLY before this module runs (inline
// head script, ahead of the CSP meta). All edit entry points short-circuit on it.
const READONLY = !!window.__SCRIBBLE_READONLY;

// v182: the STANDALONE Scribble is a LOCKED reference tool BY DEFAULT — no Open/Save/Resume/Export ever
// appear and no other file can be opened; it loads only the validated ?file= reference (chosen per exam).
// This is a served-in property of the deployment, not a URL flag, so a student can't strip it.
//
// Crucially this must NEVER lock the PL OVERLAY/EMBED: pl-scribble.py builds the overlay by READING this same
// index.html and wrapping it as a srcdoc, so the meta below rides along — but the overlay/embed inject
// __SCRIBBLE_PL / __SCRIBBLE_EMBED before this module runs and load the question via config (not file buttons),
// so we gate on that FIRST and leave them entirely alone (their own chrome already hides the file actions).
//
// Escapes a real-host student can't use: an explicit `<meta name="scribble-locked" content="false">` ships a
// FULL standalone annotator; on localhost only, `?unlock` gives a dev the full tool. A real-host ?unlock is
// ignored, and `window.__SCRIBBLE_LOCKED` / meta content="true" force the lock even on localhost.
// _sbEmbedded is GLOBALS-ONLY on purpose (v182 review): it deliberately does NOT honor the ?embed / ?overlay
// query the way embed.js does. Recognizing ?embed here would let a student strip the lock with
// `…/index.html?embed&open` (embed mode leaves body.locked off; ?open then pops the picker). Every REAL embed
// (pl-scribble.py srcdoc) injects __SCRIBBLE_EMBED as an inline <script> before this deferred module, so the
// global is always set first — a query-only embed on a real host is a localhost-dev construct only.
const _sbEmbedded = !!(window.__SCRIBBLE_PL || window.__SCRIBBLE_EMBED);
const _sbMetaLock = document.querySelector('meta[name="scribble-locked"]')?.content;
const _sbLocalhost = ["localhost", "127.0.0.1", ""].includes(location.hostname) || location.protocol === "file:";
let LOCKED_BUILD;
if (_sbEmbedded) LOCKED_BUILD = false;                                    // overlay / embed: never (own chrome)
else if (window.__SCRIBBLE_LOCKED || _sbMetaLock === "true") LOCKED_BUILD = true;  // forced lock
else if (_sbMetaLock === "false") LOCKED_BUILD = false;                   // explicit full-tool build
else if (_sbLocalhost && new URLSearchParams(location.search).has("unlock")) LOCKED_BUILD = false; // dev only
else LOCKED_BUILD = true;                                                 // DEFAULT: standalone is a locked ref tool
if (LOCKED_BUILD) document.body.classList.add("locked"); // early: no flash of the soon-hidden file actions

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
  if (typeof ev.message === "string" && (ev.message.includes("ResizeObserver loop")
      || ev.message.includes("scribble-duplicate-boot"))) return; // benign: A1 guard aborting a duplicate evaluation
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
  bootSplash: $("boot-splash"),
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
  mode: { draw: $("seg-draw"), answer: $("seg-answer") }, // v184 #3: Draw⇄Answer switch
};

// Tools that exist only in the UI layer (the Rust core stays in a neutral
// tool while they're active).
const JS_TOOLS = new Set(["snip"]);
// v171 Customize (the More-menu checklist): CLOSED id sets, mirroring the closed-enum discipline everywhere
// else. v173 (professor's decision): EVERY tool is uncheckable — no protected rows. Hidden is still never
// lost: an unchecked tool's row stays in More → Customize, one re-check restores it, and Reset restores all.
// The armed-tool fallback in applyToolVisibility keeps a hidden tool from staying invisibly armed.
// CUSTOMIZABLE is the only set a saved `toolsHidden` pref is validated against on read (closed enum).
// NB "Done" is the parent page's Annotate pill, not a rail tool — it has no row here by design.
const PROTECTED_TOOLS = new Set([]); // v173: empty by decision — kept as the mechanism for any future essential
const CUSTOMIZABLE_TOOLS = new Set(["select", "pen", "highlighter", "text", "eraser", "snip"]);
// v172: PHASE 1 (toolbar reparent) is ON — the professor's decided direction ("float like Done"). #rail moves
// out to the parent PL page so position:fixed follows the real browser viewport: the bar can leave the question
// card, sit over PL chrome once dragged, and never scrolls away. Prerequisites that made this flippable:
// the execution-readiness audit's pre-fixes (annotate-gated parent keydown, element-derived realm in
// placeMorePop, railLayout dispose, v170's unconditional pagehide dispose), chrome.css reconciled against the
// v171 layout and UN-EXCLUDED from deploy (it 404'd before), and the Done weld + ownership split with
// pl-scribble.py's sizer (it skips its FAB positioning when it sees our host; app.js welds Done into
// .rail-actions while annotate-active). The notes pane deliberately STAYS in the iframe this release.
const PHASE1_CHROME_REPARENT = true;
// (v171: the v166 wrap-vs-More overflow TRIAL is over — More won. One overflow model, one manual control: the
// width-drag handle. The presets, the wrap mode, and the student-facing A/B toggle are deleted.)
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
// v166: re-derive the toolbar fit after anything that changes tool sizes (e.g. "Larger controls").
// Module-scope hook because applyBig() is module-scope while railLayout lives in the rail-init closure.
let railRefit = () => {};
// Notes always land at the DEFAULT spot the first time they appear on a page load (Notes button, a snip's
// revealNotes, or hydrated notes) — never at a stale saved position that could be off-frame.
let notesFirstShow = true;
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
const HTML_MAX_BACKING = 16000; // safe single-canvas dimension ceiling (HTML page)
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

// v187: boot splash for the slow STANDALONE load (wasm + PDF.js + fetch). Both helpers are idempotent so any
// number of ready/error paths can call hideBootSplash() safely. A fail-safe timeout guarantees the splash can
// never get stuck covering the tool (fail-invisible), even if a boot step hangs or throws before a hide fires.
let bootSplashTimer;
function showBootSplash(msg) {
  if (!els.bootSplash) return;
  const m = els.bootSplash.querySelector(".bs-msg");
  if (m && msg) m.textContent = msg; // textContent only — never HTML
  els.bootSplash.hidden = false;
  clearTimeout(bootSplashTimer);
  bootSplashTimer = setTimeout(hideBootSplash, 20000); // never strand the splash over the tool
}
function hideBootSplash() {
  clearTimeout(bootSplashTimer);
  if (els.bootSplash) els.bootSplash.hidden = true;
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
    annoCanvas.addEventListener("pointercancel", onAnnoPointerCancelOwned); // PTR-1: pid-filtered
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
    hideBootSplash(); // v187: PDF rendered — clear the standalone boot splash
    els.placeholder.hidden = true;
    els.wrap.hidden = false;
    enableDocUI({ thumbs: true, pageNav: true });
    updateContextBar(activeTool());
    els.thumbs.textContent = "";
    // Show the page thumbnails by default for any multi-page document (they're
    // the primary way to see where your marks are and to jump around).
    els.thumbs.hidden = doc.numPages <= 1;
    els.btn.thumbs.classList.toggle("active", !els.thumbs.hidden);
    renderNotes();
    if (restored && app.notes_len() > 0 && els.notesPane.hidden) toggleNotes(true);
    if (isContinuous()) await renderContinuous(); else await renderPage();
    // v189: build thumbnails AFTER the document paints — they render N low-scale pages through the shared render
    // lock, so building them first delayed time-to-first-content (the doc the student actually opened).
    if (!els.thumbs.hidden) await buildThumbnails();
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
    hideBootSplash(); // v187: HTML doc rendered — clear the standalone boot splash
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
         (basePage.h * s * ratio > HTML_MAX_BACKING ||
          basePage.w * s * ratio > HTML_MAX_BACKING)) ratio -= 1;
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
    // The owning press ended and we missed the pointerup. This is a FINISHED gesture, not a broken one —
    // COMMIT it (v173, same disease and same cure as the v170 toolbar snap-back): on release Chrome can
    // dispatch a trailing pointermove with buttons:0 BEFORE the pointerup, and cancelling here erased the
    // whole stroke the instant the pen lifted — worst on fast strokes ("the ink disappears the minute I
    // finish"). endStroke commits ink/snip/marquee/drags at their current state and is idempotent, so the
    // real pointerup arriving a moment later is a clean no-op. Genuine interruptions still cancel via the
    // pointercancel listener below.
    if (!(ev.buttons & 1)) { endStroke(ev); return; }
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

// PTR-1 (audit, medium): a pointercancel from a NON-owning contact — canonically a rejected palm's OS
// cancel while the pen is mid-stroke — must clean up only ITS OWN bookkeeping, never nuke the live gesture
// (that erased in-flight strokes: the v173 disease via a third route). SketchView has carried this exact
// filter for versions, with a comment naming this bug. The ev=null wholesale-reset path stays untouched.
function onAnnoPointerCancelOwned(ev) {
  const owns = ev.pointerId === drawingPointerId || ev.pointerId === gesturePointerId;
  if (owns) { onAnnoPointerCancel(ev); return; }
  activePointers.delete(ev.pointerId);
  if (ev.pointerType === "pen") penActive = [...activePointers.values()].includes("pen");
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
els.annoCanvas.addEventListener("pointercancel", onAnnoPointerCancelOwned); // PTR-1: pid-filtered

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
  // v186: copy the whole-page raster IN-GESTURE — build the Promise<Blob> and hand it straight to ClipboardItem
  // so write() runs inside the click. An `await capturePageCanvas()` before write() (the old code, via capture())
  // drops the user-activation and WebKit rejects. No blob: fetch here — the raster is a fresh canvas Blob.
  item("Copy image", () => {
    if (!(navigator.clipboard?.write && window.ClipboardItem)) { status("Couldn't copy — the browser blocked clipboard access."); return; }
    status("Capturing the page…");
    // Distinguish a capture failure from a clipboard block via a flag (not err.message — write() often rejects
    // with a generic DOMException). Keep the write IN-GESTURE: do NOT await capturePageCanvas() before write().
    let captureFailed = false;
    const pngP = capturePageCanvas().then((c) => {
      if (!c) { captureFailed = true; throw new Error("capture failed"); }
      return new Promise((res, rej) => c.toBlob((b) => b ? res(b) : (captureFailed = true, rej(new Error("toBlob failed"))), "image/png"));
    });
    navigator.clipboard.write([new ClipboardItem({ "image/png": pngP })])
      .then(() => status("Page image copied to the clipboard."))
      .catch(() => status(captureFailed ? "Couldn't capture the page." : "Couldn't copy — the browser blocked clipboard access."));
    pngP.catch(() => {}); // rejection is surfaced via write()'s catch (branched on captureFailed); mark handled
  });
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
  const DEFW = 400, DEFH = 240; // small default (user pref): a compact, short floating textbox, NOT full-width
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
    // Preview the clip + let the student see what was grabbed and choose whether to keep the recognised
    // text as its caption, before it lands in the notes. (Revoke the preview URL either way.)
    const previewUrl = URL.createObjectURL(blob);
    let choice;
    try { choice = await confirmSnip(previewUrl, finalText); }
    finally { URL.revokeObjectURL(previewUrl); }
    if (!choice.add) { status("Snip discarded."); return; }
    const keepText = choice.includeText && !!finalText;
    const caption = keepText ? finalText : ""; // "image only" → no caption text under the clip
    // v189: encode to base64 only AFTER the student commits (was above the discard check, so a cancelled snip
    // paid a full multi-MB btoa for nothing). The preview above uses the Blob via previewUrl, not b64.
    const b64 = bytesToB64(new Uint8Array(await blob.arrayBuffer()));
    // Store the on-screen CSS-px size the region occupied so the note renders at SOURCE size, not the
    // 2-4x high-DPI raster (which made snips render ~2x too big).
    app.add_clipping(b64, snipPage, caption, Math.round(w * snipScale), Math.round(h * snipScale));
    renderNotes();
    revealNotes();

    // Best-effort: also put the image on the system clipboard — AND, v179 item 2a, the recognized text as a
    // text/plain flavor. The analysis already ran (finalText); carrying it means a later paste into notes
    // fills the caption in one step (no separate "analyze" action). Independent of the snip-time keepText
    // choice: the clipboard is a distinct channel, and text is only attached when there genuinely is some.
    // v181: track whether the auto-copy actually landed so the status can tell the truth — a paste after a
    // failed/absent copy would silently do nothing. The per-clip "Copy" button (fresh user gesture, writes
    // image + text) is the reliable fallback, so a miss here is never a dead end.
    let copied = false;
    try {
      if (navigator.clipboard?.write && window.ClipboardItem) {
        const parts = { "image/png": blob };
        if (finalText) parts["text/plain"] = new Blob([finalText], { type: "text/plain" });
        await navigator.clipboard.write([new ClipboardItem(parts)]);
        copied = true;
      }
    } catch { /* auto-copy is best-effort (activation/permission) — the clip's Copy button is the reliable path */ }
    // Overlay drops cross-origin question images from the raster (regionHasBrokenImage is a no-op there,
    // since Scribble's own iframe is empty) — use the raster's own drop-count instead.
    const imgWarn = (snipMode === "html" && (document.body.classList.contains("overlay")
      ? overlaySnipDropped > 0 : regionHasBrokenImage(x0, y0, x0 + w, y0 + h)))
      ? " (some external images couldn't be captured)" : "";
    const copyHint = copied ? " · copied — paste into your answer" : " · press Copy on the clip to copy it";
    status((keepText ? "Snipped — image and text added to notes." : "Snipped — image added to notes.") + imgWarn + copyHint);
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
  // Return the open promise so a caller (openReferenceFile) can await completion and run cleanup afterward.
  // openPdf/openHtml catch their own failures (they RESOLVE, not reject), so awaiting is safe and never throws.
  return (/\.html?$/i.test(f.name) || f.type === "text/html") ? openHtml(f) : openPdf(f);
}

els.filePdf.addEventListener("change", () => {
  const f = els.filePdf.files[0];
  els.filePdf.value = "";
  if (document.body.classList.contains("locked")) return; // v181: belt — the reference load bypasses this picker (routeOpen direct)
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

// v182: in a LOCKED build these failure messages must NEVER point at the (hidden) Open button, and — because
// status() auto-clears after 4s while routeOpen never runs to hide the placeholder — they must ALSO write a
// persistent line into the center placeholder so the student isn't left staring at "Open a PDF…" next to a
// button that doesn't exist (v182 review #2/#3).
function refFail(msg) {
  hideBootSplash(); // v187: the reference didn't load — clear the splash so this message is visible
  status(msg);
  if (LOCKED_BUILD && els.placeholder) els.placeholder.textContent = msg;
}
async function openReferenceFile() {
  const req = refFileRequest();
  if (!req) {
    refFail(LOCKED_BUILD
      ? "This reference link is invalid — ask your instructor for the correct link."
      : "That reference link isn't valid — you can open a file yourself with the Open button.");
    return;
  }
  document.body.classList.add("locked"); // before any await: no flash of the soon-hidden file actions
  try {
    status(`Loading ${req.name}…`);
    const r = await fetch(req.url); // same-origin credentialed — PL enforces its own access windows
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { httpStatus: r.status });
    const blob = await r.blob();
    const fallbackType = /\.html?$/i.test(req.name) ? "text/html" : "application/pdf";
    await routeOpen(new File([blob], req.name, { type: blob.type || fallbackType }));
    // openPdf/openHtml swallow a render failure (corrupt/truncated PDF, size/page cap) — they RESOLVE, so this
    // is never caught below. Detect it here and give the LOCKED tool a proper message + placeholder rather than
    // the default "Open a PDF…" that points at a hidden Open button (restores the v182 no-mispoint design).
    if (!docOpen()) refFail(LOCKED_BUILD
      ? "The reference couldn't be displayed — reload to try again."
      : "That file couldn't be displayed — you can open a file yourself with the Open button.");
  } catch (e) {
    // A dead SOFT-locked tool (?file= only) would strand the student mid-exam — unlock and fall back to the
    // normal Open UI. But a HARD deploy lock (LOCKED_BUILD) must STAY locked: v181 review caught that
    // unlocking here on a pre-window 403 / offline fetch would re-expose Open/Save/Export and defeat the
    // guaranteed lock. So only the soft lock unwinds; the hard lock just reports and stays sealed.
    if (!LOCKED_BUILD) document.body.classList.remove("locked");
    refFail(e?.httpStatus === 403
      ? "That reference isn't available yet — it may unlock when the assessment opens."
      : (LOCKED_BUILD
        ? "The reference file couldn't be loaded — reload to try again."
        : "The reference file couldn't be loaded — you can open a file yourself with the Open button."));
  } finally {
    // Guarantee the boot splash clears once the open ATTEMPT concludes (success, swallowed render failure, or
    // fetch error) — otherwise a render failure would strand it until the 20s fail-safe (v187 review finding).
    hideBootSplash();
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

// ---------- v179 item 4: "Answering" pause — draw ↔ answer without leaving annotate mode ----------
// A THIRD overlay state between Annotate-ON and Done. Because the toolbar is reparented into the PARENT page
// (PHASE1_CHROME_REPARENT), setting the IFRAME element to pointer-events:none makes the whole question
// answerable (clicks/typing fall through) while the toolbar stays clickable — so the student answers with the
// bar still up, then resumes drawing. Esc pauses; clicking any tool (or its P/H/T/E/V/S key, which routes
// through the same click) resumes. Notes stay live (they float in the iframe but the pane is not the input).
// Single writer of the iframe's pointer-events DURING a session: the parent sizer only rewrites it on the
// Annotate/Done transition, which also resets this state (ON/OFF branches below).
let annotatePaused = false;
let modeHintsShown = 0; // v185: brief Draw/Answer teach only for the first couple of mode switches, then silent (the visible toggle shows the mode)
// v180 item 1: the in-session writer of the iframe's pointer-events. The iframe CAPTURES (pe:auto) only when
// the student is actively drawing — annotate ON and not paused — so at every other time answers/clicks fall
// THROUGH to the question (pe:none). Two overrides, in precedence order:
//   • A MODAL rendered INSIDE the iframe (Help / clipping lightbox / prompt) ALWAYS forces capture, or its
//     ✕/backdrop are dead and Esc is unreachable (the reported "can't minimise help" — it happened while the
//     Answering pause had set pe:none, and also latently after Done where the parent sets pe:none).
//   • Otherwise the base is: Done (no annotate-active) → pass through; Answering pause → pass through; drawing
//     → capture. This mirrors the parent sizer's Annotate/Done base, so re-asserting it on modal-close never
//     strands the iframe capturing over a finished question.
// Call this whenever a modal opens/closes or the pause toggles — never write frameElement.pe directly.
// v183 (Fable audit): the decision is a PURE function (overlay-pe.js, truth-table tested). This wrapper only
// reads the five live DOM signals; ALL the branching lives in computeOverlayPE so a regression is caught by a
// unit test, not a live exam. (helpOverlay is declared later in the module — fine, this only runs at runtime.)
function iframeShouldCapture() {
  return computeOverlayPE({
    overlay: document.body.classList.contains("overlay"),
    annotating: document.body.classList.contains("annotate-active"),
    paused: annotatePaused,
    helpOpen: !helpOverlay.hidden,
    modalOpen: !!document.querySelector(".modal-overlay:not([hidden])"),
  });
}
function syncIframePE() {
  try { if (window.frameElement) window.frameElement.style.pointerEvents = iframeShouldCapture() ? "auto" : "none"; } catch { /* cross-frame */ }
}
// v184 #3: reflect the live Draw⇄Answer state onto the visible segmented switch (Draw active when NOT paused).
// Called from setAnnotatePaused (every state change) AND the Annotate-ON transition (fresh entry), so the
// switch is never stale. Realm-safe: els.mode.* are the SAME nodes whether the rail is in the iframe or the
// reparented parent host (they travel with the reparent), and toggling a class needs no realm awareness.
function syncModeSeg() {
  const drawing = !annotatePaused;
  els.mode.draw?.classList.toggle("active", drawing);
  els.mode.draw?.setAttribute("aria-pressed", String(drawing));
  els.mode.answer?.classList.toggle("active", !drawing);
  els.mode.answer?.setAttribute("aria-pressed", String(!drawing));
}
function setAnnotatePaused(paused) {
  if (!document.body.classList.contains("overlay") || !document.body.classList.contains("annotate-active")) return;
  // v179 F4: pause blanks the IFRAME's pointer-events — only safe when the toolbar is REPARENTED into the
  // parent page (railHostEl set), so the bar stays clickable. If the toolbar still lived in the iframe,
  // pausing would disable it too. (PHASE1 reparent is on in production, so this is a defensive guard.)
  if (!railHostEl) return;
  if (annotatePaused === paused) return;
  annotatePaused = paused;
  document.body.classList.toggle("annotate-paused", paused);          // iframe realm (CSS cue on canvas cursor)
  railHostEl?.classList.toggle("annotate-paused", paused);            // parent realm (dims the reparented rail)
  syncIframePE();                                                     // v180 item 1: modal-aware pe (never traps a modal)
  syncModeSeg();                                                      // v184 #3: reflect Draw/Answer on the visible switch
  // v185 (user): the visible Draw/Answer switch NOW shows the mode, so the status line is redundant noise on
  // every toggle — reduce it to a brief FIRST-TIME teach (a couple of switches, either direction), then stay
  // silent and let the toggle speak. No status() call at all once taught, so no empty box lingers.
  if (modeHintsShown < 2) {
    modeHintsShown++;
    status(paused ? "Answering — click the question to type your answer." : "Back to drawing.");
  }
}
// v184 #3: the visible switch drives the SAME setAnnotatePaused as Esc and clicking a tool — one state writer.
// (setAnnotatePaused no-ops off-overlay / pre-reparent, so these are inert in standalone/embed where the
// switch is hidden anyway.)
els.mode.draw?.addEventListener("click", () => setAnnotatePaused(false));
els.mode.answer?.addEventListener("click", () => setAnnotatePaused(true));

for (const b of document.querySelectorAll(".tool")) {
  b.addEventListener("click", () => {
    if (!b.dataset.tool) return; // not a mode (e.g. the Undo/Redo rail actions reuse .tool styling)
    if (annotatePaused) setAnnotatePaused(false); // v179 item 4: clicking any tool resumes drawing
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
    savePrefs(); // v181: remember the selected tool across reloads (snip is guarded on restore)
  });
}

// v180 item 4b: the ⓘ ("About") now OPENS THE SHORTCUTS MODAL, not a separate tooltip. The modal's footer
// already carries the attribution, so one bar button surfaces BOTH shortcuts and credit — shortcuts are now
// one click on the bar (default-visible) instead of buried in the More menu. The old anchored About popover
// is removed from index.html; these closer vars stay declared (and no-op) because the Phase-1 reparent (B3-4)
// still references them when registering parent-realm listeners — harmless no-ops now.
let closeAbout = () => {};
let closeAboutOnOutsideClick = () => {};
let closeAboutOnEscape = () => {};
{
  const aboutBtn = $("btn-about");
  if (aboutBtn) {
    aboutBtn.removeAttribute("aria-expanded");          // it toggles a modal dialog now, not a disclosure
    aboutBtn.setAttribute("aria-haspopup", "dialog");
    aboutBtn.title = "Keyboard shortcuts & about";
    aboutBtn.setAttribute("aria-label", "Keyboard shortcuts and about");
    // No stopPropagation: the click must still reach the document closers so opening this auto-closes an
    // open More popover (each closer excludes its own button). toggleHelp is a hoisted declaration.
    aboutBtn.addEventListener("click", () => toggleHelp());
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
// v180 item 2: the student can remove the colour/width strip from the toolbar via Customize (like a tool).
// Session+persisted pref; when true, updateContextBar keeps the strip hidden regardless of the active tool.
let coloursHidden = false;
function updateContextBar(tool) {
  // Overlay folds the colour strip into the one merged tool bar → keep it persistent (no reflow
  // as tools change). Docked behaves the same; floating stays contextual to the marking tools.
  const overlay = document.body.classList.contains("overlay");
  const show = !coloursHidden && docOpen() && (overlay || isCbarDocked() || MARKING_TOOLS.has(tool));
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
    savePrefs(); // v181: remember the chosen width across reloads
  });
}

for (const s of document.querySelectorAll("#colors .swatch")) {
  s.addEventListener("click", () => {
    if (!app.set_color(s.dataset.color)) return;
    railRoot.querySelectorAll("#colors .swatch").forEach((x) => x.classList.remove("active"));
    s.classList.add("active");
    syncAria();
    savePrefs(); // v181: remember the chosen colour across reloads
  });
}

els.btn.undo.addEventListener("click", () => { app.undo(); redrawAnnotations(); renderNotes(); }); // v179: notes list too
els.btn.redo.addEventListener("click", () => { app.redo(); redrawAnnotations(); renderNotes(); });
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
    await renderContinuous(); // v189: renderContinuous already restores the reader's page (scrollToContPage) —
    // the extra goToPage(pageNum) here was a redundant second scrollTop write + geometry read.
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
    renderNotes(); // v179 item 2b: an undone/redone note delete must re-appear in the notes list, not just the canvas
  } else if (mod && key === "y") {
    ev.preventDefault();
    app.redo();
    redrawAnnotations();
    renderNotes();
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
    // v179 item 4: Esc cancels the topmost in-progress thing; if there's nothing to cancel, it TOGGLES the
    // Answering pause (pause → answer with the bar up; press again, focus permitting, to resume). The reliable
    // resume is clicking a tool, since a key pressed while a PL input is focused never reaches this handler.
    let cancelled = false;
    if (snip) { snip = null; redrawAnnotations(); cancelled = true; } // cancel an in-progress snip
    if (marquee) { marquee = null; redrawAnnotations(); cancelled = true; } // cancel an in-progress marquee
    if (selectedIds.size > 0) { setSelection(-1); cancelled = true; }
    if (activeSketch && activeSketch.selected >= 0) {
      activeSketch.selected = -1;
      activeSketch.draw();
      cancelled = true;
    }
    if (!cancelled && document.body.classList.contains("annotate-active")) setAnnotatePaused(!annotatePaused);
  } else if (!mod && ev.key === "?") {
    ev.preventDefault();
    toggleHelp(true);
  } else if (!mod && TOOL_KEYS[key]) {
    // v180 item 4a: a tool key TOGGLES. Pressing the ACTIVE tool's own key again defocuses it → Select
    // (neutral, no ink). Two guards: (1) Select itself never toggles-to-Select (no-op), and (2) while the
    // Answering pause is on, the same key RESUMES drawing (arms the tool) instead of landing on neutral —
    // so a student answering re-enters their tool with one keystroke, not two.
    const want = TOOL_KEYS[key];
    const target = (!annotatePaused && want !== "select" && activeTool() === want) ? "select" : want;
    const btn = railRoot.querySelector(`[data-tool="${target}"]`);
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
  // v179 item 2b: delete is now UNDOABLE (Ctrl/Cmd+Z, one Rust stack) — so the blocking "can't be undone"
  // modal is gone. Delete immediately, then a non-blocking toast advertises Undo so a mis-click is never
  // silent loss. (Redraw the canvas too: deleting a sketch note removes a drawing surface.)
  mk("✕", "Delete block", () => {
    if (READONLY) return; // v179 F2: no editing in a read-only submission view (undo is disabled there too)
    if (app.remove_note(i)) {
      renderNotes();
      redrawAnnotations();
      status("Note deleted — press Ctrl/⌘+Z to undo.");
    }
  }, READONLY);
  return wrap;
}

// (v179 item 2b: noteDeleteNeedsConfirm + the delete-confirm modal are retired — delete is undoable now,
// so a mis-click is recoverable with Ctrl/Cmd+Z rather than gated behind a blocking "can't be undone" nag.)

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
    // v173: a missed release COMMITS the sketch stroke (same cure as the main canvas above / the v170
    // toolbar) — cancelling here erased fast notes-ink the instant the pen lifted. up() is pid-guarded
    // and idempotent, so the real pointerup that may still arrive is a clean no-op.
    if (!(ev.buttons & 1)) { this.up(ev); return; }
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

// Re-encode a PNG Blob through a canvas so the clipboard receives a CANVAS-NATIVE image Blob. Verified in
// Chromium (and Safari is historically strict too): clipboard.write() rejects a hand-CONSTRUCTED image/png Blob
// (atob -> Uint8Array -> new Blob, i.e. b64ToBlob) with DataError "Failed to read or decode…", yet accepts a
// canvas-produced Blob for the exact same pixels — which is why the snip-time auto-copy (out.toBlob, works) and
// the page "Copy image" (capturePageCanvas, works) both succeed while the per-clip Copy (b64ToBlob) did not.
// Pixel-lossless here (the snip raster is opaque, white-filled — no premultiplied-alpha rounding). Returns a
// Promise<Blob> so the caller hands it straight to ClipboardItem and keeps write() in-gesture.
function pngToCanvasBlob(blob) {
  if (!blob) return Promise.reject(new Error("no image"));
  return createImageBitmap(blob).then((bmp) => {
    try {
      const c = document.createElement("canvas");
      c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.drawImage(bmp, 0, 0); // pixels are copied into the canvas here — safe to close the bitmap next
      return new Promise((res, rej) => c.toBlob((b) => b ? res(b) : rej(new Error("re-encode failed")), "image/png"));
    } finally {
      bmp.close?.(); // release even if getContext/drawImage throws (was leaked on that error path)
    }
  });
}

// Copy a PNG to the system clipboard, in-gesture. `blobSrc` is a Blob OR a Promise<Blob> (a canvas raster /
// re-encode). Two hard rules, both learned the hard way (v186):
//   1. NEVER fetch a blob:/data: URL to get the bytes. The app CSP is `default-src 'self'` with no connect-src,
//      so fetch("blob:…") is BLOCKED on every browser (TypeError) — that (not a gesture quirk) is what made the
//      old per-clip Copy fail EVERY time while the snip-time auto-copy (which used the Blob directly) still put
//      the image on the clipboard, i.e. the "says Couldn't copy but it pasted" bug.
//   2. Call write() SYNCHRONOUSLY in the click and let ClipboardItem await the Promise — an `await` before write()
//      drops the user-activation and Safari/unfocused-Chrome reject. Passing a Blob/Promise keeps write in-gesture.
// v181 intent kept: carry the caption as text/plain so a rich PL editor pastes the image and a plain <textarea>
// pastes the text; a few engines reject that mixed item though, so on failure we retry image-only before crying.
async function copyImageToClipboard(blobSrc, btn, text) {
  // Stable original label + a single cancellable timer per button, so rapid re-clicks can't capture a transient
  // caption ("Copied ✓"/"Couldn't copy") as the label or leave a stale restore that re-shows a false failure.
  if (btn && !btn.dataset.origLabel) btn.dataset.origLabel = btn.textContent;
  const flash = (msg, ms) => {
    if (!btn) return;
    btn.textContent = msg;
    clearTimeout(btn._flashT);
    btn._flashT = setTimeout(() => { btn.textContent = btn.dataset.origLabel; }, ms);
  };
  const imgP = Promise.resolve(blobSrc); // normalize Blob | Promise<Blob>; a settled Blob is re-readable for the retry
  imgP.catch(() => {}); // if blobSrc is an already-rejected promise (corrupt clip), write()'s catch reports it — mark handled so no unhandledrejection
  const rich = { "image/png": imgP };
  if (text && text.trim()) rich["text/plain"] = Promise.resolve(new Blob([text], { type: "text/plain" }));
  try {
    await navigator.clipboard.write([new ClipboardItem(rich)]);
    flash("Copied ✓", 1400);
  } catch (e1) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": imgP })]);
      flash("Copied ✓", 1400);
    } catch (e2) {
      // Genuinely blocked (permission / not a secure context) — tell the student so a silent no-op paste isn't a surprise.
      console.warn("clipboard copy failed:", e1, e2);
      flash("Couldn't copy", 1900);
      status("Couldn't copy — the browser blocked clipboard access. Try again, or check the site's clipboard permission.");
    }
  }
}

// ---- #12: paste an image INTO the notes — the landing side of the reference-tab snip flow ----
// Security (§7): blob-only, decoded to pixels and re-encoded by OUR canvas (strips EXIF/polyglots);
// clipboard text/html flavors are never parsed; Rust re-validates the PNG on insert and on load.
const PASTE_B64_MAX = 2 * 1024 * 1024;   // mirror of Rust's MAX_CLIPPING_B64 — friendly-message the cap here
const PASTE_BLOB_MAX = 32 * 1024 * 1024; // absurd-input early guard before any decode work
const PASTE_EDGE_START = 2000;           // long-edge target for the first encode attempt

// v179 item 2a: `caption` carries the recognized text that rode the clipboard alongside the image (from a
// Scribble snip). It becomes the clip's caption in one step. Empty for a plain image (OS screenshot) — there
// is no OCR in the stack, so a raw bitmap has no text to analyze. Rust re-validates/clamps the caption on
// insert (§7: note text is canvas-drawn / escaped in export, never DOM HTML).
async function pasteBlobToNotes(blob, caption = "") {
  if (!docOpen() || READONLY) return;
  caption = (caption || "").slice(0, 500); // match the text-note cap; Rust clamps further
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
        app.add_pasted_clipping(b64, caption, w, h); // caption = carried recognized text (or ""); size = CSS px at scale 1
        renderNotes();
        revealNotes();
        status(caption ? "Pasted into your notes — image and its text." : "Image pasted into your notes.");
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
      if (type) {
        let text = ""; // v179 item 2a: pick up the recognized text a Scribble snip left alongside the image
        try { if (item.types.includes("text/plain")) text = await (await item.getType("text/plain")).text(); } catch { /* no text flavor */ }
        await pasteBlobToNotes(await item.getType(type), text);
        return;
      }
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
  const text = e.clipboardData?.getData("text/plain") || ""; // v179 item 2a: carry snip-recognized text as the caption
  pasteBlobToNotes(imgItem.getAsFile(), text);
});

function buildClippingBlock(div, i) {
  const img = document.createElement("img");
  // Decode the PNG bytes ONCE (Rust holds them as base64). Reused for BOTH the <img> preview and the Copy
  // button — copyImageToClipboard builds its ClipboardItem from this Blob directly (a blob:-URL fetch is
  // CSP-blocked under default-src 'self', see that function). null on a corrupt payload → broken-image, as before.
  const pngBlob = b64ToBlob(app.note_png(i));
  img.src = pngBlob ? URL.createObjectURL(pngBlob) : "";
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
  // v186: hand a CANVAS-re-encoded Blob (pngToCanvasBlob) — a constructed b64ToBlob Blob is rejected by the
  // clipboard with DataError; the canvas Blob matches the working snip auto-copy. No blob: fetch (CSP-blocked).
  copy.addEventListener("click", () => copyImageToClipboard(pngToCanvasBlob(pngBlob), copy, cap.value)); // v181 caption too
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
  // v189: the pane is hidden (the common case while drawing) → skip the expensive per-clip rebuild (each image
  // re-marshals + re-decodes its base64 across the wasm boundary). toggleNotes(true)/revealNotes set hidden=false
  // THEN call renderNotes, so a real show always rebuilds; nothing reads the list while it's hidden.
  if (els.notesPane.hidden) return;
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
        // The FIRST time notes appear on a page load they always go to the default spot (band top), however they
        // got opened — Notes button, a snip's revealNotes, or hydrated notes. After that, an in-band position the
        // student chose is respected; only a pane that has drifted out of the band gets pulled back.
        const pr = els.notesPane.getBoundingClientRect(), b = visibleBand();
        if (notesFirstShow || pr.top < b.top || pr.top > b.bottom - 36) placeNotesAtBandTop();
        else clampNotes();
        notesFirstShow = false;
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

// v190: the thumbnail strip is VIRTUALIZED — sized placeholders up front, each thumbnail's canvas rendered
// lazily via an IntersectionObserver only while near the strip's viewport, and freed when it scrolls far away.
// Mirrors the continuous-scroll virtualization (contMount/contOnIntersect/contMountVisible). Opening a long PDF
// no longer renders EVERY page's thumbnail up front through the shared render lock (the slow-load win).
let thumbIO = null;
let thumbPages = []; // i -> { base:{width,height}, mounted:bool }

async function buildThumbnails() {
  els.thumbs.textContent = "";
  thumbState.clear(); // drop any in-flight render state from the previous document
  if (thumbIO) { thumbIO.disconnect(); thumbIO = null; }
  thumbPages = [];
  if (!pdfDoc) return;
  const doc = pdfDoc;
  for (let i = 0; i < doc.numPages; i++) {
    // getPage is cheap here — the main render already parsed these pages and PDF.js caches them; the RENDER is
    // what we defer. The page aspect ratio sizes a placeholder so the strip's scrollbar + layout stay stable.
    const page = await doc.getPage(i + 1);
    if (pdfDoc !== doc) return; // document swapped mid-build
    const base = page.getViewport({ scale: 1 });
    const btn = document.createElement("button");
    btn.className = "thumb";
    btn.title = `Go to page ${i + 1}`;
    btn.dataset.page = String(i);
    const canvas = document.createElement("canvas");
    // Tiny placeholder backing at the page's aspect ratio (CSS width:100% scales it) — correct shape, ~nil
    // memory, until the observer mounts the real render.
    canvas.width = 24;
    canvas.height = Math.max(1, Math.round(24 * base.height / base.width));
    const tag = document.createElement("span");
    tag.className = "pageno";
    tag.textContent = String(i + 1);
    btn.append(canvas, tag);
    btn.addEventListener("click", () => goToPage(i));
    els.thumbs.appendChild(btn);
    thumbPages.push({ base: { width: base.width, height: base.height }, mounted: false });
  }
  thumbIO = new IntersectionObserver(thumbOnIntersect, { root: els.thumbs, rootMargin: "100% 0px" });
  for (const el of els.thumbs.children) thumbIO.observe(el);
  markActiveThumb();
  thumbMountVisible(); // render the initially-visible thumbnails synchronously (occluded/background-tab backstop)
}

// Render thumbnails within ~1 viewport of the strip; free the rest, by pure geometry — a backstop for the
// IntersectionObserver, which never fires while the tab isn't being painted.
function thumbMountVisible() {
  if (!thumbPages.length || els.thumbs.hidden) return;
  const sr = els.thumbs.getBoundingClientRect();
  const margin = els.thumbs.clientHeight; // matches the observer's 100% rootMargin
  [...els.thumbs.children].forEach((el, i) => {
    const r = el.getBoundingClientRect();
    const near = r.bottom >= sr.top - margin && r.top <= sr.bottom + margin;
    if (near) renderThumb(i); else thumbUnmount(i);
  });
}

function thumbOnIntersect(entries) {
  for (const e of entries) {
    const i = Number(e.target.dataset.page);
    if (e.isIntersecting) renderThumb(i); else thumbUnmount(i);
  }
}

// Free a thumbnail's canvas backing (reset to the tiny placeholder at the page aspect) — the button stays sized.
function thumbUnmount(i) {
  const p = thumbPages[i];
  if (!p || !p.mounted) return;
  p.mounted = false;
  if (p.renderTask) { p.renderTask.cancel(); p.renderTask = null; } // v190: cancel a superseded render (mirror contUnmount)
  const canvas = els.thumbs.children[i]?.querySelector("canvas");
  if (canvas) {
    canvas.width = 24;
    canvas.height = Math.max(1, Math.round(24 * p.base.height / p.base.width));
  }
}

// PDF.js forbids two render() calls on one canvas at once, so thumbnail
// renders are serialized per page (a re-request while busy queues one rerun).
const thumbState = new Map(); // i -> {busy, again}

async function renderThumb(i) {
  if (!thumbPages[i]) return; // not built / out of range
  const st = thumbState.get(i) || { busy: false, again: false };
  thumbState.set(i, st);
  if (st.busy) {
    st.again = true;
    return;
  }
  st.busy = true;
  thumbPages[i].mounted = true;
  try {
    const canvas = els.thumbs.children[i]?.querySelector("canvas");
    if (!canvas || !pdfDoc) return;
    const page = await pdfDoc.getPage(i + 1);
    if (!thumbPages[i]?.mounted) return; // v190: scrolled away during getPage — don't repaint an unmounted cell
    const base = page.getViewport({ scale: 1 });
    const s = THUMB_SCALE_WIDTH / base.width;
    const vp = page.getViewport({ scale: s });
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext("2d");
    // v190: store the render task (thumbUnmount cancels it) and bail if it unmounted while queued for the lock —
    // mirrors contMount/contUnmount so a superseded thumbnail render never occupies the shared lock or paints a freed cell.
    await withRenderLock(() => {
      if (!thumbPages[i]?.mounted) return Promise.resolve();
      thumbPages[i].renderTask = page.render({ canvasContext: ctx, viewport: vp, intent: "print" });
      return thumbPages[i].renderTask.promise;
    });
    app.ensure_page(i, base.width, base.height);
    app.render(ctx, i, s); // annotations visible in the overview
  } catch (e) {
    if (e?.name !== "RenderingCancelledException") console.warn("thumb render:", e); // cancellation on unmount is expected
  } finally {
    if (thumbPages[i]) thumbPages[i].renderTask = null;
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
  thumbTimer = setTimeout(() => { if (thumbPages[pageNum]?.mounted) renderThumb(pageNum); }, 800); // v190: only when the current thumb is mounted
}

els.btn.thumbs.addEventListener("click", async () => {
  els.thumbs.hidden = !els.thumbs.hidden;
  els.btn.thumbs.classList.toggle("active", !els.thumbs.hidden);
  syncAria();
  if (!els.thumbs.hidden) {
    if (els.thumbs.childElementCount === 0) await buildThumbnails();
    else thumbMountVisible(); // v190: render the now-visible thumbnails (freed while hidden)
  }
});

// v190: scroll backstop for the thumbnail strip — the IntersectionObserver is throttled when the tab isn't
// painting, so re-evaluate which thumbnails are near by geometry on scroll, exactly like the #viewer scroll
// handler backs up the continuous-page observer. setTimeout (not rAF) so it still fires in a non-painting tab.
let thumbScrollTimer;
els.thumbs.addEventListener("scroll", () => {
  clearTimeout(thumbScrollTimer);
  thumbScrollTimer = setTimeout(thumbMountVisible, 60);
}, { passive: true });

// ---------- accessibility toggles ----------

// `announce` mirrors applyPalette below: the CLICK announces, the boot-time restores stay silent (no toast on
// every reload for coarse-pointer devices). This was the professor's named bug — the toggle lives inside the
// closed More popover, so without an announce its only feedback (.active/aria-pressed) was invisible.
function applyBig(on, announce = false) {
  document.body.classList.toggle("big", on);
  railHostEl?.classList.toggle("big", on); // mirror onto the reparented rail (chrome.css .scribble-chrome.big)
  els.btn.big.classList.toggle("active", on);
  syncAria();
  clampContextBar(); // larger controls shrink the toolbar gap → re-fit a docked bar
  railRefit(); // tool widths + bar height changed → the overflow fit is stale (refit demotes into More, no overlap)
  if (announce) status(on ? "Larger controls on." : "Larger controls off.");
}
els.btn.big.addEventListener("click", () => {
  applyBig(!document.body.classList.contains("big"), true);
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
  // v180 item 1: this modal renders INSIDE the iframe. If it opens during the Answering pause (iframe
  // pe:none), its ✕/backdrop would be dead — so re-sync the iframe's pointer-events now (open → capture;
  // close → back to the pause's passthrough). Without this the Help card looked un-closable while answering.
  syncIframePE();
  // #btn-help rides inside the rail's More menu, which the overlay REPARENTS into the parent page —
  // so look it up in the rail's realm ($() would search this iframe and return null there). The ⓘ (btn-about)
  // opens the SAME modal in v180 (shortcuts merged into it), so light it up too when present.
  railRoot.querySelector("#btn-help")?.classList.toggle("active", open);
  railRoot.querySelector("#btn-about")?.classList.toggle("active", open);
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
// True only when the element gave us a REAL per-question id, i.e. PREFS_KEY is genuinely namespaced.
// v177: POSITION restore is gone (the professor's "top-center no matter what"), so nothing reads this today;
// RETAINED for the Wave-2 PREF-1 gating of width/toolsHidden restores (audit §3 #25) — do not delete.
const PREFS_PER_QUESTION = !!(window.__SCRIBBLE_PL && window.__SCRIBBLE_PL.qid); // eslint-disable-line no-unused-vars
// USER-level accessibility prefs (Larger controls, colourblind-safe palette) are NOT per-question — a shared,
// un-namespaced key so enabling them on one question applies to every question (they serve the users who
// most need consistency).
const A11Y_KEY = "scribble.a11y.v1";

// v188: pen (colour / line width / selected tool) and the toolbar's customize+size are USER PREFERENCES, not
// per-question layout — a student wants them consistent as they move through an exam. Like the a11y prefs, they
// live in this SHARED, un-namespaced key so they FOLLOW the student across questions (previously they were
// per-question, so each question reset them). What stays per-question: toolbar POSITION (restored top-center
// anyway) and notes layout (overlay notes are scratch, re-staged each load). Reads prefer this key and fall
// back to the per-question PREFS_KEY, so a pre-v188 student's last settings migrate in on first load.
const SHARED_KEY = "scribble.shared.v1";
function readShared() {
  try { return JSON.parse(localStorage.getItem(SHARED_KEY) || "{}") || {}; } catch { return {}; }
}

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
      // v181: remember the last colour / line width / selected tool (per question). Read straight off the
      // .active chips (realm-correct via railRoot). Validated + guarded on restore (applyPrefs → restorePen),
      // so a stale/edited value can never arm an invalid colour, width, or a hidden/one-shot tool.
      pen: {
        color: railRoot.querySelector("#colors .swatch.active")?.dataset.color || "",
        width: railRoot.querySelector("#widths .width.active")?.dataset.width || "",
        tool: activeTool() || "",
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
                   collapsed: r.classList.contains("fp-collapsed"),
                   // v166: chosen bar width ("" = full span). Same versioned sub-key both directions: a pre-v171
                   // object's ovMode is simply unread here (More is the only model), and a v171 object on an
                   // older bundle reads ovMode undefined → "more". Tolerant reader, no sub-key bump needed.
                   width: r.style.getPropertyValue("--rail-w") || "",
                   // v171 Customize: the DEVIATION from default — unchecked stable data-tool ids. Absent/empty
                   // = everything shown, so a future new tool defaults eligible with no migration.
                   toolsHidden: [...r.querySelectorAll(".tool.tool-off")].map((b) => b.dataset.tool).filter(Boolean),
                   // v180 Customize: the colour/width strip removed from the bar (default false = shown).
                   coloursOff: coloursHidden };
        })()
        : (prev.railFloat2 || {}),
      railFloat: prev.railFloat || {}, // carry the legacy iframe-realm key forward untouched (rollback safety)
    }));
    // v188: mirror the CROSS-QUESTION prefs into the shared key so they follow the student across questions.
    // Values read off the live rail (realm-correct via railRoot), same expressions as PREFS_KEY above. `bar` is
    // only captured in the OVERLAY (where #rail lives); elsewhere carry the last shared bar forward untouched so
    // a standalone/embed save can't wipe the overlay's toolbar customize. Collapsed is saved but the overlay
    // boot deliberately never re-applies it (R4: a bar restored collapsed is un-findable).
    const overlayRail = overlay && railRoot.querySelector("#rail");
    localStorage.setItem(SHARED_KEY, JSON.stringify({
      pen: {
        color: railRoot.querySelector("#colors .swatch.active")?.dataset.color || "",
        width: railRoot.querySelector("#widths .width.active")?.dataset.width || "",
        tool: activeTool() || "",
      },
      bar: overlayRail
        ? (() => {
          const r = railRoot.querySelector("#rail");
          return {
            collapsed: r.classList.contains("fp-collapsed"),
            width: r.style.getPropertyValue("--rail-w") || "",
            toolsHidden: [...r.querySelectorAll(".tool.tool-off")].map((b) => b.dataset.tool).filter(Boolean),
            coloursOff: coloursHidden,
          };
        })()
        : (readShared().bar || undefined), // v189: read lazily — only this non-overlay branch needs it; omit when nothing to carry
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
  // v181: restore the last colour / line width / selected tool. set_color/set_pen_width/set_tool return
  // false on an unknown value (the Rust side is a CLOSED enum), so they double as validation — a stale or
  // hand-edited pref can never arm an invalid state. The querySelector value is CSS.escape'd (defence in
  // depth against selector injection; the Rust validation is the real gate). Snip is a one-shot JS tool and
  // a Customize-hidden tool must never be armed invisibly, so both are skipped (fall back to the default pen).
  const pen = readShared().pen || p.pen || {}; // v188: prefer the shared (cross-question) pen; fall back to the per-question pref for migration
  if (pen.color) {
    const sw = railRoot.querySelector(`#colors .swatch[data-color="${CSS.escape(pen.color)}"]`);
    if (sw && app.set_color(pen.color)) {
      railRoot.querySelectorAll("#colors .swatch").forEach((x) => x.classList.remove("active"));
      sw.classList.add("active");
    }
  }
  if (pen.width) {
    const wb = railRoot.querySelector(`#widths .width[data-width="${CSS.escape(pen.width)}"]`);
    if (wb && app.set_pen_width(pen.width)) {
      railRoot.querySelectorAll("#widths .width").forEach((x) => x.classList.remove("active"));
      wb.classList.add("active");
    }
  }
  if (pen.tool && pen.tool !== "snip" && CUSTOMIZABLE_TOOLS.has(pen.tool)) {
    const tb = railRoot.querySelector(`.tool[data-tool="${pen.tool}"]`);
    if (tb && !tb.classList.contains("tool-off") && app.set_tool(pen.tool)) {
      railRoot.querySelectorAll(".tool").forEach((x) => x.classList.remove("active"));
      tb.classList.add("active");
    }
  }
  return p;
}

// "Dirty since the last save to a FILE." Autosave calls save_json(), which
// clears the Rust dirty flag, so is_dirty() alone can't tell whether the work
// has actually been written somewhere durable. We track file-saves in JS and OR
// the two for the unload guard. Reset whenever a document is freshly opened.
let dirtySinceFileSave = false;

// Snapshot the current annotations to IndexedDB under the open PDF's hash.
// PDF-only: HTML uploads have no stable identity to key on.
// v181 security (vuln-sweep, confirmed low): the IndexedDB autosave store is a SINGLE origin-wide db
// (idb.js: "scribble"/"autosave") keyed only by PDF hash — not namespaced per question/course. On a shared
// hosted PL instance (all courses one origin), another instructor's question carrying client JS could
// indexedDB.open("scribble") and CURSOR-read every snapshot a shared student autosaved. Fix: confine autosave
// to the TRUE STANDALONE tool (single-tenant). In any embedded/overlay/PL context the student's graded work
// already persists through PL's own form input, and the ?file= reference sheet is in-memory scratch — so
// there is nothing to recover and no reason to write to the shared-origin store. (SECURITY.md updated to match.)
const AUTOSAVE_ENABLED = !(window.__SCRIBBLE_PL || window.__SCRIBBLE_EMBED);
async function autosaveTick() {
  try {
    if (!AUTOSAVE_ENABLED) return; // v181: standalone only — never write the origin-wide store inside PL/embed
    if (docMode !== "pdf" || !app || !app.is_dirty()) return;
    const key = app.pdf_sha256();
    if (!key) return; // no hash (e.g. insecure context) — can't key recovery
    const json = app.save_json(); // NB: clears the Rust dirty flag
    dirtySinceFileSave = true;
    try {
      await idbPut(key, { json, savedAt: Date.now() }); // v189: dropped the written-never-read 'pages' field
    } catch (e) {
      app.mark_dirty(); // the write was lost (quota/eviction) — re-mark so the next tick retries
      idbPrune(15); // best-effort: free space (old snapshots) so the retry can land
      throw e;
    }
  } catch (e) {
    console.warn("autosave failed:", e);
  }
}
if (AUTOSAVE_ENABLED) setInterval(autosaveTick, 4000); // v181: no autosave loop inside PL/embed

// On opening a PDF, offer to recover annotations autosaved for that exact file.
// Returns true if the user restored a snapshot (so the caller can react).
async function maybeRestoreAutosave(hash) {
  if (!AUTOSAVE_ENABLED) return false; // v181: no reads inside PL/embed either (belt for the confine-to-standalone fix)
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
// v187: show the boot splash BEFORE the slow wasm load, but only in the STANDALONE tool — never in the overlay
// (_sbEmbedded), where it must stay fail-invisible. Covers wasm init + the ?file PDF fetch/render (the parts the
// user saw as a blank, "is-it-broken?" wait). hideBootSplash() fires from routeOpen / refFail / the no-file boot
// branch / the fail-safe timeout.
if (!_sbEmbedded) {
  showBootSplash(new URLSearchParams(location.search).has("file") ? "Loading your reference…" : "Loading…");
}
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
        moreBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>More'; // html-ok: static SVG literal, no user content (§7)
        const morePop = document.createElement("div");
        // A labelled popover of plain buttons — NOT role="menu" (that would demand menuitem roles + a full
        // arrow-key model, and it invalidates the children's aria-pressed / aria-haspopup).
        morePop.id = "more-popover"; morePop.hidden = true;
        morePop.append(els.btn.big, $("btn-help"), palette);
        // ---- v171: the parked-tools spill section, PREPENDED above Larger/Help/palette ----
        // (The v166 Compact/Medium/Full presets and the wrap-vs-More A/B seg controls are deleted — the width
        // handle is the one manual control and More is the one overflow model.)
        // All labels via textContent (never innerHTML of anything but the static moreBtn SVG above).
        const railBay = document.createElement("div");   // the overflow engine parks demoted groups in here
        railBay.id = "more-overflow";                    // load-bearing id: the closer exemption + the engine's bay
        railBay.setAttribute("role", "group"); railBay.setAttribute("aria-label", "Tools moved here");
        const railSecHead = document.createElement("div");
        railSecHead.className = "more-sec-head"; railSecHead.textContent = "Moved here to fit";
        // Wrap head+bay in one section so CSS can hide BOTH when nothing is parked — a bare "Moved here to
        // fit" header over an empty bay reads as a bug (.more-spill:has(#more-overflow:empty){display:none}).
        const spillWrap = document.createElement("div");
        spillWrap.className = "more-spill";
        spillWrap.append(railSecHead, railBay);
        morePop.prepend(spillWrap);
        actions.append(moreBtn);
        railEl.appendChild(actions);
        railEl.appendChild(morePop); // sibling of actions; CSS positions it under the More button
        railEl.appendChild($("rail-collapse")); // keep the collapse chevron LAST, after the appended children
        // v180 item 6: when Customize hides the CURRENTLY-ACTIVE tool, applyToolVisibility clicks a fallback
        // tool so the student isn't left holding an invisible one. That programmatic .click() bubbles to the
        // document, where the "click-away" closers below would read it as an outside click and slam the menu
        // shut mid-configuration. This flag marks such internal clicks so the closers ignore them — the menu
        // stays open (like toggling any other tool) until a REAL click-away.
        let suppressMoreClose = false;
        const closeMore = () => {
          if (morePop.hidden) return;
          const hadFocus = morePop.contains(railHostDoc.activeElement); // B3-4: realm-correct (iframe OR parent post-flip)
          morePop.hidden = true; moreBtn.setAttribute("aria-expanded", "false");
          if (hadFocus) moreBtn.focus(); // don't drop focus to <body> on Escape / item-activate
        };
        // No stopPropagation: letting the click reach the document closers means opening
        // More auto-closes the About popover (the More closer excludes moreBtn itself).
        // Flip the popover ABOVE the button when opening it downward would run past the visible band. It is
        // position:absolute under a viewport-fixed bar with no clamp of its own, and it got materially taller
        // once overflowed tool groups started parking inside it — so on a bar near the bottom of the band it
        // would open straight off-screen. Measured after unhiding (a hidden element has no rect).
        const placeMorePop = () => {
          // Element-derived realm (reparent pre-fix): the popover lives inside #rail — THIS document today, the
          // PARENT document once Phase 1 flips. ownerDocument.defaultView is correct in both, and it never
          // reaches for rail state declared in the !READONLY block below (a `railWin` reference from this
          // closure would be a ReferenceError on every More click — this function sits OUTSIDE that scope).
          const band = visibleBand(morePop.ownerDocument.defaultView || window);
          // review F13: cap the popover to the ACTUAL GAP on the side it opens toward, not the whole band —
          // a whole-band maxHeight let the flipped-above popover extend past the band TOP (Customize made it
          // tall enough), putting the menu's upper half (incl. the checklist) off-screen. Measure the gaps
          // from the More button, prefer downward, flip only when above genuinely offers more room; the
          // 140px floor keeps a usable scrollable menu even in a degenerate sliver band (overflow-y:auto).
          const br = moreBtn.getBoundingClientRect();
          const gapBelow = band.bottom - br.bottom - 10;
          const gapAbove = br.top - band.top - 10;
          morePop.style.top = ""; morePop.style.bottom = ""; morePop.style.maxHeight = "";
          const natural = morePop.getBoundingClientRect().height;
          if (!natural) return;
          const below = natural <= gapBelow || gapBelow >= gapAbove;
          morePop.style.maxHeight = `${Math.max(140, Math.floor(below ? gapBelow : gapAbove))}px`;
          if (!below) { morePop.style.top = "auto"; morePop.style.bottom = "calc(100% + 6px)"; }
        };
        moreBtn.addEventListener("click", () => {
          const open = morePop.hidden;
          morePop.hidden = !open;
          moreBtn.setAttribute("aria-expanded", String(open));
          if (open) placeMorePop();
        });
        // Activating any item (Larger / Help / palette) dismisses the menu — else Help's modal opens
        // BEHIND the still-open popover (the popover is trapped in the rail's low stacking context).
        // Any button closes the menu — EXCEPT the parked-tools bay (activating a parked tool keeps the menu
        // usable) and the Customize section (its Reset button must not slam the menu shut mid-configuration;
        // the checkbox <input>s never match closest("button") anyway, so the exemption is load-bearing for
        // Reset specifically). Help still closes it (outside both), which is why the rule exists.
        morePop.addEventListener("click", (e) => {
          if (e.target.closest("button") &&
              !e.target.closest("#more-overflow, #more-customize")) closeMore();
        });
        document.addEventListener("click", (e) => {
          if (suppressMoreClose) return; // v180 item 6: internal fallback-tool click, not a real click-away
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
                // v185 (flash fix): the host starts visibility:hidden so the reparented rail can NEVER paint
                // UNSTYLED before chrome.css lands in the parent (a <div>-defaulted full-width #mode-seg + the
                // un-scoped tools = the "blank stretched" FOUC on Annotate). chrome.css reveals the RAIL
                // (a descendant — its own visibility:visible overrides the inherited hidden, so no !important
                // war with this inline). If chrome.css never loads the bar stays hidden = fail-invisible over an
                // answerable question (§11.9), consistent with the existing chrome.css-.sheet measurement gate.
                host.style.cssText = "position:relative;z-index:2147482900;visibility:hidden;";
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
              const pMoreClick = (e) => { if (suppressMoreClose) return; if (!morePop.hidden && !morePop.contains(e.target) && !moreBtn.contains(e.target)) closeMore(); };
              const pMoreKey = (e) => { if (e.key === "Escape") closeMore(); };
              // Match the IFRAME listener order so Escape layering (C10) is identical in the parent realm:
              // About-closer (consuming) → mainKeydown (defers to an open More) → More-closer. mainKeydown MUST
              // precede pMoreKey (review R-2), else pMoreKey closes More first and mainKeydown then also clears
              // the selection on the same Escape.
              pdoc.addEventListener("click", closeAboutOnOutsideClick);
              pdoc.addEventListener("click", pMoreClick);
              pdoc.addEventListener("keydown", closeAboutOnEscape);
              // Reparent pre-fix (readiness audit, blocker #1): GATE the parent-realm shortcuts on annotate-
              // active. Bare mainKeydown here made EVERY keypress on the whole PL page a Scribble shortcut —
              // a page-level Ctrl+Z could silently undo a completed mark even after the student clicked Done,
              // and Ctrl+S / "?" were hijacked while merely reading the question. The wrapper REFERENCE (not
              // bare mainKeydown) is what gets torn down below, or removeEventListener removes nothing.
              const pMainKey = (e) => { if (document.body.classList.contains("annotate-active")) mainKeydown(e); };
              pdoc.addEventListener("keydown", pMainKey); // B3-5: tool/undo/save/Escape shortcuts in the parent realm
              pdoc.addEventListener("keydown", pMoreKey);
              railTeardowns.push(
                () => pdoc.removeEventListener("click", pMoreClick),
                () => pdoc.removeEventListener("keydown", pMoreKey),
                () => pdoc.removeEventListener("click", closeAboutOnOutsideClick),
                () => pdoc.removeEventListener("keydown", closeAboutOnEscape),
                () => pdoc.removeEventListener("keydown", pMainKey),
                () => { try { railLayout.dispose(); } catch { /* engine already gone */ } }, // reparent pre-fix: the
                // overflow engine's ResizeObserver lives in the PARENT realm once reparented (it keys on
                // rail.ownerDocument) and host.remove() below never disconnects it — a leaked cross-realm
                // observer per question swap. dispose() is safe here: this teardown only runs reparented.
                () => { host.remove(); // gate the shared <link> removal on "no other host remains" (2nd question)
                        if (!pdoc.querySelector(".pl-scribble-chrome-host")) pdoc.getElementById("pl-scribble-chrome-css")?.remove(); },
              );
            }
          } catch { /* cross-origin / no parent — keep the rail in the iframe */ }
          // NB: query the grip/collapse THROUGH railEl, not $() — $() is getElementById on the IFRAME document,
          // and the rail may have just been reparented into the parent (so $("rail-collapse") would be null).
          // onChange also nudges the bar out of an active calculator hole (a drag can park it under
          // the drawer, where it would render half-clipped — the irrecoverable-panel class of bug).
          // GEOM-1 (audit, high): alignRailToCard's inline style.left/style.width defeat the collapse CSS —
          // a minimised DEFAULT bar kept the full card width with the expand handle teleported far-left. On
          // collapse (non-moved) clear both longhands so chrome.css's right-anchored handle rules govern; on
          // expand, re-run the card alignment. (Declared before railFP so the onChange closure can call it;
          // function declaration hoists.)
          function syncCollapsedGeom() {
            if (railEl.classList.contains("fp-moved")) return; // a moved bar owns its own inline geometry
            if (railEl.classList.contains("fp-collapsed")) {
              // v177: keep the collapsed handle WHERE THE BAR WAS (right-edge preserved) — the chrome.css
              // viewport-right anchor was a long teleport away from a top-CENTERED bar. Inline left beats the
              // stylesheet's left:auto, and with width:auto the right:4px rule is then ignored (over-constrained).
              const r = railEl.getBoundingClientRect();
              railEl.style.width = "";
              if (r.width) railEl.style.left = `${Math.max(8, Math.round(r.right - 48))}px`;
            } else alignRailToCard();
          }
          // onChange also syncs the host pad: dragging a .big (60px) bar away from the default spot must CLEAR
          // the question's extra top padding, or a stale 64px gap survives the move. (syncHostPad is declared
          // below this call — safe: onChange only fires on drag drops, long after the const initializes.)
          // v181 item 2: SESSION-ONLY memory of where the student drags the bar. A fresh page load returns to
          // top-center (the professor's "top-center on load" default is kept — this is never persisted); but
          // WITHIN the tab, once you move the bar, re-opening it (Done → Annotate) reopens it where you left
          // it instead of snapping back to center. Captured after each drag settles (clamped, visible).
          let sessionRailPos = null;
          const rememberRailPos = () => {
            if (!railEl.classList.contains("fp-moved")) return; // only a genuinely moved bar
            const r = railEl.getBoundingClientRect();
            if (r.width) sessionRailPos = { left: Math.round(r.left), top: Math.round(r.top) };
          };
          const railFP = makeFloating(railEl, { collapse: railEl.querySelector("#rail-collapse"), onChange: () => { syncCollapsedGeom(); savePrefs(); calcDodgeNudge(); syncHostPad(); }, onSettle: () => { restickRail(); if (railWin !== window) { alignRailToCard(); clampFixed(railEl, railWin); } rememberRailPos(); }, win: railWin });
          // v170: the engine registers release backstops on the PARENT document, so it must be disposed on the
          // iframe swap even when the rail was never reparented. The railTeardowns path below only installs
          // inside the `railWin !== window` branch, which is dead while PHASE1_CHROME_REPARENT is false — so
          // without this the listeners outlived every question. dispose() is idempotent, so the reparented
          // branch calling it too is harmless.
          window.addEventListener("pagehide", () => { try { railFP.dispose(); } catch { /* ignore */ } }, { once: true });
          // B3-7 + review L-1: prefer railFloat2, but when NOT reparented fall back to the legacy railFloat —
          // gate-off coords are still iframe-realm (same realm v160 saved them in), so a v160 student who dragged
          // their toolbar isn't reset. Only the parent-realm (post-flip) path ignores the legacy key.
          // v188: the toolbar customize/size (toolsHidden, coloursOff, width) now follows the student across
          // questions via the shared key; fall back to the per-question railFloat2 (then legacy railFloat) for
          // migration. Position stays top-center (v177) and collapsed is still never re-applied (R4) either way.
          const rp = readShared().bar || (prefs && (prefs.railFloat2 || (railWin === window && prefs.railFloat))) || {};
          // v170: a dragged position IS restored again, but only per-question and only band-clamped — see the
          // PREFS_PER_QUESTION restore further down, which documents why the v168 blanket "never restore" was
          // both right at the time and too blunt. The COLLAPSED state is still never re-applied (R4): a bar that
          // reloaded collapsed was un-findable, and unlike a position a collapse has no on-screen affordance
          // pulling it back. Notes still stage at the band top every load via placeNotesAtBandTop — they're
          // scratch, so there is nothing there worth persisting.
          // ---- v171: bar-height plumbing (More is the only overflow model; the handle the only width control) ----
          // The notes reserve a strip at the band top so their header can't hide behind the bar; push the real
          // measured height (a .big bar is 60px, not the old hardcoded 64).
          const pushRailClear = () => {
            if (!railEl.getClientRects().length) return;   // display:none via the annotate gate measures 0
            setRailClear(Math.round(railEl.getBoundingClientRect().height) + 12);
          };
          // Pad the live host whenever the DEFAULT (un-moved) bar is genuinely taller than the server-rendered
          // 52px strip — i.e. Larger controls' 60px bar — so the question's first line is never covered. The
          // strict `> 52` on a ROUNDED value means the stock bar can never shift the question (no subpixel
          // false-positives); a MOVED bar floats free, so the pad clears (see the drag onChange below).
          const syncHostPad = () => {
            try {
              const host = overlayHost();
              if (!host) return;
              // v176 (live-verification catch): NEVER measure the reparented rail before chrome.css has
              // APPLIED — in that window the parent-realm #rail renders as an unstyled full-width vertical
              // stack thousands of px tall, and the boot-path call here wrote paddingTop:9432px, shoving the
              // question below a giant void until the next annotate cycle. Wait for the stylesheet (the
              // annotate-ON path re-runs this once it's ready); belt: no sane bar exceeds 200px.
              if (railWin !== window && !railWin.document.getElementById("pl-scribble-chrome-css")?.sheet) return;
              const sane = railEl.getClientRects().length ? railEl.getBoundingClientRect().height : 0;
              if (sane > 200) return;
              // review F6: the host's 52px baseline lives in an inline `padding:` SHORTHAND (pl-scribble.py).
              // Writing then clearing the padding-top LONGHAND deletes the shorthand's top component outright
              // (the other three sides survive, top computes to 0) — the stock bar would then cover the
              // question's first line forever. Capture the baseline once; always restore THAT, never "".
              if (host.dataset.scribbleBasePadTop == null) host.dataset.scribbleBasePadTop = host.style.paddingTop || "";
              const h = railEl.getClientRects().length ? Math.round(railEl.getBoundingClientRect().height) : 0;
              host.style.paddingTop = (!railEl.classList.contains("fp-moved") && h > 52)
                ? `${h + 4}px` : host.dataset.scribbleBasePadTop;
            } catch { /* cross-frame / no host — leave the server padding */ }
          };
          const railLayout = makeOverflow({
            rail: railEl, scroll: railEl.querySelector(".rail-scroll"),
            bay: railBay, moreBtn, win: railWin, announce: (t) => status(t),
          });
          const railResize = makeResizable(railEl, {
            handle: railEl.querySelector("#rail-resize"), win: railWin,
            // narrowest useful bar (v173): the SHELL alone — every group is demotable, so coreWidth's floor
            // collapses to grip + actions + More + collapse + handle and the drag can fold everything into More
            getMinW: () => railLayout.coreWidth(),
            onLive: () => { railLayout.reflow(); pushRailClear(); syncHostPad(); },
            onChange: () => {
              // GEOM-1: clearing the cap (End/double-click) must hand the un-moved default bar back to the
              // card alignment — the stale inline width from a previous align otherwise pins a wrong span.
              if (!railEl.style.getPropertyValue("--rail-w")) syncCollapsedGeom();
              clampFixed(railEl, railWin); savePrefs(); calcDodgeNudge();
            },
            announce: (t) => status(t),
          });
          railRefit = () => { railLayout.invalidate(); pushRailClear(); syncHostPad(); };
          // ---- v171 Customize: which tools are ELIGIBLE for the bar (the checklist at the bottom of More) ----
          // Eligibility is orthogonal to overflow: a checked tool may still be SPILLED into More by width (it
          // sits clickable in the bay, counted by the badge); an unchecked tool is .tool-off (display:none)
          // everywhere and exists only as its unchecked checklist row — hidden ≠ spilled, and hidden is
          // recoverable from More in one click (re-check → immediate refit).
          const applyToolVisibility = (hiddenSet) => {
            // Never leave the student holding an invisible tool. v173: with every tool uncheckable there is no
            // guaranteed-visible fallback, so walk a preference order for the first still-VISIBLE tool; if the
            // student hid literally everything, arm Select (neutral, no ink — harmless even while hidden).
            // (activeTool() is the existing module-scope reader — realm-correct via railRoot.)
            if (hiddenSet.has(activeTool())) {
              const fallback = ["pen", "highlighter", "text", "eraser", "select", "snip"].find((id) => !hiddenSet.has(id)) || "select";
              // v180 item 6: flag this programmatic click so the document "click-away" closers don't read it
              // as a real outside click and close the More menu mid-configuration. .click() dispatches (and
              // bubbles) synchronously, so the flag is guaranteed set for the whole event → reset in finally.
              suppressMoreClose = true;
              try { railRoot.querySelector(`.tool[data-tool="${fallback}"]`)?.click(); }
              finally { suppressMoreClose = false; }
            }
            for (const b of railRoot.querySelectorAll(".tool[data-tool]")) {
              if (!CUSTOMIZABLE_TOOLS.has(b.dataset.tool)) continue;
              b.classList.toggle("tool-off", hiddenSet.has(b.dataset.tool));
            }
            // A group whose every tool is off collapses entirely (.group-off) — the engine skips it (never a
            // demote candidate, never counted) and the divider hairlines can't dangle. In v171 only the
            // Capture/snip group can reach this state.
            for (const g of railRoot.querySelectorAll("#rail .rail-group")) {
              const tools = [...g.querySelectorAll(".tool[data-tool]")];
              g.classList.toggle("group-off", tools.length > 0 && tools.every((b) => b.classList.contains("tool-off")));
            }
            for (const box of custWrap.querySelectorAll("input[data-tool]")) {
              box.checked = !hiddenSet.has(box.dataset.tool);
            }
            railLayout.invalidate(); pushRailClear(); syncHostPad(); // full refit with the FINAL tool set
          };
          // Checklist DOM — textContent + clones of the STATIC tool SVGs from index.html only (never innerHTML
          // of anything dynamic, CLAUDE.md §7). Built only here (editable overlay): the graded read-only view
          // never reaches this block.
          const custWrap = document.createElement("div");
          custWrap.id = "more-customize"; custWrap.className = "tool-customize";
          const custHead = document.createElement("div");
          custHead.className = "more-sec-head"; custHead.textContent = "Customize tools";
          custWrap.append(custHead);
          const TOOL_LABELS = { select: "Select", pen: "Pen", highlighter: "Highlight", text: "Text", eraser: "Erase", snip: "Snip" };
          for (const id of ["select", "pen", "highlighter", "text", "eraser", "snip"]) {
            const row = document.createElement("label");
            row.className = "ct-row";
            const box = document.createElement("input");
            box.type = "checkbox"; box.dataset.tool = id; box.checked = true;
            if (PROTECTED_TOOLS.has(id)) { box.disabled = true; row.classList.add("ct-protected"); row.title = "Always on the toolbar"; }
            const live = railRoot.querySelector(`.tool[data-tool="${id}"] svg`);
            const name = document.createElement("span");
            name.textContent = TOOL_LABELS[id] || id;
            row.append(box);
            if (live) row.append(live.cloneNode(true)); // static markup shipped in index.html — safe to clone
            row.append(name);
            custWrap.append(row);
          }
          // v180 item 2: a "Colours" toggle — remove/restore the colour+width strip like a tool. It uses
          // data-extra (NOT data-tool), so the tool change-handler + serialize selectors above skip it; its
          // own handler flips coloursHidden, re-hides/re-shows the strip, and refits the bar. Icon = a clone
          // of the static palette SVG (from index.html — safe to clone, never innerHTML of dynamic content).
          {
            const row = document.createElement("label");
            row.className = "ct-row";
            const box = document.createElement("input");
            box.type = "checkbox"; box.dataset.extra = "colours"; box.checked = !coloursHidden;
            const live = railRoot.querySelector("#btn-palette svg");
            const name = document.createElement("span");
            name.textContent = "Colours";
            row.append(box);
            if (live) row.append(live.cloneNode(true));
            row.append(name);
            box.addEventListener("change", () => {
              coloursHidden = !box.checked;
              updateContextBar(activeTool());                       // hide/show the strip now
              railLayout.invalidate(); pushRailClear(); syncHostPad(); // strip width changed → refit the bar
              savePrefs();
              status(box.checked
                ? "Colours shown on the toolbar"
                : "Colours hidden from the toolbar — re-check here to restore them");
            });
            custWrap.append(row);
          }
          const ctReset = document.createElement("button");
          ctReset.type = "button"; ctReset.id = "ct-reset"; ctReset.textContent = "Reset tools to default";
          custWrap.append(ctReset);
          morePop.append(custWrap); // lands BELOW Larger/Help/palette — the low-frequency tail of the menu
          custWrap.addEventListener("change", (e) => {
            const box = e.target.closest("input[data-tool]");
            if (!box || box.disabled) return;
            const hidden = new Set([...custWrap.querySelectorAll("input[data-tool]:enabled:not(:checked)")].map((b) => b.dataset.tool));
            applyToolVisibility(hidden);
            savePrefs();
            const name = TOOL_LABELS[box.dataset.tool] || box.dataset.tool;
            status(box.checked ? `${name} shown on the toolbar` : `${name} hidden from the toolbar — re-check here to restore it`);
          });
          ctReset.addEventListener("click", () => {
            applyToolVisibility(new Set());
            coloursHidden = false; // v180 item 2: Reset restores the colour strip too
            const cbox = custWrap.querySelector('input[data-extra="colours"]');
            if (cbox) cbox.checked = true;
            updateContextBar(activeTool());
            railLayout.invalidate(); pushRailClear(); syncHostPad();
            savePrefs();
            status("Toolbar reset to default.");
          });
          // ---- restore: tools, then width, then an explicit first fit — all BEFORE the align/clamp below, so
          // geometry is measured against the FINAL tool set. The saved list is validated against the closed
          // CUSTOMIZABLE_TOOLS set, so a corrupt/stale pref can never hide a protected tool.
          const savedHidden = new Set((Array.isArray(rp.toolsHidden) ? rp.toolsHidden : []).filter((id) => CUSTOMIZABLE_TOOLS.has(id)));
          applyToolVisibility(savedHidden);
          // v180 item 2: restore the colour-strip toggle BEFORE the reflow below, so the bar is measured with
          // the strip already hidden/shown (else the first fit sizes to the wrong content width).
          coloursHidden = rp.coloursOff === true;
          const cbox0 = custWrap.querySelector('input[data-extra="colours"]');
          if (cbox0) cbox0.checked = !coloursHidden;
          updateContextBar(activeTool());
          const savedRailW = parseFloat(rp.width);
          if (Number.isFinite(savedRailW) && savedRailW > 0) railResize.setWidth(savedRailW); // re-clamps to the CURRENT band
          // The explicit trio also covers the no-saved-width branch: makeOverflow's constructor never reflows,
          // so without it the first fit would wait on an async ResizeObserver frame.
          railLayout.reflow(); pushRailClear(); syncHostPad();
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
            if (railEl.classList.contains("rail-resizing")) return; // v177: re-centering mid-gesture detaches the handle from the cursor; onChange re-centers at commit
            try {
              const fr = window.frameElement.getBoundingClientRect(); // iframe position in the parent viewport
              // v177 (user directive): the DEFAULT bar opens TOP-CENTER of the question, content-sized —
              // never the card-spanning strip (it read wider than the question: the overlay frame is the
              // full-bleed wrap, card + 32px). Width is owned by CSS (max-content, capped by --rail-max =
              // the card minus bleed, and by the user's --rail-w via min()); we own only left/top here.
              railEl.style.width = ""; // never span — content-sized always
              railEl.style.setProperty("--rail-max", `${Math.round(Math.max(160, fr.width - 44))}px`);
              const rw = Math.min(railEl.getBoundingClientRect().width || 0, Math.max(160, fr.width - 44));
              railEl.style.left = `${Math.round(fr.left + Math.max(20, (fr.width - rw) / 2))}px`;
              // v172, the professor's card-top decision: the DEFAULT bar hugs the top of the VISIBLE part of
              // the question card — just inside the card when its top is on-screen, pinned to the viewport top
              // once the student scrolls past it. Never a bare viewport `top:4px`, which parked the bar over
              // PL's own navigation permanently (readiness plan, open question 3). A dragged (fp-moved) bar
              // bailed at the top of this function and goes wherever the student puts it — default = tidy,
              // dragged = free. Re-runs on parent scroll/resize via scheduleAlign, so this IS the sticky.
              railEl.style.top = `${Math.max(4, Math.round(fr.top) + 4)}px`;
            } catch { /* cross-frame — leave the chrome.css full-width fallback */ }
          };
          // v177 (user directive, revoking the v170 per-question restore): "NO MATTER WHAT, when you open
          // the page the bar is at the TOP CENTER." A saved dragged position is deliberately NOT restored on
          // load any more — moves still hold for the session (and savePrefs keeps writing railFloat2 for
          // diagnostics/rollback), but every open lands at the centered default. Width caps and hidden-tool
          // choices still restore: they are sizes/sets, not places.
          alignRailToCard();
          clampFixed(railEl, railWin);
          const onRailResize = () => { alignRailToCard(); clampFixed(railEl, railWin); restickRail(); railLayout.reflow(); pushRailClear(); syncHostPad(); };
          railWin.addEventListener("resize", onRailResize);
          if (railWin !== window) {
            // Parent-realm listeners → tear down on the iframe swap (B3-6). Re-align on parent scroll / iframe
            // grow (resizeOverlay), rAF-coalesced (CLAUDE.md §10 — no layout work directly in the handler).
            railTeardowns.push(() => railFP.dispose()); // review N-1: remove makeFloating's parent-window blur listener
            railTeardowns.push(() => railWin.removeEventListener("resize", onRailResize));
            // STICKY-1 (audit, high — this was shipped DEAD twice over): (a) the callback must be coalesced
            // through OUR OWN realm's rAF — a parent-realm rAF with an iframe-realm callback silently never
            // fires on hosted PL (the measured v155 failure mode, documented in calc-dodge.js; CLAUDE.md §11
            // rule 2); (b) the scroll listener must be CAPTURE-PHASE ON THE PARENT DOCUMENT — PL scrolls a
            // nested div, so a bubble-phase window listener never hears it (live-measured, ISSUES-NEXT #4;
            // rule 3). This is the exact proven wiring of the calc-dodge + restickRail triggers.
            let alignRaf = 0;
            // v185 (flash fix): reflow IN THE SAME frame as alignRailToCard's --rail-max rewrite — for parity
            // with the sibling onRailResize (4587). Without it a scroll/card-width change left the bar un-demoted
            // (all tools, box at full card width = the "blank stretched" flash) for one frame until the engine's
            // async ResizeObserver→rAF reflow caught up. pushRailClear/syncHostPad are steady-state no-ops here.
            const scheduleAlign = () => { if (alignRaf) return; alignRaf = requestAnimationFrame(() => { alignRaf = 0; alignRailToCard(); railLayout.reflow(); pushRailClear(); syncHostPad(); }); };
            const alignOpts = { capture: true, passive: true };
            railWin.document.addEventListener("scroll", scheduleAlign, alignOpts);
            railTeardowns.push(() => railWin.document.removeEventListener("scroll", scheduleAlign, alignOpts));
            if (railWin.ResizeObserver && window.frameElement) {
              const ro = new railWin.ResizeObserver(scheduleAlign);
              ro.observe(window.frameElement);
              railTeardowns.push(() => { try { ro.disconnect(); } catch { /* ignore */ } if (alignRaf) cancelAnimationFrame(alignRaf); });
            }
            // v177: a top-CENTERED bar must re-center when its own width changes (tools demote/promote, .big,
            // Customize). The rail lives in the parent realm → parent RO, own-realm rAF via scheduleAlign.
            if (railWin.ResizeObserver) {
              const roSelf = new railWin.ResizeObserver(scheduleAlign);
              roSelf.observe(railEl);
              railTeardowns.push(() => { try { roSelf.disconnect(); } catch { /* ignore */ } });
            }
            window.addEventListener("pagehide", () => { for (const t of railTeardowns) { try { t(); } catch { /* ignore */ } } }, { once: true });
          }
          // MF-F: the iframe's `display:none` annotate-gate (style.css) can't reach a reparented rail, so drive
          // its visibility from HERE off the same annotate-active signal (the parent toggles that class on OUR
          // iframe body). Hidden until the student clicks Annotate. No-op when the rail stayed in the iframe.
          const syncRailVis = () => {
            if (railWin !== window) railEl.style.display = document.body.classList.contains("annotate-active") ? "" : "none";
          };
          // v172 Done WELD (readiness plan §3): while annotating, the parent's Done pill lives INSIDE the
          // reparented toolbar's right end — one floating unit, dragged together, budgeted by the overflow
          // shell automatically (.rail-actions is part of the measured shell). Ownership: pl-scribble.py keeps
          // the button's lifecycle (creation, toggle click, label, the INACTIVE corner pill, and it re-claims
          // the node itself on the OFF branch of its own m()); we own PLACEMENT while annotate-active only.
          // The sizer skips its fixed positioning when it sees our .pl-scribble-chrome-host, so there is
          // exactly one writer per state. No-op when not reparented (legacy FAB behaviour intact).
          // THE launcher pill for THIS instance (parent realm). Bind by the server-stamped identity
          // (data-scribble-id = qid.name) so a two-question page never grabs the OTHER question's pill (B3-3);
          // fall back to the global query only when there's exactly one chrome host (unambiguous slow-boot case).
          const findLauncher = () => {
            if (railWin === window) return null;
            const pdoc = railWin.document, pl = window.__SCRIBBLE_PL || {};
            const sid = `${pl.qid || "q"}.${pl.name || ""}`;
            let b = null;
            try { b = pdoc.querySelector(`.pl-scribble-annotate-btn[data-scribble-id="${(railWin.CSS || CSS).escape(sid)}"]`); } catch { /* CSS.escape unavailable */ }
            if (!b && pdoc.querySelectorAll(".pl-scribble-chrome-host").length === 1) b = pdoc.querySelector(".pl-scribble-annotate-btn");
            return b;
          };
          // v179 item 1: where a DRAGGED launcher was dropped (session-only). Read BEFORE weldDone reparents the
          // pill. Null unless the sizer marked it data-sb-moved this session — a fresh load re-renders it clean.
          const launcherDropPoint = () => {
            try {
              const b = findLauncher();
              if (!b || !b.dataset.sbMoved || b.closest(".rail-actions")) return null;
              const r = b.getBoundingClientRect();
              return r.width ? { left: Math.round(r.left), top: Math.round(r.top) } : null;
            } catch { return null; }
          };
          const weldDone = () => {
            if (railWin === window) return;
            try {
              const b = findLauncher();
              const acts = railEl.querySelector(".rail-actions");
              if (!b || !acts || b.parentElement === acts) return;
              acts.appendChild(b);
              // Neutralise any FAB positioning left from a pre-reparent toggle (slow wasm boot): inside the
              // bar it is a plain flex child. The sizer's OFF branch rewrites all of these when it re-claims.
              b.style.position = "static";
              b.style.top = b.style.right = b.style.left = b.style.bottom = "auto";
              b.style.zIndex = ""; b.style.cursor = "pointer"; b.style.boxShadow = "none";
              b.style.margin = "0 0 0 4px"; b.style.touchAction = "";
            } catch { /* cross-origin parent — Done stays the sizer's FAB */ }
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
          // v181: seed the resume tool from the persisted pen.tool so the FIRST Annotate re-arms the tool the
          // student last used (only the marking tools resume — eraser/select/snip stay off the surprise-restore
          // list by the existing rule). Reload otherwise defaults to pen.
          // v188: prefer the SHARED (cross-question) tool so the student's drawing tool follows them across
          // questions (colour/width already do via applyPrefs, but armResumeTool re-arms the tool from HERE, so
          // seeding it from the per-question pref alone left the tool resetting to pen each question). Fall back
          // to the per-question pref, then pen. Only RESUME_TOOLS follow — select/eraser/snip (incl. the select
          // state after Done) default to pen, which is exactly the "if something else, default to pen" rule.
          const sharedTool = readShared().pen?.tool;
          let lastDrawTool = RESUME_TOOLS.has(sharedTool) ? sharedTool
            : (prefs && prefs.pen && RESUME_TOOLS.has(prefs.pen.tool)) ? prefs.pen.tool : "pen";
          // v181 review fix (Select trap): arm the resume tool on Annotate. Shared by the normal ON branch AND
          // the pre-init shortcut path below — before v181 the shortcut trusted "the live tool is Pen", but the
          // v181 tool-restore can leave the WASM tool on Select/Eraser (every overlay Done persists pen.tool=
          // "select"), so an un-armed shortcut path would strand the student in a Select trap (first drag = a
          // marquee, not ink). Falls back to the first VISIBLE tool, then Select, exactly like the ON branch.
          const armResumeTool = () => {
            const resumeBtn = railRoot.querySelector(`.tool[data-tool="${lastDrawTool}"]`);
            const visibleFallback = () => {
              for (const id of ["pen", "highlighter", "text", "eraser", "select", "snip"]) {
                const b = railRoot.querySelector(`.tool[data-tool="${id}"]`);
                if (b && !b.classList.contains("tool-off")) return b;
              }
              return railRoot.querySelector('.tool[data-tool="select"]'); // everything hidden — neutral arm
            };
            (resumeBtn && !resumeBtn.classList.contains("tool-off") ? resumeBtn : visibleFallback())?.click();
          };
          let wasAnnotating = document.body.classList.contains("annotate-active");
          new MutationObserver(() => {
            const now = document.body.classList.contains("annotate-active");
            if (wasAnnotating && !now) {
              annotatePaused = false; // v179 item 4: Done exits fully — clear any paused sub-state + its classes
              document.body.classList.remove("annotate-paused");
              railHostEl?.classList.remove("annotate-paused");
              // v180 review (medium, §11 rule 9): Done must not STRAND an in-iframe modal over the finished
              // question. The parent set the iframe pe:none on Done, so a Help card / lightbox left open would
              // render with a dead ✕/backdrop (clicks pass through) and Esc routes to the now-gated parent —
              // an un-dismissable obstruction. v180 item 4b (Help promoted to a one-click bar button) makes
              // "open Help, then click Done" a realistic path. Close them here: toggleHelp(false) re-syncs pe
              // (help closed + annotate-active off ⇒ correctly leaves pe:none); a document Escape runs each
              // open dialog's OWN cleanup (removes node, resolves its promise, revokes blob URLs). mainKeydown
              // early-returns while a modal is open, so this Escape only reaches the dialog's handler.
              if (!helpOverlay.hidden) toggleHelp(false);
              if (document.querySelector(".modal-overlay:not([hidden])")) {
                document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
              }
              syncIframePE(); // final assert: everything closed + annotate-active off ⇒ pe:none (covers the
                              // help+lightbox-both-open ordering where an earlier sync still saw a modal)
              const cur = railRoot.querySelector(".tool.active")?.dataset.tool;
              if (RESUME_TOOLS.has(cur)) lastDrawTool = cur;
              railRoot.querySelector('.tool[data-tool="select"]')?.click();
              // v171: the rail is display:none now, so syncHostPad measures 0 and CLEARS any .big host pad —
              // without this, Done left the question shifted down by the taller bar's 12px extra forever.
              syncHostPad();
            } else if (!wasAnnotating && now) {
              // C14: make the reparented rail displayable BEFORE clampRailOnShow measures it — a
              // display:none rail reports height 0 and the band-clamp garbage-places its top.
              syncRailVis();
              // v179 item 1: if the student DRAGGED the inactive launcher this session, open the toolbar where
              // they dropped it (session-only — a fresh load re-renders the pill at the default, so this is
              // null and the bar opens top-center). Read the pill's rect BEFORE weldDone reparents it. floatTo
              // marks the bar fp-moved, so alignRailToCard / restickRail / scheduleAlign all bail — single
              // writer of geometry — and clampFixed pulls a near-edge drop into the visible band.
              // v181 item 2: precedence for where the bar opens — a launcher the student JUST dragged (this
              // Annotate) wins; else the position they last dragged the BAR to this session; else top-center.
              // All three are session-only (sessionRailPos is never persisted), so a fresh load is top-center.
              const dropAt = launcherDropPoint() || sessionRailPos;
              weldDone(); // v172: dock the parent's Done pill into the bar's right end for this session
              if (dropAt) { railFP.floatTo(dropAt.left, dropAt.top); clampFixed(railEl, railWin); }
              else alignRailToCard(); // STICKY-1(c): first visible placement — the bar was display:none until now
              // Arm the resume tool (shared helper): the drawing tool the student last used, else the first
              // VISIBLE tool, else Select — never a hidden (Customize-off) tool, never leaving a Select trap.
              armResumeTool();
              syncModeSeg(); // v184 #3: fresh Annotate entry starts in Draw — reflect it on the visible switch
              clampRailOnShow();
              restickRail(); // land the default bar at the band top even if the page was scrolled at Annotate-time
              railLayout.reflow(); pushRailClear(); syncHostPad(); // bar was display:none and measured 0 until now
              clampNotes(); // the pane re-appears with the chrome — never at an off-frame position
              calcDodgeNudge(); // the chrome may be re-appearing straight under an open calculator
            }
            syncRailVis(); // show/hide the reparented rail with annotate-active (hide branch; idempotent on show)
            wasAnnotating = now;
          }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
          // If Annotate was pressed BEFORE wasm init finished, the ON transition already happened and the
          // observer will never see it — run the show-clamps once for that first showing, AND arm the resume
          // tool. v181 review: the old "pen is the default, no Select trap here" assumption is now FALSE —
          // applyPrefs may have restored the WASM tool to Select/Eraser (an overlay Done persists pen.tool=
          // "select"), so this path must armResumeTool() too or the first drag draws a marquee, not ink.
          if (wasAnnotating) { syncRailVis(); const d0 = launcherDropPoint() || sessionRailPos; weldDone(); if (d0) { railFP.floatTo(d0.left, d0.top); clampFixed(railEl, railWin); } else alignRailToCard(); armResumeTool(); syncModeSeg(); clampRailOnShow(); restickRail(); clampNotes(); calcDodgeNudge(); }

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
    else { // no ?file: nothing is loading, so clear the standalone boot splash and show the normal idle state
      hideBootSplash();
      if (LOCKED_BUILD) { // v181/v182: locked ref tool with no ?file= — there's no picker to fall back to
        status("Reference tool — this link is missing its ?file=. Open the reference from your assignment link.");
        if (els.placeholder) els.placeholder.textContent = "Your reference sheet will appear here.";
      }
      else autoOpenIfRequested(); // "Open in a new tab" → pop the file picker here
    }
    if (AUTOSAVE_ENABLED) idbPrune(); // v181: bound the autosave store — standalone only (never touch it in PL/embed)
  })
  .catch((e) => {
    console.error("WASM init failed:", e);
    hideBootSplash(); // v187: boot failed — never leave the splash covering the tool (fail-invisible)
    status(`Failed to start: ${e?.message || e}`);
  });
