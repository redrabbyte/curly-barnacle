import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { deriveSas, formatSas, sha256Hex } from '@spendapp/shared';
import type { InviteState } from '@spendapp/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { localDb } from '../db';
import { clearInviteToken, readInvite, stashInvite } from '../inviteToken';
import { loadKeys } from '../keys';
import { syncNow } from '../sync';
import type { Translator } from '../i18n';
import { useT } from '../i18n/useT';

interface Claimable {
  userId: string;
  displayName: string;
  kind?: 'placeholder' | 'departed';
  /** Names already folded into this one, so a taken-over name is traceable. */
  alsoKnownAs?: string[];
}
interface InviteInfo {
  inviterName: string;
  /** False: this link shares nothing recorded before it is accepted (§4.7). */
  shareHistory?: boolean;
  claimable: Claimable[];
  /** Set when this account was in the group before and left (design §5). */
  wasMember?: { userId: string; displayName: string } | null;
  /**
   * What the link can still do for whoever is asking. Optional so a client
   * running against a server that predates it behaves exactly as it used to.
   */
  state?: InviteState;
  /** Only for `joined` and `pending` — the two the server has confirmed. */
  groupId?: string | null;
}

/** '' means "join as a new member" rather than taking over a placeholder. */
const AS_NEW = '';

/**
 * Whole templates nested rather than suffixes glued on, so a language decides
 * for itself where "(also …)" and "left this group" go.
 */
function claimLabel(t: Translator, c: Claimable): string {
  const base = c.alsoKnownAs?.length
    ? t('invitePage.claimAlso', { name: c.displayName, names: c.alsoKnownAs.join(', ') })
    : c.displayName;
  return c.kind === 'departed' ? t('invitePage.claimLeft', { name: base }) : base;
}

