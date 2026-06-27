// Scribble — tiny IndexedDB key/value store (one object store, keyed by the open
// PDF's hash). Pure storage utility with no app/document state; it backs the
// annotation autosave + crash-recovery layer in app.js. Everything stays local
// to the browser. Bump idb.js's ?v= import in app.js together with APP_VERSION.

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

export const idbGet = (key) => idbReq("readonly", (s) => s.get(key));
export const idbPut = (key, val) => idbReq("readwrite", (s) => s.put(val, key));
export const idbDelete = (key) => idbReq("readwrite", (s) => s.delete(key));

// Enumerate every entry as {key, savedAt} (a snapshot can be ~MBs with clippings).
export function idbEntries() {
  return idb().then((db) => new Promise((resolve, reject) => {
    const out = [];
    const req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) { out.push({ key: cur.key, savedAt: (cur.value && cur.value.savedAt) || 0 }); cur.continue(); }
      else resolve(out);
    };
    req.onerror = () => reject(req.error);
  }));
}

// Keep only the `keepN` most-recently-saved snapshots; delete the rest. Best-effort —
// bounds the store (one entry per PDF, up to ~30 MB each) so it can't exhaust quota.
export async function idbPrune(keepN = 20) {
  try {
    const entries = await idbEntries();
    if (entries.length <= keepN) return;
    entries.sort((a, b) => b.savedAt - a.savedAt);
    for (const e of entries.slice(keepN)) {
      try { await idbDelete(e.key); } catch { /* ignore */ }
    }
  } catch { /* enumeration unavailable — non-fatal */ }
}
