import { describe, expect, it, vi } from 'vitest';
import { generateGroupKey, type GroupWire, type Mutation } from '@spendapp/shared';
import {
  openGroupName,
  resolveGroupName,
  sealGroupName,
  sealLegacyGroupCreate,
  shouldBackfillName,
} from './groupName';
import type { KeyLookup } from './reseal';

/**
 * The group name, sealed (design §4.2).
 *
 * What matters here is the same thing that matters for an entry — that the
 * blob is bound to its row — plus the two rules that are this name's own: the
 * mirror never loses a name it had, and a device seals the name under the
 * newest epoch only when it can write under it.
 */

const GROUP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const KEYS = new Map<number, Uint8Array>([
  [0, generateGroupKey()],
  [1, generateGroupKey()],
]);
const keyFor: KeyLookup = async (e) => KEYS.get(e) ?? null;
const noKeys: KeyLookup = async () => null;

const wire = (over: Partial<GroupWire> = {}): GroupWire => ({
  id: GROUP,
  defaultCurrency: 'EUR',
  version: 3,
  nameEpoch: null,
  nameIv: null,
  nameCt: null,
  ...over,
});

async function sealedWire(name: string, epoch: number, key = KEYS.get(epoch)!): Promise<GroupWire> {
  const sealed = await sealGroupName(GROUP, epoch, key, name);
  return wire({ nameEpoch: epoch, nameIv: sealed.iv, nameCt: sealed.ct });
}

describe('sealing the name', () => {
  it('round-trips', async () => {
    const sealed = await sealGroupName(GROUP, 1, KEYS.get(1)!, 'Flat with Sam');
    expect(await openGroupName(GROUP, 1, KEYS.get(1)!, sealed)).toBe('Flat with Sam');
  });

  it('is bound to the group: right key, other group, no name', async () => {
    const sealed = await sealGroupName(GROUP, 1, KEYS.get(1)!, 'Flat with Sam');
    await expect(openGroupName(OTHER, 1, KEYS.get(1)!, sealed)).rejects.toThrow();
  });

  it('is bound to the epoch: the same key relabelled onto another epoch does not open', async () => {
    const sealed = await sealGroupName(GROUP, 1, KEYS.get(1)!, 'Flat with Sam');
    await expect(openGroupName(GROUP, 0, KEYS.get(1)!, sealed)).rejects.toThrow();
  });

  it('hides the length: a one-word name and a long one seal to the same size', async () => {
    const short = await sealGroupName(GROUP, 0, KEYS.get(0)!, 'Trip');
    const long = await sealGroupName(GROUP, 0, KEYS.get(0)!, 'A much longer name for the same group, with detail');
    expect(short.ct.length).toBe(long.ct.length);
  });

  it('fits the column at the longest name the form allows, in the widest characters', async () => {
    const sealed = await sealGroupName(GROUP, 0, KEYS.get(0)!, '🍝'.repeat(120));
    expect(sealed.ct.length).toBeLessThanOrEqual(768);
  });
});

