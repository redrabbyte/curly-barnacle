import { useEffect, useMemo, useState } from 'react';
import type {
  ActivityDto,
  ExpenseDto,
  PaymentDto,
  UpsertExpense,
  UpsertPayment,
} from '@spendapp/shared';
import { openSnapshot } from '../envelope';
import { diffExpense, type ExpenseChange } from '../expenseDiff';
import { restoreExpenseLocal, restorePaymentLocal } from '../sync';
import { revertImport } from '../import';
import type { Translator } from '../i18n';
import { useLocale, useT } from '../i18n/useT';
import { useMoney, type MoneyFormatter } from '../i18n/useMoney';
import { categoryLabel } from '../i18n/categories';
import { formatExpenseDate, useSettings } from '../settings';

interface ImportPayload {
  source?: string;
  expenseIds?: string[];
  paymentIds?: string[];
  count?: number;
}

type AnySnapshot = UpsertExpense | UpsertPayment;
const isExpenseSnapshot = (s: AnySnapshot): s is UpsertExpense => 'description' in s;

/**
 * Snapshots are sealed inside the activity payload (design §11), so reading
 * one is async and the log cannot render it inline. They are also immutable
 * once written, which is what makes caching them across renders safe: an id
 * that has been opened once never changes.
 */
const snapshotCache = new Map<string, AnySnapshot | null>();

function useSnapshots(activity: ActivityDto[]): Map<string, AnySnapshot> {
  const [, bump] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      let added = false;
      for (const a of activity) {
        if (snapshotCache.has(a.id)) continue;
        snapshotCache.set(a.id, await openSnapshot<AnySnapshot>(a.id, a.groupId, a.payload));
        added = true;
      }
      // One re-render for the batch, not one per row.
      if (live && added) bump((n) => n + 1);
    })();
    return () => {
      live = false;
    };
  }, [activity]);

  return useMemo(() => {
    const out = new Map<string, AnySnapshot>();
    for (const a of activity) {
      const s = snapshotCache.get(a.id);
      if (s) out.set(a.id, s);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity, snapshotCache.size]);
}

/**
 * Newest first, with anything not yet synced at the top.
 *
 * The server assigns the version, so a row written on this device carries 0
 * until it comes back — and ordering on that alone filed a comment somebody
 * had just posted underneath the day the expense was created. `createdAt`
 * breaks ties, which is what orders two rows from the same sync.
 */
const newestFirst = (a: ActivityDto, b: ActivityDto): number =>
  (b.version || Number.MAX_SAFE_INTEGER) - (a.version || Number.MAX_SAFE_INTEGER) ||
  (a.createdAt < b.createdAt ? 1 : -1);

/** A row that is a version of an entity, rather than a comment or a photo. */
const isEntityVersion = (a: ActivityDto): boolean =>
  a.type.startsWith('expense.') || a.type.startsWith('payment.');

/** Latest known snapshot of an entity, for restoring past a delete. */
function latestSnapshot(
  activity: ActivityDto[],
  snapshots: Map<string, AnySnapshot>,
  entityId: string,
): AnySnapshot | undefined {
  const withSnap = activity
    .filter((a) => a.entityId === entityId && snapshots.has(a.id))
    .sort((a, b) => b.version - a.version);
  return withSnap[0] ? snapshots.get(withSnap[0].id) : undefined;
}

