// Scribble — pure, dependency-free helpers.
// Nothing here touches app/document state; everything is a plain function of its
// arguments (browser globals like btoa/atob/crypto aside). Kept in one module so
// the same primitives aren't re-implemented across app.js. Bump utils.js's ?v=
// import in app.js together with APP_VERSION (cache busting).

// Base64-encode a byte array in 32 KiB chunks (String.fromCharCode blows the
// call stack on large inputs if applied to the whole array at once).
export function bytesToB64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// Decode a base64 PNG to an object URL (caller revokes when done).
export function b64ToBlobUrl(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
}

// Grow a <textarea> to fit its content (no inner scrollbar).
export function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight}px`;
}

// Heuristic: does this string look like real words rather than dingbat/symbol
// garbage? Used to discard junk captions from PDF/HTML snips. Requires >=2
// letter/number chars and that they form >=50% of the non-space content.
export function looksLikeText(s) {
  if (!s) return false;
  const wordChars = (s.match(/[\p{L}\p{N}]/gu) || []).length;
  const nonSpace = s.replace(/\s/g, "").length;
  return wordChars >= 2 && nonSpace > 0 && wordChars / nonSpace >= 0.5;
}

// Word-wrap text to a column width, preserving explicit newlines. Long words
// past the column are hard-cut. Returns an array of lines.
export function wrapLine(text, cols) {
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

// SHA-256 of a buffer as lowercase hex. crypto.subtle needs a secure context
// (https or localhost); without it we return "" and callers skip the hash check.
export async function sha256Hex(buf) {
  if (!crypto?.subtle) return "";
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