describe('resolving the name into the mirror', () => {
  it('opens a sealed name with the key it names', async () => {
    const row = await resolveGroupName(await sealedWire('Trip', 1), undefined, keyFor);
    expect(row).toEqual({ name: 'Trip', nameEpoch: 1 });
  });

  it('keeps the name it had when the key has not arrived', async () => {
    const row = await resolveGroupName(await sealedWire('Trip', 1), { name: 'Trip', nameEpoch: 0 }, noKeys);
    expect(row).toEqual({ name: 'Trip', nameEpoch: 0 });
  });

  it('shows a placeholder when there is neither a key nor a name from before', async () => {
    const row = await resolveGroupName(await sealedWire('Trip', 1), undefined, noKeys);
    expect(row).toEqual({ name: '', nameEpoch: null });
  });

  it('never swaps in something that does not open under the key it claims', async () => {
    // Sealed under a key that is not epoch 1's, labelled as if it were.
    const forged = await sealedWire('Wrong', 1, generateGroupKey());
    const row = await resolveGroupName(forged, { name: 'Trip', nameEpoch: 0 }, keyFor);
    expect(row).toEqual({ name: 'Trip', nameEpoch: 0 });
  });

  it('takes a readable name from before names were sealed, at no epoch', async () => {
    const row = await resolveGroupName(wire({ name: 'Old flat' }), undefined, keyFor);
    expect(row).toEqual({ name: 'Old flat', nameEpoch: null });
  });

  it('does not open the same blob again on every pull', async () => {
    const spy = vi.fn(keyFor);
    const row = await resolveGroupName(await sealedWire('Trip', 1), { name: 'Trip', nameEpoch: 1 }, spy);
    expect(row).toEqual({ name: 'Trip', nameEpoch: 1 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('replaces a placeholder the moment the key arrives', async () => {
    const row = await resolveGroupName(await sealedWire('Trip', 1), { name: '', nameEpoch: null }, keyFor);
    expect(row).toEqual({ name: 'Trip', nameEpoch: 1 });
  });
});

describe('deciding to seal the name under the newest epoch', () => {
  const held = { name: 'Trip', nameEpoch: 0 };

  it('seals a name nobody has sealed yet, when this device writes under the newest epoch', () => {
    expect(shouldBackfillName({ name: 'Trip', nameEpoch: null }, null, 0, 0)).toBe(true);
  });

  it('brings a name forward when it lags the newest epoch', () => {
    expect(shouldBackfillName(held, 0, 2, 2)).toBe(true);
  });

  it('leaves a name already under the newest epoch alone', () => {
    expect(shouldBackfillName(held, 2, 2, 2)).toBe(false);
  });

  it('does nothing while this device cannot write under the newest epoch', () => {
    // Holds epoch 1 trusted; the group is at 2. Somebody else's job.
    expect(shouldBackfillName(held, 0, 2, 1)).toBe(false);
    expect(shouldBackfillName(held, 0, 2, null)).toBe(false);
  });

  it('never seals a placeholder', () => {
    expect(shouldBackfillName({ name: '', nameEpoch: null }, null, 0, 0)).toBe(false);
  });

  it('has nothing to do for a group with no key at all', () => {
    expect(shouldBackfillName(held, null, null, null)).toBe(false);
  });
});

describe('a group.create queued before names were sealed', () => {
  const queued = (name: unknown): Mutation =>
    ({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      v: 1,
      type: 'group.create',
      groupId: GROUP,
      clientTs: '2026-08-12T10:00:00.000Z',
      data: { id: GROUP, name, defaultCurrency: 'EUR', wrappedKey: { epk: 'e', iv: 'i', ct: 'c' } },
    }) as unknown as Mutation;

  it('is sealed under epoch 0 on the way out, and says the same thing', async () => {
    const next = await sealLegacyGroupCreate(queued('Airport lounge'), keyFor);
    expect(next).not.toBeNull();
    const data = next!.data as { name: { iv: string; ct: string }; defaultCurrency: string };
    expect(data.defaultCurrency).toBe('EUR');
    expect(await openGroupName(GROUP, 0, KEYS.get(0)!, data.name)).toBe('Airport lounge');
  });

  it('is left alone once it is already sealed', async () => {
    expect(await sealLegacyGroupCreate(queued({ iv: 'aXY', ct: 'Y3Q' }), keyFor)).toBeNull();
  });

  it('waits when the key is not on the device', async () => {
    expect(await sealLegacyGroupCreate(queued('Airport lounge'), noKeys)).toBeNull();
  });

  it('touches nothing that is not a group.create', async () => {
    const other = { ...queued('x'), type: 'member.add' } as unknown as Mutation;
    expect(await sealLegacyGroupCreate(other, keyFor)).toBeNull();
  });
});
