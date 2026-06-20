// Scribble — self-contained PDF writer. Pure functions: given page data
// (JPEG rasters + Rust-generated vector ops) they serialize a flat PDF 1.4 with
// no app or document state. The caller passes the font + ext-gstate resource
// names so this module stays unit-testable in isolation (a headless Node check
// can exercise buildPdf directly). Bump pdf-writer.js's ?v= import in app.js
// together with APP_VERSION (cache busting).

// JPEG-encode a canvas to bytes for embedding as a /DCTDecode image.
export async function canvasJpegBytes(canvas, quality = 0.9) {
  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
  if (!blob) throw new Error("could not encode page image");
  return new Uint8Array(await blob.arrayBuffer());
}

// Serialize `pages` into a flat PDF 1.4 Blob. `fontName`/`gsName` are the
// resource names the page `ops` reference for real text + the highlight
// ext-gstate (both come from the Rust core's closed enums).
export function buildPdf(pages, { fontName, gsName }) {
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
