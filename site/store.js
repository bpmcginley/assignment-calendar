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

// ---- GitHub token for syncing done marks (fine-grained, Actions: write on this repo only) ----
const TOKEN_REC = 'github';
export async function loadToken() {
  try { return (await tx('readonly', (s) => s.get(TOKEN_REC))) || null; } catch { return null; }
}
export async function saveToken(token) {
  try { await tx('readwrite', (s) => s.put(token, TOKEN_REC)); return true; } catch { return false; }
}
export async function clearToken() {
  try { await tx('readwrite', (s) => s.delete(TOKEN_REC)); } catch { /* nothing stored */ }
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

/**
 * Encrypt a small object (the push subscription) with the same passphrase, for the server to read.
 * Returns a single base64 code: {"v":1,"salt","iter","iv","ct"}. Needs the stored PBKDF2 `base` key;
 * the AES key kept for decryption is decrypt-only.
 */
let encKeyCache = null;
export async function encryptForServer(keys, obj) {
  if (!keys || !keys.base || !keys.salt) throw new Error('needs-unlock');
  const iter = keys.iter || 600000;
  // PBKDF2 at 600k iterations takes ~1 s; keep the derived key for this session (per salt).
  if (!encKeyCache || encKeyCache.base !== keys.base || encKeyCache.salt !== keys.salt) {
    encKeyCache = { base: keys.base, salt: keys.salt, key: crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: b64(keys.salt), iterations: iter },
      keys.base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']) };
  }
  const key = await encKeyCache.key;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
    new TextEncoder().encode(JSON.stringify(obj))));
  const enc = (u) => { let s = ''; for (const b of u) s += String.fromCharCode(b); return btoa(s); };
  return btoa(JSON.stringify({ v: 1, salt: keys.salt, iter, iv: enc(iv), ct: enc(ct) }));
}

/** SHA-256 of the push endpoint, first 16 hex chars; matches notify.device_id on the server. */
export async function deviceId(endpoint) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
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
