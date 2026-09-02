/**
 * What the percentage fields of the split editor mean.
 *
 * Two rules live here, and they are the same rule seen from two sides:
 *
 * A field is read as basis points the moment it is read at all, so the
 * running total, the auto-filled fields and the number handed to `computeOwed`
 * cannot disagree. Rounding only at save time was how three fields of 33.333
 * could show "0% remaining" and still be refused for not adding up to 100%.
 *
 * A blank field is not a member left out of the split; it is a member whose
 * share has not been decided yet, and it takes an even cut of whatever the
 * entered fields leave of the 100%. Blank is the whole of the bookkeeping —
 * clearing a field hands it straight back to the pool — so what is on screen
 * and what gets saved cannot drift apart. To leave somebody out, enter 0.
 */

import { allocateByWeights } from '@spendapp/shared';

export interface PercentPlan {
  /** Basis points per member, auto-filled ones included. Sums to 10000 unless `remaining` says otherwise. */
  bp: Map<string, number>;
  /** Members taking an auto share, i.e. whose field is blank. */
  auto: Set<string>;
  /** Members whose field is not a number, or is negative. */
  invalid: string[];
  /** Percentage points still unassigned. Negative means the entered fields overshoot 100%. */
  remaining: number;
}

/**
 * A single field as basis points, or null if it is not a usable percentage.
 * Blank is null rather than zero: an empty field states nothing, and reading
 * it as a hard 0% is the one answer it definitely does not mean.
 */
export function percentBpOf(raw: string | undefined): number | null {
  if (!raw?.trim()) return null;
  const v = Number(raw.replace(',', '.'));
  return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : null;
}

export function percentPlan(
  userIds: readonly string[],
  percent: Readonly<Record<string, string>>,
): PercentPlan {
  const auto = new Set(userIds.filter((id) => !percent[id]?.trim()));
  // Seeded in the caller's order, so iterating the plan and iterating the
  // members line up; the entries below overwrite rather than append.
  const bp = new Map<string, number>(userIds.map((id) => [id, 0]));
  const invalid: string[] = [];

  let manualBp = 0;
  for (const id of userIds) {
    if (auto.has(id)) continue;
    const entered = percentBpOf(percent[id]);
    if (entered === null) invalid.push(id);
    else manualBp += entered;
    bp.set(id, entered ?? 0);
  }

  // Fields entered past 100% leave nothing to share out rather than pushing
  // the pool negative: the auto fields sit at 0, `remaining` reports the
  // overshoot, and the save refuses the split for not summing to 100%.
  const pool = Math.max(0, 10_000 - manualBp);
  const autoIds = userIds.filter((id) => auto.has(id));
  if (autoIds.length > 0) {
    const share = allocateByWeights(
      pool,
      autoIds.map((userId) => ({ userId, weight: 1 })),
    );
    autoIds.forEach((id, i) => bp.set(id, share[i]!));
  }

  let assigned = 0;
  for (const v of bp.values()) assigned += v;
  return { bp, auto, invalid, remaining: (10_000 - assigned) / 100 };
}
