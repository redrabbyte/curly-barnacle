import { isLanguage, type Language } from './index';

/**
 * The few things the service worker needs to know about whoever is signed in,
 * somewhere it can actually read them.
 *
 * Settings and the cached session live in `localStorage`, which is not exposed
 * to workers at all — and a push notification usually arrives with no page open,
 * so asking a client is not an option either. IndexedDB is reachable from both,
 * so these are mirrored into a database of their own: raw IDB rather than Dexie,
 * because pulling Dexie in to read two strings would cost more than this whole
 * file.
 *
 * Deliberately separate from the app's Dexie database, whose schema changes on
 * its own schedule. Nothing here should break because a table was added there.
 */

const DB = 'spendapp-prefs';
const STORE = 'prefs';
const KEY = 'language';
/**
 * Who this device is signed in as. Not secret — it is the same id every member
 * of a group can see — and it is here for one job: a push says which entry it
 * is about, and answering "am I in it?" takes knowing who "I" am.
 */
const SELF_KEY = 'self';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB unavailable'));
  });
}

/** Best-effort: a failure here costs a notification in the wrong language. */
export async function writeLanguagePref(language: Language): Promise<void> {
  await write(KEY, language);
}

/** Best-effort throughout: every reader here has a working answer for absent. */
async function write(key: string, value: string | null): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      if (value === null) store.delete(key);
      else store.put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('write failed'));
    });
    db.close();
  } catch {
    /* private mode, quota, or no IDB — the worker falls back to the browser */
  }
}

export async function readLanguagePref(): Promise<Language | null> {
  const value = await read(KEY);
  return isLanguage(value) ? value : null;
}

/**
 * Mirror the signed-in user id, or clear it on sign-out.
 *
 * Clearing matters more than writing: a stale id would have the worker
 * answering "is this mine?" for somebody who is no longer here, and a wrong
 * *quiet* is the one failure this whole path must not have.
 */
export async function writeSelfPref(userId: string | null): Promise<void> {
  await write(SELF_KEY, userId);
}

export async function readSelfPref(): Promise<string | null> {
  const value = await read(SELF_KEY);
  return typeof value === 'string' && value ? value : null;
}

async function read(key: string): Promise<unknown> {
  try {
    const db = await openDb();
    const value = await new Promise<unknown>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('read failed'));
    });
    db.close();
    return value;
  } catch {
    return undefined;
  }
}