function describe(t: Translator, money: MoneyFormatter, a: ActivityDto, snapshot?: AnySnapshot): string {
  const snap = snapshot && isExpenseSnapshot(snapshot) ? snapshot : undefined;
  // Without a snapshot — one that has not synced, or was written before this
  // device held the key — the sentence still has to name something.
  const what = snap
    ? t('activity.what', { description: snap.description, amount: money(snap.amountMinor, snap.currency) })
    : t('activity.anExpense');
  const named = (a.payload as { displayName?: string })?.displayName ?? t('activity.aMember');
  switch (a.type) {
    case 'group.created':
      return t('activity.group.created');
    case 'member.joined':
      return t('activity.member.joined');
    case 'expense.created':
      return t('activity.expense.created', { what });
    case 'expense.updated':
      return t('activity.expense.updated', { what });
    case 'expense.restored':
      return t('activity.expense.restored', { what });
    case 'expense.deleted':
      return t('activity.expense.deleted');
    case 'payment.created':
      return t('activity.payment.created');
    case 'payment.updated':
      return t('activity.payment.updated');
    case 'payment.deleted':
      return t('activity.payment.deleted');
    case 'member.added':
      return t('activity.member.added', { name: named });
    case 'member.claimed':
      return t('activity.member.claimed', { name: named });
    case 'member.restored':
      return t('activity.member.restored', { name: named });
    case 'import.created': {
      const p = a.payload as ImportPayload;
      return t('activity.import.created', {
        count: p.count ?? 0,
        // Splitwise is a name; a CSV is a thing, and needs words.
        source: p.source === 'splitwise' ? 'Splitwise' : t('activity.import.csv'),
      });
    }
    case 'import.reverted':
      return t('activity.import.reverted');
    // These three reached the fallback below and rendered their own type
    // string — a log line reading `attachment.added`, in either language.
    case 'comment':
      return t('activity.comment');
    case 'attachment.added':
      return t('activity.attachment.added');
    case 'attachment.removed':
      return t('activity.attachment.removed');
    case 'attachment.restored':
      return t('activity.attachment.restored');
    default:
      return a.type;
  }
}

interface Props {
  activity: ActivityDto[];
  expenses: ExpenseDto[];
  payments: PaymentDto[];
  meId: string;
  groupId: string;
  nameOf: (id: string) => string;
}

