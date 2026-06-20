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
