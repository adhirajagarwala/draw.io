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
  // Reconstruct reading order: rows top-to-bottom, then left-to-right within a
  // row — so multi-column / absolutely-positioned text doesn't read scrambled.
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
