// Scribble — thin JS glue layer. All annotation logic lives in Rust/WASM.
// No network calls except loading local static assets. No storage of student
// content outside explicit file downloads.

// Bump with index.html's ?v= references on every release (cache busting).
const APP_VERSION = "37";

import init, { App } from "./pkg/scribble.js?v=12";

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
  textLayer: $("text-layer"),
  contextBar: $("context-bar"),
  docControls: $("doc-controls"),
  widths: $("widths"),
  widthDivider: $("width-divider"),
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
  seg: { paged: $("seg-paged"), cont: $("seg-cont") },
};

// Tools that exist only in the UI layer (the Rust core stays in a neutral
// tool while they're active).
const JS_TOOLS = new Set(["snip", "pagetext"]);
const activeTool = () =>
  document.querySelector(".tool.active")?.dataset.tool;

let app;            // WASM App
let pdfDoc = null;  // PDF.js document
let docMode = "pdf"; // "pdf" | "html" — what kind of document is open
let pageNum = 0;    // 0-based current page
let drawing = false;
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

function drawSelection(ctx, offY = 0) {
  if (selectedId < 0) return;
  const bb = app.item_bbox_of(pageNum, selectedId);
  if (bb.length !== 4) {
    selectedId = -1;
    return;
  }
  const r = curRatio();
  const k = scale() * r;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, offY);
  ctx.strokeStyle = "#2f5fde";
  ctx.lineWidth = 1.5 * r;
  ctx.setLineDash([5 * r, 4 * r]);
  const pad = 4 * k / scale();
  ctx.strokeRect(bb[0] * k - pad, bb[1] * k - pad, (bb[2] - bb[0]) * k + 2 * pad, (bb[3] - bb[1]) * k + 2 * pad);
  ctx.setLineDash([]);
  ctx.fillStyle = "#ffffff";
  const hs = HANDLE_PX * r;
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
  els.wrap.classList.remove("continuous", "htmlpage");
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
  els.btn.zoomOut.disabled = currentScale <= ZOOM_MIN;
  els.btn.zoomIn.disabled = currentScale >= ZOOM_MAX;
  redrawAnnotations();
  markActiveThumb();
  // The selectable text layer is only built on demand (Page-text tool), so it
  // never competes with normal rendering or export for the PDF.js worker.
  if (activeTool() === "pagetext") buildTextLayer(page);
  else els.textLayer.textContent = "";
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
  els.textLayer.textContent = "";
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
    pdfCanvas.className = "cpdf";
    const annoCanvas = document.createElement("canvas");
    annoCanvas.className = "canno";
    const textLayer = document.createElement("div"); // Copy-text selectable layer
    textLayer.className = "ctext";
    el.append(pdfCanvas, annoCanvas, textLayer);
    els.column.appendChild(el);
    const p = { el, pdfCanvas, annoCanvas, textLayer, base: bases[i], mounted: false };
    cont.pages.push(p);
    // Same page-aware pointer pipeline as the single-page canvas.
    annoCanvas.addEventListener("pointerdown", onAnnoPointerDown);
    annoCanvas.addEventListener("pointermove", onAnnoPointerMove);
    annoCanvas.addEventListener("pointerup", endStroke);
    annoCanvas.addEventListener("pointercancel", onAnnoPointerCancel);
    cont.io.observe(el);
  }
  pageNum = Math.min(Math.max(0, keep), cont.pages.length - 1);
  basePage = cont.pages[pageNum].base;

  els.pageInput.max = String(pdfDoc.numPages);
  els.pageInput.value = String(pageNum + 1);
  els.pageCount.textContent = `/ ${pdfDoc.numPages}`;
  syncZoomSelect();
  els.btn.zoomOut.disabled = currentScale <= ZOOM_MIN;
  els.btn.zoomIn.disabled = currentScale >= ZOOM_MAX;
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
    const v = pg.getViewport({ scale: k });
    await withRenderLock(() =>
      pg.render({ canvasContext: p.pdfCanvas.getContext("2d"), viewport: v, intent: "print" }).promise);
  } catch (e) {
    if (e?.name !== "RenderingCancelledException") console.warn("cont render:", e);
    return;
  }
  if (token !== cont.token || !p.mounted) return; // rebuilt or scrolled away
  contDrawAnnos(i);
  if (activeTool() === "pagetext") buildContTextLayer(i); // keep selectable text in sync
}

