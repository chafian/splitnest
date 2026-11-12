import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * index.html carries the strict production CSP. The dev server needs inline
 * scripts (React refresh preamble) and a websocket for HMR, so the policy is
 * relaxed only while serving.
 */
function devCsp(): Plugin {
  return {
    name: 'terminal-workspace-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        /<meta http-equiv="Content-Security-Policy" content="[^"]*"\s*\/>/,
        `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none'" />`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), devCsp()],
});
