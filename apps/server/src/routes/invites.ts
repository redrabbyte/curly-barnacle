import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { inviteJoinSchema, inviteTokenSchema } from '@spendapp/shared';
import type { InviteState } from '@spendapp/shared';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { activeAdminIds, isMember } from '../lib/groups.js';
import { claimableMembers } from '../lib/members.js';
import { notifyUsers } from '../lib/notify.js';

/** Stored instead of the token, exactly as sessions store theirs. */
const hashToken = (raw: string): string => createHash('sha256').update(raw).digest('hex');

export async function inviteRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/groups/:groupId/invites', { preHandler: app.requireUser }, async (req, reply) => {
    const { groupId } = req.params as { groupId: string };
    if (!(await isMember(req.user!.id, groupId))) return reply.code(404).send({ error: 'not_found' });

    // Withholding history is opt-in and never inferred: the default has to be
    // the one that leaves a new member able to read the ledger they are in.
    const shareHistory = (req.body as { shareHistory?: unknown } | null)?.shareHistory !== false;
    const token = randomBytes(16).toString('base64url'); // 128-bit capability
    const now = new Date();
    await db.insert(schema.invites).values({
      tokenHash: hashToken(token),
      groupId,
      createdBy: req.user!.id,
      createdAt: now,
      expiresAt: new Date(now.getTime() + config.inviteTtlDays * 86_400_000),
      shareHistory,
    });
    // The token goes in the *fragment*, not the path. A fragment is never put
    // on the wire — not in the request line, not in `Referer` — so the one
    // place a live capability used to be guaranteed to land, the access log of
    // whatever serves this app, no longer sees it at all. See the note on
    // `findValidInvite` below for the rest of the reasoning.
    return { token, path: `/invite#${token}`, maxUses: 1, shareHistory };
  });

  /**
   * Public landing-page lookup: the inviter's name and the link's terms,
   * rate-limited. Not the group's name — that is sealed, and the inviter's
   * device put it in the link fragment for the landing page to read.
   *
   * A POST that reads nothing, for the same reason `/api/auth/params` is one:
   * a path parameter is logged. This one is worse than a username — the token
   * *is* the capability — and it reached the application log, the reverse
   * proxy's log, and browser history on the way. Moving it into a body costs
   * nothing here and takes it out of all three.
   */
  app.post(
    '/api/invites/lookup',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = inviteTokenSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(404).send({ error: 'invite_invalid' });
      const invite = await findValidInvite(parsed.data.token);
      if (!invite) return reply.code(404).send({ error: 'invite_invalid' });
      const state = await inviteState(invite, req.user?.id);
      // The claimable list names every placeholder in the group and carries
      // their ids, so it is withheld until the caller has signed in. A link
      // forwarded to a stranger reveals nothing but the group and inviter,
      // which is what a landing page needs; claiming requires a session
      // anyway, so gating it costs the real joiner nothing.
      //
      // Withheld again once the answer is no longer "you may join": a spent or
      // declined link is not going to admit this caller, and a page that still
      // asked which name they are would be offering a choice that leads
      // nowhere. `pending` keeps it for the same reason it keeps everything
      // else — the request it describes is real, just undecided.
      const offerClaims = state === 'open' || state === 'pending';
      const claimable = req.user && offerClaims ? await claimableMembers(invite.groupId) : [];
      // Their *own* departed membership. Rejoining on the same account
      // resurrects it by itself, so it must not be offered as something to
      // claim — that would make the correct action look like a choice between
      // "be yourself" and "start over", which is how somebody ends up listed
      // twice in a group they have always been in.
      const mine = req.user ? claimable.find((c) => c.userId === req.user!.id) : undefined;
      // What they picked last time, so coming back to the link shows the
      // choice as it stands rather than as it looked before they made it. Only
      // for a request of their own that nobody has decided yet: any other
      // state has no pick left to change.
      const picked = req.user && state === 'pending' ? await pendingClaim(invite.groupId, req.user.id) : null;
      return {
        inviterName: invite.inviterName,
        // Told up front, not discovered afterwards: a ledger you can only see
        // half of is something to accept knowingly (design §4.7).
        shareHistory: invite.shareHistory,
        state,
        // Only ever for a caller who is already inside or already asked — both
        // of whom the server has just confirmed. For anybody else the group id
        // is one more thing a forwarded link would give away, and the landing
        // page has no use for it.
        groupId: state === 'joined' || state === 'pending' ? invite.groupId : null,
        claimable: claimable.filter((c) => c.userId !== req.user?.id),
        claimMemberId: picked,
        wasMember: mine ? { userId: mine.userId, displayName: mine.displayName } : null,
      };
    },
  );

  /**
   * Following an invite no longer grants membership — it queues a request an
   * admin must approve. The link is a capability to *ask*, so a forwarded or
   * intercepted one gets a stranger no further than a row an admin will see
   * and decline.
   */
  app.post('/api/invites/join', { preHandler: app.requireUser }, async (req, reply) => {
    const parsed = inviteJoinSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(404).send({ error: 'invite_invalid' });
    const token = parsed.data.token;
    const invite = await findValidInvite(token);
    if (!invite) return reply.code(404).send({ error: 'invite_invalid' });
    const userId = req.user!.id;

    if (await isMember(userId, invite.groupId)) return { status: 'joined' as const, groupId: invite.groupId };

    // Bounded by the schema now rather than taken raw off the body: it reaches
    // a char(36) column, and an oversized string used to become a 500.
    const claim = parsed.data.claimMemberId ?? null;
    /**
     * Whether the caller said anything about a name at all. `undefined` is a
     * client that is not talking about the claim — an older one re-following
     * the link, say — and its silence must not clear a pick somebody made on
     * purpose. `null` is a person choosing to join as themselves after all.
     */
    const saidSomething = parsed.data.claimMemberId !== undefined;

    const existing = await db
      .select({ status: schema.joinRequests.status })
      .from(schema.joinRequests)
      .where(
        and(
          eq(schema.joinRequests.groupId, invite.groupId),
          eq(schema.joinRequests.userId, userId),
          eq(schema.joinRequests.kind, 'join'),
        ),
      )
      .limit(1);
    const status = existing[0]?.status;
    /**
     * Already asked. The request stands either way — asking twice must not
     * spend a second use of the link, and did not before — but the *name* on
     * it is still open to correction until an admin decides.
     *
     * Which is the whole point: picking the wrong name from a list of
     * strangers' names is the easiest mistake in this flow to make and, once
     * approved, one only an admin can undo. While it is still a request it is
     * nobody's history yet, so changing it costs nothing and needs no
     * approval of its own.
     */
    if (status === 'pending') {
      if (saidSomething) {
        await db
          .update(schema.joinRequests)
          .set({ claimMemberId: claim })
          .where(
            and(
              eq(schema.joinRequests.groupId, invite.groupId),
              eq(schema.joinRequests.userId, userId),
              eq(schema.joinRequests.kind, 'join'),
              // Only while it is still undecided. An admin approving in the
              // same second wins, and the claim they approved is the one that
              // was in front of them.
              eq(schema.joinRequests.status, 'pending'),
            ),
          );
      }
      return { status: 'pending' as const, groupId: invite.groupId };
    }
    // A decline is final for this account; otherwise the same link would let
    // someone re-ask on a loop.
    if (status === 'rejected') return reply.code(403).send({ error: 'join_declined' });

    // Spent links stop admitting people. The pending and rejected branches
    // above have already returned, so one person retrying cannot burn a use.
    //
    // Claimed by the same statement that checks it. Reading the count and then
    // incrementing it let two people arriving together both see room on a
    // single-use link and both get in — the row is only ever held by whichever
    // update the database applies first.
    const [claimed] = await db
      .update(schema.invites)
      .set({ useCount: sql`use_count + 1` })
      .where(and(eq(schema.invites.tokenHash, hashToken(token)), lt(schema.invites.useCount, schema.invites.maxUses)));
    if (claimed.affectedRows === 0) {
      return reply.code(410).send({ error: 'invite_spent' });
    }

    const now = new Date();
    // 'approved' can only be seen here by someone who has since left, so it is
    // treated as a fresh ask rather than a replay.
    await db
      .insert(schema.joinRequests)
      .values({
        groupId: invite.groupId,
        userId,
        kind: 'join',
        inviteTokenHash: hashToken(token),
        claimMemberId: claim,
        status: 'pending',
        requestedAt: now,
      })
      .onDuplicateKeyUpdate({
        set: { status: 'pending', inviteTokenHash: hashToken(token), claimMemberId: claim, requestedAt: now, decidedBy: null, decidedAt: null },
      });

    const [admins, actor] = await Promise.all([
      activeAdminIds(invite.groupId),
      db.select({ displayName: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, userId)).limit(1),
    ]);
    notifyUsers(
      admins,
      invite.groupId,
      'join.requested',
      `/g/${invite.groupId}?tab=members`,
      actor[0]?.displayName ?? undefined,
    );
    return { status: 'pending' as const, groupId: invite.groupId };
  });

  app.post('/api/invites/revoke', { preHandler: app.requireUser }, async (req, reply) => {
    const parsed = inviteTokenSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(404).send({ error: 'not_found' });
    const { token } = parsed.data;
    const rows = await db.select().from(schema.invites).where(eq(schema.invites.tokenHash, hashToken(token))).limit(1);
    const invite = rows[0];
    if (!invite || !(await isMember(req.user!.id, invite.groupId))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    await db.update(schema.invites).set({ revokedAt: new Date() }).where(eq(schema.invites.tokenHash, hashToken(token)));
    return { ok: true };
  });
}