// Free a page's canvases when it scrolls far away (keeps memory bounded).
function contUnmount(i) {
  const p = cont.pages[i];
  if (!p || !p.mounted) return;
  p.mounted = false;
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
    docMode = "pdf";
    els.htmlFrame.hidden = true;
    els.htmlFrame.srcdoc = "";
    els.pdfCanvas.hidden = false;
    app = new App(); // fresh document per PDF
    if (hash) app.set_pdf_sha256(hash);
    dirtySinceFileSave = false;
    // Recover annotations autosaved for this exact PDF, if any (before the doc
    // is read for thumbnails/render below).
    const restored = await maybeRestoreAutosave(hash);
    pageNum = 0;
    zoomMode = "fit-width"; // fill the viewer width — 100% leaves a tiny page
    // Default to continuous scroll for multi-page PDFs so "scroll = next page"
    // works natively out of the box (single page has nothing to scroll between,
    // so it opens paged). Either way the Page/Scroll switch is one click.
    scrollMode = doc.numPages > 1 ? "continuous" : "paged";
    setScrollEnabled(true);
    syncScrollUI();
    els.placeholder.hidden = true;
    els.wrap.hidden = false;
    els.btn.save.disabled = false;
    els.btn.load.disabled = false;
    els.btn.export.disabled = false;
    els.pageInput.disabled = false;
    els.zoomSelect.disabled = false;
    els.btn.thumbs.disabled = false;
    els.btn.notes.disabled = false;
    els.docControls.hidden = false;
    updateContextBar(activeTool());
    selectedId = -1;
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
    return;
  }
  let text;
  try {
    text = await file.text();
  } catch {
    status("Couldn't read that file.");
    return;
  }
  try {
    if (pdfDoc) { try { await pdfDoc.destroy(); } catch { /* ignore */ } pdfDoc = null; }
    docMode = "html";
    app = new App();
    dirtySinceFileSave = false;
    pageNum = 0;
    zoomMode = "fit-width"; // fill the viewer width; the page scales, never reflows
    scrollMode = "paged"; // continuous scroll is PDF-only
    setScrollEnabled(false);
    syncScrollUI();
    els.wrap.classList.remove("continuous");
    currentScale = 1;
    selectedId = -1;

    // The uploaded HTML renders in a same-origin sandboxed iframe with NO
    // script permission, so embedded scripts never run — it shows as static
    // content and can't do anything. The annotation canvas sits on top.
    els.placeholder.hidden = true;
    els.wrap.hidden = false;
    els.pdfCanvas.hidden = true;
    els.textLayer.textContent = "";
    els.htmlFrame.hidden = false;
    await new Promise((resolve) => {
      els.htmlFrame.onload = () => resolve();
      els.htmlFrame.srcdoc = text;
      // Fallback in case onload doesn't fire promptly.
      setTimeout(resolve, 1200);
    });

    measureHtmlHeight();
    renderHtmlPage();
    watchHtmlImages(); // re-measure once late-loading images settle

    els.btn.save.disabled = false;
    els.btn.load.disabled = false;
    els.btn.notes.disabled = false;
    els.btn.export.disabled = false;  // export rasterizes the HTML + vectors
    els.btn.thumbs.disabled = true;
    els.thumbs.hidden = true;
    els.btn.thumbs.classList.remove("active");
    els.docControls.hidden = false;
    els.pageInput.disabled = true;     // single page: nav stays off
    els.zoomSelect.disabled = false;   // but HTML IS zoomable (fixed-layout page)
    els.pageInput.value = "1";
    els.pageCount.textContent = "/ 1";
    els.btn.prev.disabled = true;
    els.btn.next.disabled = true;
    updateContextBar(activeTool());
    renderNotes();
    status("HTML loaded. Scribble away!");
  } catch (e) {
    console.error("openHtml failed:", e);
    status(`Could not open HTML: ${e?.message || e}`);
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
  els.wrap.classList.remove("continuous");
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
  els.btn.zoomOut.disabled = currentScale <= ZOOM_MIN;
  els.btn.zoomIn.disabled = currentScale >= ZOOM_MAX;
  redrawAnnotations();
  if (htmlTruncated) {
    status(`This HTML page is very tall — content past ${HTML_MAX_PAGE_H}px isn't shown or annotatable.`);
  }
}

