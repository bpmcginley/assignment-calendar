// Device storage and decryption.
//
// The passphrase itself is never stored. After unlock we keep two non-extractable CryptoKeys in IndexedDB:
//   base: the passphrase imported as a PBKDF2 key (lets us re-derive when the fetcher publishes a new salt;
//         build.py picks a fresh random salt on every run, about every 30 minutes)
//   aes:  the AES-GCM key derived for the most recent salt (skips the ~1s PBKDF2 step on most launches)
// Neither key can be read back out as bytes. The decrypted payload only ever lives in memory.

const DB_NAME = 'due';
const STORE = 'keys';
const REC = 'main';

let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked'));
    }).catch((e) => { dbPromise = null; throw e; });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export async function loadKeys() {
  try {
    const rec = await tx('readonly', (s) => s.get(REC));
    if (rec && rec.aes && rec.salt) return rec;
    return null;
  } catch { return null; }
}

export async function saveKeys(rec) {
  try { await tx('readwrite', (s) => s.put(rec, REC)); return true; } catch { /* fall through */ }
  // Some engines refuse to clone a PBKDF2 key; keep at least the AES key.
  try { await tx('readwrite', (s) => s.put({ aes: rec.aes, salt: rec.salt, iter: rec.iter }, REC)); return true; } catch { return false; }
}

export async function clearKeys() {
  try { await tx('readwrite', (s) => s.delete(REC)); } catch { /* nothing stored */ }
}

// ---- localStorage (per-device preferences; every access guarded) ----
export function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    if (v == null) return fallback;
    const parsed = JSON.parse(v);
    return parsed ?? fallback;
  } catch { return fallback; }
}
export function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
export function lsDel(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

// ---- crypto (data-contract.md) ----
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const hasCrypto = () => !!(globalThis.crypto && crypto.subtle);

export function isEncBlob(o) {
  return !!o && typeof o === 'object' && typeof o.ct === 'string' && typeof o.iv === 'string' && typeof o.salt === 'string';
}

export function importPassphrase(passphrase) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
}

export function deriveAes(base, saltB64, iterations) {
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: b64(saltB64), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
}

/** Throws if the key is wrong (AES-GCM tag check fails). */
export async function decryptBlob(aes, blob) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(blob.iv) }, aes, b64(blob.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

/** Try a passphrase against a blob. Returns {payload, keys} or null when it is wrong. */
export async function tryPassphrase(passphrase, blob) {
  const iter = blob.iter || 600000;
  const base = await importPassphrase(passphrase);
  const aes = await deriveAes(base, blob.salt, iter);
  try {
    const payload = await decryptBlob(aes, blob);
    return { payload, keys: { base, aes, salt: blob.salt, iter } };
  } catch { return null; }
}

// ---- encrypted data cache (written by sw.js; read here for an instant first paint) ----
export const DATA_CACHE = 'due-data';
const dataUrl = () => new URL('data.enc.json', location.href).href;

export async function readCachedBlob() {
  try {
    if (!('caches' in self)) return null;
    const c = await caches.open(DATA_CACHE);
    const r = await c.match(dataUrl());
    if (!r) return null;
    const blob = await r.json();
    return isEncBlob(blob) ? blob : null;
  } catch { return null; }
}

export async function writeCachedBlob(blob) {
  try {
    if (!('caches' in self)) return;
    const c = await caches.open(DATA_CACHE);
    await c.put(dataUrl(), new Response(JSON.stringify(blob), { headers: { 'Content-Type': 'application/json' } }));
  } catch { /* ignore */ }
}

export async function clearCachedBlob() {
  try { if ('caches' in self) await caches.delete(DATA_CACHE); } catch { /* ignore */ }
}
