const DB_NAME = "local-discovery";
const DB_VERSION = 1;
const STORE_PAGES = "pages";
const STORE_BLOCKLIST = "blocklist";

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PAGES)) {
        const s = db.createObjectStore(STORE_PAGES, { keyPath: "url" });
        s.createIndex("byTimestamp", "timestamp");
      }
      if (!db.objectStoreNames.contains(STORE_BLOCKLIST)) {
        db.createObjectStore(STORE_BLOCKLIST, { keyPath: "domain" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode = "readonly") {
  return open().then((db) => db.transaction(store, mode).objectStore(store));
}

export async function initDB() {
  await open();
}

// ---- pages ----
// Page record shape:
// { url, title, text, embedding (Float32Array), timestamp, hostname }

export async function putPage(record) {
  const store = await tx(STORE_PAGES, "readwrite");
  return new Promise((resolve, reject) => {
    const r = store.put(record);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

export async function getPage(url) {
  const store = await tx(STORE_PAGES);
  return new Promise((resolve, reject) => {
    const r = store.get(url);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

export async function getAllPages() {
  const store = await tx(STORE_PAGES);
  return new Promise((resolve, reject) => {
    const r = store.getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
}

export async function getRecentPages(limit, sinceTs) {
  const store = await tx(STORE_PAGES);
  const idx = store.index("byTimestamp");
  return new Promise((resolve, reject) => {
    const range = sinceTs ? IDBKeyRange.lowerBound(sinceTs) : null;
    const cursor = idx.openCursor(range, "prev");
    const out = [];
    cursor.onsuccess = (e) => {
      const c = e.target.result;
      if (!c || out.length >= limit) { resolve(out); return; }
      out.push(c.value);
      c.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
}

export async function countPages() {
  const store = await tx(STORE_PAGES);
  return new Promise((resolve, reject) => {
    const r = store.count();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function clearAllPages() {
  const store = await tx(STORE_PAGES, "readwrite");
  return new Promise((resolve, reject) => {
    const r = store.clear();
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

export async function deletePage(url) {
  const store = await tx(STORE_PAGES, "readwrite");
  return new Promise((resolve, reject) => {
    const r = store.delete(url);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

// ---- blocklist ----

export async function addBlockedDomain(domain) {
  const store = await tx(STORE_BLOCKLIST, "readwrite");
  return new Promise((resolve, reject) => {
    const r = store.put({ domain, addedAt: Date.now() });
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

export async function getBlockedDomains() {
  const store = await tx(STORE_BLOCKLIST);
  return new Promise((resolve, reject) => {
    const r = store.getAll();
    r.onsuccess = () => resolve((r.result || []).map((b) => b.domain));
    r.onerror = () => reject(r.error);
  });
}

export async function isDomainBlocked(domain) {
  const store = await tx(STORE_BLOCKLIST);
  return new Promise((resolve, reject) => {
    const r = store.get(domain);
    r.onsuccess = () => resolve(!!r.result);
    r.onerror = () => reject(r.error);
  });
}

// ---- usage stats ----

export async function approxStorageBytes() {
  // 384 * 4 bytes per embedding + average metadata overhead
  const pages = await getAllPages();
  let bytes = 0;
  for (const p of pages) {
    bytes += (p.embedding?.byteLength || (p.embedding?.length || 0) * 4);
    bytes += (p.url?.length || 0) + (p.title?.length || 0) + (p.text?.length || 0);
  }
  return bytes;
}