// Some HTML embeds images that finish loading after onload, changing the page
// height. Re-measure once they settle. A short debounce coalesces a burst of
// image loads; a hard timeout covers images that never resolve.
let htmlRemeasureTimer;
function watchHtmlImages() {
  let d;
  try { d = els.htmlFrame.contentDocument; } catch { return; }
  if (!d) return;
  const pendingImgs = [...d.images].filter((im) => !im.complete);
  if (!pendingImgs.length) return; // measured height is already final
  const remeasure = () => {
    clearTimeout(htmlRemeasureTimer);
    htmlRemeasureTimer = setTimeout(() => {
      if (docMode !== "html") return;
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

const eraseRadius = () => 10 / scale();

// setPointerCapture can throw (e.g. the pointer is already gone) — never
// let that abort an input handler mid-state-change. Captures on the canvas the
// event fired on (the single-page canvas, or the active continuous page).
function capturePointer(ev) {
  try {
    ev.currentTarget.setPointerCapture(ev.pointerId);
  } catch {
    /* capture is an optimization, not a requirement */
  }
}

function onAnnoPointerDown(ev) {
  if (!docOpen() || ev.button !== 0) return;
  // In continuous mode the page you press on becomes the active page for
  // hit-testing / drawing (scrolling alone never changes it).
  if (isContinuous()) {
    const cp = ev.currentTarget.closest(".cpage");
    if (cp) { pageNum = Number(cp.dataset.page); basePage = cont.pages[pageNum].base; }
  }
  const tool = document.querySelector(".tool.active")?.dataset.tool;
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
}
els.annoCanvas.addEventListener("pointerdown", onAnnoPointerDown);

function onAnnoPointerMove(ev) {
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
  // Hover feedback for the select tool (never changes the active page).
  if (!drawing && docOpen() && activeTool() === "select") {
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
  } else if (!drawing && !itemDrag && !resizeDrag && !snip) {
    // Other tools use the CSS crosshair; clear any leftover select-hover cursor.
    ev.currentTarget.style.cursor = "";
  }
  if (!drawing) return;
  const events = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
  for (const e of events) {
    const [x, y] = pageCoords(e);
    app.pointer_move(x, y, eraseRadius());
  }
  redrawAnnotations();
}
els.annoCanvas.addEventListener("pointermove", onAnnoPointerMove);

function endStroke(ev) {
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

function onAnnoPointerCancel() {
  drawing = false;
  itemDrag = null;
  resizeDrag = null;
  snip = null;
  app.pointer_cancel();
  redrawAnnotations();
}
els.annoCanvas.addEventListener("pointerup", endStroke);
els.annoCanvas.addEventListener("pointercancel", onAnnoPointerCancel);

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

function drawSnipMarquee(ctx, offY = 0) {
  if (!snip) return;
  const r = curRatio();
  const k = scale() * r;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, offY);
  ctx.strokeStyle = "#2f5fde";
  ctx.lineWidth = 1.5 * r;
  ctx.setLineDash([6 * r, 4 * r]);
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
    // 1. Pixels + 2. Text — captured differently for HTML vs PDF.
    let out, text = "";
    if (docMode === "html") {
      // High-DPI raster of the HTML region (the iframe can't be drawn to a
      // canvas directly) + reliable DOM text extraction.
      out = await snipHtmlRegion(x0, y0, w, h);
      text = htmlTextInRegion(x0, y0, w, h);
    } else {
      // Copy the region from the active page's live canvases (single page, or
      // the active continuous page).
      const k = scale() * curRatio();
      const srcPdf = isContinuous() ? cont.pages[pageNum]?.pdfCanvas : els.pdfCanvas;
      const srcAnno = isContinuous() ? cont.pages[pageNum]?.annoCanvas : els.annoCanvas;
      out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(w * k));
      out.height = Math.max(1, Math.round(h * k));
      const octx = out.getContext("2d");
      octx.fillStyle = "#ffffff";
      octx.fillRect(0, 0, out.width, out.height);
      for (const src of [srcPdf, srcAnno]) {
        if (src) octx.drawImage(src, x0 * k, y0 * k, w * k, h * k, 0, 0, out.width, out.height);
      }
      text = await pdfTextInRegion(x0, y0, w, h);
    }
    const blob = await new Promise((res) => out.toBlob(res, "image/png"));
    const b64 = bytesToB64(new Uint8Array(await blob.arrayBuffer()));

    const caption = text ? text.slice(0, 280)
      : docMode === "html" ? "from the page" : `from page ${pageNum + 1}`;
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
  // Position the input inside its page's element so it tracks that page. In
  // continuous mode that's the active .cpage; otherwise the single #page-wrap.
  const host = isContinuous() ? cont.pages[pageNum]?.el || els.wrap : els.wrap;
  if (els.textInput.parentElement !== host) host.appendChild(els.textInput);
  els.textInput.style.left = `${pageX * scale()}px`;
  els.textInput.style.top = `${(pageY - 18) * scale()}px`;
  els.textInput.value = initial;
  els.textInput.hidden = false;
  growTextInput();
  // Defer focus until after the pointer event sequence settles.
  setTimeout(() => els.textInput.focus(), 0);
}

// Grow the (multi-line) on-page text editor to fit its content.
function growTextInput() {
  els.textInput.style.height = "auto";
  els.textInput.style.height = `${els.textInput.scrollHeight}px`;
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
  // Enter places the note; Shift+Enter inserts a newline (multi-line notes).
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    commitTextInput();
  } else if (ev.key === "Escape") {
    hideTextInput();
  }
  ev.stopPropagation();
});
els.textInput.addEventListener("input", growTextInput);
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
  dirtySinceFileSave = false; // matches the file the user just chose
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
      c.width = Math.max(1, Math.round(w * ratio));
      c.height = Math.max(1, Math.round(h * ratio));
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

// Snip resolution for the uploaded HTML page (3x the page CSS size keeps small
// figures/equations crisp). Cached per page render so repeat snips are fast.
const HTML_SNIP_RATIO = 3;
let htmlSnipCanvas = null; // full-page raster reused across snips until re-render

// Crop a region (page coords) out of a crisp full-page HTML raster, with the
// annotation overlay composited on top. Fixes blurry / empty HTML snips.
async function snipHtmlRegion(x0, y0, w, h) {
  if (!htmlSnipCanvas) htmlSnipCanvas = await htmlPageToCanvas(HTML_SNIP_RATIO);
  const full = htmlSnipCanvas;
  const sc = full.width / basePage.w; // raster px per page unit
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(w * sc));
  out.height = Math.max(1, Math.round(h * sc));
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(full, x0 * sc, y0 * sc, w * sc, h * sc, 0, 0, out.width, out.height);
  // annotations live on the on-screen anno canvas at its own backing scale
  const anno = els.annoCanvas;
  if (anno.width > 1) {
    const a = anno.width / basePage.w;
    ctx.drawImage(anno, x0 * a, y0 * a, w * a, h * a, 0, 0, out.width, out.height);
  }
  return out;
}

