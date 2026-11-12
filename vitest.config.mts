import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // PTY and WSL tests start real processes; run files one at a time.
    fileParallelism: false,
    projects: [
      {
        test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'node' },
      },
      {
        // Real PowerShell sessions through real node-pty (Windows only).
        test: { name: 'pty', include: ['tests/pty/**/*.test.ts'], environment: 'node', testTimeout: 45_000, hookTimeout: 30_000 },
      },
      {
        // Requires an installed WSL distribution; skipped (and reported) otherwise.
        test: { name: 'wsl', include: ['tests/wsl/**/*.test.ts'], environment: 'node', testTimeout: 90_000, hookTimeout: 60_000 },
      },
    ],
  },
});
