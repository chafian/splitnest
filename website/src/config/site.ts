/**
 * Single source for site-wide constants and download URLs.
 * The release asset names are provisional until the installer work is verified:
 * change them here and nowhere else.
 */
export const SITE = {
  name: 'SplitNest',
  url: 'https://splitnest.dev',
  tagline: 'The Windows terminal workspace built for AI coding agents',
  description:
    'SplitNest is a Windows terminal workspace for AI coding agents: PowerShell and WSL in split panes, live Claude Code, Codex and Gemini CLI status on every tab, notifications when an agent needs you, and one-click resume after a restart.',
  repo: 'https://github.com/chafian/splitnest',
  license: 'MIT',
  licenseUrl: 'https://github.com/chafian/splitnest/blob/main/LICENSE',
  owner: 'Souf CH',
  year: 2026,
} as const;

const RELEASES = `${SITE.repo}/releases`;
const LATEST = `${RELEASES}/latest/download`;

export const DOWNLOADS = {
  installer: `${LATEST}/SplitNest-win32-x64-Setup.exe`,
  portable: `${LATEST}/SplitNest-win32-x64-portable.zip`,
  checksums: `${LATEST}/SHA256SUMS.txt`,
  installerName: 'SplitNest-win32-x64-Setup.exe',
  portableName: 'SplitNest-win32-x64-portable.zip',
  releases: RELEASES,
  releasesApi: 'https://api.github.com/repos/chafian/splitnest/releases',
  latestApi: 'https://api.github.com/repos/chafian/splitnest/releases/latest',
} as const;

export const LINKS = {
  repo: SITE.repo,
  userGuide: `${SITE.repo}/blob/main/docs/USER_GUIDE.md`,
  architecture: `${SITE.repo}/blob/main/docs/ARCHITECTURE.md`,
  testing: `${SITE.repo}/blob/main/docs/TESTING.md`,
  thirdParty: `${SITE.repo}/blob/main/THIRD_PARTY_LICENSES.md`,
  issues: `${SITE.repo}/issues`,
  githubPrivacy: 'https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement',
} as const;

export const NAV = [
  { label: 'Features', href: '/features/' },
  { label: 'Use cases', href: '/use-cases/' },
  { label: 'Docs', href: '/docs/' },
  { label: 'Changelog', href: '/changelog/' },
  { label: 'Download', href: '/download/' },
] as const;

export const AGENTS = [
  'Claude Code',
  'Codex',
  'Gemini CLI',
  'GitHub Copilot CLI',
  'Cursor Agent',
  'Aider',
  'OpenCode',
  'Qwen Code',
  'Amp',
] as const;
