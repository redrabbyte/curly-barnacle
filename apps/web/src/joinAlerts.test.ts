import { describe, expect, it } from 'vitest';
import type { GroupDto, MemberDto } from '@spendapp/shared';
import { adminGroups, foldCounts, openInvites, totalWaiting } from './joinAlerts';

const group = (id: string, name = id): GroupDto =>
  ({ id, name, defaultCurrency: 'EUR', version: 1, nameEpoch: 0 });

const member = (over: Partial<MemberDto> = {}): MemberDto =>
  ({
    groupId: 'g1',
    userId: 'me',
    displayName: 'Me',
    leftAt: null,
    isPlaceholder: false,
    role: 'admin',
    version: 1,
    ...over,
  }) as MemberDto;

describe('which groups the bell asks about', () => {
  it('is the ones this account administers', () => {
    const groups = [group('g1'), group('g2'), group('g3')];
    const mine = [member(), member({ role: 'member' }), member()];
    expect(adminGroups(groups, mine).map((g) => g.id)).toEqual(['g1', 'g3']);
  });

  it('leaves out a group with no membership row for us', () => {
    // The mirror can hold a group whose members have not arrived yet. Asking
    // would only earn a 403.
    expect(adminGroups([group('g1')], [undefined])).toEqual([]);
  });

  it('leaves out a group we have left, whatever the row still says', () => {
    expect(adminGroups([group('g1')], [member({ leftAt: '2026-01-01T00:00:00.000Z' })])).toEqual([]);
  });
});

describe('folding a round of counts', () => {
  it('takes what arrived', () => {
    expect(foldCounts({ g1: 1 }, { g1: 3 })).toEqual({ g1: 3 });
  });

  it('keeps the last known count for a group that did not answer', () => {
    // One poll spent offline must not make a waiting person vanish from the
    // top bar; the next round corrects it either way.
    expect(foldCounts({ g1: 2 }, { g1: null })).toEqual({ g1: 2 });
  });

  it('has nothing to keep when the first attempt is the one that failed', () => {
    expect(foldCounts({}, { g1: null })).toEqual({});
  });

  it('drops a group that is no longer asked about at all', () => {
    // Left it, or lost admin: it is absent from the round, not null in it.
    expect(foldCounts({ g1: 4, g2: 1 }, { g2: 1 })).toEqual({ g2: 1 });
  });

  it('lets a queue reach zero', () => {
    expect(foldCounts({ g1: 1 }, { g1: 0 })).toEqual({ g1: 0 });
  });
});

describe('what the bell shows', () => {
  const groups = [group('g1', 'Trip'), group('g2', 'Flat'), group('g3', 'Ski')];

  it('is nothing at all when nobody is waiting', () => {
    expect(openInvites(groups, { g1: 0, g2: 0 })).toEqual([]);
    expect(totalWaiting([])).toBe(0);
  });

  it('names only the groups with somebody waiting, in the mirror’s order', () => {
    expect(openInvites(groups, { g1: 1, g3: 2 })).toEqual([
      { groupId: 'g1', name: 'Trip', count: 1 },
      { groupId: 'g3', name: 'Ski', count: 2 },
    ]);
  });

  it('adds up across groups, which is what the badge reads', () => {
    expect(totalWaiting(openInvites(groups, { g1: 1, g2: 3, g3: 2 }))).toBe(6);
  });

  it('carries an unreadable name through as empty rather than dropping the row', () => {
    // A group whose key has not arrived still has people waiting at the door;
    // the list says so and names it the way the groups page does.
    expect(openInvites([group('g1', '')], { g1: 1 })).toEqual([{ groupId: 'g1', name: '', count: 1 }]);
  });
});
