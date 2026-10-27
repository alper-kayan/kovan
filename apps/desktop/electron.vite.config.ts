import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

// Everything is bundled into the app except node-pty (native code), so a packaged build needs
// no node_modules beyond it.
const bundled = [
  'zod',
  'electron-updater',
  '@kovan/shared',
  '@kovan/git-engine',
  '@kovan/harness',
  '@kovan/model-gateway',
  '@kovan/jevrouter',
  '@kovan/mcp-client',
  '@kovan/runner',
];

/**
 * Content-Security-Policy for the renderer. Dev additionally needs the inline React Refresh
 * preamble and the Vite HMR websocket.
 */
function csp(): Plugin {
  let dev = false;
  return {
    name: 'kovan-csp',
    configResolved(config) {
      dev = config.command === 'serve';
    },
    transformIndexHtml() {
      const policy = [
        "default-src 'self'",
        `script-src 'self'${dev ? " 'unsafe-inline'" : ''}`,
        "style-src 'self' 'unsafe-inline'",
        // Profile photos from the sign-in providers.
        "img-src 'self' data: blob: https://avatars.githubusercontent.com https://*.googleusercontent.com",
        "font-src 'self' data:",
        "worker-src 'self' blob:",
        `connect-src 'self'${dev ? ' ws://localhost:* http://localhost:*' : ''}`,
        "object-src 'none'",
        "base-uri 'none'",
      ].join('; ');
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

export default defineConfig({
  main: {
    // What a release build is built for; both are empty in development.
    define: {
      __KOVAN_SERVER_URL__: JSON.stringify(process.env['KOVAN_BUILD_SERVER_URL'] ?? ''),
      __KOVAN_UPDATE_PUBLIC_KEY__: JSON.stringify(process.env['KOVAN_UPDATE_PUBLIC_KEY'] ?? ''),
    },
    build: {
      externalizeDeps: { exclude: bundled },
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          // Background agents: agentd, started by the app as Node, outlives its windows.
          agentd: resolve(import.meta.dirname, '../../packages/agentd/src/index.ts'),
          // The MCP bridge Claude Code starts for agentd's runs.
          'claude-mcp': resolve(import.meta.dirname, '../../packages/runner/src/claude/mcpRun.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        // Sandboxed preloads must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    resolve: {
      alias: { '@renderer': resolve(import.meta.dirname, 'src/renderer/src') },
    },
    plugins: [react(), csp()],
  },
});
