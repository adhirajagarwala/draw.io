// Scribble — region text extraction. Pulls the readable text under a snip box out
// of the uploaded HTML iframe (DOM-based, reading order, with link URLs and
// recovered equation source) or out of the PDF (PDF.js glyph runs). These hold no
// app state — callers pass the live document handles. Coords are page units (CSS
// px at base width). Bump this module's ?v= import in app.js with APP_VERSION.

// Climb to the nearest equation container (KaTeX, MathJax, raw MathML, or a
// data-latex element) so an equation is captured once as its source rather than
// as garbled, doubled rendered glyphs.
function mathContainerOf(node) {
  let el = node.parentElement;
  while (el) {
    if (el.matches?.(".katex, mjx-container, math, [data-latex]")) return el;
    el = el.parentElement;
  }
  return null;
}

// Keep only the characters of a text node whose glyph-box centre lies inside the
// region (page units), so a box over half a line yields that half — not the
// whole line. Whitespace on an in-region line is kept (words stay separated) and
// a wrap to a new line inserts a space. Returns { str, top, left } or null.
function clipNodeChars(range, node, x0, y0, x1, y1) {
  const text = node.nodeValue;
  let str = "", top = null, left = null, prevCy = null;
  for (let i = 0; i < text.length; i++) {
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    const rc = range.getBoundingClientRect();
    if (rc.width === 0 && rc.height === 0) continue; // collapsed glyph (e.g. soft wrap)
    const cx = (rc.left + rc.right) / 2, cy = (rc.top + rc.bottom) / 2;
    if (cy < y0 || cy > y1) continue;               // a different line
    const ws = /\s/.test(text[i]);
    if (!ws && (cx < x0 || cx > x1)) continue;      // glyph outside the box horizontally
    if (prevCy !== null && Math.abs(cy - prevCy) > 4 && str && !str.endsWith(" ")) str += " ";
    if (!ws && top === null) { top = rc.top; left = rc.left; }
    str += text[i];
    prevCy = cy;
  }
  return top === null ? null : { str, top, left };
}

// Returns { text, hadMath }: the readable text under the region (reading order,
// links, recovered equations) and whether any equation source was recovered (so
// the caller can keep symbol-heavy math past the dingbat filter). Pass the page's
// <iframe> element.
export function htmlTextInRegion(htmlFrame, x0, y0, w, h) {
  let doc;
  try { doc = htmlFrame.contentDocument; } catch { return { text: "", hadMath: false }; }
  if (!doc || !doc.body) return { text: "", hadMath: false };
  const x1 = x0 + w, y1 = y0 + h;
  const hits = [];
  const seenLinks = new Set();
  const mathSeen = new Set();
  let hadMath = false;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const s = n.nodeValue.trim();
    if (!s) continue;
    range.selectNodeContents(n);
    // The iframe's content geometry is in page units regardless of the parent
    // transform:scale — the transform lives on the <iframe> element and is
    // invisible to the child document's getClientRects (verified live at zoom
    // 0.5/1/2), so no scale division is needed.
    let box = null;
    for (const rc of range.getClientRects()) {
      if (rc.right >= x0 && rc.left <= x1 && rc.bottom >= y0 && rc.top <= y1) { box = rc; break; }
    }
    if (!box) continue;
    // Equations: KaTeX/MathJax render the visible glyphs AND a hidden MathML+TeX
    // twin, so naive text-walking doubles/garbles them. Capture the recoverable
    // TeX source once per container and skip its glyph/annotation runs entirely.
    const mc = mathContainerOf(n);
    if (mc) {
      if (!mathSeen.has(mc)) {
        mathSeen.add(mc);
        const ann = mc.querySelector?.('annotation[encoding="application/x-tex"]');
        const tex = (ann ? ann.textContent : (mc.getAttribute?.("data-latex") || "")).trim();
        if (tex) {
          const r = mc.getBoundingClientRect();
          hits.push({ top: r.top, left: r.left, str: tex });
          hadMath = true;
        }
      }
      continue; // never emit an equation's raw rendered/annotation text
    }
    // Sub-region precision: keep only the characters under the selection so a box
    // over half a line yields that half, not the whole line. A node fully inside
    // the region (or one too long to scan per-char) is taken whole.
    const ub = range.getBoundingClientRect();
    const wholeIn = ub.left >= x0 - 0.5 && ub.right <= x1 + 0.5 &&
                    ub.top >= y0 - 0.5 && ub.bottom <= y1 + 0.5;
    let str, anchorTop = box.top, anchorLeft = box.left;
    if (wholeIn || n.nodeValue.length > 4000) {
      str = s;
    } else {
      const clip = clipNodeChars(range, n, x0, y0, x1, y1);
      if (!clip) continue;
      str = clip.str.replace(/\s+/g, " ").trim();
      if (!str) continue;
      anchorTop = clip.top;
      anchorLeft = clip.left;
    }
    const a = n.parentElement && n.parentElement.closest("a[href]");
    if (a) {
      const href = a.getAttribute("href");
      if (href && !seenLinks.has(href)) { seenLinks.add(href); str += ` (${href})`; }
    }
    hits.push({ top: anchorTop, left: anchorLeft, str });
  }
  // Reconstruct reading order: rows top-to-bottom, then left-to-right within a row.
  return assembleReadingOrder(hits, hadMath);
}

