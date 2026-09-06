import {
  SYNC_PROTOCOL,
  aliasResolver,
  type ExpenseDto,
  type PaymentDto,
  type PushEntry,
  type SyncResponse,
} from '@spendapp/shared';
import { api } from './api';
import { localDb } from './db';
import { openExpense, openPayment } from './envelope';
import { loadStoredGrants } from './entryKeys';
import { readSelfPref } from './i18n/prefs';

/**
 * Whether a push is about something the reader is actually in (design §3.3).
 *
 * This is the one place the service worker is allowed to cost something. It
 * pulls Dexie and the envelope in with it — roughly doubling the worker
 * bundle — which `i18n/prefs.ts` went out of its way to avoid for the sake of
 * reading one string. The difference is what is being read: four tables, the
 * keyring, and an entry that has to be opened exactly the way the app opens
 * it. Reimplementing that against raw IndexedDB would mean a second copy of
 * the schema and of the key-resolution rules, and a filter that quietly
 * disagrees with the app about who is in an expense is worse than a larger
 * download once per release.
 *
 * The server cannot answer this. It fans a notification out to the whole group
 * because who an entry names is sealed, and the alternative — clients telling
 * it the participants — would hand it the one thing the encryption is for: who
 * shares expenses with whom. So the question is answered here, on a device
 * that can open the entry, and the only thing it changes is how loudly the
 * notification arrives.
 *
 * `unknown` is not a failure mode to be tidied away. Offline, no key, no
 * cached session, a slow network, an entry this device cannot read — every one
 * of them lands here, and every one of them must end in the ordinary
 * notification. A missed alert about your own money is a much worse bug than a
 * buzz about somebody else's, so everything uncertain fails loud.
 */
export type Involvement = 'mine' | 'theirs' | 'unknown';

/** How long the worker will wait on the network before giving up and shouting. */
const DEADLINE_MS = 4000;

/**
 * Does this entry name me?
 *
 * Split rows with nothing in them do not count: an expense records a zero for
 * somebody who was in the group but not in this one, and treating that as
 * involvement would make the filter do nothing at all in a small group.
 *
 * `createdBy` counts even when the splits do not. Somebody editing an entry
 * you wrote is your business, and a person who paid for a round they were not
 * part of is exactly the case that would otherwise go quiet.
 *
 * `resolve` folds a claimed placeholder onto the account that took it over —
 * the same rule balances and readership already use. Without it everything
 * inherited under an old name would read as somebody else's.
 */
export function expenseNamesMe(
  expense: Pick<ExpenseDto, 'splits' | 'createdBy'>,
  me: string,
  resolve: (userId: string) => string,
): boolean {
  if (resolve(expense.createdBy) === me) return true;
  return expense.splits.some(
    (s) => resolve(s.userId) === me && (s.paidMinor !== 0 || s.owedMinor !== 0),
  );
}

/** Both ends of a payment, and whoever recorded it. */
export function paymentNamesMe(
  payment: Pick<PaymentDto, 'fromUser' | 'toUser' | 'createdBy'>,
  me: string,
  resolve: (userId: string) => string,
): boolean {
  return (
    resolve(payment.fromUser) === me ||
    resolve(payment.toUser) === me ||
    resolve(payment.createdBy) === me
  );
}

/**
 * The reader's own id, as the worker can see it.
 *
 * Deliberately the mirrored copy rather than a round trip to `/api/me`: a
 * device that has been signed out should not be quietly told who it used to
 * be, and a network hop to decide the *tone* of a notification is a poor
 * trade. Absent means `unknown`, which means the notification is shown.
 */
const readerId = (): Promise<string | null> => readSelfPref();

/**
 * Whether this module is running in the service worker rather than a page.
 *
 * Only the worker borrows and returns the database below; a page holds it open
 * on purpose, and closing it there would stop every live query on screen.
 */
const inWorker = typeof (globalThis as { window?: unknown }).window === 'undefined';

/**
 * Take the local database, and give it straight back.
 *
 * `wipeLocalDb` deletes it on logout, and a delete blocks on every open
 * connection — which is the standoff its own comment describes, except that
 * the holder is now this worker rather than another tab, and no tab can close
 * it. A push received shortly before somebody signs out on a shared device
 * would be enough to make the wipe report failure and leave the keys sitting
 * there. Held for the length of one decision instead, and reopened by the next
 * one, it is never the thing in the way.
 */
