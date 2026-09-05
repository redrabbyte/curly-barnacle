import { ME, expect, seedGroup, seedGroupKey, signIn, test } from '../fixtures/api';

const GROUP = 'dddddddd-8888-4888-8888-dddddddddddd';

/**
 * The new-entry form above the expense list starts folded to its first line —
 * the description and a show/hide button — so the list is what you see when
 * you open a group. Typing a description or pressing the button unfolds it.
 */

async function openGroup(page: import('@playwright/test').Page, api: Parameters<typeof seedGroup>[0]) {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP);
  await signIn(page);
  await page.goto(`/g/${GROUP}`);
  await expect(page.getByPlaceholder('What was it?')).toBeVisible({ timeout: 15_000 });
}

test('the form starts folded and the button unfolds it and folds it back', async ({ page, api }) => {
  await openGroup(page, api);

  const amount = page.getByPlaceholder('0.00');
  const show = page.getByRole('button', { name: 'Show', exact: true });
  const hide = page.getByRole('button', { name: 'Hide', exact: true });

  await expect(amount).toHaveCount(0);
  await expect(page.getByText('Paid by')).toHaveCount(0);
  await expect(show).toHaveAttribute('aria-expanded', 'false');

  await show.click();
  await expect(amount).toBeVisible();
  await expect(page.getByText('Paid by')).toBeVisible();
  await expect(hide).toHaveAttribute('aria-expanded', 'true');

  await hide.click();
  await expect(amount).toHaveCount(0);
  await expect(show).toBeVisible();
});

test('typing a description unfolds the form, and adding the entry folds it again', async ({ page, api }) => {
  await openGroup(page, api);

  await page.getByPlaceholder('What was it?').fill('Two coffees');
  await expect(page.getByRole('button', { name: 'Hide', exact: true })).toBeVisible();
  await page.getByPlaceholder('0.00').fill('9.60');
  await page.getByRole('button', { name: 'Add expense' }).click();

  await expect(page.getByRole('link', { name: /Two coffees/ })).toBeVisible();
  await expect(page.getByPlaceholder('What was it?')).toHaveValue('');
  await expect(page.getByPlaceholder('0.00')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show', exact: true })).toBeVisible();
});
