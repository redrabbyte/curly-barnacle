import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SYNC_PROTOCOL, type GroupChanges } from '@spendapp/shared';
import { buildApp } from '../app.js';
import { db, schema } from '../db/index.js';

/**
 * The sealed group name, at the server (design §4.2).
 *
 * The server cannot open a name. What it can hold, and what these pin, is the
 * one line that keeps the name readable to every member: it is always under
 * the newest epoch, written by somebody who holds that epoch, and the readable
 * copy goes the moment a sealed one exists.
 *
 * Skipped unless DATABASE_URL points somewhere — CI has no server.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

const ADA = '11111111-1111-4111-8111-111111111111';
const GRACE = '22222222-2222-4222-8222-222222222222';
const OUTSIDER = '44444444-4444-4444-8444-444444444444';
const GROUP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ARGON = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const app = RUN ? await buildApp() : null;
const b64 = (n: number) => randomBytes(n).toString('base64url');
const AUTH_KEY = b64(32);

async function session(userId: string): Promise<string> {
  const raw = randomBytes(32).toString('hex');
  await db.insert(schema.sessions).values({
    idHash: sha256(raw),
    userId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return raw;
}

const hdrs = (raw: string) => ({ cookie: `sid=${raw}`, 'x-requested-with': 'spendapp' });
const wrap = (userId: string, epoch: number) => ({ userId, epoch, epk: b64(32), iv: b64(12), ct: b64(48) });
const sealed = () => ({ iv: b64(12), ct: b64(48) });

async function reset() {
  await db.delete(schema.processedMutations);
  await db.delete(schema.activity);
  await db.delete(schema.groupKeys);
  await db.delete(schema.sessions);
  await db.delete(schema.groupMembers);
  await db.delete(schema.groups);
  await db.delete(schema.users);
  const passwordHash = await argon2.hash(AUTH_KEY, ARGON);
  for (const [id, name] of [
    [ADA, 'Ada'],
    [GRACE, 'Grace'],
    [OUTSIDER, 'Alan'],
  ] as const) {
    await db.insert(schema.users).values({
      id,
      username: name.toLowerCase(),
      passwordHash,
      kdfSalt: b64(16),
      kdfParams: { memoryKiB: 19456, iterations: 2, parallelism: 1 },
      publicKey: b64(32),
      wrappedPrivateKey: '{"iv":"aXY","ct":"Y3Q"}',
      displayName: name,
      createdAt: new Date(),
      privacyAcceptedAt: new Date(),
      privacyVersion: '1',
    });
  }
  // A group from before names were sealed: readable, nothing sealed yet.
  await db
    .insert(schema.groups)
    .values({ id: GROUP, name: 'Paris trip', defaultCurrency: 'EUR', createdBy: ADA, createdAt: new Date(), lastVersion: 1 });
  await db.insert(schema.groupMembers).values([
    { groupId: GROUP, userId: ADA, role: 'admin', joinedAt: new Date() },
    { groupId: GROUP, userId: GRACE, role: 'member', joinedAt: new Date() },
  ]);
}

const groupRow = async () => (await db.select().from(schema.groups).where(eq(schema.groups.id, GROUP)))[0]!;

async function mint(as: string, epoch: number, users: string[], name?: { iv: string; ct: string }) {
  const res = await app!.inject({
    method: 'POST',
    url: `/api/groups/${GROUP}/keys`,
    headers: hdrs(await session(as)),
    payload: { mint: true, wraps: users.map((u) => wrap(u, epoch)), ...(name ? { name } : {}) },
  });
  return res;
}

async function setName(as: string, epoch: number, name = sealed()) {
  return app!.inject({
    method: 'POST',
    url: `/api/groups/${GROUP}/name`,
    headers: hdrs(await session(as)),
    payload: { epoch, ...name },
  });
}

async function pull(as: string): Promise<GroupChanges> {
  const res = await app!.inject({
    method: 'POST',
    url: '/api/sync',
    headers: hdrs(await session(as)),
    payload: { protocolVersion: SYNC_PROTOCOL.current, cursors: {}, mutations: [] },
  });
  return (res.json() as { changes: Record<string, GroupChanges> }).changes[GROUP]!;
}

afterAll(async () => {
  await app?.close();
});

d('minting with the name', () => {
  beforeEach(reset);

  it('stores the name with the epoch it was sealed under, and drops the readable copy', async () => {
    const name = sealed();
    const res = await mint(ADA, 0, [ADA, GRACE], name);
    expect(res.json()).toMatchObject({ minted: true, named: true });
    const g = await groupRow();
    expect(g.name).toBeNull();
    expect(g.nameEpoch).toBe(0);
    expect(g.nameCt).toBe(name.ct);
  });

  it('goes ahead without a name, leaving it for whoever can seal it', async () => {
    // A rotation that ends somebody's access must not wait on a device that
    // could not open the name itself.
    const res = await mint(ADA, 0, [ADA, GRACE]);
    expect(res.json()).toMatchObject({ minted: true, named: false });
    const g = await groupRow();
    expect(g.name).toBe('Paris trip');
    expect(g.nameEpoch).toBeNull();
  });

  it('brings the name forward on every rotation', async () => {
    await mint(ADA, 0, [ADA, GRACE], sealed());
    const later = sealed();
    await mint(ADA, 1, [ADA], later);
    const g = await groupRow();
    expect(g.nameEpoch).toBe(1);
    expect(g.nameCt).toBe(later.ct);
  });

  it('refuses a mint that goes backwards, so the name can never be under an epoch nobody new holds', async () => {
    await mint(ADA, 2, [ADA, GRACE], sealed());
    const res = await mint(ADA, 1, [ADA], sealed());
    expect(res.json()).toMatchObject({ minted: false, named: false });
    const rows = await db.select().from(schema.groupKeys).where(eq(schema.groupKeys.epoch, 1));
    expect(rows).toHaveLength(0);
    expect((await groupRow()).nameEpoch).toBe(2);
  });

  it('is one epoch at a time', async () => {
    const res = await app!.inject({
      method: 'POST',
      url: `/api/groups/${GROUP}/keys`,
      headers: hdrs(await session(ADA)),
      payload: { mint: true, wraps: [wrap(ADA, 0), wrap(ADA, 1)], name: sealed() },
    });
    expect(res.statusCode).toBe(400);
  });
});

d('sealing the name after the fact', () => {
  beforeEach(reset);

  it('accepts the name under the newest epoch from a member who holds it', async () => {
    await mint(ADA, 0, [ADA, GRACE]);
    const name = sealed();
    const res = await setName(GRACE, 0, name);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stored: true });
    const g = await groupRow();
    expect(g.name).toBeNull();
    expect(g.nameCt).toBe(name.ct);
  });

  it('lets the first writer win, quietly', async () => {
    await mint(ADA, 0, [ADA, GRACE]);
    const first = sealed();
    await setName(GRACE, 0, first);
    const second = await setName(ADA, 0, sealed());
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ stored: false });
    expect((await groupRow()).nameCt).toBe(first.ct);
  });

  it('refuses any epoch but the newest', async () => {
    await mint(ADA, 0, [ADA, GRACE]);
    await mint(ADA, 1, [ADA, GRACE]);
    const stale = await setName(GRACE, 0);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'not_newest_epoch' });
    // And an epoch that does not exist yet is not the newest either.
    expect((await setName(GRACE, 2)).statusCode).toBe(409);
    expect((await groupRow()).name).toBe('Paris trip');
  });

  it('refuses a member who was not given the newest epoch', async () => {
    await mint(ADA, 0, [ADA, GRACE]);
    await mint(ADA, 1, [ADA]); // Grace was left off this one
    const res = await setName(GRACE, 1);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'epoch_not_held' });
  });

  it('is not a way in for somebody outside the group', async () => {
    await mint(ADA, 0, [ADA, GRACE]);
    expect((await setName(OUTSIDER, 0)).statusCode).toBe(404);
  });

  it('brings a lagging name forward', async () => {
    await mint(ADA, 0, [ADA, GRACE], sealed());
    await mint(ADA, 1, [ADA, GRACE]); // minted without the name
    const forward = sealed();
    expect((await setName(GRACE, 1, forward)).json()).toEqual({ stored: true });
    const g = await groupRow();
    expect(g.nameEpoch).toBe(1);
    expect(g.nameCt).toBe(forward.ct);
  });
});

d('what the pull says about the name', () => {
  beforeEach(reset);

  it('sends the readable name only while nobody has sealed it, and always the newest epoch', async () => {
    let ch = await pull(ADA);
    expect(ch.group).toMatchObject({ name: 'Paris trip', nameEpoch: null, nameIv: null, nameCt: null });
    expect(ch.latestEpoch).toBeNull();

    await mint(ADA, 0, [ADA, GRACE]);
    ch = await pull(ADA);
    expect(ch.group.name).toBe('Paris trip');
    expect(ch.latestEpoch).toBe(0);

    const name = sealed();
    await setName(ADA, 0, name);
    ch = await pull(GRACE);
    expect(ch.group).toMatchObject({ name: null, nameEpoch: 0, nameIv: name.iv, nameCt: name.ct });
    expect(JSON.stringify(ch)).not.toContain('Paris trip');
  });
});

d('creating a group', () => {
  beforeEach(reset);

  it('stores the name sealed under epoch 0 and keeps it out of the activity log', async () => {
    const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const name = sealed();
    const res = await app!.inject({
      method: 'POST',
      url: '/api/sync',
      headers: hdrs(await session(ADA)),
      payload: {
        protocolVersion: SYNC_PROTOCOL.current,
        cursors: {},
        mutations: [
          {
            id: '99999999-9999-4999-8999-999999999999',
            v: 1,
            clientTs: new Date().toISOString(),
            type: 'group.create',
            groupId: id,
            data: { id, name, defaultCurrency: 'EUR', wrappedKey: { epk: b64(32), iv: b64(12), ct: b64(48) } },
          },
        ],
      },
    });
    expect((res.json() as { results: { status: string }[] }).results[0]).toMatchObject({ status: 'applied' });

    const [g] = await db.select().from(schema.groups).where(eq(schema.groups.id, id));
    expect(g).toMatchObject({ name: null, nameEpoch: 0, nameIv: name.iv, nameCt: name.ct });

    const [created] = await db.select().from(schema.activity).where(eq(schema.activity.entityId, id));
    expect(created!.type).toBe('group.created');
    expect(created!.payload).toEqual({ defaultCurrency: 'EUR' });
  });

  it('refuses a readable name outright', async () => {
    const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccd';
    const res = await app!.inject({
      method: 'POST',
      url: '/api/sync',
      headers: hdrs(await session(ADA)),
      payload: {
        protocolVersion: SYNC_PROTOCOL.current,
        cursors: {},
        mutations: [
          {
            id: '99999999-9999-4999-8999-999999999998',
            v: 1,
            clientTs: new Date().toISOString(),
            type: 'group.create',
            groupId: id,
            data: { id, name: 'Trip', defaultCurrency: 'EUR', wrappedKey: { epk: b64(32), iv: b64(12), ct: b64(48) } },
          },
        ],
      },
    });
    // The whole batch fails validation: nothing readable gets a foot in.
    expect(res.statusCode).toBe(400);
    expect(await db.select().from(schema.groups).where(eq(schema.groups.id, id))).toHaveLength(0);
  });
});
