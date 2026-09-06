import { describe, expect, it } from 'vitest';
import type { UpsertExpense } from '@spendapp/shared';
import { diffExpense, participantsOf } from './expenseDiff';

/**
 * What an edit did, read back off the two snapshots straddling it (design §11).
 *
 * The log used to say "edited" and stop, which is the least useful true thing
 * it could say about a change to somebody's money. These pin the sentences it
 * says instead — and, as much, the ones it must not: an edit that raises a
 * total re-derives every split row underneath it, and saying the shares were
 * rearranged as well would be noise dressed as detail.
 */

const base: UpsertExpense = {
  id: 'e1',
  groupId: 'g1',
  description: 'Dinner',
  category: 'food',
  note: '',
  expenseDate: '2026-01-05T19:00:00.000Z',
  currency: 'EUR',
  amountMinor: 1000,
  rateToDefault: null,
  splitMeta: { mode: 'equal', userIds: ['a', 'b'] },
  splits: [
    { userId: 'a', paidMinor: 1000, owedMinor: 500 },
    { userId: 'b', paidMinor: 0, owedMinor: 500 },
  ],
};

const edit = (over: Partial<UpsertExpense>): UpsertExpense => ({ ...base, ...over });

describe('what changed', () => {
  it('says nothing about an edit that changed nothing it describes', () => {
    expect(diffExpense(base, edit({ rateToDefault: '1.08' }))).toEqual([]);
  });

  it('names both sides of a rename', () => {
    expect(diffExpense(base, edit({ description: 'Lunch' }))).toEqual([
      { field: 'description', from: 'Dinner', to: 'Lunch' },
    ]);
  });

  it('reports the amount with the currency it is in', () => {
    expect(diffExpense(base, edit({ amountMinor: 1200 }))).toEqual([
      {
        field: 'amount',
        from: { amountMinor: 1000, currency: 'EUR' },
        to: { amountMinor: 1200, currency: 'EUR' },
      },
    ]);
  });

  /**
   * A conversion moves both at once. Two lines would have it saying the amount
   * went from 1000 to 1080 without saying those are different currencies.
   */
  it('folds a currency conversion into one line', () => {
    const converted = edit({ currency: 'CHF', amountMinor: 1080 });
    expect(diffExpense(base, converted)).toEqual([
      {
        field: 'amount',
        from: { amountMinor: 1000, currency: 'EUR' },
        to: { amountMinor: 1080, currency: 'CHF' },
      },
    ]);
  });

  it('tells an added note from a changed one and from a deleted one', () => {
    expect(diffExpense(base, edit({ note: 'split the taxi too' }))).toEqual([
      { field: 'note', kind: 'added' },
    ]);
    const withNote = edit({ note: 'first' });
    expect(diffExpense(withNote, edit({ note: 'second' }))).toEqual([
      { field: 'note', kind: 'changed' },
    ]);
    expect(diffExpense(withNote, base)).toEqual([{ field: 'note', kind: 'removed' }]);
  });

  it('reports the category and the date', () => {
    expect(diffExpense(base, edit({ category: 'travel' }))).toEqual([
      { field: 'category', from: 'food', to: 'travel' },
    ]);
    expect(diffExpense(base, edit({ expenseDate: '2026-01-06T19:00:00.000Z' }))).toEqual([
      { field: 'date', from: '2026-01-05T19:00:00.000Z', to: '2026-01-06T19:00:00.000Z' },
    ]);
  });

  it('names who joined and who was taken off', () => {
    const three = edit({
      splitMeta: { mode: 'equal', userIds: ['a', 'c'] },
      splits: [
        { userId: 'a', paidMinor: 1000, owedMinor: 500 },
        { userId: 'c', paidMinor: 0, owedMinor: 500 },
      ],
    });
    expect(diffExpense(base, three)).toEqual([{ field: 'whoPays', added: ['c'], removed: ['b'] }]);
  });

  /**
   * The rule the notification filter uses, for the same reason: a row of
   * zeroes is somebody the editor listed and then left out. Counting it would
   * make dropping a person from the split invisible here.
   */
  it('treats a row of zeroes as not being in it', () => {
    const zeroed = edit({
      splits: [
        { userId: 'a', paidMinor: 1000, owedMinor: 1000 },
        { userId: 'b', paidMinor: 0, owedMinor: 0 },
      ],
    });
    expect(participantsOf(zeroed)).toEqual(new Set(['a']));
    expect(diffExpense(base, zeroed)).toEqual([{ field: 'whoPays', added: [], removed: ['b'] }]);
  });

  it('reports a change of split method', () => {
    const exact = edit({
      splitMeta: { mode: 'exact', entries: [{ userId: 'a', amountMinor: 600 }, { userId: 'b', amountMinor: 400 }] },
      splits: [
        { userId: 'a', paidMinor: 1000, owedMinor: 600 },
        { userId: 'b', paidMinor: 0, owedMinor: 400 },
      ],
    });
    expect(diffExpense(base, exact)).toEqual([{ field: 'splitMode', from: 'equal', to: 'exact' }]);
  });

  it('reports the shares moving between the same people', () => {
    const sixty = edit({
      splitMeta: { mode: 'equal', userIds: ['a'] },
      splits: [
        { userId: 'a', paidMinor: 1000, owedMinor: 600 },
        { userId: 'b', paidMinor: 0, owedMinor: 400 },
      ],
    });
    expect(diffExpense(base, sixty)).toEqual([{ field: 'shares' }]);
  });

  /**
   * The one the split rows would have got wrong. Raising the total re-derives
   * every share underneath an equal split, so comparing the rows would report
   * a rearrangement nobody asked for. The meta is what the editor was told.
   */
  it('does not claim the shares moved when only the total did', () => {
    const dearer = edit({
      amountMinor: 1200,
      splits: [
        { userId: 'a', paidMinor: 1200, owedMinor: 600 },
        { userId: 'b', paidMinor: 0, owedMinor: 600 },
      ],
    });
    expect(diffExpense(base, dearer)).toEqual([
      {
        field: 'amount',
        from: { amountMinor: 1000, currency: 'EUR' },
        to: { amountMinor: 1200, currency: 'EUR' },
      },
    ]);
  });

  /** Somebody joining already changes the meta; saying so twice helps nobody. */
  it('does not add a shares line on top of somebody joining', () => {
    const three = edit({
      splitMeta: { mode: 'equal', userIds: ['a', 'b', 'c'] },
      splits: [
        { userId: 'a', paidMinor: 1000, owedMinor: 334 },
        { userId: 'b', paidMinor: 0, owedMinor: 333 },
        { userId: 'c', paidMinor: 0, owedMinor: 333 },
      ],
    });
    expect(diffExpense(base, three)).toEqual([{ field: 'whoPays', added: ['c'], removed: [] }]);
  });

  it('reports every part of an edit that touched several', () => {
    const lots = edit({ description: 'Lunch', amountMinor: 1500, note: 'with tip' });
    expect(diffExpense(base, lots).map((c) => c.field)).toEqual(['description', 'amount', 'note']);
  });
});
