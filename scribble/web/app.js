// Scribble — thin JS glue layer. All annotation logic lives in Rust/WASM.
// No network calls except loading local static assets. No storage of student
// content outside explicit file downloads.

import init, { App } from "./pkg/scribble.js";

// PDF.js is imported lazily so a load failure there can never break the UI.
let pdfjsLib = null;
async function getPdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = await import("./vendor/pdfjs/pdf.min.mjs");
    pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.min.mjs";
  }
  return pdfjsLib;
}

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 100;
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

const $ = (id) => document.getElementById(id);
const els = {
  placeholder: $("placeholder"),
  wrap: $("page-wrap"),
  pdfCanvas: $("pdf-canvas"),
  annoCanvas: $("anno-canvas"),
  textInput: $("text-input"),
  filePdf: $("file-pdf"),
  fileJson: $("file-json"),
  pageIndicator: $("page-indicator"),
  zoomIndicator: $("zoom-indicator"),
  status: $("status"),
  btn: {
    open: $("btn-open"), save: $("btn-save"), load: $("btn-load"),
    undo: $("btn-undo"), redo: $("btn-redo"),
    prev: $("btn-prev"), next: $("btn-next"),
    zoomIn: $("btn-zoom-in"), zoomOut: $("btn-zoom-out"),
    export: $("btn-export"),
  },
};

let app;            // WASM App
let pdfDoc = null;  // PDF.js document
let pageNum = 0;    // 0-based current page
let zoomIdx = 2;    // index into ZOOM_STEPS
let drawing = false;
let renderTask = null;

const scale = () => ZOOM_STEPS[zoomIdx];

let statusTimer;
function status(msg) {
  els.status.textContent = msg; // textContent only — never HTML
  els.status.classList.add("show");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => els.status.classList.remove("show"), 4000);
}

// ---------- rendering ----------

function redrawAnnotations() {
  const ctx = els.annoCanvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, els.annoCanvas.width, els.annoCanvas.height);
  app.render(ctx, pageNum, scale());
  els.btn.undo.disabled = !app.can_undo();
  els.btn.redo.disabled = !app.can_redo();
}

async function renderPage() {
  if (!pdfDoc) return;
  commitTextInput();
  const page = await pdfDoc.getPage(pageNum + 1);
  const base = page.getViewport({ scale: 1 });
  app.ensure_page(pageNum, base.width, base.height);
  const vp = page.getViewport({ scale: scale() });
  const w = Math.floor(vp.width), h = Math.floor(vp.height);
  for (const c of [els.pdfCanvas, els.annoCanvas]) {
    c.width = w;
    c.height = h;
  }
  if (renderTask) renderTask.cancel();
  renderTask = page.render({ canvasContext: els.pdfCanvas.getContext("2d"), viewport: vp });
  try {
    await renderTask.promise;
  } catch (e) {
    if (e?.name !== "RenderingCancelledException") throw e;
    return;
  }
  renderTask = null;
  els.pageIndicator.textContent = `${pageNum + 1} / ${pdfDoc.numPages}`;
  els.zoomIndicator.textContent = `${Math.round(scale() * 100)}%`;
  els.btn.prev.disabled = pageNum === 0;
  els.btn.next.disabled = pageNum >= pdfDoc.numPages - 1;
  els.btn.zoomOut.disabled = zoomIdx === 0;
  els.btn.zoomIn.disabled = zoomIdx === ZOOM_STEPS.length - 1;
  redrawAnnotations();
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
      disableAutoFetch: true,
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
    zoomIdx = 2;
    els.placeholder.hidden = true;
    els.wrap.hidden = false;
    els.btn.save.disabled = false;
    els.btn.load.disabled = false;
    els.btn.export.disabled = false;
    await renderPage();
    status("PDF loaded. Scribble away!");
  } catch (e) {
    console.error("openPdf failed:", e);
    status(`Could not open PDF: ${e?.message || e}`);
  }
}

// ---------- pointer input ----------

