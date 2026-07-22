// rail-overflow.js — what the OVERLAY toolbar does when it is too narrow for its tools.
//
// ONE model (v171): whole .rail-group / #context-bar nodes are demoted into the More popover, lowest priority
// first, and promoted back when they genuinely fit again. The width-drag handle sets --rail-w (a CAP — the bar
// is content-sized up to it); this engine decides which groups live on the bar vs. in More at that width.
// (The v166–v170 wrap-to-a-2nd-row mode and the Compact/Medium/Full presets are deleted: one overflow model,
// one manual control.)
//
// GRANULARITY is the group, never the individual tool: the hairline dividers are keyed on
// `.rail-scroll > .rail-group + .rail-group`, so half-emptying a group leaves a dangling separator — and after
// the overlay hide-rules there are only ~5 candidates anyway.
// Bump this module's ?v= import with APP_VERSION.

const GAP = 8; // px of slack required before promoting back — hysteresis, kills demote<->promote flicker

// Which group leaves first (ascending). The Draw group (pen/highlight/text/erase) AND Select fall through to
// Infinity: they NEVER leave, so the core tools are always on the bar. Undo/Redo outrank the colour strip
// because Ctrl+Z/Ctrl+Y fully cover them from the keyboard.
// NB: the Marks group (tick/cross/circle/arrow/rect) also lands Infinity, but it is display:none in overlay
// (style.css trim rules) — it MUST be given a finite priority here before it is ever surfaced on the bar,
// or it can neither demote nor count toward the width floor correctly.
function prioFor(node) {
  if (node.id === "context-bar") return 3;
  if (node.querySelector('[data-tool="snip"]')) return 1;
  if (node.querySelector("#btn-undo, #btn-redo")) return 2;
  return Infinity;
}

