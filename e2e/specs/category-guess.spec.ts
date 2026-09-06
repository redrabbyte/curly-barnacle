import { ME, expect, seedGroup, seedGroupKey, signIn, test } from '../fixtures/api';

const GROUP = 'dddddddd-9999-4999-9999-dddddddddddd';

/**
 * The category follows what the entry is called, until somebody picks one.
 *
 * The matching itself is unit-tested (`categoryGuess.test.ts`); what is worth
 * a browser is the part that unit test cannot see — that the dropdown really
 * moves as the name is typed, and really stops moving once it has been used.
 */

const category = (page: import('@playwright/test').Page) =>
  page.locator('select').filter({ has: page.locator('option[value="groceries"]') });

async function openGroup(page: import('@playwright/test').Page, api: Parameters<typeof seedGroup>[0]) {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP);
  await signIn(page);
  await page.goto(`/g/${GROUP}`);
  await expect(page.getByPlaceholder('What was it?')).toBeVisible({ timeout: 15_000 });
}

test('the category follows the name', async ({ page, api }) => {
  await openGroup(page, api);
  const name = page.getByPlaceholder('What was it?');

  await name.fill('Pizza');
  await expect(category(page)).toHaveValue('food');

  // A German name in an English app: both languages' words are read.
  await name.fill('Lidl Wocheneinkauf');
  await expect(category(page)).toHaveValue('groceries');

  // And back to the catch-all when the name stops saying anything, rather than
  // leaving the mark of a name that is no longer there.
  await name.fill('Sundries');
  await expect(category(page)).toHaveValue('other');
});

test('picking a category yourself ends the guessing', async ({ page, api }) => {
  await openGroup(page, api);
  const name = page.getByPlaceholder('What was it?');

  await name.fill('Pizza');
  await expect(category(page)).toHaveValue('food');

  await category(page).selectOption('transport');
  await name.fill('Lidl Wocheneinkauf');
  await expect(category(page)).toHaveValue('transport');

  await page.getByPlaceholder('0.00').fill('12.00');
  await page.getByRole('button', { name: 'Add expense' }).click();
  await expect(page.getByRole('link', { name: /Lidl Wocheneinkauf/ })).toBeVisible();
});
