import { ME, expect, seedGroup, seedGroupKey, signIn, test } from '../fixtures/api';

const GROUP = '66666666-6666-4666-8666-666666666666';
const ADMIN = 'aaaa0000-0000-4000-8000-00000000000b';

/**
 * Following the same invite link twice.
 *
 * A link is a one-shot capability, but the message it arrived in is not: it
 * sits in the chat, and people tap it again to see whether anything happened.
 * The landing page used to answer every one of these with the join screen —
 * inviter, group name, and an "are you one of these people?" picker — which
 * read like a second chance to choose a name. It was not: the server returns
 * the request that already exists rather than rewriting it, so the picker
 * moved nothing. These specs pin what each of those visits says instead.
 */
test.beforeEach(async ({ api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ADMIN, displayName: 'Sam', isPlaceholder: false, role: 'admin' },
    { userId: 'aaaa0000-0000-4000-8000-000000000001', displayName: 'Robin', isPlaceholder: true },
  ]);
  await seedGroupKey(api, GROUP);
});

test('a second visit shows the request already waiting, not the picker again', async ({ page }) => {
  await signIn(page);
  await page.goto('/invite#tokAAAAAAAAAAAAAAAAAA.VHJpcA');
  await page.getByRole('button', { name: /join group/i }).click();
  await expect(page.getByText(/Request sent/i)).toBeVisible();

  // Away and back to the link, exactly as closing the app and tapping it in
  // the chat again would. Via another page on purpose: the first visit strips
  // the fragment out of the address bar, so going straight back would be a
  // same-document jump that never reloads anything.
  await page.goto('/');
  await page.goto('/invite#tokAAAAAAAAAAAAAAAAAA.VHJpcA');
  await expect(page.getByText(/already asked to join/i)).toBeVisible();
  // The one thing that made the old screen misleading: a name to pick, which
  // could not change the request that was already lodged.
  await expect(page.locator('#claim')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /join group/i })).toHaveCount(0);
});

test('a member following their own group’s link is taken into the group', async ({ page, api }) => {
  api.members.get(GROUP)!.push({
    groupId: GROUP,
    userId: ME.id,
    displayName: ME.displayName,
    leftAt: null,
    isPlaceholder: false,
    role: 'member',
    version: 5,
  });

  await signIn(page);
  await page.goto('/invite#tokAAAAAAAAAAAAAAAAAA.VHJpcA');
  await page.waitForURL(new RegExp(`/g/${GROUP}`), { timeout: 20_000 });
});

test('a third party is told the link is spent before pressing anything', async ({ page, api }) => {
  // Somebody the link was forwarded to, after the person it was meant for
  // used it. The old page let them choose a name and press Join, and only
  // then answered with an error.
  api.inviteSpent = true;

  await signIn(page);
  await page.goto('/invite#tokAAAAAAAAAAAAAAAAAA.VHJpcA');
  await expect(page.getByText(/Somebody else has already used this invite link/i)).toBeVisible();
  await expect(page.getByText(/ask whoever runs the group to send you a new one/i)).toBeVisible();
  await expect(page.locator('#claim')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /join group/i })).toHaveCount(0);
});

test('a signed-out visitor is not told a stranger took their link', async ({ page, api }) => {
  // It may well have been them, on another device or logged out. Saying
  // somebody else got there would be both wrong and alarming, so the way
  // forward is to log in and find out.
  api.inviteSpent = true;
  api.signedIn = false;

  await page.goto('/invite#tokAAAAAAAAAAAAAAAAAA.VHJpcA');
  await expect(page.getByText(/If that was you, log in/i)).toBeVisible();
  await expect(page.getByText(/Somebody else/i)).toHaveCount(0);
  await expect(page.getByRole('link', { name: /log in to check/i })).toBeVisible();
});

test('a declined request is said to be declined, not merely used up', async ({ page, api }) => {
  api.joinRequests.set(GROUP, [
    {
      userId: ME.id,
      displayName: ME.displayName,
      claimMemberId: null,
      requestedAt: '2026-08-01T00:00:00.000Z',
      status: 'rejected',
      decidedAt: '2026-08-02T00:00:00.000Z',
    },
  ]);
  api.inviteSpent = true;

  await signIn(page);
  await page.goto('/invite#tokAAAAAAAAAAAAAAAAAA.VHJpcA');
  await expect(page.getByText(/was declined/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /join group/i })).toHaveCount(0);
});
