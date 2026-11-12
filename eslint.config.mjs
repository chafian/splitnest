import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['.vite/**', 'out/**', 'node_modules/**', 'coverage/**', 'website/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // The renderer must not reach Node.js or Electron directly.
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['electron', 'node:*', 'fs', 'path', 'child_process', 'os', 'node-pty'], message: 'Renderer code has no Node.js or Electron access; use window.appApi.' },
            { group: ['**/main/**', '**/pty-host/**', '**/preload/**'], message: 'Renderer may only import shared modules.' },
          ],
        },
      ],
    },
  },
);
