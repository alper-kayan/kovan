import { defineConfig } from 'vitest/config';

// Tests read the English texts, whatever this computer's language is.
export default defineConfig({ test: { env: { KOVAN_LANG: 'en' } } });
