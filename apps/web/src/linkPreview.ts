/**
 * Absolute-URL link-preview tags (`og:url`, `og:image`).
 *
 * Unfurlers — Signal, WhatsApp, Discord, Slack, Mastodon — fetch a shared link
 * within seconds and render a card from the `og:` tags. Title and description
 * live in `index.html` because they are the same for every deployment. These two
 * cannot: the Open Graph spec requires absolute URLs, and an absolute URL means
 * somebody's hostname.
 *
 * This repo is public and self-hostable, so a hostname must never be committed
 * to it. The value therefore comes from the environment at build time —
 * `APP_ORIGIN`, the same variable the server already treats as the canonical
 * public origin, set once in the shared `.env` by `deploy/setup.sh`.
 *
 * Unset — a plain `pnpm build`, or a self-hoster who has not configured it — and
 * the tags are simply omitted: previews keep their title and description and
 * lose only the thumbnail. Guessing a hostname would be worse than omitting it,
 * because a wrong `og:image` renders as a broken card.
 */

/** The app icon used as the preview thumbnail. In `public/`, so served at the root. */
const PREVIEW_IMAGE = '/icon-512.png';

/** Matches the real file; unfurlers can lay out the card without fetching it first. */
const PREVIEW_IMAGE_SIZE = { width: 512, height: 512 } as const;

/**
 * Normalise a configured origin down to scheme://host[:port].
 *
 * Returns `null` for anything unusable rather than throwing: link previews are
 * cosmetic and must not be able to fail a deploy. A bad value here means
 * `APP_ORIGIN` is wrong, which breaks the `__Host-` session cookie long before
 * it breaks a preview card — that is the failure worth reporting, and it is not
 * this module's to report.
 */
export const previewOrigin = (raw: string | undefined): string | null => {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // `http:` is allowed so a LAN or onion deployment still gets previews.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // `URL.origin` drops any path, query or trailing slash, and cannot contain a
  // quote or angle bracket — so the result is safe to interpolate into an
  // HTML attribute below without further escaping.
  return url.origin === 'null' ? null : url.origin;
};

/**
 * The tags to inject, or `''` when no usable origin is configured.
 *
 * Indented to match `DOCUMENT_META_TAGS` so the built `index.html` stays
 * readable when someone views source.
 */
export const linkPreviewTags = (raw: string | undefined): string => {
  const origin = previewOrigin(raw);
  if (!origin) return '';
  return [
    `<meta property="og:url" content="${origin}/" />`,
    `<meta property="og:image" content="${origin}${PREVIEW_IMAGE}" />`,
    `<meta property="og:image:width" content="${PREVIEW_IMAGE_SIZE.width}" />`,
    `<meta property="og:image:height" content="${PREVIEW_IMAGE_SIZE.height}" />`,
  ].join('\n    ');
};
