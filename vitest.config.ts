import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // Builds the migrated, seeded database image once; every test loads its own copy (PGlite).
    globalSetup: ['packages/db/test/global-setup.ts'],
    // The first test in a file waits for PGlite's WebAssembly start-up, slow when every worker does it at once.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
