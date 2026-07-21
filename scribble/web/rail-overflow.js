// rail-overflow.js — what the OVERLAY toolbar does when it is too narrow for its tools.
//
// TWO modes, exactly one class on #rail at a time (the user is A/B-ing them; the loser gets deleted):
//   .ov-wrap : PURE CSS — the scroller wraps to a 2nd row. This module only promotes everything back first.
//   .ov-more : whole .rail-group / #context-bar nodes are demoted into the More popover, lowest priority first.
//
// GRANULARITY is the group, never the individual tool: the hairline dividers are keyed on
// `.rail-scroll > .rail-group + .rail-group`, so half-emptying a group leaves a dangling separator — and after
// the overlay hide-rules there are only ~5 candidates anyway.
// Bump this module's ?v= import with APP_VERSION.

const GAP = 8; // px of slack required before promoting back — hysteresis, kills demote<->promote flicker

// Which group leaves first (ascending). The Draw group (pen/highlight/text/erase) is Infinity: it NEVER leaves,
// so the core drawing tools are always on the bar. Undo/Redo outrank the colour strip because Ctrl+Z/Ctrl+Y
// fully cover them from the keyboard.
function prioFor(node) {
  if (node.id === "context-bar") return 3;
  if (node.querySelector('[data-tool="snip"]')) return 1;
  if (node.querySelector("#btn-undo, #btn-redo")) return 2;
  if (node.querySelector('[data-tool="select"]')) return 4;
  return Infinity;
}

