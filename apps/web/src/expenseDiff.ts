import type { SplitMeta, UpsertExpense } from '@spendapp/shared';

/**
 * What actually changed between two versions of an expense (design §11).
 *
 * The log knew that somebody edited an entry and nothing about what they did
 * to it, which is the half a reader wants: an amount that moved is a balance
 * that moved, and "edited" is the one word that does not say so. Every write
 * already carries a sealed snapshot of the version it creates, so the answer
 * is sitting in the activity feed — it only had to be compared against the
 * snapshot before it.
 *
 * Pure, and returns ids and minor units rather than sentences: the money
 * formatter, the category labels and the member names all live in the
 * component, and a diff that reached for them would be untestable and
 * monolingual.
 */

export interface Money {
  amountMinor: number;
  currency: string;
}

export type ExpenseChange =
  | { field: 'description'; from: string; to: string }
  | { field: 'amount'; from: Money; to: Money }
  | { field: 'category'; from: string; to: string }
  | { field: 'date'; from: string; to: string }
  | { field: 'note'; kind: 'added' | 'changed' | 'removed' }
  | { field: 'splitMode'; from: SplitMeta['mode']; to: SplitMeta['mode'] }
  | { field: 'whoPays'; added: string[]; removed: string[] }
  | { field: 'shares' };

/**
 * Who the entry names, by the same rule the notification filter uses: a row of
 * zeroes is somebody the editor listed and then left out, not a participant.
 */
export function participantsOf(expense: Pick<UpsertExpense, 'splits'>): Set<string> {
  return new Set(
    expense.splits.filter((s) => s.paidMinor !== 0 || s.owedMinor !== 0).map((s) => s.userId),
  );
}

/**
 * Structural equality, over the one shape that needs it.
 *
 * `splitMeta` is a small discriminated union of arrays of numbers — JSON is an
 * honest comparison of it and a readable one. It would not be for anything
 * holding a Date, a Map or an undefined, and nothing here does.
 */
const sameMeta = (a: SplitMeta, b: SplitMeta): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A note appearing, going, or being rewritten — three different sentences. */
const noteChange = (from: string, to: string): 'added' | 'changed' | 'removed' => {
  if (!from) return 'added';
  if (!to) return 'removed';
  return 'changed';
};

/**
 * The changes from `before` to `after`, in the order they are worth reading.
 *
 * Empty when the two versions differ only in ways this does not describe — a
 * frozen conversion rate, a re-seal under a new epoch — which is why the row
 * still carries its own "edited" line rather than being replaced by this.
 */
export function diffExpense(before: UpsertExpense, after: UpsertExpense): ExpenseChange[] {
  const out: ExpenseChange[] = [];

  if (before.description !== after.description) {
    out.push({ field: 'description', from: before.description, to: after.description });
  }
  // Currency and amount as one line. A conversion changes both, and reporting
  // them separately would say the amount tripled without saying it is francs.
  if (before.amountMinor !== after.amountMinor || before.currency !== after.currency) {
    out.push({
      field: 'amount',
      from: { amountMinor: before.amountMinor, currency: before.currency },
      to: { amountMinor: after.amountMinor, currency: after.currency },
    });
  }
  if (before.category !== after.category) {
    out.push({ field: 'category', from: before.category, to: after.category });
  }
  if (before.expenseDate !== after.expenseDate) {
    out.push({ field: 'date', from: before.expenseDate, to: after.expenseDate });
  }
  if (before.note !== after.note) {
    out.push({ field: 'note', kind: noteChange(before.note, after.note) });
  }
  if (before.splitMeta.mode !== after.splitMeta.mode) {
    out.push({ field: 'splitMode', from: before.splitMeta.mode, to: after.splitMeta.mode });
  }

  const was = participantsOf(before);
  const now = participantsOf(after);
  const added = [...now].filter((id) => !was.has(id));
  const removed = [...was].filter((id) => !now.has(id));
  if (added.length > 0 || removed.length > 0) {
    out.push({ field: 'whoPays', added, removed });
  } else if (before.splitMeta.mode === after.splitMeta.mode && !sameMeta(before.splitMeta, after.splitMeta)) {
    // Only when nobody joined or left, because either of those changes the
    // meta by itself and would have this saying the same thing twice.
    //
    // Compared on `splitMeta` rather than on the split rows: the rows are the
    // arithmetic, so raising the total re-derives every one of them, and a
    // plain "10 → 12 on an equal split" would otherwise also claim the shares
    // were rearranged. The meta is what the editor was actually asked for.
    out.push({ field: 'shares' });
  }

  return out;
}
