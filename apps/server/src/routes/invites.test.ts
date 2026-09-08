import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { db, schema } from '../db/index.js';

/**
 * The invite flow against a real MySQL, because the parts worth pinning are
 * the parts a stub cannot have: that the stored row holds no usable token,
 * that a link handed out before the tokens were hashed still resolves, and
 * that two people racing a single-use link cannot both get in.
 *
 * Skipped unless DATABASE_URL points somewhere — CI has no server.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

const ADMIN = '11111111-1111-4111-8111-111111111111';
const JOINER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const GROUP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const app = RUN ? await buildApp() : null;

async function asUser(userId: string) {
  // A session row is the cheapest honest way in: the cookie is a random token
  // the server only ever sees as a hash.
  const raw = Buffer.from(userId.replaceAll('-', '').padEnd(64, '0')).toString('hex').slice(0, 64);
  await db
    .insert(schema.sessions)
    .values({
      idHash: sha256(raw),
      userId,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    .onDuplicateKeyUpdate({ set: { expiresAt: new Date(Date.now() + 86_400_000) } });
  return { cookie: `sid=${raw}`, 'x-requested-with': 'spendapp' };
}

async function reset() {
  await db.delete(schema.joinRequests);
  await db.delete(schema.invites);
  await db.delete(schema.sessions);
  await db.delete(schema.groupMembers);
  await db.delete(schema.groups);
  await db.delete(schema.users);
  for (const [id, name] of [
    [ADMIN, 'Ada'],
    [JOINER, 'Grace'],
    [OTHER, 'Alan'],
  ] as const) {
    await db.insert(schema.users).values({
      id,
      username: name.toLowerCase(),
      passwordHash: '$argon2id$fake',
      kdfSalt: 'c2FsdA',
      kdfParams: { memoryKiB: 19456, iterations: 2, parallelism: 1 },
      publicKey: 'cHVibGlj',
      wrappedPrivateKey: '{"iv":"aXY","ct":"Y3Q"}',
      displayName: name,
      createdAt: new Date(),
      privacyAcceptedAt: new Date(),
      privacyVersion: '1',
    });
  }
  await db
    .insert(schema.groups)
    .values({ id: GROUP, nameEpoch: 0, nameIv: 'aXY', nameCt: 'Y3Q', defaultCurrency: 'EUR', createdBy: ADMIN, createdAt: new Date(), lastVersion: 1 });
  await db.insert(schema.groupMembers).values({ groupId: GROUP, userId: ADMIN, role: 'admin', joinedAt: new Date() });
}

d('invites', () => {
  beforeEach(reset);
  afterAll(async () => {
    await app?.close();
  });

  async function createInvite(): Promise<string> {
    const res = await app!.inject({
      method: 'POST',
      url: `/api/groups/${GROUP}/invites`,
      headers: await asUser(ADMIN),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; path: string };
    // The whole point of M1: what gets handed out puts the capability in the
    // fragment, which never reaches a server and so never reaches a log.
    expect(body.path).toBe(`/invite#${body.token}`);
    return body.token;
  }

  /**
   * Both of these take the token in a body. A path parameter is logged — by
   * this app, which keeps `req.url` on purpose, and by whatever proxy is in
   * front of it — and this one is not an identifier but a live capability.
   */
  // Unauthenticated, like the landing page it serves — but still a non-GET,
  // so it carries the CSRF header every other write does.
  const lookup = (token: string) =>
    app!.inject({
      method: 'POST',
      url: '/api/invites/lookup',
      headers: { 'x-requested-with': 'spendapp' },
      payload: { token },
    });
  const join = (token: string, headers: Record<string, string>, claim?: string | null) =>
    app!.inject({
      method: 'POST',
      url: '/api/invites/join',
      headers,
      // Absent unless a caller says something about a name — which is the
      // difference the update path turns on.
      payload: claim === undefined ? { token } : { token, claimMemberId: claim },
    });

  /** A name in the group with no account behind it, for a claim to point at. */
  async function placeholder(id: string, name: string): Promise<string> {
    await db
      .insert(schema.users)
      .values({ id, displayName: name, isPlaceholder: true, placeholderGroupId: GROUP, createdAt: new Date() });
    await db.insert(schema.groupMembers).values({ groupId: GROUP, userId: id, joinedAt: new Date() });
    return id;
  }
  const requestFor = async (userId: string) =>
    (
      await db
        .select()
        .from(schema.joinRequests)
        .where(and(eq(schema.joinRequests.groupId, GROUP), eq(schema.joinRequests.userId, userId)))
    )[0];

  it('stores no usable token — a dump of the table admits nobody', async () => {
    const token = await createInvite();
    const [row] = await db.select().from(schema.invites);
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row!.tokenHash).toBe(sha256(token));
  });

  it('still resolves a link that was handed out, and never says the group name', async () => {
    const token = await createInvite();
    const res = await lookup(token);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { inviterName: string; groupName?: unknown };
    expect(body.inviterName).toBe('Ada');
    // The name is sealed; the link the inviter handed out carries it instead.
    expect(body).not.toHaveProperty('groupName');
  });

  it('resolves a row written before the tokens were hashed', async () => {
    // What the migration produced: SHA2(token, 256) from MySQL, matched here
    // by hashing what the caller presents. If these ever disagreed, every
    // invite in existence would stop working at once.
    const token = 'legacyTokenAAAAAAAAAA';
    await db.insert(schema.invites).values({
      tokenHash: sha256(token),
      groupId: GROUP,
      createdBy: ADMIN,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const [viaSql] = await db.execute(`SELECT SHA2('${token}', 256) AS h`);
    expect((viaSql as unknown as { h: string }[])[0]!.h).toBe(sha256(token));

    const res = await lookup(token);
    expect(res.statusCode).toBe(200);
  });

  it('gives an admin the hash to read digits from, never the token', async () => {
    const token = await createInvite();
    await join(token, await asUser(JOINER));

    const res = await app!.inject({
      method: 'GET',
      url: `/api/groups/${GROUP}/join-requests`,
      headers: await asUser(ADMIN),
    });
    const body = res.body;
    expect(body).not.toContain(token);
    const [request] = (res.json() as { requests: { inviteTokenHash: string }[] }).requests;
    // Both sides of the handshake must reach the same input, or the digits
    // they read to each other would never match.
    expect(request!.inviteTokenHash).toBe(sha256(token));
  });

  it('admits one person from a single-use link, even under a race', async () => {
    const token = await createInvite();
    const [joiner, other] = await Promise.all([asUser(JOINER), asUser(OTHER)]);
    const results = await Promise.all([
      join(token, joiner),
      join(token, other),
    ]);
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 410]);

    const requests = await db.select().from(schema.joinRequests).where(eq(schema.joinRequests.groupId, GROUP));
    expect(requests).toHaveLength(1);
    const [invite] = await db.select().from(schema.invites);
    expect(invite!.useCount).toBe(1);
  });

  it('revokes by hash, so a revoked link stops working', async () => {
    const token = await createInvite();
    const del = await app!.inject({
      method: 'POST',
      url: '/api/invites/revoke',
      headers: await asUser(ADMIN),
      payload: { token },
    });
    expect(del.statusCode).toBe(200);
    expect((await lookup(token)).statusCode).toBe(404);
  });

  it('never puts a live token in a URL, which is what gets logged', async () => {
    // The regression this guards is not a broken feature — it is a working one
    // that quietly writes a capability into the request log, the proxy's log
    // and browser history. Nothing about the app looks different when it does,
    // so the property has to be asserted rather than noticed.
    const token = await createInvite();
    const joiner = await asUser(JOINER);
    const calls = [
      await lookup(token),
      await join(token, joiner),
      await app!.inject({ method: 'POST', url: '/api/invites/revoke', headers: await asUser(ADMIN), payload: { token } }),
    ];
    for (const res of calls) {
      expect(res.raw.req.url ?? '', 'the token reached a URL').not.toContain(token);
    }
  });

  it('refuses a token shaped like anything but one, without a database round trip', async () => {
    // It reaches a hash lookup and a char(36) column further in. Bounded here
    // so an oversized or malformed body is a 404 rather than a 500.
    for (const token of ['', 'short', 'x'.repeat(500), '../../etc/passwd', 'has spaces in it']) {
      expect((await lookup(token)).statusCode, token.slice(0, 20)).toBe(404);
    }
  });

  /**
   * What the landing page asks before it draws anything. Following the same
   * link twice is the ordinary case — the message it came in stays in the
   * chat — and the page used to answer all of these with the join screen,
   * alias picker and all, even though pressing the button could only ever
   * repeat what had already happened.
   */
  describe('says what the link can still do for whoever is asking', () => {
    const state = async (token: string, headers?: Record<string, string>) => {
      const res = await app!.inject({
        method: 'POST',
        url: '/api/invites/lookup',
        headers: { 'x-requested-with': 'spendapp', ...headers },
        payload: { token },
      });
      expect(res.statusCode).toBe(200);
      return res.json() as { state: string; groupId: string | null; claimable: unknown[] };
    };

    it('is open to a stranger while the one use is still there', async () => {
      const token = await createInvite();
      expect((await state(token)).state).toBe('open');
      expect((await state(token, await asUser(JOINER))).state).toBe('open');
    });

    it('tells the joiner their request is already waiting, not that the link is gone', async () => {
      const token = await createInvite();
      const joiner = await asUser(JOINER);
      await join(token, joiner);

      const second = await state(token, joiner);
      expect(second.state).toBe('pending');
      // The group they are waiting on: the page re-derives the confirmation
      // digits from it, so a second visit reads out the same ones.
      expect(second.groupId).toBe(GROUP);
    });

    it('tells a member they are already in, and which group to open', async () => {
      const token = await createInvite();
      const admin = await asUser(ADMIN);
      const seen = await state(token, admin);
      expect(seen.state).toBe('joined');
      expect(seen.groupId).toBe(GROUP);
      // Nothing to pick: they are in the group, and offering to take over a
      // name is what made a second visit look like it did something.
      expect(seen.claimable).toEqual([]);
    });

    it('tells a third party the link is spent, before they press anything', async () => {
      const token = await createInvite();
      await join(token, await asUser(JOINER));

      // The whole point: this is what somebody the link was forwarded to sees,
      // instead of a join screen ending in a 410.
      expect((await state(token, await asUser(OTHER))).state).toBe('spent');
      expect((await state(token)).state).toBe('spent');
      // Never the group id — a forwarded link should give away no more than it
      // already has.
      expect((await state(token, await asUser(OTHER))).groupId).toBeNull();
    });

    it('keeps a decline final rather than softening it into "already used"', async () => {
      const token = await createInvite();
      const joiner = await asUser(JOINER);
      await join(token, joiner);
      await db
        .update(schema.joinRequests)
        .set({ status: 'rejected', decidedBy: ADMIN, decidedAt: new Date() })
        .where(and(eq(schema.joinRequests.groupId, GROUP), eq(schema.joinRequests.userId, JOINER)));

      expect((await state(token, joiner)).state).toBe('declined');
      // And still the truth for everybody else: the use is gone either way.
      expect((await state(token, await asUser(OTHER))).state).toBe('spent');
    });
  });

  /**
   * The pick, while it is still only a pick.
   *
   * Choosing a name happens in the worst possible position: a list of
   * strangers' names, for a group nobody can see yet, seconds after following
   * a link. Once approved it is a stretch of the ledger that has changed
   * hands; while it is a request it is nobody's history yet, so it stays open
   * to correction — and correcting it must not cost a second use of the link.
   */
  describe('changing the name on a request nobody has decided', () => {
    it('rewrites the pick without lodging a second request or spending a use', async () => {
      const robin = await placeholder('44444444-4444-4444-8444-444444444444', 'Robin');
      const sam = await placeholder('55555555-5555-4555-8555-555555555555', 'Sam');
      const token = await createInvite();
      const joiner = await asUser(JOINER);

      await join(token, joiner, robin);
      expect((await requestFor(JOINER))!.claimMemberId).toBe(robin);

      const again = await join(token, joiner, sam);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ status: 'pending' });
      expect((await requestFor(JOINER))!.claimMemberId).toBe(sam);
      // One row, one use. Asking again is not a second ask.
      const rows = await db.select().from(schema.joinRequests).where(eq(schema.joinRequests.groupId, GROUP));
      expect(rows).toHaveLength(1);
      const [invite] = await db.select().from(schema.invites);
      expect(invite!.useCount).toBe(1);
    });

    it('clears the pick when they decide to come in as themselves after all', async () => {
      const robin = await placeholder('44444444-4444-4444-8444-444444444444', 'Robin');
      const token = await createInvite();
      const joiner = await asUser(JOINER);
      await join(token, joiner, robin);

      await join(token, joiner, null);
      expect((await requestFor(JOINER))!.claimMemberId).toBeNull();
    });

    it('leaves the pick alone when the caller says nothing about it', async () => {
      // An older client re-following the link says only "join". Silence is not
      // a choice to abandon the name they picked on the first visit.
      const robin = await placeholder('44444444-4444-4444-8444-444444444444', 'Robin');
      const token = await createInvite();
      const joiner = await asUser(JOINER);
      await join(token, joiner, robin);

      await join(token, joiner);
      expect((await requestFor(JOINER))!.claimMemberId).toBe(robin);
    });

    it('tells the joiner which name their standing request is on', async () => {
      // The landing page seeds its picker from this: coming back to the link
      // has to show the choice as it stands, not as it looked before one was
      // made.
      const robin = await placeholder('44444444-4444-4444-8444-444444444444', 'Robin');
      const token = await createInvite();
      const joiner = await asUser(JOINER);
      await join(token, joiner, robin);

      const res = await lookup(token);
      expect(res.statusCode).toBe(200);
      // Anonymously, there is no request to speak of and nothing to say.
      expect((res.json() as { claimMemberId: string | null }).claimMemberId).toBeNull();

      const mine = await app!.inject({
        method: 'POST',
        url: '/api/invites/lookup',
        headers: { ...joiner },
        payload: { token },
      });
      expect((mine.json() as { claimMemberId: string | null }).claimMemberId).toBe(robin);
    });

    it('refuses to move a decided request', async () => {
      const robin = await placeholder('44444444-4444-4444-8444-444444444444', 'Robin');
      const sam = await placeholder('55555555-5555-4555-8555-555555555555', 'Sam');
      const token = await createInvite();
      const joiner = await asUser(JOINER);
      await join(token, joiner, robin);
      await db
        .update(schema.joinRequests)
        .set({ status: 'rejected', decidedBy: ADMIN, decidedAt: new Date() })
        .where(and(eq(schema.joinRequests.groupId, GROUP), eq(schema.joinRequests.userId, JOINER)));

      const res = await join(token, joiner, sam);
      expect(res.statusCode).toBe(403);
      expect((await requestFor(JOINER))!.claimMemberId).toBe(robin);
    });
  });

  describe('a link made for a name, or for several people', () => {
    const ROBIN = '44444444-4444-4444-8444-444444444444';
    const create = async (payload: Record<string, unknown>) =>
      app!.inject({ method: 'POST', url: `/api/groups/${GROUP}/invites`, headers: await asUser(ADMIN), payload });
    const lookupAs = async (token: string, headers: Record<string, string>) =>
      (
        await app!.inject({
          method: 'POST',
          url: '/api/invites/lookup',
          headers: { 'x-requested-with': 'spendapp', ...headers },
          payload: { token },
        })
      ).json() as {
        state: string;
        maxUses: number;
        suggestedClaim: { userId: string; displayName: string } | null;
        suggestionGone: boolean;
      };

    it('admits as many people as it was made for, and no more', async () => {
      const res = await create({ maxUses: 2 });
      expect(res.statusCode).toBe(200);
      const { token, maxUses } = res.json() as { token: string; maxUses: number };
      expect(maxUses).toBe(2);
      expect((await join(token, await asUser(JOINER))).statusCode).toBe(200);
      expect((await join(token, await asUser(OTHER))).statusCode).toBe(200);
      // A third stranger, with the two uses gone.
      await db.insert(schema.users).values({
        id: ROBIN,
        username: 'robin',
        passwordHash: '$argon2id$fake',
        kdfSalt: 'c2FsdA',
        kdfParams: { memoryKiB: 19456, iterations: 2, parallelism: 1 },
        publicKey: 'cHVibGlj',
        wrappedPrivateKey: '{"iv":"aXY","ct":"Y3Q"}',
        displayName: 'Robin',
        createdAt: new Date(),
        privacyAcceptedAt: new Date(),
        privacyVersion: '1',
      });
      expect((await join(token, await asUser(ROBIN))).statusCode).toBe(410);
      expect((await lookupAs(token, {})).state).toBe('spent');
      // So the landing page can say "as many as it was made for" rather than
      // "somebody else used it".
      expect((await lookupAs(token, {})).maxUses).toBe(2);
    });

    it('is capped: never unlimited, never more than nine', async () => {
      expect((await create({ maxUses: 10 })).statusCode).toBe(400);
      expect((await create({ maxUses: 0 })).statusCode).toBe(400);
      expect((await create({ maxUses: 9 })).statusCode).toBe(200);
    });

    it('refuses a name together with several uses: a name changes hands once', async () => {
      const robin = await placeholder(ROBIN, 'Robin');
      expect((await create({ claimMemberId: robin, maxUses: 2 })).statusCode).toBe(400);
      expect((await create({ claimMemberId: robin, maxUses: 1 })).statusCode).toBe(200);
      expect((await create({ claimMemberId: robin })).statusCode).toBe(200);
    });

    it('refuses to be made for a name that cannot change hands', async () => {
      // An active member's name is not on offer, and neither is an id that
      // is in no group at all.
      expect((await create({ claimMemberId: ADMIN })).statusCode).toBe(409);
      expect((await create({ claimMemberId: ROBIN })).statusCode).toBe(409);
    });

    it('suggests the name to the follower, and uses it when a client says nothing', async () => {
      const robin = await placeholder(ROBIN, 'Robin');
      const { token } = (await create({ claimMemberId: robin })).json() as { token: string };
      const joiner = await asUser(JOINER);
      // To a stranger without a session the name is one more thing a
      // forwarded link must not give away.
      expect((await lookupAs(token, {})).suggestedClaim).toBeNull();
      const seen = await lookupAs(token, joiner);
      expect(seen.suggestedClaim).toEqual({ userId: robin, displayName: 'Robin' });
      expect(seen.suggestionGone).toBe(false);

      // An older client, re-following the link and not talking about names.
      expect((await join(token, joiner)).statusCode).toBe(200);
      expect((await requestFor(JOINER))?.claimMemberId).toBe(robin);
    });

    it('lets the follower decline the suggestion outright', async () => {
      const robin = await placeholder(ROBIN, 'Robin');
      const { token } = (await create({ claimMemberId: robin })).json() as { token: string };
      // Explicit null: they looked, and it is not them.
      expect((await join(token, await asUser(JOINER), null)).statusCode).toBe(200);
      expect((await requestFor(JOINER))?.claimMemberId).toBeNull();
    });

    it('says when the name it was made for has been taken since', async () => {
      const robin = await placeholder(ROBIN, 'Robin');
      const { token } = (await create({ claimMemberId: robin })).json() as { token: string };
      // Taken over by somebody else in the meantime.
      await db
        .update(schema.groupMembers)
        .set({ leftAt: new Date(), aliasOf: ADMIN })
        .where(and(eq(schema.groupMembers.groupId, GROUP), eq(schema.groupMembers.userId, robin)));
      const seen = await lookupAs(token, await asUser(JOINER));
      expect(seen.suggestedClaim).toBeNull();
      expect(seen.suggestionGone).toBe(true);
    });
  });

  it('keeps the join request pointing at its invite', async () => {
    const token = await createInvite();
    await join(token, await asUser(JOINER));
    const [row] = await db
      .select()
      .from(schema.joinRequests)
      .where(and(eq(schema.joinRequests.groupId, GROUP), eq(schema.joinRequests.userId, JOINER)));
    expect(row!.inviteTokenHash).toBe(sha256(token));
  });
});
