import { describe, expect, it } from 'vitest';
import { inviteFragment, parseInviteFragment } from './inviteToken';

/**
 * The invite fragment carries the token and, after a dot, the group's name
 * (design §4.2, §4.7). The token is a capability and must come back exactly;
 * the name is a courtesy and must never cost the token.
 */

const TOKEN = 'tokAAAAAAAAAAAAAAAAAA';

describe('the invite fragment', () => {
  it('carries the name after the token, and reads both back', () => {
    const fragment = inviteFragment(TOKEN, 'Trip');
    expect(fragment).toBe(`${TOKEN}.VHJpcA`);
    expect(parseInviteFragment(fragment)).toEqual({ token: TOKEN, name: 'Trip' });
  });

  it('survives characters a messenger would otherwise mangle', () => {
    for (const name of ['Flat 12b', 'Wohnung für Jürgen', '🍝 Pasta night', 'a/b+c=d']) {
      const fragment = inviteFragment(TOKEN, name);
      // Nothing outside the URL-safe alphabet, so no messenger rewrites it.
      expect(fragment).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(parseInviteFragment(fragment)).toEqual({ token: TOKEN, name });
    }
  });

  it('reads a link from before the name travelled in it', () => {
    expect(parseInviteFragment(TOKEN)).toEqual({ token: TOKEN, name: null });
  });

  it('loses a mangled name rather than the invite', () => {
    expect(parseInviteFragment(`${TOKEN}.!!!not-base64!!!`)).toEqual({ token: TOKEN, name: null });
    expect(parseInviteFragment(`${TOKEN}.`)).toEqual({ token: TOKEN, name: null });
  });

  it('is nothing for an empty fragment', () => {
    expect(parseInviteFragment('')).toBeNull();
  });
});
