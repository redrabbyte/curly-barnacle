/**
 * Where an invite token lives on this device, and why it is not in the URL
 * path any more (design §4.7).
 *
 * The token is a live capability. Hashing it at rest — which the server does,
 * with a comment explaining exactly why — bought nothing while the raw value
 * was a path segment, because a path segment reaches:
 *
 *  - the application's own request log, which deliberately keeps `req.url`;
 *  - the access log of whatever web server sits in front, paired with an IP;
 *  - browser history, which survives the invite itself; and
 *  - the `Referer` of any outbound navigation from the invite page.
 *
 * A fragment reaches none of them. It is never sent to a server, so the first
 * two cannot see it, and `Referer` never carries one. History still has it,
 * which is the honest remaining cost — but history is on the device of the
 * person the link was meant for.
 *
 * The awkward part is the login round trip. Sending someone to `/login` and
 * back used to carry the token through `?next=/invite/<token>`, which put it
 * straight back into a URL — and a query string is logged exactly like a path.
 * So it is parked here instead: `sessionStorage`, which is scoped to this tab,
 * dies with it, and never travels. `next` then only has to say `/invite`.
 *
 * The group's name rides in the same fragment, after a dot (design §4.2). The
 * server holds the name sealed and cannot put it on a landing page, and the
 * person following the link holds no key by construction — so the inviter's
 * own device, which has the name opened, writes it into the link. The same
 * fragment, for the same reason: it is the one place in a URL a server never
 * sees.
 */

const STASH_KEY = 'invite-token';

/** Everything a link carries: the capability, and what it is for. */
export interface Invite {
  token: string;
  /** Null for a link from before the name travelled in it. */
  name: string | null;
}

/** `<token>.<name>` — the dot is outside the token's base64url alphabet. */
const SEPARATOR = '.';

const utf8 = { encode: (s: string) => new TextEncoder().encode(s), decode: (b: Uint8Array) => new TextDecoder().decode(b) };

/**
 * The fragment for a link. base64url rather than percent-encoding so a name
 * with spaces or an umlaut survives every messenger that rewrites URLs.
 */
export function inviteFragment(token: string, name: string): string {
  const bytes = utf8.encode(name);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  return `${token}${SEPARATOR}${b64}`;
}

/** The token and the name out of a fragment, in either shape. */
export function parseInviteFragment(fragment: string): Invite | null {
  if (!fragment) return null;
  const at = fragment.indexOf(SEPARATOR);
  if (at === -1) return { token: fragment, name: null };
  const token = fragment.slice(0, at);
  const encoded = fragment.slice(at + 1);
  try {
    const bin = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const name = utf8.decode(bytes).trim();
    return { token, name: name === '' ? null : name };
  } catch {
    // A mangled suffix costs the name, never the invite.
    return { token, name: null };
  }
}

/** The invite as it arrived, from the fragment or from before a login. */
export function readInvite(): Invite | null {
  const fromHash = location.hash.replace(/^#/, '');
  if (fromHash) return parseInviteFragment(decodeURIComponent(fromHash));
  try {
    const stashed = sessionStorage.getItem(STASH_KEY);
    return stashed ? parseInviteFragment(stashed) : null;
  } catch {
    // Private-mode Safari has historically thrown here. A missing token is a
    // link that has to be followed again, not a broken page.
    return null;
  }
}

/** Hold it across the trip to the login screen, so `next` can stay a bare path. */
export function stashInvite(invite: Invite): void {
  try {
    sessionStorage.setItem(STASH_KEY, invite.name === null ? invite.token : inviteFragment(invite.token, invite.name));
  } catch {
    /* nothing to do: the invite page will ask them to follow the link again */
  }
}

/** Once it has been spent, or once the page is done with it. */
export function clearInviteToken(): void {
  try {
    sessionStorage.removeItem(STASH_KEY);
  } catch {
    /* see above */
  }
}
