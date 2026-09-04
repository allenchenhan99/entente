import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts', 'apps/**/src/**/*.test.tsx'],
    passWithNoTests: true,
    // Fixtures and timeline tests format local time; pin the zone so CI (UTC) and laptops (+08:00) agree.
    env: { TZ: 'Asia/Taipei' },
    // Real PTY round trips are slow on CI runners.
    testTimeout: 20_000,
  },
});
