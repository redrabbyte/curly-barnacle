import { fromBase64Url, openJson, sealJson, toBase64Url, type GroupDto, type GroupWire, type Mutation } from '@spendapp/shared';
import { groupNameAad } from './aad';
import type { KeyLookup } from './reseal';

/**
 * The group name, sealed and opened (design §4.2).
 *
 * Sealed under the group's *newest* epoch, and re-sealed at every rotation,
 * because a member admitted from today onwards holds nothing older and still
 * has to know what the group is called. Opened on every pull into the mirror,
 * exactly as an expense is, so nothing above the mirror learns that the name
 * was ever ciphertext.
 */

/** What the blob says. An object rather than a bare string so it pads and parses like every other record. */
interface NameContent {
  name: string;
}

export async function sealGroupName(
  groupId: string,
  epoch: number,
  key: Uint8Array,
  name: string,
): Promise<{ iv: string; ct: string }> {
  const sealed = await sealJson(key, { name } satisfies NameContent, groupNameAad(groupId, epoch));
  return { iv: toBase64Url(sealed.iv), ct: toBase64Url(sealed.ciphertext) };
}

export async function openGroupName(
  groupId: string,
  epoch: number,
  key: Uint8Array,
  sealed: { iv: string; ct: string },
): Promise<string> {
  const content = await openJson<NameContent>(
    key,
    { iv: fromBase64Url(sealed.iv), ciphertext: fromBase64Url(sealed.ct) },
    groupNameAad(groupId, epoch),
  );
  if (typeof content?.name !== 'string') throw new Error('not a group name');
  return content.name;
}

/**
 * The mirror row for a group as it arrived, given what the mirror already
 * holds (design §4.2).
 *
 * Three outcomes, in order of preference. The sealed name opens with a key
 * this device holds: that is the name. It does not — no key yet, a key this
 * device was never given, a blob somebody produced that does not open — but
 * the mirror already has a name from an earlier pull: keep it, because a name
 * that was right yesterday is a better thing to show than nothing, and the
 * next pull may bring the key. Neither: an empty name with `nameEpoch: null`,
 * which the UI shows as "waiting for keys" and nothing ever seals back.
 *
 * The readable `name` from before names were sealed counts as opened at no
 * epoch: it is the name, and the backfill below is what seals it.
 *
 * Pure over the key lookup, so the rule can be tested without a database.
 */
export async function resolveGroupName(
  wire: GroupWire,
  previous: Pick<GroupDto, 'name' | 'nameEpoch'> | undefined,
  keyFor: KeyLookup,
): Promise<Pick<GroupDto, 'name' | 'nameEpoch'>> {
  if (wire.nameEpoch !== null && wire.nameIv && wire.nameCt) {
    // Nothing to do when the row is what we already opened. Names are opened
    // on every pull, and every pull is a few seconds apart.
    if (previous && previous.nameEpoch === wire.nameEpoch && previous.name !== '') return previous;
    const key = await keyFor(wire.nameEpoch);
    if (key) {
      try {
        return { name: await openGroupName(wire.id, wire.nameEpoch, key, { iv: wire.nameIv, ct: wire.nameCt }), nameEpoch: wire.nameEpoch };
      } catch {
        /* a blob that does not open under the key it claims: keep what we had */
      }
    }
  } else if (typeof wire.name === 'string' && wire.name !== '') {
    // Not yet sealed by anybody. Held at "no epoch" so that the backfill sees
    // it as work to do rather than as something already under a key.
    return { name: wire.name, nameEpoch: null };
  }
  if (previous && previous.name !== '') return previous;
  return { name: '', nameEpoch: null };
}

/**
 * Whether this device should seal the name under the group's newest epoch now.
 *
 * Yes when the name it holds is real, it is not already under the newest
 * epoch, and this device can write under that epoch — meaning it holds it
 * *trusted*, the same bar every entry has to clear. A name under an older
 * epoch is not wrong, it is merely unreadable to whoever holds only the newer
 * one, and that is what this repairs.
 *
 * Pure, so it can be tested exhaustively.
 */
export function shouldBackfillName(
  held: Pick<GroupDto, 'name' | 'nameEpoch'>,
  sealedEpoch: number | null,
  latestEpoch: number | null,
  writableEpoch: number | null,
): boolean {
  if (held.name === '') return false; // a placeholder: nothing to seal
  if (latestEpoch === null || writableEpoch !== latestEpoch) return false;
  return sealedEpoch === null || sealedEpoch < latestEpoch;
}

/** The name sealed for the mint of `epoch`, or nothing when the mirror holds only a placeholder. */
export async function nameForMint(
  groupId: string,
  epoch: number,
  key: Uint8Array,
  held: Pick<GroupDto, 'name' | 'nameEpoch'> | undefined,
): Promise<{ iv: string; ct: string } | undefined> {
  if (!held || held.name === '') return undefined;
  return sealGroupName(groupId, epoch, key, held.name);
}

/**
 * A `group.create` queued by the app before names were sealed carries the
 * name readable. The server refuses that shape now, so it is sealed on the
 * way out — under epoch 0, which the creator minted and adopted before the
 * mutation was queued, and which no rotation can have moved past: the group
 * does not exist anywhere else yet. Null when there is nothing to convert, or
 * no key to do it with; the mutation then waits, exactly as an entry does.
 */
export async function sealLegacyGroupCreate(mutation: Mutation, keyFor: KeyLookup): Promise<Mutation | null> {
  if (mutation.type !== 'group.create') return null;
  const data = mutation.data as { id: string; name: unknown };
  if (typeof data.name !== 'string') return null;
  const key = await keyFor(0);
  if (!key) return null;
  const name = await sealGroupName(data.id, 0, key, data.name);
  return { ...mutation, data: { ...mutation.data, name } };
}
