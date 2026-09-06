import { writeSelfPref } from './i18n/prefs';
import type { Me } from './types';

/**
 * The last known session, cached so the app opens straight to its content
 * offline instead of the login screen.
 *
 * In its own module rather than inside `auth.tsx` because non-React code needs
 * it too — group key commitments are bound to the account that wrote them, so
 * `groupKeys.ts` has to name the same user the AAD did — and importing the
 * auth provider from there would close a cycle through `sync.ts`.
 *
 * Nothing secret lives here. The account keys are in IndexedDB (`keys.ts`) and
 * deliberately not in localStorage; this is a display name and an id.
 */
export const SESSION_CACHE_KEY = 'me';

interface WebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * `localStorage`, if this realm has one.
 *
 * It does not in a service worker, and the worker now reaches this module
 * through the group keys — so the global is looked up rather than named. A
 * bare `localStorage` would be a `ReferenceError` there, which is a strange
 * way to find out that a cached session is simply not available.
 */
const store = (): WebStorage | null =>
  (globalThis as { localStorage?: WebStorage }).localStorage ?? null;

export function readCachedSession(): Me | null {
  try {
    const s = store()?.getItem(SESSION_CACHE_KEY);
    return s ? (JSON.parse(s) as Me) : null;
  } catch {
    return null;
  }
}

export function writeCachedSession(user: Me | null): void {
  if (user) store()?.setItem(SESSION_CACHE_KEY, JSON.stringify(user));
  else store()?.removeItem(SESSION_CACHE_KEY);
  // The service worker cannot see localStorage, and it needs the id to tell a
  // push about one of this user's own entries from one about strangers'.
  // Fire-and-forget: every reader of it treats absent as "do not know", which
  // is the safe answer anyway.
  void writeSelfPref(user?.id ?? null);
}

/** Who a commitment or any other account-bound blob belongs to. */
export const cachedUserId = (): string | null => readCachedSession()?.id ?? null;