// Extract readable text (incl. link URLs) from the iframe DOM whose layout boxes
// fall inside the region — far more reliable than glyph-anchor heuristics, and
// it actually handles links. Coords are page units (CSS px at base width).
function htmlTextInRegion(x0, y0, w, h) {
  let doc;
  try { doc = els.htmlFrame.contentDocument; } catch { return ""; }
  if (!doc || !doc.body) return "";
  const x1 = x0 + w, y1 = y0 + h;
  const parts = [];
  const seenLinks = new Set();
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const s = n.nodeValue.trim();
    if (!s) continue;
    range.selectNodeContents(n);
    const rects = range.getClientRects();
    let hit = false;
    for (const rc of rects) {
      // The iframe is laid out at base width with no scroll, so its client rect
      // is already in page units.
      if (rc.right >= x0 && rc.left <= x1 && rc.bottom >= y0 && rc.top <= y1) { hit = true; break; }
    }
    if (!hit) continue;
    parts.push(s);
    const a = n.parentElement && n.parentElement.closest("a[href]");
    if (a) {
      const href = a.getAttribute("href");
      if (href && !seenLinks.has(href)) { seenLinks.add(href); parts.push(`(${href})`); }
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// Extract PDF text overlapping the region, in reading order. Uses each glyph
// run's box (not just its baseline anchor) so partly-covered runs are caught,
// and groups runs into rows so the result reads top-to-bottom, left-to-right.
async function pdfTextInRegion(x0, y0, w, h) {
  if (!pdfDoc) return "";
  try {
    const page = await pdfDoc.getPage(pageNum + 1);
    const tc = await page.getTextContent();
    const x1 = x0 + w, y1 = y0 + h;
    const hits = [];
    for (const item of tc.items) {
      if (!item.str) continue;
      const e = item.transform[4], f = item.transform[5];
      const iw = item.width || 0;
      const ih = item.height || Math.abs(item.transform[3]) || 8;
      const left = e, right = e + iw;
      const bottom = basePage.h - f;     // baseline, flipped top-down
      const top = bottom - ih;
      if (right >= x0 && left <= x1 && bottom >= y0 && top <= y1) {
        hits.push({ x: left, y: top, str: item.str, eol: item.hasEOL });
      }
    }
    hits.sort((a, b) => (Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x));
    let text = "", prevY = null;
    for (const it of hits) {
      if (prevY !== null && it.y - prevY > 4) text += "\n";
      text += it.str + (it.eol ? "\n" : " ");
      prevY = it.y;
    }
    return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return "";
  }
}

async function exportPdf() {
  if (!docOpen()) return;
  commitTextInput();
  clearTimeout(thumbTimer); // don't contend with exports for page renders
  els.btn.export.disabled = true;
  try {
    const pages = [];
    if (docMode === "html") {
      status("Rendering the page…");
      const canvas = await htmlPageToCanvas();
      pages.push({
        w: basePage.w, h: basePage.h,
        ops: app.export_pdf_ops(0), // annotations as crisp vectors
        images: [{
          jpeg: await canvasJpegBytes(canvas),
          pxW: canvas.width, pxH: canvas.height,
          x: 0, y: 0, w: basePage.w, h: basePage.h,
        }],
      });
    } else {
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

// A small modal that asks what to do with unsaved work before opening a file.
// Resolves to "save" | "newtab" | "discard" | "cancel".
function confirmOpenDialog() {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "modal-overlay";
    const card = document.createElement("div");
    card.className = "modal-card";
    const h = document.createElement("h3");
    h.textContent = "You have unsaved work";
    const p = document.createElement("p");
    p.textContent = "Opening a file replaces what's on screen. What would you like to do?";
    const row = document.createElement("div");
    row.className = "modal-actions";
    const cleanup = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
    const mk = (label, val, cls = "") => {
      const b = document.createElement("button");
      b.className = `btn labeled ${cls}`;
      b.textContent = label;
      b.addEventListener("click", () => { cleanup(); resolve(val); });
      return b;
    };
    row.append(
      mk("Save, then open", "save", "primary"),
      mk("Open in a new tab", "newtab"),
      mk("Discard & open", "discard"),
      mk("Cancel", "cancel"),
    );
    card.append(h, p, row);
    ov.append(card);
    const onKey = (e) => { if (e.key === "Escape") { cleanup(); resolve("cancel"); } };
    ov.addEventListener("click", (e) => { if (e.target === ov) { cleanup(); resolve("cancel"); } });
    document.addEventListener("keydown", onKey);
    document.body.append(ov);
  });
}

els.btn.open.addEventListener("click", async () => {
  // Opening replaces the current document — guard unsaved work with a choice.
  if (docOpen() && (dirtySinceFileSave || app?.is_dirty())) {
    const choice = await confirmOpenDialog();
    if (choice === "cancel") return;
    if (choice === "newtab") { window.open(location.pathname, "_blank"); return; }
    if (choice === "save") downloadJson();
    // "discard" and "save" both fall through to the picker.
  }
  els.filePdf.click();
});
els.btn.save.addEventListener("click", downloadJson);
els.btn.load.addEventListener("click", () => els.fileJson.click());
els.btn.export.addEventListener("click", exportPdf);

els.filePdf.addEventListener("change", () => {
  const f = els.filePdf.files[0];
  els.filePdf.value = "";
  if (!f) return;
  if (/\.html?$/i.test(f.name) || f.type === "text/html") openHtml(f);
  else openPdf(f);
});

els.fileJson.addEventListener("change", () => {
  const f = els.fileJson.files[0];
  els.fileJson.value = "";
  if (f) loadJsonFile(f);
});

// Mirror the visual selected/toggled state into aria-pressed so assistive tech
// announces these controls as toggle buttons that are on or off. Called after
// any change to the toolbar / view toggles / segmented control.
function syncAria() {
  const set = (el, on) => el && el.setAttribute("aria-pressed", on ? "true" : "false");
  document.querySelectorAll(".tool").forEach((t) => set(t, t.classList.contains("active")));
  document.querySelectorAll("#colors .swatch").forEach((s) => set(s, s.classList.contains("active")));
  document.querySelectorAll("#widths .width").forEach((w) => set(w, w.classList.contains("active")));
  set(els.btn.palette, els.btn.palette.classList.contains("active"));
  set(els.btn.big, document.body.classList.contains("big"));
  set(els.btn.thumbs, !els.thumbs.hidden);
  set(els.btn.notes, !els.notesPane.hidden);
  set(els.seg.paged, els.seg.paged.classList.contains("active"));
  set(els.seg.cont, els.seg.cont.classList.contains("active"));
}

for (const b of document.querySelectorAll(".tool")) {
  b.addEventListener("click", () => {
    commitTextInput();
    const name = b.dataset.tool;
    if (JS_TOOLS.has(name)) {
      app.set_tool("select"); // neutral: core draws nothing on pointer events
    } else if (!app.set_tool(name)) {
      return;
    }
    document.querySelectorAll(".tool").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    document.body.classList.toggle("textselect", name === "pagetext");
    if (name !== "select") setSelection(-1);
    els.annoCanvas.style.cursor = name === "snip" ? "crosshair" : "";
    updateContextBar(name);
    syncAria();
    // Build/tear down selectable text as the Copy-text tool toggles (works in
    // single-page PDF, continuous PDF per page, and HTML via direct selection).
    setCopyText(name === "pagetext");
  });
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
  const show = docOpen() && MARKING_TOOLS.has(tool);
  els.contextBar.hidden = !show;
  // The colorblind-safe palette toggle only matters while choosing colours, so
  // it rides with the contextual bar and hides when no marking tool is active.
  els.btn.palette.hidden = !show;
  if (show) {
    const w = WIDTH_TOOLS.has(tool);
    els.widths.style.display = w ? "flex" : "none";
    els.widthDivider.style.display = w ? "" : "none";
  }
}

for (const b of document.querySelectorAll("#widths .width")) {
  b.addEventListener("click", () => {
    if (!app.set_pen_width(b.dataset.width)) return;
    document.querySelectorAll("#widths .width").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    syncAria();
  });
}

for (const s of document.querySelectorAll("#colors .swatch")) {
  s.addEventListener("click", () => {
    if (!app.set_color(s.dataset.color)) return;
    document.querySelectorAll("#colors .swatch").forEach((x) => x.classList.remove("active"));
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
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    // HTML never re-flows on resize — renderHtmlPage only recomputes the scale,
    // so annotations stay aligned. PDFs re-render for fit modes / dpr changes.
    renderDoc();
  }, 150);
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
  // When the shortcuts overlay is open, it captures Esc / ? and suppresses the
  // rest so nothing fires behind the modal.
  if (!helpOverlay.hidden) {
    if (ev.key === "Escape" || ev.key === "?") { ev.preventDefault(); toggleHelp(false); }
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
  } else if (!mod && ev.key === "?") {
    ev.preventDefault();
    toggleHelp(true);
  } else if (!mod && TOOL_KEYS[key]) {
    document.querySelector(`[data-tool="${TOOL_KEYS[key]}"]`)?.click();
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
});

window.addEventListener("beforeunload", (ev) => {
  // Warn if there are changes not written to a FILE. Autosave clears the Rust
  // dirty flag, so we OR it with our own file-save tracking (see autosaveTick).
  if (dirtySinceFileSave || app?.is_dirty()) {
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
  mk("✕", "Delete block", () => { app.remove_note(i); renderNotes(); }, false);
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
    const input = document.createElement("textarea");
    input.rows = 1;
    input.maxLength = 500;
    input.value = initial;
    input.className = "sketch-text-input";
    input.style.left = `${x * this.scale}px`;
    input.style.top = `${y * this.scale - 18}px`;
    this.canvas.parentElement.appendChild(input);
    const grow = () => { input.style.height = "auto"; input.style.height = `${input.scrollHeight}px`; };
    grow();
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
    input.addEventListener("input", grow);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
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
  h.addEventListener("mousedown", () => { block.draggable = true; });
  block.addEventListener("dragend", () => { block.draggable = false; });
  return h;
}

let dragFromIndex = -1;

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
      // Caption wraps to fit the width (auto-growing) rather than truncating.
      const cap = document.createElement("textarea");
      cap.className = "caption";
      cap.maxLength = 300;
      cap.rows = 1;
      cap.placeholder = "Caption…";
      cap.value = app.note_caption(i);
      cap.addEventListener("input", () => { app.update_note_caption(i, cap.value); autoGrow(cap); });
      div.append(img, cap);
      queueMicrotask(() => autoGrow(cap));
    }
    div.appendChild(blockActions(i, total));
    els.notesList.appendChild(div);
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
  els.splitter.hidden = !visible;
  els.btn.notes.classList.toggle("active", visible);
  syncAria();
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
els.splitter.addEventListener("pointerup", () => { splitDrag = null; savePrefs(); });
els.splitter.addEventListener("dblclick", () => { els.notesPane.style.width = ""; savePrefs(); });

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

// ---------- PDF.js text layer (Page-text tool) ----------

let textLayerTask = null;

// Build a selectable PDF.js text layer for `page` into `container` at scale
// factor `sf`. Used for the single-page view and for each continuous .cpage.
async function buildTextLayer(page, container = els.textLayer, sf = scale()) {
  container.textContent = "";
  if (container === els.textLayer && textLayerTask?.cancel) textLayerTask.cancel();
  try {
    const lib = await getPdfjs();
    if (typeof lib.TextLayer !== "function") return; // not in this build
    const vp = page.getViewport({ scale: sf });
    container.style.setProperty("--scale-factor", String(sf));
    const task = new lib.TextLayer({
      textContentSource: page.streamTextContent(),
      container,
      viewport: vp,
    });
    if (container === els.textLayer) textLayerTask = task;
    await task.render();
  } catch (e) {
    if (e?.name !== "AbortException") console.warn("text layer:", e);
  }
}

// Build the text layer for one mounted continuous page (Copy-text tool only).
async function buildContTextLayer(i) {
  const p = cont.pages[i];
  if (!p || !p.mounted || !p.textLayer || !pdfDoc) return;
  try {
    const page = await pdfDoc.getPage(i + 1);
    await buildTextLayer(page, p.textLayer, cont.scale);
  } catch { /* best-effort */ }
}

// Build/clear selectable text across the whole continuous column.
function buildAllContTextLayers() {
  for (let i = 0; i < cont.pages.length; i++) {
    if (cont.pages[i].mounted) buildContTextLayer(i);
  }
}
function clearAllTextLayers() {
  els.textLayer.textContent = "";
  for (const p of cont.pages) if (p.textLayer) p.textLayer.textContent = "";
}

// Activate/deactivate selectable text for the Copy-text tool across every mode.
function setCopyText(on) {
  if (!on) { clearAllTextLayers(); return; }
  if (docMode === "html") {
    status("Select text on the page, then ⌘/Ctrl-C to copy.");
    return; // the iframe text is selected directly (see body.textselect CSS)
  }
  if (!pdfDoc) return;
  status("Select text on the page, then ⌘/Ctrl-C to copy.");
  if (isContinuous()) buildAllContTextLayers();
  else pdfDoc.getPage(pageNum + 1).then((pg) => buildTextLayer(pg));
}

// ---------- accessibility toggles ----------

function applyBig(on) {
  document.body.classList.toggle("big", on);
  els.btn.big.classList.toggle("active", on);
  syncAria();
}
els.btn.big.addEventListener("click", () => {
  applyBig(!document.body.classList.contains("big"));
  savePrefs();
});

// Apply the standard or colorblind-safe palette. Shared by the toggle and the
// boot-time preference restore. Colors still come from the closed Rust enum.
function applyPalette(safe, announce = false) {
  app.set_palette(safe ? "safe" : "standard");
  els.btn.palette.classList.toggle("active", safe);
  for (const s of document.querySelectorAll("#colors .swatch")) {
    s.style.background = app.color_css(s.dataset.color);
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

// ---------- keyboard-shortcuts overlay ----------

const helpOverlay = $("help-overlay");
function toggleHelp(show) {
  const open = show ?? helpOverlay.hidden;
  helpOverlay.hidden = !open;
  $("btn-help").classList.toggle("active", open);
  if (open) $("help-close").focus();
}
$("btn-help").addEventListener("click", () => toggleHelp());
$("help-close").addEventListener("click", () => toggleHelp(false));
// Click the dimmed backdrop (but not the card) to dismiss.
helpOverlay.addEventListener("click", (ev) => {
  if (ev.target === helpOverlay) toggleHelp(false);
});

// ---------- embedded mode (the FULL app, running inside an exam page) ----------
//
// When Scribble is framed same-origin inside a host page (e.g. PrairieLearn),
// it is the complete tool — every drawing tool, the notes pane, sketches — and
// it gains the ability to pull the host's problem content (text, figures,
// equations) straight into the Notes pane. It only READS the host DOM and
// turns it into an image or escaped text; it never executes host markup.
//
// Activated by `?embed` plus a reachable, same-origin parent document.
// Everything here is additive — standalone mode never runs it.
function initEmbed() {
  if (!new URLSearchParams(location.search).has("embed")) return;
  let host, sourceEl;
  try {
    host = window.parent.document;                      // throws if cross-origin
    const sel = (window.frameElement && window.frameElement.dataset.source)
      || "[data-scribble-source]";
    sourceEl = host.querySelector(sel) || host.body;
  } catch {
    status("Embedded, but can't read the host page (cross-origin).");
    return;
  }
  document.body.classList.add("embedded");
  els.placeholder.textContent =
    "Snip text, figures or equations from the problem on the left — they land in your notes. You can also draw your own scratch work (＋ Draw).";
  toggleNotes(true);

  const dpr2 = () => Math.min(3, Math.max(1, window.devicePixelRatio || 1));

  function svgToPng(svg) {
    return new Promise((res, rej) => {
      const box = svg.getBoundingClientRect();
      const w = Math.max(1, Math.round(box.width));
      const h = Math.max(1, Math.round(box.height));
      const clone = svg.cloneNode(true);
      clone.setAttribute("width", w);
      clone.setAttribute("height", h);
      if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      const xml = new XMLSerializer().serializeToString(clone);
      const url = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(xml)));
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = w * dpr2(); c.height = h * dpr2();
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        res(c.toDataURL("image/png"));
      };
      img.onerror = () => rej(new Error("could not rasterize SVG"));
      img.src = url;
    });
  }
  function imgToPng(imgEl) {
    return new Promise((res, rej) => {
      const draw = (image) => {
        const c = document.createElement("canvas");
        c.width = image.naturalWidth || image.width;
        c.height = image.naturalHeight || image.height;
        c.getContext("2d").drawImage(image, 0, 0);
        res(c.toDataURL("image/png"));
      };
      const im = new Image();
      im.onload = () => { try { draw(im); } catch (e) { rej(e); } };
      im.onerror = () => rej(new Error("image load failed"));
      im.src = imgEl.src;
    });
  }
  function latexOf(node) {
    const eq = node.closest && node.closest("[data-latex]");
    if (eq && eq.dataset.latex) return eq.dataset.latex.trim();
    const ann = node.querySelector && node.querySelector('annotation[encoding="application/x-tex"]');
    return ann ? ann.textContent.trim() : "";
  }
  function capturableAt(x, y) {
    let n = host.elementFromPoint(x, y);
    while (n && n !== sourceEl.parentNode) {
      if (n.matches && n.matches("[data-latex], svg, img, canvas")) return n;
      n = n.parentNode;
    }
    return null;
  }
  async function pngOf(node) {
    const tag = node.tagName.toLowerCase();
    const svg = tag === "svg" ? node : node.querySelector && node.querySelector("svg");
    if (svg) return svgToPng(svg);
    if (tag === "img") return imgToPng(node);
    if (tag === "canvas") return node.toDataURL("image/png");
    return "";
  }
  async function captureNode(node) {
    try {
      const dataUrl = await pngOf(node);
      if (!dataUrl) { status("Couldn't capture that element."); return; }
      const latex = latexOf(node);
      app.add_clipping(dataUrl.split(",")[1], 0,
        latex || node.getAttribute("alt") || "from the problem");
      renderNotes();
      if (els.notesPane.hidden) toggleNotes(true);
      status(latex ? "Captured figure + LaTeX into your notes." : "Captured into your notes.");
    } catch (e) {
      status("Capture failed: " + (e.message || e));
    }
  }
  function grabText() {
    const sel = host.getSelection ? host.getSelection() : null;
    const t = sel ? sel.toString().trim() : "";
    if (!t) { status("Select some text in the problem first."); return; }
    try { app.add_text_note(t); renderNotes(); if (els.notesPane.hidden) toggleNotes(true); sel.removeAllRanges(); status("Added the problem text to your notes."); }
    catch (e) { status(String(e)); }
  }

  // host-snip mode: hover highlights a figure/equation in the problem, click captures
  let snipMode = false, hovered = null;
  function setSnip(on) {
    snipMode = on;
    btnSnipHost.classList.toggle("active", on);
    sourceEl.style.cursor = on ? "copy" : "";
    if (!on) clearHover();
    status(on ? "Click a figure or equation in the problem to capture it." : "");
  }
  function clearHover() { if (hovered) hovered.classList.remove("se-host-hl"); hovered = null; }
  host.addEventListener("mousemove", (ev) => {
    if (!snipMode) return;
    const n = capturableAt(ev.clientX, ev.clientY);
    if (n !== hovered) { clearHover(); hovered = n; if (n) n.classList.add("se-host-hl"); }
  }, true);
  host.addEventListener("click", (ev) => {
    if (!snipMode) return;
    const n = capturableAt(ev.clientX, ev.clientY);
    if (!n) return;
    ev.preventDefault(); ev.stopPropagation();
    captureNode(n);
    setSnip(false);
  }, true);
  const hl = host.createElement("style");
  hl.textContent = ".se-host-hl{outline:2px solid #2f5fde;outline-offset:3px;border-radius:4px;cursor:copy;}";
  host.head.appendChild(hl);

  // embed-only action buttons in our top bar. They carry an icon so they stay
  // usable at the narrow widths where text labels collapse (like other btns).
  const mk = (svg, label, fn) => {
    const b = document.createElement("button");
    b.className = "btn labeled";
    b.title = label;
    b.innerHTML = `<svg viewBox="0 0 24 24">${svg}</svg>`;
    b.append(document.createTextNode(label));
    b.addEventListener("click", fn);
    return b;
  };
  const btnSnipHost = mk(
    '<path d="M4 8V4h4"/><path d="M16 4h4v4"/><path d="M20 16v4h-4"/><path d="M8 20H4v-4"/><rect x="9" y="9" width="6" height="6"/>',
    "Snip from problem", () => setSnip(!snipMode));
  const btnGrab = mk(
    '<path d="M5 6h14M5 11h9"/><path d="M17.5 13v7M14 16.5h7"/>',
    "Grab problem text", grabText);
  const group = document.createElement("div");
  group.className = "embed-actions";
  group.append(btnSnipHost, btnGrab);
  document.getElementById("topbar").insertBefore(
    group, document.querySelector(".topbar-right"));
}

// ---------- persistence: UI prefs (localStorage) + autosave recovery (IndexedDB) ----------
//
// Two independent layers, both best-effort (private-mode / disabled storage just
// degrades silently):
//   • UI prefs — palette, larger-controls, notes-pane width — survive reloads.
//   • Autosave — the annotation document is snapshotted to IndexedDB keyed by the
//     open PDF's hash, so a crash/accidental close can be recovered when the same
//     PDF is reopened. Nothing leaves the machine; it's the same local-only data.

const PREFS_KEY = "scribble.prefs.v1";

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      palette: els.btn.palette.classList.contains("active") ? "safe" : "standard",
      big: document.body.classList.contains("big"),
      notesWidth: els.notesPane.style.width || "",
    }));
  } catch { /* storage unavailable — non-fatal */ }
}

function applyPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {}; } catch { /* ignore */ }
  if (p.big) applyBig(true);
  if (p.notesWidth) els.notesPane.style.width = p.notesWidth;
  applyPalette(p.palette === "safe"); // also paints the swatches for the active palette
}

// --- IndexedDB key/value helpers (one object store, keyed by PDF hash) ---
const IDB_NAME = "scribble";
const IDB_STORE = "autosave";
let idbPromise = null;
function idb() {
  if (!idbPromise) {
    idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return idbPromise;
}
function idbReq(mode, fn) {
  return idb().then((db) => new Promise((resolve, reject) => {
    const store = db.transaction(IDB_STORE, mode).objectStore(IDB_STORE);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}
const idbGet = (key) => idbReq("readonly", (s) => s.get(key));
const idbPut = (key, val) => idbReq("readwrite", (s) => s.put(val, key));
const idbDelete = (key) => idbReq("readwrite", (s) => s.delete(key));

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
    await idbPut(key, { json, savedAt: Date.now(), pages: pdfDoc?.numPages || 0 });
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

// Read-only debug handle, opt-in via ?debug (used by tests; harmless: the
// page is fully client-side and the user already owns all state).
if (new URLSearchParams(location.search).has("debug")) {
  Object.defineProperty(window, "__app", { get: () => app });
  Object.defineProperty(window, "__pdf", { get: () => pdfDoc });
}

init()
  .then(() => {
    app = new App();
    applyPrefs();
    updateContextBar(activeTool()); // hide the colour UI (and palette) until a doc opens
    initEmbed();
  })
  .catch((e) => {
    console.error("WASM init failed:", e);
    status(`Failed to start: ${e?.message || e}`);
  });
