import { sealJson, toBase64Url } from '@spendapp/shared';
import { ME, epochKeyOf, expect, groupKeyFor, openSealedName, seedGroup, seedGroupKey, signIn, test } from '../fixtures/api';

/**
 * The group name is sealed like everything else the members write (design
 * §4.2). What is worth pinning is the same thing envelope.spec pins for an
 * expense: that the name leaves the device only as ciphertext, and that the
 * two places the server used to need it readable — the invite landing page
 * and the notification title — still say it without the server's help.
 */

const GROUP = '55555555-5555-4555-8555-555555555555';
const NAME = 'Divorce lawyer fund';

/** A name sealed the way the client seals one, under a seeded key unless told otherwise. */
async function sealNameFor(groupId: string, name: string, epoch: number, key = groupKeyFor(epoch)) {
  const s = await sealJson(key, { name }, new TextEncoder().encode(`groupname|${groupId}|${epoch}`));
  return { epoch, iv: toBase64Url(s.iv), ct: toBase64Url(s.ciphertext) };
}

test('a group is created with its name sealed, and the name never crosses the wire', async ({ page, api }) => {
  const bodies: string[] = [];
  page.on('request', (r) => {
    const body = r.postData();
    if (body && new URL(r.url()).pathname.startsWith('/api/')) bodies.push(body);
  });

  await signIn(page);
  await page.getByPlaceholder('e.g. Flat 12b').fill(NAME);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  // Usable at once, from the mirror, before the mutation has gone anywhere.
  await expect(page.getByRole('link', { name: new RegExp(NAME) })).toBeVisible();

  await expect.poll(() => api.mutations.filter((m) => m.type === 'group.create').length).toBeGreaterThan(0);
  const pushed = api.mutations.find((m) => m.type === 'group.create')!;
  const data = pushed.data as { id: string; name: { iv: string; ct: string } };
  expect(typeof data.name).toBe('object');

  // Sealed under the epoch minted for the group, and it says what was typed.
  expect(await openSealedName(data.id, { epoch: 0, ...data.name }, api.groupSecrets.get(data.id))).toBe(NAME);
  // And that is the only form in which it left: no request body carries it.
  for (const body of bodies) expect(body).not.toContain(NAME);

  // Round trip: the name the mock now sends back sealed is the one shown.
  await page.reload();
  await expect(page.getByRole('link', { name: new RegExp(NAME) })).toBeVisible();
});

test('a name that lagged a rotation is brought forward by the first member who can', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Old flat', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP, 0);
  await seedGroupKey(api, GROUP, 1);
  // Sealed under epoch 0 while the group is at 1: what a rotation by a device
  // that held only a placeholder leaves behind, and what a member admitted on
  // epoch 1 alone could not read.
  api.groups.get(GROUP)!.sealedName = await sealNameFor(GROUP, 'Old flat', 0);

  await signIn(page);
  await expect(page.getByRole('link', { name: /Old flat/ })).toBeVisible();

  // Re-sealed under the newest epoch and handed over, unprompted.
  await expect.poll(() => api.nameSeals.some((n) => n.groupId === GROUP && n.via === 'backfill')).toBe(true);
  const sealed = api.groups.get(GROUP)!.sealedName!;
  expect(sealed.epoch).toBe(1);
  expect(await openSealedName(GROUP, sealed, epochKeyOf(api, GROUP, 1))).toBe('Old flat');
  // Once, not on every pull.
  await page.waitForTimeout(1500);
  expect(api.nameSeals.filter((n) => n.groupId === GROUP)).toHaveLength(1);

  // Still called what it was, now from the sealed copy.
  await page.reload();
  await expect(page.getByRole('link', { name: /Old flat/ })).toBeVisible();
});

test('a member whose key has not arrived sees the group waiting, not blank or wrong', async ({ page, api }) => {
  // In the group, with the name sealed under a key this device does not hold
  // — the window between an admin approving and their device handing the
  // keyring over.
  seedGroup(api, GROUP, 'Not yet', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false },
  ]);
  await seedGroupKey(api, GROUP, 0);
  api.groups.get(GROUP)!.sealedName = await sealNameFor(GROUP, 'Not yet', 3, new Uint8Array(32).fill(0x77));

  await signIn(page);
  await expect(page.getByText('Waiting for the group key…')).toBeVisible();
  await expect(page.getByText('Not yet')).toHaveCount(0);
});

test('the invite landing page names the group from the link', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: '11111111-1111-4111-8111-111111111111', displayName: 'Lukas', isPlaceholder: false },
  ]);
  api.signedIn = false;

  // "Trip", base64url, after the token.
  await page.goto('/invite#tokAAAAAAAAAAAAAAAAAA.VHJpcA');
  await expect(page.getByRole('heading', { name: 'Trip' })).toBeVisible();
});

test('a link from before the name travelled in it still works, without the name', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: '11111111-1111-4111-8111-111111111111', displayName: 'Lukas', isPlaceholder: false },
  ]);
  api.signedIn = false;

  // It cannot say which group, because nothing on the server can either.
  await page.goto('/invite#tokAAAAAAAAAAAAAAAAAA');
  await expect(page.getByRole('heading', { name: 'a group' })).toBeVisible();
  await expect(page.getByText('Trip')).toHaveCount(0);
});
