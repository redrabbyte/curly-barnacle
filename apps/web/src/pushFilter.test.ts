import { describe, expect, it } from 'vitest';
import { aliasResolver, type ExpenseDto, type PaymentDto } from '@spendapp/shared';
import { expenseNamesMe, paymentNamesMe } from './pushFilter';

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

const expense = (
  createdBy: string,
  ...splits: { userId: string; paidMinor: number; owedMinor: number }[]
): Pick<ExpenseDto, 'splits' | 'createdBy'> => ({ createdBy, splits });

const payment = (
  createdBy: string,
  fromUser: string,
  toUser: string,
): Pick<PaymentDto, 'fromUser' | 'toUser' | 'createdBy'> => ({ createdBy, fromUser, toUser });

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
