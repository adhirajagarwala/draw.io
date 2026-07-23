// watchdog.js — CLASSIC script (not a module), loaded BEFORE the app's module graph. ONE job: self-heal the
// PL-overlay first-load race observed live at v172, where the app module FETCHES (200) but never EVALUATES
// (zero statements run — root cause still under investigation) and annotate never arrives. A re-parse of the
// iframe document reliably recovers (verified live), so: if the module hasn't stamped window.__scribbleBooted
// by BOOT_DEADLINE_MS after the window load event, reload this document ONCE. window.name survives document
// reloads inside the same iframe, so it carries the retried marker and a lost second race just leaves the
// page alone instead of reload-looping.
//
// Deliberately NOT here (review W1, high): any pre-boot body classes. An early `overlay` class RELEASES the
// anti-flash gate `html.pl-overlay body:not(.overlay) { visibility:hidden }` (style.css) and paints the
// standalone #placeholder text over the live exam question — first-paint transparency is already delivered
// by the srcdoc's synchronous html.pl-overlay class, and boot-complete visibility belongs to app.js alone.
//
// Scope (review W2): the reload arm is gated on __SCRIBBLE_EMBED — the race is a PL-srcdoc phenomenon, and
// standalone/off-line use must never have a slow healthy boot killed (nor its top-level window.name polluted).
// Deadline (review W3): the countdown is anchored at the window LOAD event, not parse time — module fetches on
// a cold, throttled connection can legitimately take longer than any fixed parse-time budget, while the race
// being healed (fetched-but-never-ran) still fires load and is still caught.
//
// CSP note: this file exists because the iframe's script-src is 'self' with no 'unsafe-inline' — an inline
// watchdog would be stripped. Keep it dependency-free and classic; it must run even when modules can't.
(function () {
  "use strict";
  var BOOT_DEADLINE_MS = 4000;
  var RETRY_MARK = ";scribble-boot-retried";
  try {
    if (!window.__SCRIBBLE_EMBED) return; // PL srcdoc only — inert everywhere else
    var arm = function () {
      setTimeout(function () {
        if (window.__scribbleBooted) return;                    // module evaluated — nothing to heal
        if (window.name.indexOf(RETRY_MARK) !== -1) return;     // already retried once — stay put
        window.name += RETRY_MARK;
        location.reload();                                      // the re-parse path reliably recovers (v172 field data)
      }, BOOT_DEADLINE_MS);
    };
    if (document.readyState === "complete") arm();
    else window.addEventListener("load", arm, { once: true });
  } catch (e) { /* never let the watchdog break a boot that would have succeeded */ }
})();
