import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { db, schema } from '../db/index.js';

/**
 * Saying, from inside a group, that one of its names is you (design §5).
 *
 * Taking over a name used to be decidable in exactly one moment — the seconds
 * after following an invite link, from a list of names belonging to a group
 * nobody could see yet. Getting it wrong left no way back: joining as somebody
 * new stranded the name for good, and picking a stranger's needed an admin to
 * unclaim it. So the same question is asked from inside, where the ledger is
 * on screen, and answered by the same admin in the same queue.
 *
 * Skipped unless DATABASE_URL points somewhere — CI has no server.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

const ADMIN = '88888888-1111-4888-8888-111111111111';
const MEMBER = '88888888-1111-4888-8888-222222222222';
const ROBIN = '88888888-1111-4888-8888-333333333333';
const SAM = '88888888-1111-4888-8888-444444444444';
const OUTSIDER = '88888888-1111-4888-8888-555555555555';
const GROUP = '88888888-1111-4888-8888-999999999999';

const app = RUN ? await buildApp() : null;

async function asUser(userId: string): Promise<Record<string, string>> {
  const raw = randomBytes(32).toString('hex');
  await db.insert(schema.sessions).values({
    idHash: createHash('sha256').update(raw).digest('hex'),
    userId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return { cookie: `sid=${raw}`, 'x-requested-with': 'spendapp' };
}

async function reset() {
  await db.delete(schema.joinRequests);
  await db.delete(schema.sessions);
  await db.delete(schema.activity);
  await db.delete(schema.groupMembers);
  await db.delete(schema.groups);
  await db.delete(schema.users);
  for (const [id, name, placeholder] of [
    [ADMIN, 'Ada', false],
    [MEMBER, 'Grace', false],
    [OUTSIDER, 'Alan', false],
    [ROBIN, 'Robin', true],
    [SAM, 'Sam', true],
  ] as const) {
    await db.insert(schema.users).values({
      id,
      username: placeholder ? null : name.toLowerCase(),
      displayName: name,
      publicKey: placeholder ? null : 'cHVibGlj',
      isPlaceholder: placeholder,
      placeholderGroupId: placeholder ? GROUP : null,
      createdAt: new Date(),
    });
  }
  await db.insert(schema.groups).values({
    id: GROUP,
    nameEpoch: 0,
    nameIv: 'aXY',
    nameCt: 'Y3Q',
    defaultCurrency: 'EUR',
    createdBy: ADMIN,
    createdAt: new Date(),
    lastVersion: 1,
  });
  await db.insert(schema.groupMembers).values([
    { groupId: GROUP, userId: ADMIN, role: 'admin', joinedAt: new Date(), version: 1 },
    { groupId: GROUP, userId: MEMBER, role: 'member', joinedAt: new Date(), version: 1 },
    { groupId: GROUP, userId: ROBIN, role: 'member', joinedAt: new Date(), version: 1 },
    { groupId: GROUP, userId: SAM, role: 'member', joinedAt: new Date(), version: 1 },
  ]);
}

const rowFor = async (userId: string) =>
  (
    await db
      .select()
      .from(schema.groupMembers)
      .where(and(eq(schema.groupMembers.groupId, GROUP), eq(schema.groupMembers.userId, userId)))
  )[0]!;

const claimRow = async (userId: string) =>
  (
    await db
      .select()
      .from(schema.joinRequests)
      .where(
        and(
          eq(schema.joinRequests.groupId, GROUP),
          eq(schema.joinRequests.userId, userId),
          eq(schema.joinRequests.kind, 'claim'),
        ),
      )
  )[0];

d('asking to take over a name from inside the group', () => {
  beforeEach(reset);

  const ask = async (actor: string, claimMemberId: string) =>
    app!.inject({
      method: 'POST',
      url: `/api/groups/${GROUP}/claim-requests`,
      headers: await asUser(actor),
      payload: { claimMemberId },
    });

  const decide = async (actor: string, userId: string, decision: 'approve' | 'reject', expect_?: string | null) =>
    app!.inject({
      method: 'POST',
      url: `/api/groups/${GROUP}/join-requests/${userId}`,
      headers: await asUser(actor),
      payload: { decision, kind: 'claim', ...(expect_ === undefined ? {} : { expectClaimMemberId: expect_ }) },
    });

  it('moves the name only once an admin says so', async () => {
    expect((await ask(MEMBER, ROBIN)).statusCode).toBe(200);
    // Nothing has happened to the ledger yet — that is what makes the ask
    // safe to get wrong.
    expect((await rowFor(ROBIN)).aliasOf).toBeNull();

    expect((await decide(ADMIN, MEMBER, 'approve')).statusCode).toBe(200);
    expect((await rowFor(ROBIN)).aliasOf).toBe(MEMBER);
    expect((await rowFor(ROBIN)).leftAt).not.toBeNull();
  });

  it('leaves the claimer’s own membership exactly as it was', async () => {
    // The bug this guards: the claim path resets the role and the recorded
    // epochs, which is right for somebody being let back in and wrong for
    // somebody already here — an admin would demote themselves by correcting
    // a name.
    await db
      .update(schema.groupMembers)
      .set({ role: 'admin', heldEpochs: [0, 1] })
      .where(and(eq(schema.groupMembers.groupId, GROUP), eq(schema.groupMembers.userId, MEMBER)));

    await ask(MEMBER, ROBIN);
    await decide(ADMIN, MEMBER, 'approve');

    const row = await rowFor(MEMBER);
    expect(row.role).toBe('admin');
    expect(row.heldEpochs).toEqual([0, 1]);
    expect(row.leftAt).toBeNull();
  });

  it('says so in the feed, because balances moved with the name', async () => {
    await ask(MEMBER, ROBIN);
    await decide(ADMIN, MEMBER, 'approve');
    const rows = await db.select().from(schema.activity).where(eq(schema.activity.groupId, GROUP));
    const claimed = rows.find((r) => r.type === 'member.claimed');
    expect(claimed).toBeDefined();
    expect(claimed!.entityId).toBe(ROBIN);
    expect(claimed!.actorId).toBe(MEMBER);
  });

  it('overwrites an undecided ask rather than piling up a second one', async () => {
    await ask(MEMBER, ROBIN);
    expect((await ask(MEMBER, SAM)).statusCode).toBe(200);
    expect((await claimRow(MEMBER))!.claimMemberId).toBe(SAM);
    const all = await db.select().from(schema.joinRequests).where(eq(schema.joinRequests.groupId, GROUP));
    expect(all).toHaveLength(1);
  });

  it('can be taken back while nobody has answered', async () => {
    await ask(MEMBER, ROBIN);
    const res = await app!.inject({
      method: 'DELETE',
      url: `/api/groups/${GROUP}/claim-requests`,
      headers: await asUser(MEMBER),
    });
    expect(res.statusCode).toBe(200);
    expect(await claimRow(MEMBER)).toBeUndefined();
  });

  it('refuses a name somebody has already taken over', async () => {
    await ask(MEMBER, ROBIN);
    await decide(ADMIN, MEMBER, 'approve');
    const res = await ask(ADMIN, ROBIN);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'not_claimable' });
  });

  it('refuses an active account, which is not recovery but somebody else', async () => {
    const res = await ask(MEMBER, ADMIN);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'not_claimable' });
  });

  it('refuses somebody who is not in the group', async () => {
    const res = await ask(OUTSIDER, ROBIN);
    expect(res.statusCode).toBe(404);
    expect(await claimRow(OUTSIDER)).toBeUndefined();
  });

  it('is an admin decision, like every other membership change', async () => {
    await ask(MEMBER, ROBIN);
    expect((await decide(MEMBER, MEMBER, 'approve')).statusCode).toBe(404);
    expect((await rowFor(ROBIN)).aliasOf).toBeNull();
  });

  it('refuses an approval of a name that changed underneath the admin', async () => {
    // The queue said Robin; by the time the button was pressed the ask was
    // about Sam. The admin agreed to a specific stretch of the ledger moving,
    // having read on their own device which entries those were.
    await ask(MEMBER, ROBIN);
    await ask(MEMBER, SAM);
    const res = await decide(ADMIN, MEMBER, 'approve', ROBIN);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'claim_changed' });
    expect((await rowFor(SAM)).aliasOf).toBeNull();
  });

  it('keeps a decline reversible, and the name free until it is not', async () => {
    await ask(MEMBER, ROBIN);
    expect((await decide(ADMIN, MEMBER, 'reject')).statusCode).toBe(200);
    expect((await claimRow(MEMBER))!.status).toBe('rejected');
    expect((await rowFor(ROBIN)).aliasOf).toBeNull();

    expect((await decide(ADMIN, MEMBER, 'approve')).statusCode).toBe(200);
    expect((await rowFor(ROBIN)).aliasOf).toBe(MEMBER);
  });

  it('does not disturb the join request that let them in', async () => {
    // Two rows about one person, and the older one is how they got here.
    // Overwriting it would erase that.
    await db.insert(schema.joinRequests).values({
      groupId: GROUP,
      userId: MEMBER,
      kind: 'join',
      inviteTokenHash: 'a'.repeat(64),
      status: 'approved',
      requestedAt: new Date('2026-01-01T00:00:00.000Z'),
      decidedBy: ADMIN,
      decidedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await ask(MEMBER, ROBIN);
    const rows = await db
      .select()
      .from(schema.joinRequests)
      .where(and(eq(schema.joinRequests.groupId, GROUP), eq(schema.joinRequests.userId, MEMBER)));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.kind === 'join')!.status).toBe('approved');
    expect(rows.find((r) => r.kind === 'claim')!.status).toBe('pending');
  });

  it('shows a member their own ask, and nobody else’s', async () => {
    await ask(MEMBER, ROBIN);
    const mine = await app!.inject({
      method: 'GET',
      url: `/api/groups/${GROUP}/join-requests`,
      headers: await asUser(MEMBER),
    });
    expect(mine.statusCode).toBe(200);
    const body = mine.json() as { requests: unknown[]; mine: { claimMemberId: string; status: string } | null };
    // The queue itself is an admin's; the one row that is theirs comes back
    // whoever they are, because they have to be able to see it is waiting.
    expect(body.requests).toEqual([]);
    expect(body.mine).toEqual({ claimMemberId: ROBIN, status: 'pending' });

    const admin = await app!.inject({
      method: 'GET',
      url: `/api/groups/${GROUP}/join-requests`,
      headers: await asUser(ADMIN),
    });
    const seen = admin.json() as { requests: { userId: string; kind: string; inviteTokenHash: string | null }[] };
    expect(seen.requests).toHaveLength(1);
    expect(seen.requests[0]).toMatchObject({ userId: MEMBER, kind: 'claim', inviteTokenHash: null });
  });
});
