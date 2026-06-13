// Scribble embed — HTML capture module (proof of concept).
//
// This is the part that only works when Scribble runs INSIDE the page that
// holds the exam content (the "embedded" model). It mounts a small scratch
// panel and lets the student pull content out of a host "source" element:
//
//   1. selected text   -> a text note            (native selection, trivial)
//   2. a figure / image / equation element -> a clipping (PNG + any LaTeX)
//
// Everything here only READS the host DOM and renders it to an image or
// escaped text; it never executes host markup, so it adds no injection
// surface. In production the same two capture functions feed Scribble's real
// (Rust/WASM) notes pipeline; here they feed a lightweight local list so the
// approach can be demoed without the full app.

(function () {
  "use strict";

  // ---- helpers ---------------------------------------------------------

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === "class") n.className = props[k];
      else if (k === "text") n.textContent = props[k];
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), props[k]);
      else n.setAttribute(k, props[k]);
    }
    for (const c of kids) if (c) n.append(c);
    return n;
  }

  const DPR = () => Math.min(3, Math.max(1, window.devicePixelRatio || 1));

  // Render an <svg> element to a PNG data URL (lossless, no taint for
  // same-origin / inline SVG). This is the reliable path: in real exams,
  // figures are usually <img>/<svg> and MathJax renders equations as SVG.
  function svgToPng(svg) {
    return new Promise((resolve, reject) => {
      const box = svg.getBoundingClientRect();
      const w = Math.max(1, Math.round(box.width));
      const h = Math.max(1, Math.round(box.height));
      const clone = svg.cloneNode(true);
      clone.setAttribute("width", w);
      clone.setAttribute("height", h);
      if (!clone.getAttribute("xmlns")) {
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      }
      const xml = new XMLSerializer().serializeToString(clone);
      const url = "data:image/svg+xml;base64," +
        btoa(unescape(encodeURIComponent(xml)));
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = w * DPR();
        c.height = h * DPR();
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/png"));
      };
      img.onerror = () => reject(new Error("could not rasterize SVG"));
      img.src = url;
    });
  }

  // Draw an <img> to a PNG data URL (same-origin host images don't taint).
  function imgToPng(imgEl) {
    const c = document.createElement("canvas");
    c.width = imgEl.naturalWidth || imgEl.width;
    c.height = imgEl.naturalHeight || imgEl.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(imgEl, 0, 0);
    return c.toDataURL("image/png");
  }

  // Find the most relevant capturable element under a point: an explicit
  // equation (data-latex), an <svg>, an <img>, or a <canvas>.
  function capturableAt(x, y, root) {
    let n = document.elementFromPoint(x, y);
    while (n && n !== root.parentNode) {
      if (n.matches && n.matches("[data-latex], svg, img, canvas")) return n;
      n = n.parentNode;
    }
    return null;
  }

  // Pull the original LaTeX out of an equation element. Supports a plain
  // data-latex attribute (a common convention) and MathJax's MathML
  // <annotation encoding="application/x-tex">. Returns "" if none.
  function latexOf(node) {
    if (!node) return "";
    const eq = node.closest("[data-latex]");
    if (eq && eq.dataset.latex) return eq.dataset.latex.trim();
    const ann = node.querySelector?.(
      'annotation[encoding="application/x-tex"]');
    if (ann) return ann.textContent.trim();
    return "";
  }

  async function captureElement(node) {
    const latex = latexOf(node);
    let png = "";
    const tag = node.tagName.toLowerCase();
    const svg = tag === "svg" ? node : node.querySelector?.("svg");
    if (svg) png = await svgToPng(svg);
    else if (tag === "img") png = imgToPng(node);
    else if (tag === "canvas") png = node.toDataURL("image/png");
    return { png, latex, caption: latex || node.getAttribute("alt") || "" };
  }

  // ---- the mountable panel --------------------------------------------

  function mount(rootEl, opts) {
    const source = opts && opts.source;
    if (!source) throw new Error("mount: opts.source (host content element) is required");

    const notes = [];            // { type:'text'|'clip', ... }
    let snipping = false;
    let hovered = null;

    // --- panel UI ---
    rootEl.classList.add("scribble-embed");
    const list = el("div", { class: "se-list" });
    const btnSel = el("button", {
      class: "se-btn", text: "＋ Add selected text",
      title: "Select text in the problem, then click this",
      onclick: addSelection,
    });
    const btnSnip = el("button", {
      class: "se-btn", text: "✂ Snip a figure / equation",
      title: "Click, then click a figure or equation in the problem",
      onclick: toggleSnip,
    });
    const btnCopy = el("button", {
      class: "se-btn", text: "⧉ Copy all to clipboard",
      onclick: copyAll,
    });
    rootEl.append(
      el("div", { class: "se-head" }, el("strong", { text: "Scratch" }),
        el("span", { class: "se-hint", text: "embedded · reads the problem" })),
      el("div", { class: "se-tools" }, btnSel, btnSnip, btnCopy),
      list,
    );

    render();

    // --- selection -> text note ---
    function addSelection() {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : "";
      if (!text) { flash("Select some text in the problem first."); return; }
      // Only accept selections that live inside the host content.
      if (sel.anchorNode && !source.contains(sel.anchorNode)) {
        flash("That selection isn't inside the problem.");
        return;
      }
      notes.push({ type: "text", text });
      sel.removeAllRanges();
      render();
    }

    // --- snip an element ---
    function toggleSnip() {
      snipping = !snipping;
      btnSnip.classList.toggle("active", snipping);
      source.classList.toggle("se-snip-target", snipping);
      flash(snipping ? "Click a figure or equation to snip it." : "");
      clearHover();
    }
    function onMove(ev) {
      if (!snipping) return;
      const node = capturableAt(ev.clientX, ev.clientY, source);
      if (node !== hovered) { clearHover(); hovered = node; if (node) node.classList.add("se-hl"); }
    }
    function clearHover() { if (hovered) hovered.classList.remove("se-hl"); hovered = null; }
    async function onClick(ev) {
      if (!snipping) return;
      const node = capturableAt(ev.clientX, ev.clientY, source);
      if (!node || !source.contains(node)) return;
      ev.preventDefault();
      ev.stopPropagation();
      try {
        const clip = await captureElement(node);
        if (!clip.png) { flash("Couldn't capture that element."); return; }
        notes.push({ type: "clip", ...clip });
        render();
        flash(clip.latex ? "Snipped — image + LaTeX captured." : "Snipped to scratch.");
      } catch (e) {
        flash("Snip failed: " + e.message);
      }
      toggleSnip();
    }
    document.addEventListener("mousemove", onMove);
    source.addEventListener("click", onClick, true);

    // --- render the scratch list ---
    function render() {
      list.textContent = "";
      if (notes.length === 0) {
        list.append(el("div", { class: "se-empty",
          text: "Nothing yet. Select text or snip a figure/equation from the problem." }));
        return;
      }
      notes.forEach((nt, i) => {
        const block = el("div", { class: "se-block" });
        const del = el("button", {
          class: "se-del", text: "✕", title: "Remove",
          onclick: () => { notes.splice(i, 1); render(); },
        });
        if (nt.type === "text") {
          const ta = el("textarea", { class: "se-ta" });
          ta.value = nt.text;
          ta.addEventListener("input", () => { nt.text = ta.value; });
          block.append(ta);
        } else {
          const img = el("img", { class: "se-img", src: nt.png, alt: "clipping" });
          block.append(img);
          if (nt.latex) {
            block.append(el("code", { class: "se-latex", text: nt.latex }));
          }
          const cap = el("input", { class: "se-cap", placeholder: "Caption…" });
          cap.value = nt.caption || "";
          cap.addEventListener("input", () => { nt.caption = cap.value; });
          block.append(cap);
        }
        block.append(del);
        list.append(block);
      });
    }

    function copyAll() {
      const text = notes.map((n) =>
        n.type === "text" ? n.text
          : `[clipping]${n.latex ? " LaTeX: " + n.latex : ""}${n.caption ? " — " + n.caption : ""}`
      ).join("\n\n");
      navigator.clipboard?.writeText(text).then(
        () => flash("Copied notes to clipboard."),
        () => flash("Clipboard not available."));
    }

    let flashTimer;
    function flash(msg) {
      let bar = rootEl.querySelector(".se-flash");
      if (!bar) { bar = el("div", { class: "se-flash" }); rootEl.append(bar); }
      bar.textContent = msg;
      bar.style.opacity = msg ? "1" : "0";
      clearTimeout(flashTimer);
      if (msg) flashTimer = setTimeout(() => (bar.style.opacity = "0"), 3000);
    }

    return {
      destroy() {
        document.removeEventListener("mousemove", onMove);
        source.removeEventListener("click", onClick, true);
        rootEl.textContent = "";
      },
    };
  }

  window.Scribble = { mount };
})();
