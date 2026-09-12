import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { DOCUMENT_META_TAGS } from './src/documentPolicy';
import { linkPreviewTags } from './src/linkPreview';

/**
 * Insert a block of tags immediately before the document's closing head tag.
 *
 * Deliberately the *last* `</head>`, not the first. A `</head>` written
 * anywhere else in the file — inside a comment, in a string, in prose — is
 * still a literal match, and injecting at it drops the tags into the middle of
 * whatever that construct is. That is not hypothetical: a comment mentioning
 * the tag by name once landed the app's `<script>` inside the comment, and the
 * built page rendered white because nothing ever loaded.
 *
 * This makes *our* injections safe from that. Vite's own asset injection is
 * not — it takes the first match — which is why the checked-in `index.html`
 * is separately pinned to exactly one closing head tag by documentPolicy.test.ts.
 */
const injectIntoHead = (html: string, tags: string): string => {
  const at = html.lastIndexOf('</head>');
  if (at === -1) throw new Error('index.html has no closing head tag to inject into');
  return `${html.slice(0, at)}${tags}\n  ${html.slice(at)}`;
};

/**
 * Put the document's security policy in the document.
 *
 * Build only: the dev server's HMR client runs inline script and `eval`, so a
 * meta CSP in the checked-in `index.html` would break `pnpm dev` and get
 * deleted by whoever hit it first. Injecting here means the policy cannot be
 * lost that way, and cannot be forgotten by an operator either — it ships
 * inside the file rather than depending on the web server in front of it.
 */
const documentPolicy = (): Plugin => ({
  name: 'spendapp:document-policy',
  apply: 'build',
  transformIndexHtml: (html) => injectIntoHead(html, `  ${DOCUMENT_META_TAGS}`),
});

/**
 * Inject the absolute-URL link-preview tags, if an origin is configured.
 *
 * Separate from `documentPolicy` because it is conditional and environment-fed,
 * where the policy is unconditional and checked in. See src/linkPreview.ts for
 * why the hostname cannot live in this repo.
 */
const linkPreview = (): Plugin => ({
  name: 'spendapp:link-preview',
  apply: 'build',
  transformIndexHtml: (html) => {
    const tags = linkPreviewTags(process.env.APP_ORIGIN);
    if (!tags) {
      // Visible in the deploy log, because a silently thumbnail-less preview is
      // hard to trace back to a missing variable months later.
      console.warn('[spendapp:link-preview] APP_ORIGIN unset or unusable — og:url/og:image omitted');
      return html;
    }
    return injectIntoHead(html, `  ${tags}`);
  },
});

export default defineConfig({
  // Stamped at build time (UTC date + time); shown small under the title.
  define: { __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')) },
  plugins: [
    documentPolicy(),
    linkPreview(),
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectManifest: {
        /**
         * The images too, not only the bundle.
         *
         * The default patterns are js/css/html, and the plugin adds whatever
         * the webmanifest names on top — which covers the app icons and misses
         * `badge-96.png` entirely, because nothing links to it. It is fetched
         * by the *platform*, when a push arrives, to draw the status-bar icon.
         *
         * Left out of the precache, that fetch has to reach the network at the
         * moment a notification is drawn, which is exactly the moment a phone
         * is least likely to be on one. When it fails nothing errors: Android
         * quietly substitutes its own generic glyph — a bell — and the app
         * looks like it chose a bell instead of its own mark.
         */
        // Named on its own rather than by widening the patterns to `png`: the
        // app icons are already precached because the webmanifest names them,
        // and globbing them again lists each of them twice.
        globPatterns: ['**/*.{js,css,html}', 'badge-96.png'],
        // The QR decoder is 128 KiB and lazily imported so that only an admin
        // who opens the scanner pays for it — but precaching it handed that
        // cost straight back, to everyone, on every service-worker install.
        // That install is what stands between a deploy and the update prompt,
        // so it is worth keeping lean.
        //
        // Nothing is lost offline: scanning someone in needs `/admit` to
        // reach the server, so a decoder cached for an offline device could
        // never finish the job it was cached for.
        globIgnores: ['**/jsQR-*.js'],
      },
      manifest: {
        name: 'SpendApp',
        short_name: 'SpendApp',
        description: 'Shared expenses with friends',
        theme_color: '#0f766e',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      // Caching/navigation/push behavior lives in src/sw.ts (injectManifest).
    }),
  ],
  server: {
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
});
