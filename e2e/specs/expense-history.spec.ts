import { ME, expect, seedGroup, seedGroupKey, signIn, test } from '../fixtures/api';

const GROUP = 'cccccccc-9999-4999-8999-cccccccccccc';

/**
 * The per-expense history, saying what an edit did (design §11).
 *
 * "Edited" is a true thing to say about a change to somebody's money and very
 * nearly the least useful one. Every write already seals a snapshot of the
 * version it creates, so the log can compare an edit against the snapshot
 * before it and name the parts that moved — end to end here, because the whole
 * chain is the point: seal, sync, decrypt on the way back in, diff, render.
 *
 * Comments and photos belong in the same list. Comment rows were being caught
 * by the filter and rendered as the bare word `comment`, having no case in the
 * describer; photos were logged against the attachment and so were missing
 * from the expense's history altogether.
 */

// A 1×1 PNG — real enough for the compression step's createImageBitmap.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('the history names what each edit changed', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP);

  await signIn(page);
  await page.goto(`/g/${GROUP}`);
  await page.getByPlaceholder('What was it?').fill('Lunch');
  await page.getByPlaceholder('0.00').first().fill('12.00');
  await page.getByRole('button', { name: /^(Save|Add)/ }).first().click();
  await expect(page.getByText('Lunch')).toBeVisible();

  await page.getByText('Lunch').first().click();

  // Two fields at once, so the log has to report both rather than the first
  // difference it finds.
  await page.getByRole('button', { name: 'edit', exact: true }).click();
  await page.getByPlaceholder('What was it?').fill('Lunch for two');
  await page.getByPlaceholder('0.00').first().fill('24.00');
  await page.getByRole('button', { name: /^(Save|Update)/ }).first().click();
  await expect(page.getByText('Lunch for two').first()).toBeVisible();

  await expect(page.getByText(/renamed from .Lunch. to .Lunch for two./)).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/amount .*12\.00.*→.*24\.00/)).toBeVisible();

  // The note is its own line, and says which of the three things happened.
  await page.getByRole('button', { name: 'edit', exact: true }).click();
  await page.getByPlaceholder(/note/i).fill('split the taxi too');
  await page.getByRole('button', { name: /^(Save|Update)/ }).first().click();
  await expect(page.getByText('added a note')).toBeVisible({ timeout: 15_000 });

  // Nothing about any of it was readable on the wire — the snapshots the log
  // reads are sealed like everything else.
  for (const m of api.mutations.filter((x) => x.type === 'expense.upsert')) {
    expect(JSON.stringify(m.data)).not.toContain('Lunch');
    expect(JSON.stringify(m.data)).not.toContain('taxi');
  }
});

test('comments and photos appear in the expense’s own history', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP);

  await signIn(page);
  await page.goto(`/g/${GROUP}`);
  await page.getByPlaceholder('What was it?').fill('Taxi');
  await page.getByPlaceholder('0.00').first().fill('9.00');
  await page.getByRole('button', { name: /^(Save|Add)/ }).first().click();
  await page.getByText('Taxi').first().click();

  await page.getByPlaceholder(/comment/i).fill('who was in this?');
  await page.getByRole('button', { name: 'Post' }).click();
  // `commented`, not the raw activity type, which is what the row rendered
  // when the describer had no case for it.
  await expect(page.getByText('commented')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('comment', { exact: true })).toHaveCount(0);

  await page
    .locator('input[type=file][multiple]')
    .setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByText('added a photo')).toBeVisible({ timeout: 15_000 });
});