export function makeOverflow({ rail, scroll, bay, moreBtn, win = window, announce }) {
  let ro = null, raf = 0, lastW = -1, lastH = -1;

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
    // review F5 (symmetric with demote's guard): moving a focused element in the DOM drops keyboard focus to
    // <body> — re-focus the same element after the move so a keyboard user promoting out of More isn't stranded.
    const hadFocus = node.contains(doc.activeElement) ? doc.activeElement : null;
    const o = +node.dataset.railOrder;
    const ref = [...scroll.children].find((c) => +c.dataset.railOrder > o) || null;
    scroll.insertBefore(node, ref);
    delete node.dataset.railW;
    hadFocus?.focus?.();
  }

  function demote(node) {
    // Never strand keyboard focus in a node we are about to hide inside a closed popover.
    if (node.contains(doc.activeElement)) moreBtn?.focus();
    node.dataset.railW = String(Math.round(node.getBoundingClientRect().width));
    bay.appendChild(node);
  }

  // The active tool's group must never leave the bar — losing sight of the tool you are holding is the
  // hidden-irrecoverable-control failure class this project treats as a real bug.
  function activeGroup() {
    const act = scroll.querySelector(".tool.active");
    return act ? act.closest(".rail-group") : null;
  }

  function reflow() {
    if (!rendered()) return;
    // review F3: a COLLAPSED bar hides its groups (display:none) — scrollWidth reads 0, so a reflow here would
    // "promote" everything and fire a false "All tools on the toolbar" announce. The expand path re-sizes the
    // bar, which re-fires the ResizeObserver → a real reflow runs then.
    if (rail.classList.contains("fp-collapsed")) return;
    stamp();
    const act = activeGroup();
    // 1) demote while overflowing, lowest priority first. An all-off group (.group-off — every tool in it
    //    hidden via Customize) is display:none: never a candidate, never counted.
    let guard = 12;
    while (scroll.scrollWidth > scroll.clientWidth + 1 && guard-- > 0) {
      const cands = [...scroll.children]
        .filter((c) => c !== act && Number.isFinite(+c.dataset.railPrio) && !c.classList.contains("group-off"))
        .sort((a, b) => +a.dataset.railPrio - +b.dataset.railPrio);
      if (!cands.length) break;              // only the un-demotable remain — .rail-scroll's overflow-x carries it
      demote(cands[0]);
    }
    // 2) promote back only when the group genuinely fits again (never trial-promote — that is the flicker, and it
    //    costs a layout flush per attempt). TWO regimes, because a CAPPED bar is content-sized:
    //      chosen width  -> the bar hugs its content (max-content capped at --rail-w), so there is never "slack"
    //                       to measure; ask instead whether shell + content + the group still fits the cap.
    //      full width    -> the bar is a fixed calc(100% - 8px), so real slack in the scroller is the right test.
    let capPx = parseFloat(rail.style.getPropertyValue("--rail-w")) || Infinity;
    // review F0 (promote starvation): a MOVED bar with NO chosen width is content-sized too (style.css .fp-moved
    // width:max-content) — the scroller never has slack, so the Infinity-regime slack test below could never
    // pass and tools parked by an earlier narrow cap stayed in More forever after End/double-click ("full
    // width") or a window re-widen. Its real ceiling is the CSS viewport clamp (max-width: calc(100vw - 8px)),
    // so treat THAT as the cap and use the same hypothetical-fit test as a chosen width.
    if (!Number.isFinite(capPx) && rail.classList.contains("fp-moved")) {
      capPx = Math.max(160, (realmWin.innerWidth || 0) - 8);
    }
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

  let sayTimer = 0, lastSaid = 0; // review F1/F7: init 0 so a clean boot / Annotate press announces nothing
  function syncMoreBtn() {
    if (!moreBtn) return;
    // Count TOOLS, not groups — undo/redo park as ONE group but read as TWO tools, and a group-count badge
    // under-sold what was hidden. The colour strip counts as one item (a stated fudge: it isn't a "tool").
    // Hidden (.tool-off) tools are display:none inside the bay and still match this selector — but a hidden
    // tool's GROUP only reaches the bay via demotion, and .group-off groups are never demoted, so in practice
    // the count is of visible, spilled tools.
    const n = bay.querySelectorAll(".tool:not(.tool-off)").length + (bay.querySelector("#context-bar") ? 1 : 0);
    moreBtn.setAttribute("aria-label", n ? `More tools, ${n} moved here` : "More tools");
    let badge = moreBtn.querySelector(".more-badge");
    if (n) {
      if (!badge) { badge = doc.createElement("span"); badge.className = "more-badge"; moreBtn.appendChild(badge); }
      badge.textContent = String(n);           // textContent only — never innerHTML
    } else if (badge) badge.remove();
    // an armed tool that left the bar must still read as armed
    moreBtn.classList.toggle("has-active", !!bay.querySelector(".tool.active"));
    // review F1/F7: announce ONLY when the count actually changed. The old unconditional schedule meant every
    // reflow — including the no-op ones inside railRefit — re-queued a count toast that then OVERWROTE the
    // message that triggered it ("Larger controls on.", the Customize hide/show lines, Reset) ~300ms later in
    // the single #status live region, cutting the professor's named-bug fix down to a 300ms flash. Badge and
    // aria-label above stay unconditional (they're state, not an event).
    if (announce && n !== lastSaid) {
      lastSaid = n;
      clearTimeout(sayTimer);
      sayTimer = setTimeout(() => announce(n ? `${n} tool${n > 1 ? "s" : ""} in More` : "All tools on the toolbar"), 300);
    }
  }

  // (v171 review F4: measureContent — the old promote-everything-measure-restore probe — is deleted. Its only
  // caller was the preset derivation, which is gone; keeping an export that mutates the DOM as a side effect
  // of "measuring" was a foot-gun.)

  // The narrowest useful bar: shell + the never-demoted core (Draw + Select), measured IN PLACE — protected
  // groups are never demoted, so there is no promote churn to undo. The getClientRects filter excludes
  // display:none groups (the overlay-hidden Marks group would otherwise inflate the floor via its Infinity
  // priority); the +16 slack keeps the floor clear of the GAP=8 promote hysteresis.
  function coreWidth() {
    stamp();
    const shell = rail.getBoundingClientRect().width - scroll.getBoundingClientRect().width;
    const core = [...scroll.children]
      .filter((c) => !Number.isFinite(+c.dataset.railPrio) && c.getClientRects().length)
      .reduce((s, c) => s + c.getBoundingClientRect().width, 0);
    return Math.round(shell + core + 16);
  }

  // Full REFIT: promote everything home, then re-demote against CURRENT sizes. promote() clears each group's
  // cached railW stamp and demote() re-stamps fresh widths, so after a size change (.big, a Customize toggle)
  // parked groups can genuinely return — the old "clear railW then reflow" left `+railW || 9999` blocking every
  // promote. Synchronous promote→re-demote is safe (reflow is already synchronous); the announce is
  // debounced in syncMoreBtn, so no spam.
  function invalidate() { parked().forEach(promote); reflow(); }

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
    reflow, coreWidth, invalidate,
    dispose() { try { ro?.disconnect(); } catch { /* realm gone */ } ro = null; if (raf) realmWin.cancelAnimationFrame(raf); },
  };
}
