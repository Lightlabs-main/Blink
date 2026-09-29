import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/api/src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'apps/mobile/**'],
    // First test in a file pays the cold import of Solana/Prisma modules on slow disks.
    testTimeout: 20_000,
  },
})
