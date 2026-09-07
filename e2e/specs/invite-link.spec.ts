import { expect, seedGroup, seedGroupKey, signIn, test } from '../fixtures/api';

const GROUP = '33333333-3333-4333-8333-333333333333';
// The token is in the fragment, deliberately: a fragment is never sent to a
// server, so it cannot reach the API's request log, the proxy's access log, or
// the `Referer` of anything the invite page loads (design §4.7). The group's
// name rides after it, base64url — the server holds the name sealed and cannot
// put it on the landing page, so the inviting device writes it into the link.
const EXPECTED = 'http://127.0.0.1:4173/invite#tokAAAAAAAAAAAAAAAAAA.VHJpcA';

test.beforeEach(async ({ api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: '11111111-1111-4111-8111-111111111111', displayName: 'Lukas', isPlaceholder: false },
  ]);
  // The link carries the name, which this device can only write in once it
  // has opened it — so it needs the key, like every member does.
  await seedGroupKey(api, GROUP);
});

async function showLink(page: import('@playwright/test').Page): Promise<void> {
  // Through the form, so the account keys are on the device: the link
  // carries the group's name, and only a device that can open it writes it in.
  await signIn(page);
  await page.goto(`/g/${GROUP}`);
  await page.getByRole('button', { name: 'Invite link' }).click();
  // Two steps now: how much history the link shares is a choice, not a default
  // to be discovered afterwards (design §4.7).
  await page.getByRole('button', { name: /sharing everything/i }).click();
  await page.getByText(/valid 14 days/).waitFor();
}

test('copies the link to the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await showLink(page);
  await page.getByRole('button', { name: 'Copy link' }).click();
  await expect(page.getByText('Copied')).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(EXPECTED);
});

test('hands the link to the share sheet where one exists', async ({ page, context }) => {
  await context.addInitScript(`navigator.share = (data) => { window.__shared = data; return Promise.resolve(); }`);
  await showLink(page);
  await page.getByRole('button', { name: 'Share link' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __shared?: { url?: string } }).__shared?.url))
    .toBe(EXPECTED);
});

test('dismissing the share sheet is not an error', async ({ page, context }) => {
  await context.addInitScript(
    `navigator.share = () => Promise.reject(Object.assign(new Error('cancel'), { name: 'AbortError' }))`,
  );
  await showLink(page);
  await page.getByRole('button', { name: 'Share link' }).click();
  await expect(page.getByText('Sharing failed')).toHaveCount(0);
});

test('offers no share button where the browser has no share sheet', async ({ page, context }) => {
  await context.addInitScript(`Object.defineProperty(navigator, 'share', { value: undefined, configurable: true })`);
  await showLink(page);
  await expect(page.getByRole('button', { name: 'Share link' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy link' })).toHaveCount(1);
});

test('falls back when the clipboard API is unavailable (insecure context)', async ({ page, context }) => {
  await context.addInitScript(`Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })`);
  await showLink(page);
  await page.getByRole('button', { name: 'Copy link' }).click();
  // Either the execCommand fallback worked or it said so — never nothing.
  await expect(page.getByText(/Copied|Could not copy/)).toBeVisible();
});
