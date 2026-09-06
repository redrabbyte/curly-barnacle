import { describe, expect, it } from 'vitest';
import { aliasResolver, type ExpenseDto, type PaymentDto } from '@spendapp/shared';
import { expenseNamesMe, involvementFrom, paymentNamesMe } from './pushFilter';

/**
 * Who a notification is for (design §3.3).
 *
 * The server sends every entry event to the whole group because it cannot read
 * a split. This is the test it cannot run: given the opened entry, is the
 * reader in it? A wrong `false` silences somebody about their own money, so the
 * cases that matter here are the ones that must come back true.
 */

const split = (userId: string, paidMinor: number, owedMinor: number) => ({
  userId,
  paidMinor,
  owedMinor,
});

/** Only the fields either rule reads; the rest is not what is under test. */
const expense = (
  createdBy: string,
  ...splits: { userId: string; paidMinor: number; owedMinor: number }[]
): ExpenseDto => ({ createdBy, splits }) as ExpenseDto;

const payment = (createdBy: string, fromUser: string, toUser: string): PaymentDto =>
  ({ createdBy, fromUser, toUser }) as PaymentDto;

/** Nobody has been claimed: every id means itself. */
const plain = aliasResolver([]);

describe('expenses', () => {
  it('names somebody who owes a share', () => {
    const e = expense('b', split('a', 0, 500), split('b', 500, 0));
    expect(expenseNamesMe(e, 'a', plain)).toBe(true);
  });

  it('names somebody who paid but owes nothing', () => {
    const e = expense('b', split('a', 500, 0), split('b', 0, 500));
    expect(expenseNamesMe(e, 'a', plain)).toBe(true);
  });

  it('does not name somebody who is only in the group', () => {
    const e = expense('b', split('b', 500, 0), split('c', 0, 500));
    expect(expenseNamesMe(e, 'a', plain)).toBe(false);
  });

  /**
   * A split row of zeroes is what an unticked member looks like once the form
   * has been through the editor. Counting it would make the filter agree that
   * everybody is in everything, which is the same as not having one.
   */
  it('does not name somebody carried as a zero', () => {
    const e = expense('b', split('a', 0, 0), split('b', 500, 0), split('c', 0, 500));
    expect(expenseNamesMe(e, 'a', plain)).toBe(false);
  });

  it('names the author of an entry somebody else changed', () => {
    const e = expense('a', split('b', 500, 0), split('c', 0, 500));
    expect(expenseNamesMe(e, 'a', plain)).toBe(true);
  });

  /**
   * The claim case. The split still says the placeholder; only the alias says
   * it means this account now. Without resolving it, everything somebody
   * inherited would arrive as other people's business.
   */
  it('names the account that claimed a placeholder', () => {
    const resolve = aliasResolver([
      { userId: 'p', aliasOf: 'a' },
      { userId: 'a', aliasOf: null },
    ]);
    const e = expense('b', split('p', 0, 500), split('b', 500, 0));
    expect(expenseNamesMe(e, resolve('a'), resolve)).toBe(true);
  });
});

describe('payments', () => {
  it('names the payer', () => {
    expect(paymentNamesMe(payment('a', 'a', 'b'), 'a', plain)).toBe(true);
  });

  it('names the payee', () => {
    expect(paymentNamesMe(payment('a', 'a', 'b'), 'b', plain)).toBe(true);
  });

  it('does not name a bystander', () => {
    expect(paymentNamesMe(payment('b', 'b', 'c'), 'a', plain)).toBe(false);
  });

  /** Settling up on somebody's behalf is still a thing they should hear about. */
  it('names whoever recorded it', () => {
    expect(paymentNamesMe(payment('a', 'b', 'c'), 'a', plain)).toBe(true);
  });

  it('names the account that claimed a placeholder', () => {
    const resolve = aliasResolver([{ userId: 'p', aliasOf: 'a' }]);
    expect(paymentNamesMe(payment('b', 'p', 'b'), resolve('a'), resolve)).toBe(true);
  });
});

describe('which version of the entry is judged', () => {
  const ENTRY = { type: 'expense', id: 'e1', groupId: 'g1' } as const;

  /**
   * The bug this exists for.
   *
   * B writes an expense naming only B; A is told, quietly and correctly, that
   * it is not theirs. B then edits it to include A. The push announcing that
   * edit arrives before any sync could have brought it, so A's mirror still
   * holds the version without A in it — and reading the mirror first meant A
   * was told a second time, silently, that they were not involved. In the one
   * expense they had just been added to.
   */
  it('judges an edit by the pulled version, not the copy from before it', () => {
    const beforeTheEdit = expense('b', split('b', 500, 0));
    const afterTheEdit = expense('b', split('b', 500, 0), split('a', 0, 250));
    expect(involvementFrom(ENTRY, afterTheEdit, beforeTheEdit, 'a', plain)).toBe('mine');
  });

  /**
   * And the other direction, which is the one it is tempting to get wrong.
   *
   * Removed from an expense, you are not named in the version that arrives —
   * so judging by that alone made "your share of this just vanished" the
   * quietest thing the app can say, in the wording reserved for strangers'
   * expenses. A balance moved. Being taken off is a change *to* somebody, not
   * a change that stopped concerning them.
   */
  it('is loud when the edit is the reader being taken off', () => {
    const beforeTheEdit = expense('b', split('b', 500, 0), split('a', 0, 250));
    const afterTheEdit = expense('b', split('b', 500, 0));
    expect(involvementFrom(ENTRY, afterTheEdit, beforeTheEdit, 'a', plain)).toBe('mine');
  });

  /** The same for a payment edited so the reader is no longer one of its ends. */
  it('is loud when a payment stops being between the reader and anybody', () => {
    const entry = { type: 'payment', id: 'p1', groupId: 'g1' } as const;
    expect(involvementFrom(entry, payment('b', 'b', 'c'), payment('b', 'b', 'a'), 'a', plain)).toBe(
      'mine',
    );
  });

  /** Never in it and still not in it stays quiet — both sides have to be no. */
  it('stays quiet when neither version names the reader', () => {
    const beforeTheEdit = expense('b', split('b', 500, 0));
    const afterTheEdit = expense('b', split('b', 300, 0), split('c', 0, 200));
    expect(involvementFrom(ENTRY, afterTheEdit, beforeTheEdit, 'a', plain)).toBe('theirs');
  });

  /**
   * The delta had nothing because this device's cursor is already past the
   * entry — so the sync that moved the cursor wrote the very version the push
   * is about, and the mirror is current rather than merely available.
   */
  it('falls back to the mirror when the pull found nothing', () => {
    const held = expense('b', split('b', 500, 0), split('a', 0, 250));
    expect(involvementFrom(ENTRY, null, held, 'a', plain)).toBe('mine');
  });

  /** Nothing anywhere is not a quiet "no" — it is a loud "cannot tell". */
  it('is unknown when neither has it', () => {
    expect(involvementFrom(ENTRY, null, undefined, 'a', plain)).toBe('unknown');
  });

  it('reads a payment as a payment', () => {
    const entry = { type: 'payment', id: 'p1', groupId: 'g1' } as const;
    expect(involvementFrom(entry, payment('b', 'b', 'a'), undefined, 'a', plain)).toBe('mine');
    expect(involvementFrom(entry, payment('b', 'b', 'c'), undefined, 'a', plain)).toBe('theirs');
  });
});