function pageCoords(ev) {
  const r = els.annoCanvas.getBoundingClientRect();
  return [(ev.clientX - r.left) / scale(), (ev.clientY - r.top) / scale()];
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
  if (tool === "text") {
    // Prevent the click's default focus behavior from stealing focus
    // back from the text input (which would instantly commit/close it).
    ev.preventDefault();
    const id = app.find_text(pageNum, x, y);
    if (id >= 0) {
      // Existing note: drag to move; release without moving to edit.
      commitTextInput();
      if (app.begin_text_drag(pageNum, id)) {
        textDrag = { id, startX: x, startY: y, moved: false };
        capturePointer(ev);
      }
      return;
    }
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
  if (textDrag) {
    const [x, y] = pageCoords(ev);
    if (Math.hypot(x - textDrag.startX, y - textDrag.startY) > 3 / scale()) {
      textDrag.moved = true;
    }
    if (textDrag.moved) {
      app.drag_text(x, y);
      redrawAnnotations();
    }
    return;
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
  if (textDrag) {
    const { id, moved } = textDrag;
    textDrag = null;
    app.end_text_drag();
    if (!moved) {
      // A plain click on an existing note opens it for editing.
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
  textDrag = null;
  app.pointer_cancel();
  redrawAnnotations();
});

// ---------- text notes (place / edit / drag) ----------

let pendingText = null; // {x, y, editId} in page coords
let textDrag = null;    // {id, startX, startY, moved}

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
  if (file.size > 10 * 1024 * 1024) {
    status("Annotation file too large.");
    return;
  }
  let text;
  try {
    text = await file.text();
  } catch {
    status("Could not read file.");
    return;
  }
  const currentSha = app.pdf_sha256();
  try {
    app.load_json(text);
  } catch (e) {
    status(`Could not load annotations: ${e}`);
    return;
  }
  const loadedSha = app.pdf_sha256();
  if (loadedSha && currentSha && loadedSha !== currentSha) {
    status("Warning: these annotations were made on a different PDF.");
  } else {
    status("Annotations loaded.");
  }
  app.set_pdf_sha256(currentSha); // keep hash of the actually-open PDF
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
  // pages: [{ w, h, pxW, pxH, jpeg: Uint8Array, ops: string }] — w/h in PDF
  // points; `ops` is the Rust-generated vector operator stream (annotations
  // stay crisp vectors; text notes remain real, selectable PDF text).
  const enc = new TextEncoder();
  const chunks = [];
  let offset = 0;
  const offsets = [];
  const push = (data) => {
    const b = typeof data === "string" ? enc.encode(data) : data;
    chunks.push(b);
    offset += b.length;
  };
  const obj = (n, body) => {
    offsets[n] = offset;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };

  push("%PDF-1.4\n");
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker

  // 1 Catalog, 2 Pages, 3 Font, 4 ExtGState, then 3 objects per page.
  const FIRST_PAGE_OBJ = 5;
  const fontName = app.text_font_name();
  const gsName = app.highlight_gstate_name();
  const kids = pages.map((_, i) => `${FIRST_PAGE_OBJ + i * 3} 0 R`).join(" ");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  obj(4, "<< /Type /ExtGState /CA 0.35 /ca 0.35 /BM /Multiply >>");

  pages.forEach((p, i) => {
    const pageN = FIRST_PAGE_OBJ + i * 3, contentN = pageN + 1, imageN = pageN + 2;
    const w = p.w.toFixed(2), h = p.h.toFixed(2);
    obj(pageN,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << ` +
      `/XObject << /Im0 ${imageN} 0 R >> /Font << /${fontName} 3 0 R >> ` +
      `/ExtGState << /${gsName} 4 0 R >> >> /Contents ${contentN} 0 R >>`);
    const stream = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q\n${p.ops}`;
    const streamBytes = enc.encode(stream);
    offsets[contentN] = offset;
    push(`${contentN} 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n`);
    push(streamBytes);
    push("\nendstream\nendobj\n");
    offsets[imageN] = offset;
    push(
      `${imageN} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.pxW} /Height ${p.pxH} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
    push(p.jpeg);
    push("\nendstream\nendobj\n");
  });

  const count = FIRST_PAGE_OBJ + pages.length * 3;
  const xrefAt = offset;
  push(`xref\n0 ${count}\n`);
  push("0000000000 65535 f \n");
  for (let n = 1; n < count; n++) {
    push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  return new Blob(chunks, { type: "application/pdf" });
}

async function exportPdf() {
  if (!pdfDoc) return;
  commitTextInput();
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
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      // Annotations are NOT rasterized — they are exported as vector
      // operators generated by the Rust core (crisp at any zoom).
      pages.push({
        w: base.width, h: base.height,
        pxW: canvas.width, pxH: canvas.height,
        jpeg: await canvasJpegBytes(canvas),
        ops: app.export_pdf_ops(i),
      });
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
    if (!app.set_tool(b.dataset.tool)) return;
    document.querySelectorAll("#toolbar .tool").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
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
els.btn.prev.addEventListener("click", () => { if (pageNum > 0) { pageNum--; renderPage(); } });
els.btn.next.addEventListener("click", () => {
  if (pdfDoc && pageNum < pdfDoc.numPages - 1) { pageNum++; renderPage(); }
});
els.btn.zoomIn.addEventListener("click", () => {
  if (zoomIdx < ZOOM_STEPS.length - 1) { zoomIdx++; renderPage(); }
});
els.btn.zoomOut.addEventListener("click", () => {
  if (zoomIdx > 0) { zoomIdx--; renderPage(); }
});

const TOOL_KEYS = { p: "pen", h: "highlighter", t: "text", e: "eraser" };

document.addEventListener("keydown", (ev) => {
  if (ev.target === els.textInput) return;
  const mod = ev.ctrlKey || ev.metaKey;
  if (mod && ev.key.toLowerCase() === "z") {
    ev.preventDefault();
    if (ev.shiftKey) app.redo(); else app.undo();
    redrawAnnotations();
  } else if (!mod && TOOL_KEYS[ev.key.toLowerCase()]) {
    document.querySelector(`#toolbar [data-tool="${TOOL_KEYS[ev.key.toLowerCase()]}"]`)?.click();
  }
});

window.addEventListener("beforeunload", (ev) => {
  if (app?.is_dirty()) {
    ev.preventDefault();
    ev.returnValue = "";
  }
});

// ---------- boot ----------

// Read-only debug handle, opt-in via ?debug (used by tests; harmless: the
// page is fully client-side and the user already owns all state).
if (new URLSearchParams(location.search).has("debug")) {
  Object.defineProperty(window, "__app", { get: () => app });
}

init()
  .then(() => {
    app = new App();
  })
  .catch((e) => {
    console.error("WASM init failed:", e);
    status(`Failed to start: ${e?.message || e}`);
  });
