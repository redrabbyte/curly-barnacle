import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { Tx } from './groups.js';

/**
 * The sealed group name, server side (design §4.2).
 *
 * This server holds the name as ciphertext under one of the group's epoch
 * keys and cannot open it. What it *can* do is hold the one line that keeps
 * the name readable to everybody: the name must be sealed under the newest
 * epoch, because a member admitted from today onwards holds nothing older.
 * Epoch numbers are plain, so that is checkable here without a key.
 */

/** The newest epoch anybody holds a wrap for, or null before the first key. */
export async function newestEpoch(tx: Tx | typeof db, groupId: string): Promise<number | null> {
  const [row] = await tx
    .select({ epoch: sql<number | null>`max(${schema.groupKeys.epoch})` })
    .from(schema.groupKeys)
    .where(eq(schema.groupKeys.groupId, groupId));
  const epoch = row?.epoch;
  return epoch === null || epoch === undefined ? null : Number(epoch);
}

/**
 * Store a name sealed under `epoch`, unless the row already carries one under
 * this epoch or a newer one. First writer wins: several members backfilling
 * the same group at once all hold the same key and the same name, so which
 * blob lands does not matter, and a name under a newer epoch must never be
 * replaced by one under an older.
 *
 */
export async function storeSealedName(
  tx: Tx | typeof db,
  groupId: string,
  epoch: number,
  sealed: { iv: string; ct: string },
): Promise<boolean> {
  const [res] = await tx
    .update(schema.groups)
    .set({ nameEpoch: epoch, nameIv: sealed.iv, nameCt: sealed.ct })
    .where(and(eq(schema.groups.id, groupId), or(isNull(schema.groups.nameEpoch), lt(schema.groups.nameEpoch, epoch))));
  return res.affectedRows > 0;
}
