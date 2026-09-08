import { ME, expect, seedExpense, seedGroup, seedGroupKey, signIn, test } from '../fixtures/api';

const GROUP = 'dddd0000-0000-4000-8000-00000000c1a2';
const SAM = 'aaaa0000-0000-4000-8000-0000000000a5';
const ROBIN = 'aaaa0000-0000-4000-8000-0000000000b7';

/**
 * Putting a name right after the join (design §5).
 *
 * Taking over a name used to be decidable in exactly one moment: the seconds
 * after following an invite link, from a list of names belonging to a group
 * nobody could see yet. Both ways of getting it wrong were dead ends —
 * joining as somebody new when a name was already yours could not be undone at
 * all, and picking a stranger's needed an admin to unclaim it, after which the
 * name could never be claimed again by anybody.
 *
 * So the same question is asked from inside the group, where the ledger is on
 * screen. It is still a request: a takeover moves a stretch of the ledger, and
 * everybody's balance moves with it.
 */
test.beforeEach(async ({ api }) => {
  seedGroup(api, GROUP, 'Flat', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
    { userId: SAM, displayName: 'Sam', isPlaceholder: false },
    { userId: ROBIN, displayName: 'Robin', isPlaceholder: true },
  ]);
  await seedGroupKey(api, GROUP, 0);
  // Something to move, so the ask can say what it is about.
  await seedExpense(api, GROUP, 'Dinner', SAM, 1000, 0, [ROBIN]);
});

test('a member can say a name is them, and an admin approves it', async ({ page, api }) => {
  await signIn(page);
  await page.goto(`/g/${GROUP}?tab=members`);

  await page.getByText('Is one of these names you?').click();
  await page.locator('#own-claim').selectOption(ROBIN);
  // Read off this device, because only this device can open a split.
  await expect(page.getByText(/That name is in 1 entry/i)).toBeVisible();
  await page.getByRole('button', { name: 'That one is me' }).click();

  // Waiting, and nothing has moved yet.
  await expect(page.getByText('You have asked to take over Robin.')).toBeVisible();
  await expect
    .poll(() => api.joinRequests.get(GROUP)?.find((r) => r.kind === 'claim')?.claimMemberId)
    .toBe(ROBIN);

  // The same queue an admin decides joins in — with no digits to read out,
  // because the asker arrived long ago and there is no link behind this.
  const queue = page.getByRole('main');
  await expect(queue.getByText(/is already here, and says Robin is them/i)).toBeVisible();
  await expect(queue.getByText(/Check by voice/i)).toHaveCount(0);

  await page.getByRole('button', { name: 'Approve', exact: true }).click();

  // The name retires pointing at them, and the members list says so.
  await expect(page.getByText('Names taken over')).toBeVisible();
  await expect(page.getByText(/now counts as Lukas/i)).toBeVisible();
  // No membership was granted and no keyring travelled: they were already in,
  // and re-sharing the ring would widen what a from-today member can read.
  expect(api.publishedWraps.filter((w) => w.groupId === GROUP && w.userId === ME.id)).toHaveLength(0);
});

test('the ask can be taken back while nobody has answered', async ({ page, api }) => {
  await signIn(page);
  await page.goto(`/g/${GROUP}?tab=members`);

  await page.getByText('Is one of these names you?').click();
  await page.locator('#own-claim').selectOption(ROBIN);
  await page.getByRole('button', { name: 'That one is me' }).click();
  await expect(page.getByText('You have asked to take over Robin.')).toBeVisible();

  await page.getByRole('button', { name: 'Take it back' }).click();
  await expect(page.getByText('You have asked to take over Robin.')).toHaveCount(0);
  await expect.poll(() => api.joinRequests.get(GROUP)?.some((r) => r.kind === 'claim') ?? false).toBe(false);
  // And Robin is still a name standing on its own, for anybody to take over.
  await expect(page.getByRole('main').getByText('unclaimed')).toBeVisible();
});

test('a name somebody has already taken over is not offered', async ({ page, api }) => {
  // Offering it again would point two people at one history.
  api.members.get(GROUP)!.find((m) => m.userId === ROBIN)!.aliasOf = SAM;
  api.members.get(GROUP)!.find((m) => m.userId === ROBIN)!.leftAt = '2026-06-01T00:00:00.000Z';

  await signIn(page);
  await page.goto(`/g/${GROUP}?tab=members`);
  await expect(page.getByText('Is one of these names you?')).toHaveCount(0);
});
