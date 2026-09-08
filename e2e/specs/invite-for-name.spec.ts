import { ME, expect, seedGroup, seedGroupKey, signIn, test } from '../fixtures/api';

const GROUP = '77777777-7777-4777-8777-777777777777';
const ROBIN = 'bbbb0000-0000-4000-8000-000000000001';
const LINK = '/invite#tokAAAAAAAAAAAAAAAAAA.VHJpcA';

/**
 * A link made *for* a name, and a link made for several people.
 *
 * Who takes over which name used to be decided in the worst possible place:
 * by the person following the link, from a list of strangers' names, for a
 * group they could not see yet. The inviter can see the ledger, so the
 * initial pick moves to their side — as a suggestion the follower lands on
 * and can still change, not a decision made for them. A name changes hands
 * once, so a link made for one admits one person; a link made for nobody in
 * particular may admit up to nine, and says so wherever "used once" used to
 * be assumed.
 */
test.describe('making the link', () => {
  test.beforeEach(async ({ api }) => {
    seedGroup(api, GROUP, 'Trip', [
      { userId: ME.id, displayName: 'Lukas', isPlaceholder: false, role: 'admin' },
      { userId: ROBIN, displayName: 'Robin', isPlaceholder: true },
    ]);
    await seedGroupKey(api, GROUP);
  });

  test('made for a name, it admits one person and says who it is for', async ({ page, api }) => {
    await signIn(page);
    await page.goto(`/g/${GROUP}`);
    await page.getByRole('button', { name: 'Invite link' }).click();
    await page.locator('#invite-for').selectOption(ROBIN);
    // The count follows the name: a takeover is one person's.
    await expect(page.locator('#invite-uses')).toBeDisabled();
    await expect(page.locator('#invite-uses')).toHaveValue('1');
    await page.getByRole('button', { name: /sharing everything/i }).click();
    await page.getByText(/valid 14 days/).waitFor();
    await expect.poll(() => api.lastInvite).toEqual({ maxUses: 1, claimMemberId: ROBIN });
    await expect(page.getByText(/Made for Robin/)).toBeVisible();
  });

  test('made for nobody in particular, it can admit several', async ({ page, api }) => {
    await signIn(page);
    await page.goto(`/g/${GROUP}`);
    await page.getByRole('button', { name: 'Invite link' }).click();
    await page.locator('#invite-uses').selectOption('3');
    await page.getByRole('button', { name: /sharing everything/i }).click();
    await page.getByText(/admits 3 people, valid 14 days/).waitFor();
    await expect.poll(() => api.lastInvite).toEqual({ maxUses: 3, claimMemberId: null });
    await expect(page.getByText(/Made for/)).toHaveCount(0);
  });

  test('offers no name when there is none to make it for', async ({ page, api }) => {
    seedGroup(api, GROUP, 'Trip', [{ userId: ME.id, displayName: 'Lukas', isPlaceholder: false, role: 'admin' }]);
    await signIn(page);
    await page.goto(`/g/${GROUP}`);
    await page.getByRole('button', { name: 'Invite link' }).click();
    await expect(page.locator('#invite-uses')).toBeVisible();
    await expect(page.locator('#invite-for')).toHaveCount(0);
  });
});

test.describe('following the link', () => {
  const OTHER = 'bbbb0000-0000-4000-8000-000000000002';
  test.beforeEach(async ({ api }) => {
    seedGroup(api, GROUP, 'Trip', [
      { userId: OTHER, displayName: 'Sam', isPlaceholder: false, role: 'admin' },
      { userId: ROBIN, displayName: 'Robin', isPlaceholder: true },
    ]);
    await seedGroupKey(api, GROUP);
  });

  test('lands on the name the link was made for, and joins as it', async ({ page, api }) => {
    api.inviteClaimMemberId = ROBIN;
    await signIn(page);
    await page.goto(LINK);
    await expect(page.getByText(/made this link for Robin/i)).toBeVisible();
    await expect(page.locator('#claim')).toHaveValue(ROBIN);
    await page.getByRole('button', { name: /join as this person/i }).click();
    await expect(page.getByText(/Request sent/i)).toBeVisible();
    expect(api.joinRequests.get(GROUP)?.[0]?.claimMemberId).toBe(ROBIN);
  });

  test('the suggestion is a starting point, not a decision', async ({ page, api }) => {
    api.inviteClaimMemberId = ROBIN;
    await signIn(page);
    await page.goto(LINK);
    await page.locator('#claim').selectOption('');
    await page.getByRole('button', { name: /^join group$/i }).click();
    await expect(page.getByText(/Request sent/i)).toBeVisible();
    // Explicit null, never absent: absent would fall back to the link's name.
    expect(api.joinRequests.get(GROUP)?.[0]?.claimMemberId).toBeNull();
  });

  test('says so when the name it was made for has since been taken', async ({ page, api }) => {
    api.inviteClaimMemberId = ROBIN;
    // Robin taken over by Sam in the meantime: no longer on offer.
    api.members.set(
      GROUP,
      (api.members.get(GROUP) ?? []).map((m) => (m.userId === ROBIN ? { ...m, leftAt: '2026-08-01T00:00:00.000Z', aliasOf: OTHER } : m)),
    );
    await signIn(page);
    await page.goto(LINK);
    await expect(page.getByText(/somebody else has since taken over/i)).toBeVisible();
    await expect(page.locator('#claim')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^join group$/i })).toBeVisible();
  });

  test('a spent link made for several people does not blame somebody else', async ({ page, api }) => {
    api.inviteMaxUses = 3;
    api.inviteSpent = true;
    await signIn(page);
    await page.goto(LINK);
    await expect(page.getByText(/as many people as it was made for/i)).toBeVisible();
    await expect(page.getByText(/Somebody else/i)).toHaveCount(0);
  });
});
