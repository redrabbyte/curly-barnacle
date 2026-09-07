import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { GroupDto, MemberDto } from '@spendapp/shared';
import { api } from './api';
import { localDb } from './db';

/**
 * Which groups have somebody waiting to be let in — across every group at
 * once, for the bell in the top bar.
 *
 * Join requests are not group entities, so they never ride the sync mirror
 * (see `MembersTab`): the only thing that knows about them is
 * `/api/groups/:id/join-requests`, one group at a time, and only for an admin.
 * So this asks that same endpoint for each group this account administers,
 * which is why there is nothing new on the server — the mirror already says
 * which groups those are, and the count is the one thing it cannot say.
 *
 * The decisions worth testing are pure and live at the top of this file; the
 * hook underneath is the plumbing that feeds them.
 */

/** Dispatched when a decision changes a queue, so the bell need not wait for its poll. */
export const JOIN_REQUESTS_EVENT = 'app:join-requests';

/** Slower than the members tab's own 8s: this asks once per administered group. */
const POLL_MS = 60_000;

export interface OpenInvites {
  groupId: string;
  /** The group's name as the mirror holds it; empty when its key has not arrived. */
  name: string;
  count: number;
}

/**
 * The groups worth asking about: the ones this account is currently an admin
 * of. Anywhere else the endpoint would answer 403, and a member who is not an
 * admin has nothing to approve.
 *
 * `mine` is positional — one membership row per group, in the same order —
 * because that is what a `bulkGet` on the compound key returns.
 */
export function adminGroups(groups: readonly GroupDto[], mine: readonly (MemberDto | undefined)[]): GroupDto[] {
  return groups.filter((_, i) => {
    const me = mine[i];
    return me?.role === 'admin' && !me.leftAt;
  });
}

/**
 * Fold a round of fetches into what the bell already had.
 *
 * A group whose fetch failed keeps its previous count rather than dropping to
 * zero: one poll spent offline should not make a waiting person disappear from
 * the top bar, and the next round corrects it either way. A group that is no
 * longer administered is absent from `fetched` and so leaves entirely.
 */
export function foldCounts(
  previous: Readonly<Record<string, number>>,
  fetched: Readonly<Record<string, number | null>>,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [groupId, count] of Object.entries(fetched)) {
    const value = count ?? previous[groupId];
    if (value !== undefined) next[groupId] = value;
  }
  return next;
}

/**
 * What the bell shows: the groups with somebody waiting, in the mirror's own
 * order so it matches the list on the groups page.
 */
export function openInvites(groups: readonly GroupDto[], counts: Readonly<Record<string, number>>): OpenInvites[] {
  return groups
    .filter((g) => (counts[g.id] ?? 0) > 0)
    .map((g) => ({ groupId: g.id, name: g.name, count: counts[g.id]! }));
}

export const totalWaiting = (invites: readonly OpenInvites[]): number =>
  invites.reduce((n, g) => n + g.count, 0);

/** How many are waiting on one group, or null when the answer did not arrive. */
async function pendingCount(groupId: string): Promise<number | null> {
  try {
    const res = await api<{ requests: { status: string }[] }>(`/api/groups/${groupId}/join-requests`);
    return res.requests.filter((r) => r.status === 'pending').length;
  } catch {
    // Offline, or no longer an admin. Either way this round says nothing.
    return null;
  }
}

export function useOpenInvites(meId: string | undefined): OpenInvites[] {
  const rows = useLiveQuery(async () => {
    if (!meId) return null;
    const groups = await localDb.groups.toArray();
    const mine = await localDb.members.bulkGet(groups.map((g) => [g.id, meId] as [string, string]));
    return { groups, mine };
  }, [meId]);

  const groups = useMemo(() => (rows ? adminGroups(rows.groups, rows.mine) : []), [rows]);
  // A string, so the effect below restarts when the set of groups changes and
  // not merely when Dexie hands back a fresh array of the same ones.
  const key = groups.map((g) => g.id).join(',');
  const [counts, setCounts] = useState<Record<string, number>>({});

  const refresh = useCallback(async () => {
    const ids = key === '' ? [] : key.split(',');
    if (ids.length === 0) return setCounts({});
    // Nothing to learn while offline, and every request would fail loudly in
    // the network tab for no benefit.
    if (!navigator.onLine) return;
    const fetched: Record<string, number | null> = {};
    await Promise.all(ids.map(async (id) => void (fetched[id] = await pendingCount(id))));
    setCounts((previous) => foldCounts(previous, fetched));
  }, [key]);

  useEffect(() => {
    const onWake = () => {
      if (!document.hidden) void refresh();
    };
    onWake();
    const timer = window.setInterval(onWake, POLL_MS);
    window.addEventListener('focus', onWake);
    window.addEventListener('online', onWake);
    document.addEventListener('visibilitychange', onWake);
    // A decision taken on a members tab, and a notification tap that routes
    // through the app — both change the queue without a poll being due.
    window.addEventListener(JOIN_REQUESTS_EVENT, onWake);
    window.addEventListener('app:navigate', onWake);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onWake);
      window.removeEventListener('online', onWake);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener(JOIN_REQUESTS_EVENT, onWake);
      window.removeEventListener('app:navigate', onWake);
    };
  }, [refresh]);

  return useMemo(() => openInvites(groups, counts), [groups, counts]);
}
