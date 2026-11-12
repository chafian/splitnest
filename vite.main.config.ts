import { defineConfig } from 'vite';

// Used for the main process and the PTY host. node-pty is loaded at runtime
// from an explicit path and must never be bundled.
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['node-pty'],
    },
  },
});
