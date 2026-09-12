import { describe, expect, it } from 'vitest';
import { linkPreviewTags, previewOrigin } from './linkPreview';

/**
 * Link-preview tags, pinned on the two things that can actually go wrong.
 *
 * One: a hostname must never end up committed to this repo, so the tags have to
 * be absent by default and appear only when the environment supplies an origin.
 * A regression here is invisible locally and only shows up as one operator's
 * domain in everybody else's build.
 *
 * Two: the output is interpolated straight into `index.html`, so a value that
 * escapes its attribute would be an HTML injection in the built document.
 */

describe('previewOrigin', () => {
  it('returns null when unset, empty or whitespace', () => {
    for (const v of [undefined, '', '   ', '\n']) expect(previewOrigin(v)).toBeNull();
  });

  it('normalises away path, query, fragment and trailing slash', () => {
    for (const v of [
      'https://example.test',
      'https://example.test/',
      'https://example.test/some/path',
      'https://example.test/?a=b#c',
    ]) {
      expect(previewOrigin(v)).toBe('https://example.test');
    }
  });

  it('keeps a non-default port, which a self-hosted deployment may well use', () => {
    expect(previewOrigin('http://localhost:5173/')).toBe('http://localhost:5173');
  });

  it('allows http so a LAN or onion deployment still gets previews', () => {
    expect(previewOrigin('http://spend.lan')).toBe('http://spend.lan');
  });

  it('rejects non-http(s) schemes and unparseable values rather than throwing', () => {
    for (const v of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'not a url', '//example.test']) {
      expect(previewOrigin(v)).toBeNull();
    }
  });
});

describe('linkPreviewTags', () => {
  it('emits nothing without an origin — the default, so no build carries a hostname', () => {
    expect(linkPreviewTags(undefined)).toBe('');
    expect(linkPreviewTags('')).toBe('');
    expect(linkPreviewTags('javascript:alert(1)')).toBe('');
  });

  it('emits og:url and an absolute og:image with its real dimensions', () => {
    const tags = linkPreviewTags('https://example.test');
    expect(tags).toContain('<meta property="og:url" content="https://example.test/" />');
    expect(tags).toContain('<meta property="og:image" content="https://example.test/icon-512.png" />');
    expect(tags).toContain('<meta property="og:image:width" content="512" />');
    expect(tags).toContain('<meta property="og:image:height" content="512" />');
  });

  it('cannot break out of the HTML attribute it is interpolated into', () => {
    // The tag markup itself contains <, > and quotes, so assert on the injected
    // VALUES: every content="..." must be a clean URL or a bare number, with no
    // quote or angle bracket smuggled in from the input. URL parsing either
    // rejects these or strips them into the path, which never reaches origin.
    for (const hostile of [
      'https://example.test/"><script>alert(1)</script>',
      'https://example.test/#"><img src=x onerror=alert(1)>',
      'https://exa"mple.test',
      'https://example.test/\'onmouseover=\'alert(1)',
    ]) {
      const tags = linkPreviewTags(hostile);
      if (tags === '') continue; // rejected outright, which is also fine
      const values = [...tags.matchAll(/content="([^"]*)"/g)].map((m) => m[1]);
      expect(values.length).toBeGreaterThan(0);
      for (const v of values) {
        expect(v).not.toMatch(/["'<>]/);
        expect(v).toMatch(/^(https?:\/\/[A-Za-z0-9.\-:]+(?:\/[A-Za-z0-9.\-]*)?|\d+)$/);
      }
    }
  });
});
