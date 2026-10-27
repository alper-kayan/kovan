import { resolve } from 'node:path';
import { BILLING_CONSENT, BILLING_CONSENT_VERSION, MANAGED_MARKUP } from '@kovan/shared';
import { defineConfig } from 'vite';
import { sitePlugin } from './plugins/site';

const root = import.meta.dirname;
const page = (path: string) => resolve(root, path);
const SERVER = 'http://localhost:4807';

export default defineConfig({
  root,
  appType: 'mpa',
  plugins: [sitePlugin(root)],
  // Billing constants come from @kovan/shared at build time, so the site never ships its schemas.
  define: {
    __BILLING_CONSENT__: JSON.stringify(BILLING_CONSENT),
    __BILLING_CONSENT_VERSION__: JSON.stringify(BILLING_CONSENT_VERSION),
    __MANAGED_MARKUP__: JSON.stringify(MANAGED_MARKUP),
  },
  server: {
    port: 4810,
    strictPort: true,
    proxy: {
      '/api': SERVER,
      '/auth': SERVER,
      // Only the release redirects; /download/ itself is a page of this site.
      '^/download/(mac|windows-x64|windows-arm64|linux)$': SERVER,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Small assets stay files: the server's CSP has no data: for fonts or scripts.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        home: page('index.html'),
        demo: page('demo/index.html'),
        docs: page('docs/index.html'),
        models: page('models/index.html'),
        changelog: page('changelog/index.html'),
        download: page('download/index.html'),
        account: page('account/index.html'),
        billing: page('account/billing/index.html'),
        security: page('security/index.html'),
        privacy: page('privacy/index.html'),
        terms: page('terms/index.html'),
        contact: page('contact/index.html'),
        notFound: page('404.html'),
      },
    },
  },
});