// Overlay mode: the question lives in the PARENT page (not an iframe), so text-node geometry is in
// VIEWPORT coords — convert to page coords by subtracting the host's top-left. Whole-node granularity
// (a caption, not a transcript); MathJax's hidden MathML twin is skipped so equations don't double up.
export function overlayTextInRegion(host, x0, y0, w, h) {
  if (!host || !host.ownerDocument) return { text: "", hadMath: false };
  const hb = host.getBoundingClientRect();
  const ox = hb.left, oy = hb.top;
  const x1 = x0 + w, y1 = y0 + h;
  const doc = host.ownerDocument;
  const hits = [], seenLinks = new Set(), mathSeen = new Set();
  let hadMath = false;
  const walker = doc.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const s = n.nodeValue.trim();
    if (!s) continue;
    const pe = n.parentElement;
    if (!pe) continue;
    if (pe.closest("mjx-assistive-mml, .MathJax_Preview, .katex-mathml")) continue; // hidden math twin
    range.selectNodeContents(n);
    let box = null;
    for (const rc of range.getClientRects()) {
      const l = rc.left - ox, t = rc.top - oy, r = rc.right - ox, b = rc.bottom - oy;
      if (r >= x0 && l <= x1 && b >= y0 && t <= y1) { box = { top: t, left: l }; break; }
    }
    if (!box) continue;
    const mc = pe.closest("mjx-container, .MathJax, [data-latex], .katex");
    if (mc) {
      hadMath = true;
      if (mathSeen.has(mc)) continue;
      mathSeen.add(mc);
      const tex = (mc.getAttribute("data-latex")
        || mc.querySelector?.('annotation[encoding="application/x-tex"]')?.textContent || s).trim();
      const r = mc.getBoundingClientRect();
      hits.push({ top: r.top - oy, left: r.left - ox, str: tex });
      continue;
    }
    // Sub-region precision: keep only the characters actually under the box, so a box over half a
    // sentence yields that half — not the whole text node. clipNodeChars works in VIEWPORT coords, so
    // convert the page-space region back to viewport (add the host origin). A node fully inside the box,
    // or one too long to scan per-char, is taken whole. (This mirrors htmlTextInRegion.)
    const ub = range.getBoundingClientRect();
    const vx0 = x0 + ox, vy0 = y0 + oy, vx1 = x1 + ox, vy1 = y1 + oy;
    const wholeIn = ub.left >= vx0 - 0.5 && ub.right <= vx1 + 0.5 && ub.top >= vy0 - 0.5 && ub.bottom <= vy1 + 0.5;
    let str = s, aTop = box.top, aLeft = box.left;
    if (!wholeIn && n.nodeValue.length <= 4000) {
      const clip = clipNodeChars(range, n, vx0, vy0, vx1, vy1);
      if (!clip) continue;
      str = clip.str.replace(/\s+/g, " ").trim();
      if (!str) continue;
      aTop = clip.top - oy; aLeft = clip.left - ox;
    }
    const a = pe.closest("a[href]");
    if (a) { const href = a.getAttribute("href"); if (href && !seenLinks.has(href)) { seenLinks.add(href); str += ` (${href})`; } }
    hits.push({ top: aTop, left: aLeft, str });
  }
  // SVG-rendered MathJax has NO text nodes (the glyphs are SVG paths and the MathML twin is skipped above),
  // so the text walk misses every equation. Catch each math container in the region directly and pull its
  // accessible source — TeX if present, else MathJax's plain speech ("t equals 0") — so math isn't dropped.
  const mathText = (mc) => {
    const sp = mc.getAttribute("data-semantic-speech-none"); // MathJax's clean spoken form, e.g. "t equals 0"
    if (sp && sp.trim()) return sp.replace(/\s+/g, " ").trim();
    // else a real TeX source if present; do NOT fall back to raw MathML textContent (it runs the tokens
    // together into garble like "dqdt"). No clean source → skip it (the snip IMAGE still carries the math).
    return (mc.getAttribute("data-latex")
      || mc.querySelector?.('annotation[encoding="application/x-tex"]')?.textContent || "").trim();
  };
  // ONE representation per TOP-LEVEL equation: match only the outer container (a bare [data-latex] selector
  // catches nested sub-expressions, and each fragment would garble the caption) and skip nested/seen ones.
  for (const mc of host.querySelectorAll("mjx-container, .katex")) {
    if (mathSeen.has(mc) || mc.parentElement?.closest("mjx-container, .katex")) continue;
    const r = mc.getBoundingClientRect();
    const l = r.left - ox, t = r.top - oy;
    if (!(r.right - ox >= x0 && l <= x1 && r.bottom - oy >= y0 && t <= y1)) continue; // outside the snip
    mathSeen.add(mc);
    const str = mathText(mc);
    if (!str) continue;
    hadMath = true;
    // Anchor at the container top (matches the surrounding text hits' box.top). A tall inline equation's box
    // extends above/below the line, so linearising it into a 1-D caption can't be pixel-perfect — top keeps it
    // roughly in its sentence position (centre-anchoring pushed it out of order and read worse).
    hits.push({ top: t, left: l, str });
  }
  return assembleReadingOrder(hits, hadMath);
}