export function makeOverflow({ rail, scroll, popover, bay, moreBtn, win = window, announce }) {
  let mode = "more", ro = null, raf = 0, lastW = -1, lastH = -1;

  const doc = rail.ownerDocument;
  const realmWin = doc.defaultView || win;

  // Stamp DOM order (where a node returns) + priority (which node leaves) once.
  function stamp() {
    [...scroll.children].forEach((c, i) => {
      if (c.dataset.railOrder == null) c.dataset.railOrder = String(i);
      if (c.dataset.railPrio == null) c.dataset.railPrio = String(prioFor(c));
    });
  }

  const parked = () => [...bay.children];
  const rendered = () => rail.getClientRects().length > 0; // the annotate gate can have us at display:none (measures 0)

  // Re-insert at the ORIGINAL index: find the first still-present sibling whose order is greater. O(n) over <=5.
  function promote(node) {
    const o = +node.dataset.railOrder;
    const ref = [...scroll.children].find((c) => +c.dataset.railOrder > o) || null;
    scroll.insertBefore(node, ref);
    delete node.dataset.railW;
  }

  function demote(node) {
    // Never strand keyboard focus in a node we are about to hide inside a closed popover.
    if (node.contains(doc.activeElement)) moreBtn?.focus();
    node.dataset.railW = String(Math.round(node.getBoundingClientRect().width));
    bay.appendChild(node);
  }

  function promoteAll() { parked().forEach(promote); syncMoreBtn(); }

  // The active tool's group must never leave the bar — losing sight of the tool you are holding is the
  // hidden-irrecoverable-control failure class this project treats as a real bug.
  function activeGroup() {
    const act = scroll.querySelector(".tool.active");
    return act ? act.closest(".rail-group") : null;
  }

  function reflow() {
    if (mode !== "more" || !rendered()) return;
    stamp();
    const act = activeGroup();
    // 1) demote while overflowing, lowest priority first
    let guard = 12;
    while (scroll.scrollWidth > scroll.clientWidth + 1 && guard-- > 0) {
      const cands = [...scroll.children]
        .filter((c) => c !== act && Number.isFinite(+c.dataset.railPrio))
        .sort((a, b) => +a.dataset.railPrio - +b.dataset.railPrio);
      if (!cands.length) break;              // only the un-demotable remain — .rail-scroll's overflow-x carries it
      demote(cands[0]);
    }
    // 2) promote back only when the group genuinely fits again (never trial-promote — that is the flicker, and it
    //    costs a layout flush per attempt). TWO regimes, because a CAPPED bar is content-sized:
    //      chosen width  -> the bar hugs its content (max-content capped at --rail-w), so there is never "slack"
    //                       to measure; ask instead whether shell + content + the group still fits the cap.
    //      full width    -> the bar is a fixed calc(100% - 8px), so real slack in the scroller is the right test.
    const capPx = parseFloat(rail.style.getPropertyValue("--rail-w")) || Infinity;
    let g2 = 12;
    while (g2-- > 0) {
      const shellW = rail.getBoundingClientRect().width - scroll.getBoundingClientRect().width;
      const back = parked()
        .sort((a, b) => +b.dataset.railPrio - +a.dataset.railPrio)   // highest priority returns first
        .find((n) => {
          const w = +n.dataset.railW || 9999;
          return Number.isFinite(capPx)
            ? shellW + scroll.scrollWidth + w + GAP <= capPx
            : scroll.clientWidth - scroll.scrollWidth >= w + GAP;
        });
      if (!back) break;
      promote(back);
    }
    syncMoreBtn();
  }

  let sayTimer = 0;
  function syncMoreBtn() {
    if (!moreBtn) return;
    const n = parked().length;
    moreBtn.setAttribute("aria-label", n ? `More tools, ${n} moved here` : "More tools");
    let badge = moreBtn.querySelector(".more-badge");
    if (n) {
      if (!badge) { badge = doc.createElement("span"); badge.className = "more-badge"; moreBtn.appendChild(badge); }
      badge.textContent = String(n);           // textContent only — never innerHTML
    } else if (badge) badge.remove();
    // an armed tool that left the bar must still read as armed
    moreBtn.classList.toggle("has-active", !!bay.querySelector(".tool.active"));
    if (announce) {
      clearTimeout(sayTimer);
      sayTimer = setTimeout(() => announce(n ? `${n} tool group${n > 1 ? "s" : ""} moved into More` : "All tools on the toolbar"), 300);
    }
  }

  function setMode(next) {
    const m = next === "wrap" ? "wrap" : "more";
    if (m === "wrap") promoteAll();            // wrap owns the layout — nothing may stay parked
    mode = m;
    rail.classList.toggle("ov-wrap", m === "wrap");
    rail.classList.toggle("ov-more", m === "more");
    if (m === "more") reflow();
  }

  // Measure the bar's natural content width (used to DERIVE preset widths that are guaranteed to overflow —
  // hardcoded px could fail to overflow on a wide card, making the whole wrap-vs-More comparison unrunnable).
  function measureContent() {
    const wasParked = parked();
    wasParked.forEach(promote);                // measure the FULL set
    const content = scroll.scrollWidth;
    const shell = rail.getBoundingClientRect().width - scroll.getBoundingClientRect().width;
    if (mode === "more") reflow();             // put it back the way it was
    return { content, shell, full: content + shell };
  }

  // Width budget that RETAINS exactly the top-`keep` priority groups. Presets use this instead of a percentage
  // of content, so Compact and Medium differ by a real NUMBER OF TOOLS rather than landing on the same demotion.
  function budgetFor(keep) {
    const wasParked = parked();
    wasParked.forEach(promote);                                   // measure the FULL set
    const items = [...scroll.children].map((c) => ({ prio: +c.dataset.railPrio, w: c.getBoundingClientRect().width }));
    const shell = rail.getBoundingClientRect().width - scroll.getBoundingClientRect().width;
    items.sort((a, b) => b.prio - a.prio);                        // highest priority is retained first
    const keepW = items.slice(0, Math.max(1, keep)).reduce((s, i) => s + i.w, 0);
    if (mode === "more") reflow();                                // restore the previous demotion state
    return Math.round(shell + keepW + 16);
  }

  function invalidate() { parked().forEach((n) => delete n.dataset.railW); reflow(); }

  function schedule() {
    if (raf) return;
    raf = realmWin.requestAnimationFrame(() => { raf = 0; reflow(); });
  }

  function observe() {
    if (ro || !realmWin.ResizeObserver) return;
    // Observe #rail, NEVER .rail-scroll (.rail-scroll is flex:1 1 auto and WOULD self-trigger every demotion).
    // With a chosen width the bar IS content-sized (max-content capped at --rail-w), so demoting does resize it
    // and this observer does re-fire — but it CONVERGES: demotion only continues while content exceeds the cap,
    // and once it fits, the re-fired reflow finds no overflow and stops. The lastW/lastH early-out below absorbs
    // the settle frame.
    ro = new realmWin.ResizeObserver((entries) => {
      const r = entries[0] && entries[0].contentRect;
      if (r && Math.abs(r.width - lastW) < 1 && Math.abs(r.height - lastH) < 1) return; // early-out
      if (r) { lastW = r.width; lastH = r.height; }
      schedule();
    });
    ro.observe(rail); // DO NOT observe .rail-scroll
  }

  stamp();
  observe();
  return {
    setMode, getMode: () => mode, reflow, promoteAll, measureContent, budgetFor, invalidate,
    dispose() { try { ro?.disconnect(); } catch { /* realm gone */ } ro = null; if (raf) realmWin.cancelAnimationFrame(raf); },
  };
}
