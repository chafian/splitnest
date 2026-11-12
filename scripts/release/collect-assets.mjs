// Release workflow: gathers the release files from `npm run make` under stable names, writes
// SHA256SUMS.txt and BINARIES.md, and the release notes.
//   node scripts/release/collect-assets.mjs <out dir> <assets dir>
//
// Names (fixed, without the version, so that the website's
// releases/latest/download/<name> links always point at the newest stable release):
//   SplitNest-win32-x64-Setup.exe     installer (Squirrel.Windows)
//   SplitNest-win32-x64-portable.zip  portable build (no installer, no automatic updates)
//   RELEASES, splitnest-<version>-full.nupkg   the update feed Squirrel reads (names as Squirrel
//                                     writes them; RELEASES refers to the package by name)
//   SHA256SUMS.txt, BINARIES.md       checksums and the binary inventory
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [outArg, assetsArg] = process.argv.slice(2);
if (!outArg || !assetsArg) throw new Error('usage: collect-assets.mjs <out dir> <assets dir>');
const root = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const out = path.resolve(outArg);
const assets = path.resolve(assetsArg);
mkdirSync(assets, { recursive: true });

const squirrel = path.join(out, 'make', 'squirrel.windows', 'x64');
const zipDir = path.join(out, 'make', 'zip', 'win32', 'x64');
const need = (p) => {
  if (!existsSync(p)) throw new Error(`missing build output: ${p}`);
  return p;
};
const nupkg = `${pkg.name}-${pkg.version}-full.nupkg`;
const zips = existsSync(zipDir) ? readdirSync(zipDir).filter((f) => f.endsWith('.zip')) : [];
if (zips.length !== 1) throw new Error(`expected one portable ZIP in ${zipDir}, found ${zips.length}`);
const files = [
  [need(path.join(squirrel, 'SplitNest-win32-x64-Setup.exe')), 'SplitNest-win32-x64-Setup.exe'],
  [need(path.join(squirrel, 'RELEASES')), 'RELEASES'],
  [need(path.join(squirrel, nupkg)), nupkg],
  [need(path.join(zipDir, zips[0])), 'SplitNest-win32-x64-portable.zip'],
];
for (const [from, name] of files) copyFileSync(from, path.join(assets, name));

// Binary inventory (fails on wrong metadata for our binaries).
execFileSync(process.execPath, [path.join(root, 'scripts', 'binary-inventory.mjs'), '--out', out, '--md', path.join(assets, 'BINARIES.md')], { stdio: 'inherit' });

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const names = [...files.map(([, n]) => n), 'BINARIES.md'];
writeFileSync(path.join(assets, 'SHA256SUMS.txt'), names.map((n) => `${sha(path.join(assets, n))}  ${n}`).join('\n') + '\n');

// Release notes: the CHANGELOG section for this version, plus how to verify.
const changelog = existsSync(path.join(root, 'CHANGELOG.md')) ? readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8') : '';
const section = new RegExp(`^## \\[?${pkg.version.replace(/\./g, '\\.')}\\]?[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(changelog)?.[1]?.trim();
const notes = [
  section || `SplitNest ${pkg.version}.`,
  '',
  '### Download',
  '- **Installer:** `SplitNest-win32-x64-Setup.exe` (per-user, no administrator rights, updates itself; see the [privacy policy](https://splitnest.dev/privacy/) for the update check).',
  '- **Portable:** `SplitNest-win32-x64-portable.zip` (no installer, never checks for updates).',
  '',
  '### Verify',
  '- Compare SHA-256 hashes with `SHA256SUMS.txt` ([how](https://splitnest.dev/download/#verify-the-sha-256-checksum)). `BINARIES.md` lists every Windows binary, ours and upstream.',
  `- These files are built by GitHub Actions from tag \`v${pkg.version}\` of this repository, with a build provenance attestation: \`gh attestation verify <file> -R ${process.env.GITHUB_REPOSITORY ?? 'chafian/splitnest'}\`.`,
  '- This release is **not code signed** yet; see the [code signing policy](https://splitnest.dev/code-signing/).',
  '',
].join('\n');
writeFileSync(path.join(assets, '..', 'release-notes.md'), notes);
console.log(`Collected ${names.length + 1} release files in ${assets}`);