// Extract PDF text overlapping the region, in reading order. Uses each glyph
// run's box (not just its baseline anchor) so partly-covered runs are caught,
// and groups runs into rows so the result reads top-to-bottom, left-to-right.
// Pass the loaded pdfDoc, the 0-based pageNum, and basePage { w, h }.
export async function pdfTextInRegion(pdfDoc, pageNum, basePage, x0, y0, w, h) {
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
        // Sub-region precision: if the run is only partly inside the box, keep
        // just the characters whose estimated centre falls in it. PDF.js gives no
        // per-glyph boxes, so the run width is split proportionally — approximate,
        // but far better than dumping the whole line for a half-line selection.
        let str = item.str;
        if ((left < x0 || right > x1) && item.str.length > 1 && iw > 0) {
          const cw = iw / item.str.length;
          let s2 = "";
          for (let k = 0; k < item.str.length; k++) {
            const cxk = left + cw * (k + 0.5);
            if (cxk >= x0 && cxk <= x1) s2 += item.str[k];
          }
          str = s2;
        }
        if (str) hits.push({ x: Math.max(left, x0), y: top, str, eol: item.hasEOL });
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

// v189: single source for the row-then-column reading-order reconstruction + whitespace normalization that
// htmlTextInRegion and overlayTextInRegion both ended with (byte-identical). The 6px row-gap threshold and the
// normalize regex now live in ONE place so a tweak can't be hand-copied to only one caller. (function-hoisted.)
function assembleReadingOrder(hits, hadMath) {
  hits.sort((p, q) => (Math.abs(p.top - q.top) > 6 ? p.top - q.top : p.left - q.left));
  let text = "", prevTop = null;
  for (const it of hits) {
    if (prevTop !== null) text += (it.top - prevTop > 6) ? "\n" : " ";
    text += it.str;
    prevTop = it.top;
  }
  return {
    text: text.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
    hadMath,
  };
}
