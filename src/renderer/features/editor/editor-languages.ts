// File name -> CodeMirror language. Each language is loaded on first use so
// opening the app does not pay for parsers it never needs.
import type { Extension } from '@codemirror/state';
import type { StreamParser } from '@codemirror/language';

export interface LanguageInfo {
  /** Shown in the editor status bar. */
  label: string;
  load(): Promise<Extension>;
}

const legacy = (label: string, get: () => Promise<StreamParser<unknown>>): LanguageInfo => ({
  label,
  load: async () => {
    const [{ StreamLanguage }, parser] = await Promise.all([import('@codemirror/language'), get()]);
    return StreamLanguage.define(parser);
  },
});

const js = (label: string, options: { jsx?: boolean; typescript?: boolean }): LanguageInfo => ({
  label,
  load: async () => (await import('@codemirror/lang-javascript')).javascript(options),
});

const BY_EXTENSION: Record<string, LanguageInfo> = {
  js: js('JavaScript', {}),
  mjs: js('JavaScript', {}),
  cjs: js('JavaScript', {}),
  jsx: js('JavaScript JSX', { jsx: true }),
  ts: js('TypeScript', { typescript: true }),
  mts: js('TypeScript', { typescript: true }),
  cts: js('TypeScript', { typescript: true }),
  tsx: js('TypeScript JSX', { jsx: true, typescript: true }),
  json: { label: 'JSON', load: async () => (await import('@codemirror/lang-json')).json() },
  jsonc: { label: 'JSON with comments', load: async () => (await import('@codemirror/lang-json')).json() },
  css: { label: 'CSS', load: async () => (await import('@codemirror/lang-css')).css() },
  scss: { label: 'SCSS', load: async () => (await import('@codemirror/lang-css')).css() },
  less: { label: 'Less', load: async () => (await import('@codemirror/lang-css')).css() },
  html: { label: 'HTML', load: async () => (await import('@codemirror/lang-html')).html() },
  htm: { label: 'HTML', load: async () => (await import('@codemirror/lang-html')).html() },
  vue: { label: 'Vue', load: async () => (await import('@codemirror/lang-html')).html() },
  md: { label: 'Markdown', load: async () => (await import('@codemirror/lang-markdown')).markdown() },
  markdown: { label: 'Markdown', load: async () => (await import('@codemirror/lang-markdown')).markdown() },
  py: { label: 'Python', load: async () => (await import('@codemirror/lang-python')).python() },
  java: { label: 'Java', load: async () => (await import('@codemirror/lang-java')).java() },
  xml: { label: 'XML', load: async () => (await import('@codemirror/lang-xml')).xml() },
  svg: { label: 'SVG', load: async () => (await import('@codemirror/lang-xml')).xml() },
  xaml: { label: 'XAML', load: async () => (await import('@codemirror/lang-xml')).xml() },
  csproj: { label: 'XML', load: async () => (await import('@codemirror/lang-xml')).xml() },
  yml: { label: 'YAML', load: async () => (await import('@codemirror/lang-yaml')).yaml() },
  yaml: { label: 'YAML', load: async () => (await import('@codemirror/lang-yaml')).yaml() },
  sql: { label: 'SQL', load: async () => (await import('@codemirror/lang-sql')).sql() },
  sh: legacy('Shell', async () => (await import('@codemirror/legacy-modes/mode/shell')).shell),
  bash: legacy('Shell', async () => (await import('@codemirror/legacy-modes/mode/shell')).shell),
  zsh: legacy('Shell', async () => (await import('@codemirror/legacy-modes/mode/shell')).shell),
  ps1: legacy('PowerShell', async () => (await import('@codemirror/legacy-modes/mode/powershell')).powerShell),
  psm1: legacy('PowerShell', async () => (await import('@codemirror/legacy-modes/mode/powershell')).powerShell),
  psd1: legacy('PowerShell', async () => (await import('@codemirror/legacy-modes/mode/powershell')).powerShell),
  properties: legacy('Properties', async () => (await import('@codemirror/legacy-modes/mode/properties')).properties),
  ini: legacy('INI', async () => (await import('@codemirror/legacy-modes/mode/properties')).properties),
  env: legacy('Env', async () => (await import('@codemirror/legacy-modes/mode/properties')).properties),
  toml: legacy('TOML', async () => (await import('@codemirror/legacy-modes/mode/toml')).toml),
  gradle: legacy('Groovy', async () => (await import('@codemirror/legacy-modes/mode/groovy')).groovy),
  groovy: legacy('Groovy', async () => (await import('@codemirror/legacy-modes/mode/groovy')).groovy),
  kt: legacy('Kotlin', async () => (await import('@codemirror/legacy-modes/mode/clike')).kotlin),
  kts: legacy('Kotlin', async () => (await import('@codemirror/legacy-modes/mode/clike')).kotlin),
  c: legacy('C', async () => (await import('@codemirror/legacy-modes/mode/clike')).c),
  h: legacy('C', async () => (await import('@codemirror/legacy-modes/mode/clike')).c),
  cpp: legacy('C++', async () => (await import('@codemirror/legacy-modes/mode/clike')).cpp),
  hpp: legacy('C++', async () => (await import('@codemirror/legacy-modes/mode/clike')).cpp),
  cs: legacy('C#', async () => (await import('@codemirror/legacy-modes/mode/clike')).csharp),
  go: legacy('Go', async () => (await import('@codemirror/legacy-modes/mode/go')).go),
  rs: legacy('Rust', async () => (await import('@codemirror/legacy-modes/mode/rust')).rust),
  rb: legacy('Ruby', async () => (await import('@codemirror/legacy-modes/mode/ruby')).ruby),
  lua: legacy('Lua', async () => (await import('@codemirror/legacy-modes/mode/lua')).lua),
  diff: legacy('Diff', async () => (await import('@codemirror/legacy-modes/mode/diff')).diff),
  patch: legacy('Diff', async () => (await import('@codemirror/legacy-modes/mode/diff')).diff),
};

const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  '.bashrc': 'sh',
  '.zshrc': 'sh',
  '.profile': 'sh',
  '.env': 'env',
  '.gitignore': 'properties',
  '.gitattributes': 'properties',
  '.editorconfig': 'ini',
  'tsconfig.json': 'jsonc',
  'jsconfig.json': 'jsonc',
  '.eslintrc': 'jsonc',
  '.prettierrc': 'json',
};

const DOCKERFILE: LanguageInfo = legacy('Dockerfile', async () => (await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile);
const PLAIN: LanguageInfo = { label: 'Plain text', load: async () => [] };

export function languageFor(fileName: string): LanguageInfo {
  const lower = fileName.toLowerCase();
  const byName = BY_NAME[lower];
  if (byName === 'dockerfile' || lower.startsWith('dockerfile.') || lower.endsWith('.dockerfile')) return DOCKERFILE;
  if (byName) return BY_EXTENSION[byName] ?? PLAIN;
  if (lower.startsWith('.env.')) return BY_EXTENSION.env!;
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  return BY_EXTENSION[ext] ?? PLAIN;
}