export function ActivityTab({ activity, expenses, payments, meId, groupId, nameOf }: Props) {
  const t = useT();
  const locale = useLocale();
  const money = useMoney();
  const snapshots = useSnapshots(activity);
  // An import already undone must not offer the button again.
  const revertedImports = useMemo(
    () => new Set(activity.filter((a) => a.type === 'import.reverted').map((a) => a.entityId)),
    [activity],
  );
  const sorted = useMemo(() => activity.slice().sort(newestFirst).slice(0, 100), [activity]);
  const expenseById = useMemo(() => new Map(expenses.map((e) => [e.id, e])), [expenses]);
  const paymentById = useMemo(() => new Map(payments.map((p) => [p.id, p])), [payments]);
  // The newest logged version of each entity: everything below it is something
  // you could go back to, and it is the one thing you cannot "revert" to.
  const newestVersionOf = useMemo(() => {
    const out = new Map<string, string>();
    // Versions only. A comment is logged against the expense it is on, so
    // counting it here made the newest *edit* look superseded the moment
    // somebody commented — and offered a "revert to this" that went nowhere.
    for (const a of [...activity].filter(isEntityVersion).sort((x, y) => x.version - y.version)) {
      out.set(a.entityId, a.id);
    }
    return out;
  }, [activity]);

  if (sorted.length === 0) return <p className="text-slate-500 dark:text-slate-400">{t('activity.empty')}</p>;

  return (
    <ul className="flex flex-col gap-2 text-sm">
      {sorted.map((a) => {
        const snap = snapshots.get(a.id);
        // Deleted and still deleted → offer restore (design §11).
        const deleted =
          (a.type === 'expense.deleted' && expenseById.get(a.entityId)?.deletedAt) ||
          (a.type === 'payment.deleted' && paymentById.get(a.entityId)?.deletedAt);
        const restorable = deleted ? latestSnapshot(activity, snapshots, a.entityId) : undefined;
        // Any earlier version of something that still exists can be gone back
        // to, straight from the feed — the per-expense log is a longer route to
        // the same place, and payments had no route at all.
        const revertable =
          !deleted && snap && newestVersionOf.get(a.entityId) !== a.id
            ? snap
            : undefined;
        const restore = (s: AnySnapshot) =>
          isExpenseSnapshot(s) ? restoreExpenseLocal(s, meId) : restorePaymentLocal(s, meId);
        const importPayload =
          a.type === 'import.created' && !revertedImports.has(a.entityId)
            ? (a.payload as ImportPayload)
            : undefined;
        return (
          <li key={a.id} className="flex items-center justify-between gap-2 border-b border-slate-100 pb-1">
            <span>
              <span className="font-medium">{nameOf(a.actorId)}</span> {describe(t, money, a, snap)}
              {restorable && isExpenseSnapshot(restorable) && (
                <span className="text-slate-500 dark:text-slate-400">
                  {' '}
                  {t('activity.wasNamed', { description: restorable.description })}
                </span>
              )}
            </span>
            <span className="flex items-center gap-2 whitespace-nowrap text-slate-400">
              {restorable && (
                <button className="text-teal-700 dark:text-teal-300 underline" onClick={() => void restore(restorable)}>
                  {t('activity.restore')}
                </button>
              )}
              {revertable && (
                <button className="text-teal-700 dark:text-teal-300 underline" onClick={() => void restore(revertable)}>
                  {t('activity.revertTo')}
                </button>
              )}
              {importPayload && (
                <button
                  className="text-teal-700 dark:text-teal-300 underline"
                  onClick={() => {
                    const count = importPayload.count ?? 0;
                    if (!confirm(t('activity.confirmRevertImport', { count }))) return;
                    void revertImport(
                      groupId,
                      a.entityId,
                      importPayload.expenseIds ?? [],
                      importPayload.paymentIds ?? [],
                    );
                  }}
                >
                  {t('activity.revertImport')}
                </button>
              )}
              {new Date(a.createdAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One change, in words. Returns a list because a single edit to the split can
 * both add and remove somebody, and those are two things to say.
 */
function changeLines(
  t: Translator,
  money: MoneyFormatter,
  nameOf: (id: string) => string,
  date: (iso: string) => string,
  c: ExpenseChange,
): string[] {
  switch (c.field) {
    case 'description':
      return [t('change.description', { from: c.from, to: c.to })];
    case 'amount':
      return [
        t('change.amount', {
          from: money(c.from.amountMinor, c.from.currency),
          to: money(c.to.amountMinor, c.to.currency),
        }),
      ];
    case 'category':
      return [t('change.category', { from: categoryLabel(t, c.from), to: categoryLabel(t, c.to) })];
    case 'date':
      return [t('change.date', { from: date(c.from), to: date(c.to) })];
    case 'note':
      return [t(`change.note.${c.kind}`)];
    case 'splitMode':
      return [t('change.splitMode', { from: t(`split.${c.from}`), to: t(`split.${c.to}`) })];
    case 'whoPays':
      return [
        ...(c.added.length > 0
          ? [t('change.whoPays.added', { names: c.added.map(nameOf).join(', ') })]
          : []),
        ...(c.removed.length > 0
          ? [t('change.whoPays.removed', { names: c.removed.map(nameOf).join(', ') })]
          : []),
      ];
    case 'shares':
      return [t('change.shares')];
  }
}

function ChangeList({
  changes,
  nameOf,
}: {
  changes: ExpenseChange[];
  nameOf: (id: string) => string;
}) {
  const t = useT();
  const money = useMoney();
  const {
    settings: { displayTz, language },
  } = useSettings();
  const lines = useMemo(
    () =>
      changes.flatMap((c) =>
        changeLines(t, money, nameOf, (iso) => formatExpenseDate(iso, displayTz, language), c),
      ),
    [changes, t, money, nameOf, displayTz, language],
  );
  if (lines.length === 0) return null;
  return (
    <ul className="mt-0.5 flex flex-col gap-0.5 pl-3 text-xs text-slate-500 dark:text-slate-400">
      {/* Index keys: the list is derived fresh per row and never reorders. */}
      {lines.map((line, i) => (
        <li key={i}>{line}</li>
      ))}
    </ul>
  );
}

/**
 * Per-expense version log with revert (design §11).
 *
 * Shows what each edit *did*, not only that there was one. Every write seals a
 * snapshot of the version it creates, so an edit is described by comparing its
 * snapshot with the one before it — no extra storage, and nothing the server
 * can read either way.
 *
 * Comments and photos belong here too. Comment rows were already being caught
 * by the filter (they are logged against the expense) and rendered as the bare
 * word `comment`, having no case in `describe`; attachment rows were logged
 * against the attachment and so were missing altogether. A history of an
 * expense that omits somebody attaching the receipt is not its history.
 */
export function VersionLog({
  activity,
  expense,
  attachmentIds,
  meId,
  nameOf,
}: {
  activity: ActivityDto[];
  expense: ExpenseDto;
  /** The expense's photos, live or deleted — the log rows only name the photo. */
  attachmentIds: Set<string>;
  meId: string;
  nameOf: (id: string) => string;
}) {
  const t = useT();
  const locale = useLocale();
  const money = useMoney();
  const rows = useMemo(
    () =>
      activity
        .filter(
          (a) =>
            (a.entityType === 'expense' && a.entityId === expense.id) ||
            (a.entityType === 'attachment' && attachmentIds.has(a.entityId)),
        )
        .sort(newestFirst),
    [activity, expense.id, attachmentIds],
  );
  const snapshots = useSnapshots(rows);

  // The versions of the expense itself, newest first. Comments and photos sit
  // between them in the list but are not versions of anything: they carry no
  // snapshot, cannot be reverted to, and must not be what an edit is compared
  // against.
  const versions = useMemo(() => rows.filter((a) => a.type.startsWith('expense.')), [rows]);
  const newestVersionId = versions[0]?.id;
  const previousOf = useMemo(() => {
    const out = new Map<string, string>();
    versions.forEach((a, i) => {
      const older = versions[i + 1];
      if (older) out.set(a.id, older.id);
    });
    return out;
  }, [versions]);

  if (rows.length === 0)
    return <p className="text-sm text-slate-500 dark:text-slate-400">{t('activity.noHistory')}</p>;

  return (
    <ul className="flex flex-col gap-1 text-sm">
      {rows.map((a) => {
        const snap = snapshots.get(a.id);
        const isVersion = a.type.startsWith('expense.');
        // Both ends have to open before an edit can be described. A version
        // written before snapshots existed, or under an epoch this device was
        // never given, leaves the row saying only that it was edited — which
        // is what every row said before.
        const olderId = previousOf.get(a.id);
        const older = olderId ? snapshots.get(olderId) : undefined;
        const changes =
          snap && older && isExpenseSnapshot(snap) && isExpenseSnapshot(older)
            ? diffExpense(older, snap)
            : [];
        return (
          <li key={a.id} className="flex flex-col">
            <span className="flex items-start justify-between gap-2">
              <span className="min-w-0">
                <span className="font-medium">{nameOf(a.actorId)}</span> {describe(t, money, a, snap)}
                {a.id === newestVersionId && (
                  <span className="ml-1 text-xs text-slate-400">{t('activity.current')}</span>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-2 whitespace-nowrap text-slate-400">
                {isVersion && a.id !== newestVersionId && snap && isExpenseSnapshot(snap) && (
                  <button
                    className="text-teal-700 dark:text-teal-300 underline"
                    onClick={() => void restoreExpenseLocal(snap, meId)}
                  >
                    {t('activity.revertTo')}
                  </button>
                )}
                {new Date(a.createdAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })}
              </span>
            </span>
            <ChangeList changes={changes} nameOf={nameOf} />
          </li>
        );
      })}
    </ul>
  );
}
