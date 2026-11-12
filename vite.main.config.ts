import { defineConfig } from 'vite';

// Used for the main process and the PTY host. node-pty is loaded at runtime
// from an explicit path and must never be bundled.
export default defineConfig({
  // The GitHub repository whose Releases are the update feed. The release workflow builds with its
  // own repository (TW_UPDATE_REPO = github.repository), so test repositories update from themselves.
  define: {
    __SPLITNEST_UPDATE_REPO__: JSON.stringify(process.env.TW_UPDATE_REPO || 'chafian/splitnest'),
  },
  build: {
    rollupOptions: {
      external: ['node-pty'],
    },
  },
});
