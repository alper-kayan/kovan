import { defineConfig } from 'vitest/config';

// Unit tests cover the plain TypeScript in src/lib; screens are checked on the simulators.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], setupFiles: ['src/lib/i18n/testSetup.ts'] },
});
