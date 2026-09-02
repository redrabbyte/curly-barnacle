import { describe, expect, it } from 'vitest';
import { computeOwed } from '@spendapp/shared';
import { percentBpOf, percentPlan } from './percentSplit';

const ids = ['ada', 'bob', 'cal'];
const sum = (plan: ReturnType<typeof percentPlan>): number =>
  [...plan.bp.values()].reduce((a, b) => a + b, 0);

describe('reading a percentage field', () => {
  it('takes a decimal comma, and refuses what is not a percentage', () => {
    expect(percentBpOf('12.5')).toBe(1250);
    expect(percentBpOf('12,5')).toBe(1250);
    expect(percentBpOf('0')).toBe(0);
    expect(percentBpOf('abc')).toBeNull();
    expect(percentBpOf('-1')).toBeNull();
    expect(percentBpOf('')).toBeNull();
  });

  it('rounds to basis points, which is the precision that survives a save', () => {
    expect(percentBpOf('33.333')).toBe(3333);
    expect(percentBpOf('33.336')).toBe(3334);
  });
});

describe('filling in the fields nobody has entered', () => {
  it('splits the whole 100% when nothing has been entered at all', () => {
    const plan = percentPlan(ids, {});
    expect(plan.auto).toEqual(new Set(ids));
    expect([...plan.bp.values()]).toEqual([3334, 3333, 3333]);
    expect(plan.remaining).toBe(0);
  });

  it('shares out only what the entered fields leave', () => {
    const plan = percentPlan(ids, { ada: '50' });
    expect(plan.bp.get('ada')).toBe(5000);
    expect(plan.bp.get('bob')).toBe(2500);
    expect(plan.bp.get('cal')).toBe(2500);
    expect(plan.remaining).toBe(0);
  });

  it('hands a field back to the pool when it is cleared', () => {
    const entered = percentPlan(ids, { ada: '50', bob: '30' });
    expect(entered.bp.get('cal')).toBe(2000);
    const cleared = percentPlan(ids, { ada: '50', bob: '' });
    expect(cleared.auto).toEqual(new Set(['bob', 'cal']));
    expect(cleared.bp.get('bob')).toBe(2500);
  });

  it('keeps an entered 0 out of the split without dropping the member', () => {
    const plan = percentPlan(ids, { cal: '0' });
    expect(plan.auto.has('cal')).toBe(false);
    expect(plan.bp.get('cal')).toBe(0);
    expect(plan.bp.get('ada')).toBe(5000);
    expect(plan.remaining).toBe(0);
  });

  it('leaves the pool empty rather than negative when the entries overshoot', () => {
    const plan = percentPlan(ids, { ada: '80', bob: '40' });
    expect(plan.bp.get('cal')).toBe(0);
    expect(plan.remaining).toBe(-20);
  });

  it('reports an unreadable field instead of counting it', () => {
    const plan = percentPlan(ids, { ada: 'half', bob: '50' });
    expect(plan.invalid).toEqual(['ada']);
    expect(plan.bp.get('ada')).toBe(0);
  });
});

describe('what the indicator says and what the save does', () => {
  // The bug this file exists for: 33.333 three times summed to 99.999, which
  // the old indicator rounded to a green "0% remaining" while computeOwed
  // refused the same split for adding up to 9999bp instead of 10000.
  it('agrees with computeOwed on a split that rounds away from 100%', () => {
    const percent = { ada: '33.333', bob: '33.333', cal: '33.333' };
    const plan = percentPlan(ids, percent);
    expect(plan.remaining).not.toBe(0);
    expect(sum(plan)).toBe(9999);
    expect(() =>
      computeOwed(10_000, {
        mode: 'percent',
        entries: ids.map((userId) => ({ userId, percentBp: plan.bp.get(userId)! })),
      }),
    ).toThrow();
  });

  it('reads 0% remaining exactly when the split is one computeOwed accepts', () => {
    const cases: Record<string, string>[] = [
      {},
      { ada: '50' },
      { ada: '50', bob: '30' },
      { ada: '50', bob: '30', cal: '20' },
      { ada: '33.33', bob: '33.33', cal: '33.34' },
      { cal: '0' },
    ];
    for (const percent of cases) {
      const plan = percentPlan(ids, percent);
      expect(plan.remaining, JSON.stringify(percent)).toBe(0);
      const owed = computeOwed(10_000, {
        mode: 'percent',
        entries: ids.map((userId) => ({ userId, percentBp: plan.bp.get(userId)! })),
      });
      expect(owed.reduce((a, o) => a + o.owedMinor, 0)).toBe(10_000);
    }
  });
});

describe('the shape of the plan', () => {
  it('lists every member once, in the order they were given', () => {
    const plan = percentPlan(ids, { bob: '40' });
    expect([...plan.bp.keys()]).toEqual(ids);
    expect([...plan.bp.values()]).toEqual([3000, 4000, 3000]);
    expect(sum(plan)).toBe(10_000);
  });
});
