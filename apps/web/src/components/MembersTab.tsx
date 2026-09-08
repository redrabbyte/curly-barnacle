import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { aliasResolver, deriveSas, formatSas, fromBase64Url, type MemberDto } from '@spendapp/shared';
import { useLiveQuery } from 'dexie-react-hooks';
import { api } from '../api';
import {
  claimScope,
  claimableNames,
  entriesNaming,
  mergeEntries,
  nameLooksDifferent,
  type ClaimScope,
} from '../claim';
import { strandedNames } from '../departed';
import { grantEntries } from '../entryKeys';
import { forgetGroupLocally, localDb } from '../db';
import { JOIN_REQUESTS_EVENT } from '../joinAlerts';
import { holdsFullHistory } from '../coverage';
import { epochSas, keyringSas, ringsAreUniform, rotateGroupKey, shareKeyring } from '../groupKeys';
import { addPlaceholderLocal, syncNow } from '../sync';
import { ScanToAdd } from './ScanToAdd';
import { useLocale, useT } from '../i18n/useT';

/**
 * Two-step remove. The confirmation names the person, because in a list of
 * short rows the tap target for the wrong one is a few pixels away.
 */
function RemoveButton({
  member,
  busy,
  confirming,
  onAsk,
  onCancel,
  onConfirm,
}: {
  member: MemberDto;
  busy: boolean;
  confirming: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const small = 'rounded px-2 py-1 text-xs font-medium disabled:opacity-50';
  if (!confirming) {
    return (
      <button
        disabled={busy}
        onClick={onAsk}
        aria-label={t('members.removeLabel', { name: member.displayName })}
        className={`${small} border border-red-300 text-red-700 dark:border-red-800 dark:text-red-400`}
      >
        {t('members.remove')}
      </button>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <button disabled={busy} onClick={onConfirm} className={`${small} bg-red-700 text-white`}>
        {t('members.removeConfirm', { name: member.displayName })}
      </button>
      <button
        disabled={busy}
        onClick={onCancel}
        className={`${small} border border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-300`}
      >
        {t('members.cancel')}
      </button>
    </span>
  );
}

interface JoinRequest {
  userId: string;
  /**
   * Which question this row asks: to be let in, or — from somebody already in
   * — that one of the group's names is them (design §5). The same admin
   * decides both, so they share a queue; almost everything else about them
   * differs, which is why the card reads the kind before anything else.
   */
  kind: 'join' | 'claim';
  displayName: string;
  claimMemberId: string | null;
  requestedAt: string;
  /** Both halves of the SAS (design §4.3); absent on accounts predating §4.1. */
  publicKey: string | null;
  /** Null on a claim: it is asked from inside, with no link behind it. */
  inviteTokenHash: string | null;
  /** Epochs they could open when they last left; absent unless they were here before. */
  heldEpochs?: number[] | null;
  /** This account has been in this group before, under the same id. */
  previouslyMember?: boolean;
  /** False means approving must rotate instead of handing over the keyring. */
  shareHistory: boolean;
  /** 'rejected' rows are recent declines, kept listed so they can be undone. */
  status: 'pending' | 'rejected';
  decidedAt: string | null;
}

/**
 * The caller's own claim, as the queue reports it: still waiting, or turned
 * down recently enough to be worth saying so.
 */
type OwnClaim = { claimMemberId: string; status: 'pending' | 'rejected' } | null;

/**
 * What is busy. A person can have two rows in this queue at once — how they
 * got in, and a name they say is theirs — and they are also a row in the
 * members list below, so the id alone would disable three unrelated buttons.
 */
const rowKey = (kind: string, userId: string): string => `${kind}:${userId}`;

/**
 * The digits the admin reads out and the joiner confirms, derived from the
 * joiner's own public key so a different asker yields different digits.
 *
 * Long enough that a server cannot grind a key to match them, which six digits
 * was not. The joiner hashes their token to reach the same input this gets from
 * the server, so no live invite has to travel back to an admin.
 */
function SasDigits({ groupId, request }: { groupId: string; request: JoinRequest }) {
  const t = useT();
  const [sas, setSas] = useState<string | null>(null);

  useEffect(() => {
    if (!request.publicKey || !request.inviteTokenHash) return;
    let live = true;
    const tokenHash = request.inviteTokenHash;
    void deriveSas(tokenHash, fromBase64Url(request.publicKey), groupId).then((s) => {
      if (live) setSas(s);
    });
    return () => {
      live = false;
    };
  }, [groupId, request.inviteTokenHash, request.publicKey]);

  if (!request.publicKey) {
    return (
      <span className="text-xs text-slate-400">
        {t('members.noKeyYet')}
      </span>
    );
  }
  if (!sas) return null;
  return (
    <span className="text-xs text-slate-500 dark:text-slate-400">
      {t('members.checkByVoice')}{' '}
      <span className="font-mono font-medium tracking-wider">{formatSas(sas)}</span>
    </span>
  );
}

/**
 * Digits that say two members hold the same keys for this group.
 *
 * The join digits above run *before* approval and authenticate the joiner's
 * public key to the admin — the direction that stops the wrong person being
 * let in. Nothing there speaks for the keys travelling back the other way, and
 * on a first join there is no earlier commitment of this account's to check
 * them against either. That gap is what this closes: both people read the
 * number off their own screen, and a key the server substituted on the way
 * cannot make the two agree.
 *
 * Which number depends on the group. Whole-keyring digits are the stronger
 * check but only mean anything where every member holds the same keyring, and
 * a group that has ever admitted somebody from today onwards is not that —
 * there, two honest members differ for a reason that is not an attack. So the
 * keyring digits are offered only when coverage says every ring is identical,
 * and otherwise the newest epoch is compared, which every member holds. Never
 * both: the keyring digits already say everything the epoch digits do, and two
 * numbers to read down a phone is how a check stops being done at all.
 *
 * Shown quietly and always, rather than pushed at anyone. It is a check to
 * reach for — after a join, after adding a device, or when something looks
 * wrong — and a banner demanding it on every visit is one people learn to
 * dismiss, which is the state in which it protects nobody.
 */
function GroupKeyCheck({ groupId }: { groupId: string }) {
  const t = useT();
  /** `epoch` null means the keyring digits, which span every epoch at once. */
  const [check, setCheck] = useState<{ epoch: number | null; sas: string } | null>(null);

  /**
   * The stored keyring, watched rather than read once.
   *
   * Approving someone from today onwards mints an epoch, and so does removing
   * a member — both are things an admin does from this very screen, and both
   * leave the digits above them describing a key the group no longer writes
   * under. An admin who then reads that number down the phone gets a mismatch
   * that means nothing, which is worse than showing no check at all: the one
   * signal this is here to send is the one it would be sending falsely.
   *
   * Watched through the database rather than re-read by each action, so a key
   * that arrived from a background sync, a rotation another tab performed, or
   * the rotation `sync.ts` runs on somebody else's behalf all count the same.
   * The row is read here to register the dependency — `getKeyring` answers
   * from a memo cache and may never touch the table, so a live query built
   * over it alone would observe nothing and never fire.
   */
  const stored = useLiveQuery(() => localDb.groupKeys.get(groupId), [groupId]);
  /**
   * Which epochs are held and whether each is trusted, which is the whole of
   * what can change: `absorbInto` skips any epoch already in the ring, so a
   * held epoch's key never changes under it. Sorted, because the row preserves
   * insertion order and re-deriving on a reordering would be work for nothing.
   */
  const held = stored?.epochs
    .map((e) => `${e.epoch}:${e.trusted === false ? 0 : 1}`)
    .sort()
    .join('|');

  useEffect(() => {
    if (!held) {
      setCheck(null);
      return;
    }
    let live = true;
    void (async () => {
      // Offline, or a server that would rather not say: fall back to the epoch
      // digits, which are the check that always applies.
      const uniform = await ringsAreUniform(groupId).catch(() => false);
      if (!live) return;
      const whole = uniform ? await keyringSas(groupId) : null;
      if (!live) return;
      if (whole) {
        setCheck({ epoch: null, sas: whole });
        return;
      }
      const latest = await epochSas(groupId);
      if (live && latest) setCheck({ epoch: latest.epoch, sas: latest.sas });
    })();
    return () => {
      live = false;
    };
  }, [groupId, held]);

  if (!check) return null;
  return (
    <section className="flex flex-col gap-1">
      <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400">{t('keycheck.title')}</h2>
      {check.epoch !== null && (
        <p className="text-xs text-slate-500 dark:text-slate-400">{t('keycheck.epoch', { epoch: check.epoch })}</p>
      )}
      <p className="font-mono text-sm font-medium tracking-wider">{formatSas(check.sas)}</p>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {t(check.epoch === null ? 'keycheck.explainHistory' : 'keycheck.explainEpoch')}
      </p>
    </section>
  );
}

/**
 * Who is in the group: real accounts, and placeholders standing in for people
 * who have not signed up. A placeholder can be split with like anyone else,
 * and whoever follows an invite link can take one over.
 *
 * Admins additionally see the pending join queue — following an invite only
 * asks to join, so somebody has to say yes.
 */
export function MembersTab({ members, groupId, meId }: { members: MemberDto[]; groupId: string; meId: string }) {
  const t = useT();
  const locale = useLocale();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  /** This member's own standing claim, which is theirs to see whoever they are. */
  const [myClaim, setMyClaim] = useState<OwnClaim>(null);
  const [claimPick, setClaimPick] = useState<string>('');
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimOpen, setClaimOpen] = useState(false);
  // The queue carries recent declines alongside the pending asks, so the two
  // are split here rather than fetched twice.
  const pendingRequests = requests.filter((r) => r.status !== 'rejected');
  const declinedRequests = requests.filter((r) => r.status === 'rejected');
  const [deciding, setDeciding] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  // Approving hands over the keyring, so the digits have to be claimed matched
  // first. Nothing here can check that; refusing to proceed silently is the point.
  const [confirmApprove, setConfirmApprove] = useState<string | null>(null);
  const [keyHandoff, setKeyHandoff] = useState<string | null>(null);
  const [orphanEpochs, setOrphanEpochs] = useState<number[]>([]);
  const navigate = useNavigate();
  // Only this device can say what a claim carries: the entries are readable
  // here and nowhere else. Used both to warn the admin before they decide and
  // to work out which epochs have to travel with the approval.
  const ledger = useLiveQuery(
    async () => ({
      expenses: await localDb.expenses.where('groupId').equals(groupId).toArray(),
      payments: await localDb.payments.where('groupId').equals(groupId).toArray(),
    }),
    [groupId],
  );
  // Splits keep naming a claimed placeholder, so every question of the form
  // "which entries are this person's" has to follow the alias or it misses
  // exactly the half a claim moved.
  const resolve = useMemo(() => aliasResolver(members), [members]);
  const claimCarries = useCallback(
    (claimMemberId: string | null): ClaimScope =>
      !claimMemberId || !ledger
        ? { naming: 0, grantable: [] }
        : claimScope(claimMemberId, ledger.expenses, ledger.payments, resolve),
    [ledger, resolve],
  );

  const active = members.filter((m) => m.leftAt === null);
  // Names somebody has taken over. They have `leftAt` set, so every other
  // section filters them out — which is how a wrong claim used to become
  // invisible as well as permanent.
  const takenOver = members.filter((m) => m.aliasOf);
  // Removed names the ledger still uses. Only this device can tell: the server
  // cannot read a split, so it does not know the name is owed anything.
  const stranded = useMemo(
    () => (ledger ? strandedNames(members, ledger.expenses, ledger.payments) : []),
    [members, ledger],
  );
  const nameOf = (id: string) => members.find((m) => m.userId === id)?.displayName ?? t('members.someone');
  // Names this member could say are theirs. Read off the mirror rather than
  // asked for: the same rule the server applies to an invite link, applied to
  // the members list every device already holds.
  const couldBeMe = useMemo(() => claimableNames(members, meId), [members, meId]);
  const users = active.filter((m) => !m.isPlaceholder);
  const placeholders = active.filter((m) => m.isPlaceholder);
  const meIsAdmin = active.some((m) => m.userId === meId && m.role === 'admin');
  const adminCount = active.filter((m) => m.role === 'admin').length;

  // Epochs only I can still open. Leaving would take them with me and no
  // rotation could ever bring them back, so §4.7 asks for a loud warning
  // rather than a silent, permanent loss of the group's past.
  useEffect(() => {
    let live = true;
    void api<{ epochs: { epoch: number; holders: number; mine: boolean }[] }>(
      `/api/groups/${groupId}/key-coverage`,
    )
      .then((res) => {
        if (live) setOrphanEpochs(res.epochs.filter((e) => e.mine && e.holders === 1).map((e) => e.epoch));
      })
      .catch(() => {
        /* offline: the warning is unavailable, and leaving still needs the server anyway */
      });
    return () => {
      live = false;
    };
  }, [groupId, members]);

  // Join requests are not group entities, so they do not ride the sync mirror.
  // Fetched by every member, not only admins: the queue is empty for the rest,
  // but a claim of their own comes back with it, and they need it on any
  // device rather than only the tab they asked from.
  const loadRequests = useCallback(async () => {
    try {
      const res = await api<{ requests: JoinRequest[]; mine: OwnClaim }>(
        `/api/groups/${groupId}/join-requests`,
      );
      setRequests(res.requests);
      setMyClaim(res.mine ?? null);
    } catch {
      /* offline: the queue is simply unavailable until the network returns */
    }
  }, [groupId]);

  useEffect(() => {
    void loadRequests();
  }, [loadRequests]);

  // An ask of their own, or an answer to one, is worth opening the section
  // for — once. Setting `open` from `myClaim` on every render instead would
  // re-open it under somebody who has just folded it away.
  useEffect(() => {
    if (myClaim) setClaimOpen(true);
  }, [myClaim]);

  /**
   * Keep the queue fresh while this tab is open. A join request is pushed to
   * admins, and the notification deep-links here — but if this screen was
   * already mounted, nothing reloaded it, so the tap landed on a members list
   * with no pending request visible and no way to tell that was stale.
   *
   * Requests do not ride the sync mirror (they are not group entities), so
   * there is nothing else that would have refreshed them. Polling while
   * visible, and on regaining focus, is what the mirror does for everything
   * else — this just gives the queue the same treatment.
   */
  useEffect(() => {
    // Somebody waiting on their own claim is watching for exactly one answer,
    // so they poll for as long as it is outstanding and then stop.
    if (!meIsAdmin && myClaim?.status !== 'pending') return;
    const refresh = () => {
      if (!document.hidden) void loadRequests();
    };
    const id = window.setInterval(refresh, 8000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    // A notification tap routes through here even when the screen is already
    // up, which is the exact case the interval would otherwise have to cover.
    window.addEventListener('app:navigate', refresh);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('app:navigate', refresh);
    };
  }, [loadRequests, meIsAdmin, myClaim?.status]);

  async function decide(userId: string, decision: 'approve' | 'reject', kind: 'join' | 'claim' = 'join') {
    const request = requests.find((r) => r.userId === userId && r.kind === kind);
    setDeciding(rowKey(kind, userId));
    setError(null);
    setKeyHandoff(null);
    try {
      const res = await api<{ status: string; publicKey: string | null }>(
        `/api/groups/${groupId}/join-requests/${userId}`,
        {
          method: 'POST',
          body: {
            decision,
            kind,
            // What this screen said the request was for. A pending pick can
            // still change — that is the point of it being pending — and the
            // entries below are read off *this* name. Sending it back turns a
            // request that moved underneath the admin into a refusal rather
            // than an approval of something they never saw.
            expectClaimMemberId: request?.claimMemberId ?? null,
          },
        },
      );

      /**
       * A name being put right, by somebody who is already here.
       *
       * No keyring travels: they are a member, with whatever history their own
       * welcome gave them, and re-sharing the ring here would quietly widen
       * that. What does travel is the entries the name brings — otherwise they
       * are handed debts they cannot read, which is the bargain §4.8 exists to
       * refuse.
       */
      if (kind === 'claim') {
        if (decision === 'approve' && res.publicKey && request?.claimMemberId) {
          try {
            const owed = claimCarries(request.claimMemberId).grantable;
            if (owed.length > 0) await grantEntries(groupId, userId, res.publicKey, owed);
          } catch (err) {
            setKeyHandoff(t('members.claimGrantFailed', { reason: (err as Error).message }));
          }
        }
        await loadRequests();
        if (decision === 'approve') await syncNow();
        return;
      }
      // A history-scoped invite (design §4.7). The cut has to be a key
      // boundary, so approving mints a fresh epoch wrapped to everyone
      // *including* them — and pointedly does not hand over the older ones.
      // If nothing has ever been rotated there is only epoch 0, so this
      // rotation is what creates the boundary at all.
      if (decision === 'approve' && request && !request.shareHistory) {
        try {
          const rotated = await rotateGroupKey(groupId);
          // Somebody who was here before gets their own past back, and only
          // that. Withholding it does not protect anything they have not
          // already read, and it leaves their own splits — which still name
          // them, and which everyone else can see — unreadable to them, so
          // their balance would be wrong rather than merely partial.
          // Their own past, plus whatever the name they are taking over is
          // part of. Claiming rewrites a ledger identity, so handing over the
          // debts without the entries behind them is a bargain nobody can
          // check — and the admin has already agreed to the claim.
          //
          // Unless they said not to: the key opens the whole epoch, so an
          // admin who is not willing to show the rest of that stretch can send
          // the debts across unreadable instead. Their own past is not part of
          // that choice — nothing is being disclosed by giving it back.
          /**
           * Everything that is theirs, one entry at a time (design §4.8):
           * whatever the name they are taking over is in, and whatever names
           * *them*. The second is not the same as the epochs they held — an
           * entry written while they were away can still name them, because
           * whoever was offline when they left went on splitting with them.
           * That entry sits under an epoch they never had, so nothing but a
           * grant reaches it. Each costs nothing else.
           */
          const scope = claimCarries(request.claimMemberId);
          const mine = ledger ? entriesNaming(userId, ledger.expenses, ledger.payments, resolve) : [];
          const handOver = mergeEntries(scope.grantable, mine);
          if (handOver.length > 0 && res.publicKey) {
            await grantEntries(groupId, userId, res.publicKey, handOver);
          }
          // And the epochs they could open before, which returning gives back
          // (§4.7) — the stretch they were away for stays shut.
          const wanted = [...new Set(request.heldEpochs ?? [])];
          const owed = wanted.length;
          let restored = 0;
          if (owed > 0 && res.publicKey) {
            restored = await shareKeyring(groupId, userId, res.publicKey, wanted);
          }
          // Nobody can hand back what they do not hold themselves. An admin
          // who joined from-today has none of the older epochs, so the person
          // returning gets less of their own past than they had — and is owed
          // that said out loud rather than left to notice a gap.
          setKeyHandoff(
            restored < owed
              ? t('members.scopedRestoredPartly', { restored, owed })
              : restored > 0
                ? t('members.scopedRestored', { count: restored })
                : t(rotated ? 'members.scopedAdded' : 'members.scopedNoKey'),
          );
        } catch (err) {
          setKeyHandoff(t('members.scopedRotateFailed', { reason: (err as Error).message }));
        }
        await loadRequests();
        await syncNow();
        return;
      }
      // Membership alone only gets them ciphertext — the keyring has to follow,
      // and only a member's device can wrap it. Whole ring, so they read the
      // group's history rather than an apparently empty group (design §4.2).
      //
      // Reported separately because by this point they are already a member:
      // treating a failed hand-off as a failed approval would be a lie, and
      // the request is consumed either way. Publishing is idempotent, so any
      // admin can put it right by re-sharing.
      if (decision === 'approve' && res.publicKey) {
        try {
          await shareKeyring(groupId, userId, res.publicKey);
          /**
           * And the entries they are in, one at a time (design §4.8).
           *
           * The ring above already covers everything this device can read, so
           * for a whole-history admin these grants are a duplicate. They are
           * not for that case. An admin who joined partway through can only
           * pass on the epochs they hold, and a returning member who used to
           * hold more comes back to a ledger missing entries with their own
           * name in them — approved on a link that said full history.
           *
           * A grant does not care which epoch an entry sits in. So whatever
           * the approver can read and the joiner is party to comes across,
           * even when the epoch behind it cannot. What no current member can
           * read is beyond saving by anyone, which is what the warning before
           * leaving is for.
           */
          const owed = mergeEntries(
            claimCarries(request?.claimMemberId ?? null).grantable,
            ledger ? entriesNaming(userId, ledger.expenses, ledger.payments, resolve) : [],
          );
          if (owed.length > 0) await grantEntries(groupId, userId, res.publicKey, owed);
          // Only a full-keyring member can grant full history (design §4.7).
          // Saying nothing here would quietly produce a second partial member
          // and leave both of them believing they see the whole ledger.
          if (!(await holdsFullHistory(groupId))) {
            setKeyHandoff(t('members.addedPartial'));
          }
        } catch (err) {
          setKeyHandoff(t('members.shareFailed', { reason: (err as Error).message }));
        }
      }
      await loadRequests();
      if (decision === 'approve') await syncNow(); // pull the new membership in
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeciding(null);
      setConfirmApprove(null);
      // The bell in the top bar counts the same queue from outside this
      // screen. Telling it now beats leaving a decided request lit up there
      // until its own poll comes round a minute later.
      window.dispatchEvent(new CustomEvent(JOIN_REQUESTS_EVENT));
    }
  }

  async function remove(userId: string) {
    setDeciding(userId);
    setError(null);
    setKeyHandoff(null);
    try {
      await api(`/api/groups/${groupId}/members/${userId}`, { method: 'DELETE' });
      // Removal stops the server sending them anything; it does not stop the
      // key they already hold from opening whatever is written next. Rotating
      // is what actually ends their access (design §4.5).
      try {
        const rotated = await rotateGroupKey(groupId);
        if (rotated) setKeyHandoff(t('members.removedRotated'));
      } catch (err) {
        // They are already out; say plainly that the key still opens new
        // entries, because retrying is the only thing that fixes it.
        setKeyHandoff(t('members.removedRotateFailed', { reason: (err as Error).message }));
      }
      await syncNow();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeciding(null);
      setConfirmRemove(null);
    }
  }

  /**
   * Say that one of the group's names is you.
   *
   * A request rather than an act, for the same reason the invite page's is:
   * taking a name over moves a stretch of the ledger, and everybody's balance
   * moves with it. What has changed is only *when* it can be asked — the
   * moment somebody follows a link is the worst possible one, because the
   * names on offer belong to a group they cannot see yet.
   */
  async function askForName(claimMemberId: string) {
    setBusy(true);
    setClaimError(null);
    try {
      await api(`/api/groups/${groupId}/claim-requests`, { method: 'POST', body: { claimMemberId } });
      await loadRequests();
    } catch (err) {
      setClaimError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Take the ask back. Nothing has happened yet, so nothing is undone. */
  async function withdrawClaim() {
    setBusy(true);
    setClaimError(null);
    try {
      await api(`/api/groups/${groupId}/claim-requests`, { method: 'DELETE' });
      await loadRequests();
      setClaimPick('');
    } catch (err) {
      setClaimError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function unclaim(userId: string) {
    setDeciding(userId);
    setError(null);
    try {
      await api(`/api/groups/${groupId}/members/${userId}/unclaim`, { method: 'POST' });
      await syncNow();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeciding(null);
    }
  }

  async function restore(userId: string) {
    setDeciding(userId);
    setError(null);
    try {
      await api(`/api/groups/${groupId}/members/${userId}/restore`, { method: 'POST' });
      await syncNow();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeciding(null);
    }
  }

  async function setRole(userId: string, role: 'admin' | 'member') {
    setDeciding(userId);
    setError(null);
    try {
      await api(`/api/groups/${groupId}/members/${userId}/role`, { method: 'POST', body: { role } });
      await syncNow();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeciding(null);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const displayName = name.trim();
    if (!displayName) return;
    setBusy(true);
    setError(null);
    try {
      // Local first (design §3.6): the name is splittable immediately, and
      // the id is minted here so queued expenses can already reference it.
      await addPlaceholderLocal(groupId, displayName);
      setName('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const row = 'flex items-center justify-between rounded border border-slate-200 px-3 py-2 dark:border-slate-700';

  // Only real accounts count: placeholders cannot outlive the group.
  const lastRealMember = users.filter((m) => m.userId !== meId).length === 0;

  async function leave() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/groups/${groupId}/leave`, { method: 'POST' });
      await forgetGroupLocally(groupId);
      navigate('/', { replace: true });
    } catch (err) {
      setError((err as Error).message); // offline: leaving needs the server
      setBusy(false);
      setConfirmLeave(false);
    }
  }

  const smallButton = 'rounded px-2 py-1 text-xs font-medium disabled:opacity-50';

  return (
    <div className="flex flex-col gap-4">
      {/* Outside the queue below: approving empties it, so a warning rendered
          in there would vanish at the exact moment it became true. */}
      {keyHandoff && (
        <p className="rounded bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          {keyHandoff}
        </p>
      )}
      {meIsAdmin && pendingRequests.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400">
            {t('members.waiting', { count: pendingRequests.length })}
          </h2>
          {pendingRequests.map((r) => (
            <div key={r.userId} className={row}>
              <span className="flex flex-col">
                <span>{r.displayName}</span>
                {r.claimMemberId && (
                  <span className="text-xs text-slate-400">
                    {t(r.kind === 'claim' ? 'members.saysTheyAre' : 'members.wantsToTakeOver', {
                      name:
                        members.find((m) => m.userId === r.claimMemberId)?.displayName ??
                        t('members.aPlaceholder'),
                    })}
                  </span>
                )}
                {/* Digits authenticate somebody arriving. A member asking about
                    a name arrived long ago, over this same queue, and there is
                    no link behind the ask to derive them from. */}
                {r.kind === 'join' && <SasDigits groupId={groupId} request={r} />}
                {r.previouslyMember && (
                  <span className="text-xs text-slate-500 dark:text-slate-400">{t('members.wasHereBefore')}</span>
                )}
                {r.claimMemberId && nameLooksDifferent(nameOf(r.claimMemberId), r.displayName) && (
                  <span className="text-xs font-medium text-amber-700 dark:text-amber-500">
                    {t('members.claimNameDiffers', { claimed: nameOf(r.claimMemberId), asker: r.displayName })}
                  </span>
                )}
                {r.claimMemberId && claimCarries(r.claimMemberId).naming > 0 && (
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {t('members.claimBringsEntries', {
                      count: claimCarries(r.claimMemberId).naming,
                      name: nameOf(r.claimMemberId),
                    })}
                  </span>
                )}
                {confirmApprove === r.userId && (
                  <span className="text-xs font-medium text-amber-700 dark:text-amber-500">
                    {t('members.approveAsk')}
                  </span>
                )}
              </span>
              <span className="flex shrink-0 gap-2">
                <button
                  disabled={deciding === rowKey(r.kind, r.userId)}
                  onClick={() =>
                    // No key means no keyring to hand over, so nothing to
                    // confirm — and a claim hands none over either, however
                    // many keys the asker holds: they are already inside.
                    r.publicKey && r.kind === 'join' && confirmApprove !== r.userId
                      ? setConfirmApprove(r.userId)
                      : void decide(r.userId, 'approve', r.kind)
                  }
                  className={`${smallButton} bg-teal-700 text-white`}
                >
                  {confirmApprove === r.userId ? t('members.approveConfirm') : t('members.approve')}
                </button>
                <button
                  disabled={deciding === rowKey(r.kind, r.userId)}
                  onClick={() =>
                    confirmApprove === r.userId
                      ? setConfirmApprove(null)
                      : void decide(r.userId, 'reject', r.kind)
                  }
                  className={`${smallButton} border border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-300`}
                >
                  {confirmApprove === r.userId ? t('members.approveCancel') : t('members.decline')}
                </button>
              </span>
            </div>
          ))}
          <p className="text-xs text-slate-400">{t('members.queueNote')}</p>
        </section>
      )}

      {meIsAdmin && declinedRequests.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400">
            {t('members.declined', { count: declinedRequests.length })}
          </h2>
          {declinedRequests.map((r) => (
            <div key={r.userId} className={`${row} opacity-60`}>
              <span className="flex flex-col">
                <span className="line-through">{r.displayName}</span>
                <span className="text-xs text-slate-400">
                  {t('members.declinedOn', {
                    date: r.decidedAt ? new Date(r.decidedAt).toLocaleDateString(locale) : '',
                  })}
                </span>
              </span>
              <button
                disabled={deciding === rowKey(r.kind, r.userId)}
                onClick={() => void decide(r.userId, 'approve', r.kind)}
                className={`${smallButton} shrink-0 border border-teal-700 text-teal-800 dark:border-teal-500 dark:text-teal-400`}
              >
                {r.kind === 'claim' ? t('members.letThemHaveIt') : t('members.letThemIn')}
              </button>
            </div>
          ))}
          <p className="text-xs text-slate-400">{t('members.declinedNote')}</p>
        </section>
      )}

      {/**
       * Putting a name right from inside the group.
       *
       * Every takeover used to have to be decided in the ten seconds after
       * following an invite link, from a list of names belonging to a group
       * the reader could not see yet — and the two ways of getting it wrong,
       * joining as somebody new when a name was already yours and picking a
       * stranger's, were both dead ends. This is the same question, asked
       * where the answer is knowable: the ledger is on screen, and the names
       * in it have entries next to them.
       */}
      {(couldBeMe.length > 0 || myClaim) && (
        <details
          // Folded away by default: in a group full of placeholders somebody
          // typed, this is a question with an answer already, and it should not
          // sit open under everyone's members list forever. It opens itself
          // when there is something outstanding (see the effect above).
          open={claimOpen}
          onToggle={(e) => setClaimOpen(e.currentTarget.open)}
          className="rounded border border-slate-200 px-3 py-2 dark:border-slate-700"
        >
          <summary className="cursor-pointer text-sm font-medium text-slate-500 dark:text-slate-400">
            {t('members.isThisYou')}
          </summary>
          {/* Only once it is open. A closed <details> still renders its
              children, and a list of every name in the group is one every
              other control here would then have to be distinguished from. */}
          {claimOpen && (
          <div className="mt-2 flex flex-col gap-2">
            {myClaim?.status === 'pending' ? (
              <div className={row}>
                <span className="flex flex-col">
                  <span className="text-sm">
                    {t('members.claimWaiting', { name: nameOf(myClaim.claimMemberId) })}
                  </span>
                  <span className="text-xs text-slate-400">{t('members.claimWaitingNote')}</span>
                </span>
                <button
                  disabled={busy}
                  onClick={() => void withdrawClaim()}
                  className={`${smallButton} shrink-0 border border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-300`}
                >
                  {t('members.claimWithdraw')}
                </button>
              </div>
            ) : (
              <>
                {myClaim?.status === 'rejected' && (
                  <p className="rounded bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                    {t('members.claimDeclined', { name: nameOf(myClaim.claimMemberId) })}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  {/* Labelled by attribute rather than a hidden <label>: the
                      summary above already says these words, and two copies of
                      them is one for a screen reader to read out twice. */}
                  <select
                    id="own-claim"
                    aria-label={t('members.isThisYou')}
                    value={claimPick}
                    onChange={(e) => setClaimPick(e.target.value)}
                    className="grow rounded border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800"
                  >
                    <option value="">{t('members.claimNobody')}</option>
                    {couldBeMe.map((c) => (
                      <option key={c.userId} value={c.userId}>
                        {c.kind === 'departed' ? t('members.claimLeft', { name: c.displayName }) : c.displayName}
                      </option>
                    ))}
                  </select>
                  <button
                    disabled={busy || !claimPick}
                    onClick={() => void askForName(claimPick)}
                    className="rounded bg-teal-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {t('members.claimAsk')}
                  </button>
                </div>
                {/* What the ask is actually about, counted on this device
                    because only this device can read a split. */}
                {claimPick && claimCarries(claimPick).naming > 0 && (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {t('members.claimBringsMine', { count: claimCarries(claimPick).naming })}
                  </p>
                )}
              </>
            )}
            {/* Its own line rather than the shared one at the foot of the
                members list: a refusal has to appear next to the button that
                caused it, not a screen below it. */}
            {claimError && <p className="text-sm text-red-600 dark:text-red-400">{claimError}</p>}
            <p className="text-xs text-slate-400">{t('members.isThisYouNote')}</p>
          </div>
          )}
        </details>
      )}

      {meIsAdmin && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400">{t('members.addInPerson')}</h2>
          <ScanToAdd groupId={groupId} members={members} onDone={() => void loadRequests()} />
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400">{t('members.registered')}</h2>
        {users.map((m) => (
          <div key={m.userId} className={row}>
            <span>
              {m.displayName}
              {m.role === 'admin' && (
                <span className="ml-2 rounded bg-teal-100 px-1.5 py-0.5 text-xs font-medium text-teal-800 dark:bg-teal-900 dark:text-teal-200">
                  {t('members.admin')}
                </span>
              )}
            </span>
            <span className="flex items-center gap-3">
              {m.userId === meId && <span className="text-xs text-slate-400">{t('members.you')}</span>}
              {meIsAdmin && m.role !== 'admin' && (
                <button
                  disabled={deciding === m.userId}
                  onClick={() => void setRole(m.userId, 'admin')}
                  className={`${smallButton} border border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-300`}
                >
                  {t('members.makeAdmin')}
                </button>
              )}
              {/* Demoting the last admin would leave nobody able to approve joins. */}
              {meIsAdmin && m.role === 'admin' && adminCount > 1 && (
                <button
                  disabled={deciding === m.userId}
                  onClick={() => void setRole(m.userId, 'member')}
                  className={`${smallButton} border border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-300`}
                >
                  {t('members.removeAdmin')}
                </button>
              )}
              {/* Removing yourself is leaving, and that lives in its own section. */}
              {meIsAdmin && m.userId !== meId && (
                <RemoveButton
                  member={m}
                  busy={deciding === m.userId}
                  confirming={confirmRemove === m.userId}
                  onAsk={() => setConfirmRemove(m.userId)}
                  onCancel={() => setConfirmRemove(null)}
                  onConfirm={() => void remove(m.userId)}
                />
              )}
            </span>
          </div>
        ))}
      </section>

      {takenOver.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400">{t('members.takenOver')}</h2>
          {takenOver.map((m) => (
            <div key={m.userId} className={row}>
              <span className="flex flex-col">
                <span>{m.displayName}</span>
                <span className="text-xs text-slate-400">
                  {t('members.nowCountsAs', { name: nameOf(m.aliasOf!) })}
                </span>
              </span>
              {meIsAdmin && (
                <button
                  disabled={deciding === m.userId}
                  onClick={() => void unclaim(m.userId)}
                  className={`${smallButton} border border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-300`}
                >
                  {t('members.undo')}
                </button>
              )}
            </div>
          ))}
          <p className="text-xs text-slate-400">{t('members.undoNote')}</p>
        </section>
      )}

      {stranded.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400">{t('members.stranded')}</h2>
          {stranded.map((m) => (
            <div key={m.userId} className={row}>
              <span>{m.displayName}</span>
              {meIsAdmin && (
                <button
                  disabled={deciding === m.userId}
                  onClick={() => void restore(m.userId)}
                  className={`${smallButton} border border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-300`}
                >
                  {t('members.putBack')}
                </button>
              )}
            </div>
          ))}
          <p className="text-xs text-slate-400">{t('members.strandedNote')}</p>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400">{t('members.notSignedUp')}</h2>
        {placeholders.length === 0 && (
          <p className="text-sm text-slate-400">{t('members.noPlaceholders')}</p>
        )}
        {placeholders.map((m) => (
          <div key={m.userId} className={row}>
            <span>{m.displayName}</span>
            <span className="flex items-center gap-3">
              <span className="text-xs text-slate-400">{t('members.unclaimed')}</span>
              {meIsAdmin && (
                <RemoveButton
                  member={m}
                  busy={deciding === m.userId}
                  confirming={confirmRemove === m.userId}
                  onAsk={() => setConfirmRemove(m.userId)}
                  onCancel={() => setConfirmRemove(null)}
                  onConfirm={() => void remove(m.userId)}
                />
              )}
            </span>
          </div>
        ))}
        <form onSubmit={(e) => void add(e)} className="flex gap-2">
          <input
            className="grow rounded border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800"
            placeholder={t('members.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
          />
          <button
            disabled={busy || !name.trim()}
            className="rounded bg-teal-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {t('members.add')}
          </button>
        </form>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <p className="text-xs text-slate-400">{t('members.inviteNote')}</p>
      </section>

      <section className="flex flex-col gap-2 rounded border border-red-200 p-3 dark:border-red-900">
        <h2 className="text-sm font-medium text-red-700 dark:text-red-400">{t('members.leaveTitle')}</h2>
        {lastRealMember ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {t('members.leaveLast')}
          </p>
        ) : (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {t('members.leaveOthers')}
          </p>
        )}
        {/* Not a variant of the two messages above — it can be true alongside
            either, and it is the only one that destroys something for the
            people who stay (design §4.7). */}
        {orphanEpochs.length > 0 && !lastRealMember && (
          <p className="rounded bg-red-50 p-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">
            {t('members.leaveOrphans')}
          </p>
        )}
        {confirmLeave ? (
          <div className="flex flex-wrap gap-2">
            <button
              disabled={busy}
              onClick={() => void leave()}
              className="rounded bg-red-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {lastRealMember ? t('members.deleteForGood') : t('members.confirmLeave')}
            </button>
            <button
              disabled={busy}
              onClick={() => setConfirmLeave(false)}
              className="rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 dark:border-slate-600 dark:text-slate-300"
            >
              {t('members.cancel')}
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmLeave(true)}
            className="self-start rounded border border-red-300 px-3 py-2 text-sm font-medium text-red-700 dark:border-red-800 dark:text-red-400"
          >
            {t('members.leave')}
          </button>
        )}
      </section>
      <GroupKeyCheck groupId={groupId} />
    </div>
  );
}