async function findValidInvite(token: string) {
  const rows = await db
    .select({
      groupId: schema.invites.groupId,
      expiresAt: schema.invites.expiresAt,
      inviterName: schema.users.displayName,
      shareHistory: schema.invites.shareHistory,
      useCount: schema.invites.useCount,
      maxUses: schema.invites.maxUses,
    })
    .from(schema.invites)
    .innerJoin(schema.groups, eq(schema.groups.id, schema.invites.groupId))
    .innerJoin(schema.users, eq(schema.users.id, schema.invites.createdBy))
    .where(and(eq(schema.invites.tokenHash, hashToken(token)), isNull(schema.invites.revokedAt), isNull(schema.groups.deletedAt)))
    .limit(1);
  const invite = rows[0];
  if (!invite) return null;
  if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) return null;
  return invite;
}

/**
 * What this link can still do for this caller (see `InviteState`).
 *
 * Deliberately reproduces the order `/api/invites/join` decides in, because
 * the landing page's job is to say in advance what pressing the button would
 * do. Membership first, then a standing request, then the link's own use
 * count — so the person who spent the link is shown their own request rather
 * than told a stranger took it, and a decline stays final rather than being
 * softened into "already used".
 */
async function inviteState(
  invite: { groupId: string; useCount: number; maxUses: number },
  userId: string | undefined,
): Promise<InviteState> {
  const spent = invite.useCount >= invite.maxUses ? 'spent' : 'open';
  if (!userId) return spent;
  if (await isMember(userId, invite.groupId)) return 'joined';
  const rows = await db
    .select({ status: schema.joinRequests.status })
    .from(schema.joinRequests)
    // A claim asked from inside the group is a different question with a row
    // of its own; it says nothing about what this link can do.
    .where(
      and(
        eq(schema.joinRequests.groupId, invite.groupId),
        eq(schema.joinRequests.userId, userId),
        eq(schema.joinRequests.kind, 'join'),
      ),
    )
    .limit(1);
  const status = rows[0]?.status;
  if (status === 'pending') return 'pending';
  if (status === 'rejected') return 'declined';
  // 'approved' without a live membership is somebody who has since left. Their
  // way back is a fresh link — this one's use is gone — so it falls through to
  // the count, which says exactly that.
  return spent;
}

/** The name a standing join request has picked, if it has picked one. */
async function pendingClaim(groupId: string, userId: string): Promise<string | null> {
  const rows = await db
    .select({ claimMemberId: schema.joinRequests.claimMemberId })
    .from(schema.joinRequests)
    .where(
      and(
        eq(schema.joinRequests.groupId, groupId),
        eq(schema.joinRequests.userId, userId),
        eq(schema.joinRequests.kind, 'join'),
        eq(schema.joinRequests.status, 'pending'),
      ),
    )
    .limit(1);
  return rows[0]?.claimMemberId ?? null;
}