export function InvitePage() {
  // From the fragment, or from the stash if this is the return leg of a login.
  // Read once: the fragment is cleared below, and re-reading it after that
  // would turn a signed-in joiner's page into an expired one. The group's name
  // comes from the same fragment: the server holds it sealed and cannot say
  // it, so the inviter's device wrote it into the link (design §4.2).
  const [invite] = useState(readInvite);
  const token = invite?.token ?? null;
  const groupName = invite?.name ?? null;
  const { user, loading } = useAuth();
  const t = useT();
  const navigate = useNavigate();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [claim, setClaim] = useState<string>(AS_NEW);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [pendingGroupId, setPendingGroupId] = useState<string | null>(null);
  const [sas, setSas] = useState<string | null>(null);

  // The approval happens on somebody else's device, so nothing here knows it
  // landed. Watching the mirror for the group turning up is what closes the
  // loop — otherwise the joiner sits on "request sent" until they reload.
  const joined = useLiveQuery(
    async () => (pendingGroupId ? ((await localDb.groups.get(pendingGroupId)) ?? null) : null),
    [pendingGroupId],
  );
  useEffect(() => {
    if (joined) navigate(`/g/${joined.id}`, { replace: true });
  }, [joined, navigate]);

  useEffect(() => {
    if (!token) return;
    /**
     * Out of the address bar as soon as it has been read.
     *
     * A fragment never reaches a server, but it is still on screen and still
     * goes into whatever the reader shares next — and this page invites
     * sharing, since the person following the link is often standing next to
     * the person who sent it. `replaceState` rather than a route change so the
     * back button still leaves the page rather than landing on a stripped copy
     * of it.
     */
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    api<InviteInfo>('/api/invites/lookup', { method: 'POST', body: { token } })
      .then(setInfo)
      .catch((err: Error) => setError(err.message));
  }, [token]);

  /**
   * Following the same link twice is the ordinary case, not the odd one: the
   * message it arrived in stays in the chat, and people tap it again to check
   * whether anything happened. The server now says what the link can still do
   * for this account, and everything except "you may join" is handled here
   * rather than left to a button that would have been inert.
   */
  useEffect(() => {
    if (!info || !token) return;
    const state = info.state ?? 'open';
    // Nothing left to spend, whichever of these it is. Clearing the stash
    // matters most on a shared browser, where the next person at this tab
    // would otherwise inherit whatever the link still carried.
    if (state !== 'open') clearInviteToken();
    if (state === 'joined' && info.groupId) {
      const groupId = info.groupId;
      // Sync first, exactly as the join path does: arriving at a group the
      // mirror has never heard of shows an empty screen for as long as the
      // pull takes. A failure here is not a reason to strand them on a
      // landing page for a group they are already in.
      void syncNow()
        .catch(() => {})
        .then(() => navigate(`/g/${groupId}`, { replace: true }));
      return;
    }
    if (state === 'pending' && info.groupId) {
      const groupId = info.groupId;
      setPending(true);
      // The same watcher the fresh-join path arms, so an approval that lands
      // while this page is open still opens the group by itself.
      setPendingGroupId(groupId);
      void (async () => {
        if (groupName) await localDb.pendingNames.put({ groupId, name: groupName }).catch(() => {});
        // Re-derivable rather than remembered: the digits are a function of
        // the token, this device's key and the group, so the admin still
        // reads the same ones off a request made on a previous visit. Locked
        // keys mean no digits, not a broken page — the same as on a fresh ask.
        const keys = await loadKeys();
        if (keys) setSas(await deriveSas(await sha256Hex(token), keys.publicKey, groupId));
      })();
    }
  }, [info, token, groupName, navigate]);

  // A name match is a hint, never a pre-made choice. Claiming rewrites every
  // split that mentions the placeholder, so a second Sam joining a group that
  // already lists a Sam must not be walked into taking over the first one.
  const nameMatch = info?.claimable.find(
    (c) => c.displayName.trim().toLowerCase() === (user?.displayName ?? '').trim().toLowerCase(),
  );

  async function join() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ groupId: string; status: 'joined' | 'pending' }>('/api/invites/join', {
        method: 'POST',
        body: claim === AS_NEW ? { token } : { token, claimMemberId: claim },
      });
      // Spent, whichever way it went. Leaving it in the tab's storage would
      // hand the next person at this browser a working link.
      clearInviteToken();
      // Following a link only asks; an admin still has to say yes. Already
      // being a member is the one case that goes straight through.
      if (res.status === 'pending') {
        setPending(true);
        setPendingGroupId(res.groupId);
        setBusy(false);
        // The push saying this was approved arrives before any key to open
        // the group's real name does. The worker titles it from here.
        if (groupName) await localDb.pendingNames.put({ groupId: res.groupId, name: groupName }).catch(() => {});
        // The admin sees the same digits (design §4.3). Derived from this
        // device's own public key, so an interceptor who followed the link
        // reads out a different number — which is the only thing that
        // distinguishes them from the person the admin is expecting.
        const keys = await loadKeys();
        // Hashed first: the admin's side only ever sees the hash, because the
        // server no longer keeps the token itself.
        if (keys && token) setSas(await deriveSas(await sha256Hex(token), keys.publicKey, res.groupId));
        return;
      }
      await syncNow();
      navigate(`/g/${res.groupId}`, { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  // No token at all: either an old-format link that has just been rewritten
  // here, or a bare /invite somebody typed. Saying so beats an endless spinner.
  if (!token) return <p className="mt-8 text-center text-red-600 dark:text-red-400">{t('invitePage.noToken')}</p>;
  if (error && !info) return <p className="mt-8 text-center text-red-600 dark:text-red-400">{error}</p>;
  if (!info || loading)
    return <p className="mt-8 text-center text-slate-500 dark:text-slate-400">{t('group.loading')}</p>;

  const state = info.state ?? 'open';
  // The effect above is already on its way into the group. Saying so beats
  // flashing the join screen — with its "are you one of these people?" — at
  // somebody who has been a member for weeks.
  if (state === 'joined')
    return <p className="mt-8 text-center text-slate-500 dark:text-slate-400">{t('invitePage.alreadyMember')}</p>;

  // Only these two are still about deciding how to join. On a spent or
  // declined link the terms of the invite are history, and repeating them
  // would read like an offer.
  const live = state === 'open' || state === 'pending';
  const waiting = user && (pending || state === 'pending');

  return (
    <div className="mx-auto mt-10 flex max-w-sm flex-col items-center gap-4 text-center">
      <p>{t('invitePage.invitedBy', { name: info.inviterName })}</p>
      <h1 className="text-2xl font-semibold">{groupName ?? t('invitePage.unnamedGroup')}</h1>

      {/* Rejoining on the same account restores the old membership row by
          itself, so there is nothing to pick. Saying so is the whole fix: the
          option that does the right thing used to be labelled "join as someone
          new", which reads like abandoning your own history. */}
      {live && info.wasMember && (
        <p className="rounded bg-teal-50 p-3 text-left text-sm text-teal-900 dark:bg-teal-950 dark:text-teal-100">
          {t('invitePage.wasMember', { name: info.wasMember.displayName })}
        </p>
      )}

      {live && info.shareHistory === false && (
        <p className="rounded bg-amber-50 p-3 text-left text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          {t('invitePage.fromToday')}
        </p>
      )}

      {state === 'spent' ? (
        <div className="flex flex-col gap-3">
          <p className="rounded bg-amber-50 p-3 text-left text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
            {/* Signed in, the server has ruled out every way this could have
                been *their* use of it — no membership, no request of their
                own — so it can say plainly that somebody else got there. To an
                anonymous visitor it cannot: they may be the joiner, logged out
                or on a second device, and telling them a stranger took their
                link would be both wrong and alarming. */}
            {user ? t('invitePage.spent') : t('invitePage.spentSignedOut')}
          </p>
          {user ? (
            <Link to="/" className="text-sm text-teal-700 underline dark:text-teal-300">
              {t('invitePage.backToGroups')}
            </Link>
          ) : (
            <Link
              to="/login?next=%2Finvite"
              onClick={() => invite && stashInvite(invite)}
              className="rounded bg-teal-700 px-6 py-2 font-medium text-white"
            >
              {t('invitePage.logInToCheck')}
            </Link>
          )}
        </div>
      ) : state === 'declined' ? (
        <div className="flex flex-col gap-3">
          <p className="rounded bg-amber-50 p-3 text-left text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
            {t('invitePage.declined')}
          </p>
          <Link to="/" className="text-sm text-teal-700 underline dark:text-teal-300">
            {t('invitePage.backToGroups')}
          </Link>
        </div>
      ) : waiting ? (
        <div className="flex flex-col gap-2">
          <p className="rounded bg-teal-50 px-4 py-3 text-teal-900 dark:bg-teal-950 dark:text-teal-100">
            {/* "Sent" is only true of the visit that sent it. Coming back to
                the link is the case this page used to answer with the join
                screen, and the one word that has to change is the verb. */}
            {state === 'pending' ? t('invitePage.requestWaiting') : t('invitePage.requestSent')}
          </p>
          {sas && (
            <div className="flex flex-col gap-1 rounded border border-slate-200 px-4 py-3 dark:border-slate-700">
              <span className="text-sm text-slate-500 dark:text-slate-400">
                {t('invitePage.sasIntro')}
              </span>
              <span className="font-mono text-xl font-medium tracking-wider">
                {formatSas(sas)}
              </span>
              <span className="text-xs text-slate-400">
                {t('invitePage.sasHint')}
              </span>
            </div>
          )}
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t('invitePage.willOpen')}
          </p>
          <Link to="/" className="text-sm text-teal-700 underline dark:text-teal-300">
            {t('invitePage.backToGroups')}
          </Link>
        </div>
      ) : user ? (
        <>
          {info.claimable.length > 0 && (
            <div className="flex w-full flex-col gap-1 text-left">
              {/* Taking over a name is *added* to coming back as yourself —
                  the server resurrects your own membership and aliases the
                  claimed row, and the key grant is the union of both. Framing
                  it as an alternative told people they had to give one up. */}
              <label htmlFor="claim" className="text-sm font-medium text-slate-500 dark:text-slate-400">
                {info.wasMember
                  ? t('invitePage.alsoYou', { name: info.wasMember.displayName })
                  : t('invitePage.areYouOne')}
              </label>
              <select
                id="claim"
                value={claim}
                onChange={(e) => setClaim(e.target.value)}
                className="rounded border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800"
              >
                <option value={AS_NEW}>
                  {info.wasMember
                    ? t('invitePage.rejoinAs', { name: info.wasMember.displayName })
                    : t('invitePage.joinAsNew')}
                </option>
                {info.claimable.map((c) => (
                  <option key={c.userId} value={c.userId}>
                    {claimLabel(t, c)}
                  </option>
                ))}
              </select>
              {nameMatch && claim === AS_NEW && (
                <p className="text-xs text-amber-700 dark:text-amber-500">
                  {t('invitePage.nameClash', { name: nameMatch.displayName })}
                </p>
              )}
              {info.wasMember && claim !== AS_NEW && (
                <p className="text-xs text-slate-400">
                  {t('invitePage.claimAddsTo', { name: info.wasMember.displayName })}
                </p>
              )}
              <p className="text-xs text-slate-400">{t('invitePage.claimNote')}</p>
            </div>
          )}
          <button
            onClick={() => void join()}
            disabled={busy}
            className="rounded bg-teal-700 px-6 py-2 font-medium text-white disabled:opacity-50"
          >
            {claim !== AS_NEW
              ? info.wasMember
                ? t('invitePage.rejoinAndTakeOver')
                : t('invitePage.joinAsThisPerson')
              : info.wasMember
                ? t('invitePage.rejoin')
                : t('invitePage.join')}
          </button>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </>
      ) : (
        <Link
          // The token travels in this tab's storage, not in `next` — a query
          // string is logged exactly like the path this was moved out of.
          to="/login?next=%2Finvite"
          onClick={() => invite && stashInvite(invite)}
          className="rounded bg-teal-700 px-6 py-2 font-medium text-white"
        >
          {t('invitePage.logInToJoin')}
        </Link>
      )}
    </div>
  );
}

/**
 * A link from before the token moved into the fragment (design §4.7).
 *
 * Not redirected into the new shape, deliberately. By the time this component
 * renders, the browser has already asked the web server for
 * `/invite/<token>` — the token is in that access log line and in the
 * `Referer` of anything the page loads. Quietly carrying on would hide that
 * the one thing this change was for has already happened for this link.
 *
 * So it asks for a new one. Invites are cheap, single-use and short-lived, and
 * any member can issue one.
 */
export function OldInviteLink() {
  const t = useT();
  return (
    <div className="mx-auto mt-10 flex max-w-sm flex-col items-center gap-3 text-center">
      <p className="rounded bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
        {t('invitePage.oldLink')}
      </p>
      <Link to="/" className="text-sm text-teal-700 underline dark:text-teal-300">
        {t('invitePage.backToGroups')}
      </Link>
    </div>
  );
}