async function openDb(): Promise<void> {
  if (inWorker && !localDb.isOpen()) await localDb.open();
}

function releaseDb(): void {
  if (!inWorker) return;
  try {
    localDb.close();
  } catch {
    /* already closed, or never opened */
  }
}

/** The alias map for one group, so a claimed placeholder resolves to its owner. */
async function resolverFor(groupId: string): Promise<(userId: string) => string> {
  const members = await localDb.members.where('groupId').equals(groupId).toArray();
  return aliasResolver(members);
}

/**
 * The entry, if this device already holds it.
 *
 * The cheap half, and the one that answers an edit, a delete or a comment on
 * something already synced without touching the network at all.
 */
async function fromMirror(entry: PushEntry): Promise<ExpenseDto | PaymentDto | undefined> {
  return entry.type === 'expense'
    ? localDb.expenses.get(entry.id)
    : localDb.payments.get(entry.id);
}

/**
 * The entry, pulled and opened in memory.
 *
 * A push about a *new* entry always lands ahead of the sync that would bring
 * it, so without this the filter would answer `unknown` for the one case it
 * exists to handle.
 *
 * Nothing is written. Applying the delta here would mean reimplementing the
 * whole of `syncNow` — grants before keys, commitments before wraps, coverage,
 * the outbox — inside a worker that may be racing a tab doing the same thing.
 * The cost of not applying it is that the page pulls the same delta again
 * later, which is a round trip, against a sync engine built to be replayed.
 *
 * Cursors are sent for every group, not just this one: the server treats a
 * missing cursor as zero, so naming one group would ask it to send every other
 * group's entire history back.
 */
async function fromServer(entry: PushEntry): Promise<ExpenseDto | PaymentDto | null> {
  const cursorRows = await localDb.cursors.toArray();
  // No cursor for this group means it has never synced here. Asking from zero
  // inside a push handler could be the group's whole history; it is not worth
  // it to decide how loud one notification should be.
  if (!cursorRows.some((c) => c.groupId === entry.groupId)) return null;

  // Grants persisted from an earlier session — the worker starts with an empty
  // unwrapped cache, and an entry held only by grant would not open without it.
  await loadStoredGrants().catch(() => {});

  const res = await api<SyncResponse>('/api/sync', {
    method: 'POST',
    body: {
      protocolVersion: SYNC_PROTOCOL.current,
      cursors: Object.fromEntries(cursorRows.map((c) => [c.groupId, c.version])),
      mutations: [],
    },
  });

  const changes = res.changes[entry.groupId];
  if (!changes) return null;
  if (entry.type === 'expense') {
    const wire = changes.expenses.find((e) => e.id === entry.id);
    return wire ? openExpense(wire) : null;
  }
  const wire = changes.payments.find((p) => p.id === entry.id);
  return wire ? openPayment(wire) : null;
}

/** The decision, with every uncertain path collapsing onto `unknown`. */
export async function involvementOf(entry: PushEntry): Promise<Involvement> {
  try {
    await openDb();
    const me = await readerId();
    if (!me) return 'unknown';
    const resolve = await resolverFor(entry.groupId);
    const mine = resolve(me);

    const held = (await fromMirror(entry)) ?? (await fromServer(entry));
    if (!held) return 'unknown';

    const names =
      entry.type === 'expense'
        ? expenseNamesMe(held as ExpenseDto, mine, resolve)
        : paymentNamesMe(held as PaymentDto, mine, resolve);
    return names ? 'mine' : 'theirs';
  } catch {
    // Offline, signed out, a key this device was never given, a server that
    // said no. None of them are reasons to stay quiet about somebody's money.
    return 'unknown';
  } finally {
    releaseDb();
  }
}

/**
 * The decision, or `unknown` if it takes too long.
 *
 * The push handler is on a clock it does not control: the browser will draw
 * its own "this site was updated in the background" notification if
 * `showNotification` has not been called by the time it loses patience, which
 * is a worse notification than the one this is trying to improve. So the wait
 * is bounded well inside that, and a slow answer is no answer.
 */
export async function involvementWithin(entry: PushEntry, ms = DEADLINE_MS): Promise<Involvement> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      involvementOf(entry),
      new Promise<Involvement>((resolve) => {
        timer = setTimeout(() => resolve('unknown'), ms);
      }),
    ]);
  } finally {
    // The race does not cancel the loser, and an uncleared timer is a reason
    // for the browser to keep this worker alive after the notification is
    // already on screen.
    clearTimeout(timer);
  }
}
