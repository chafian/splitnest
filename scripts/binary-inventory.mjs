// Inventory of every Windows binary SplitNest ships, and a metadata check for the ones we build.
//
//   node scripts/binary-inventory.mjs [--out <dir>] [--md <file>] [--json <file>]
//
// Looks in <out>/SplitNest-win32-x64 (the packaged app) and, if present, in the Squirrel output
// (<out>/make/squirrel.windows/x64: Setup.exe, and every binary inside the .nupkg). For each PE file
// (.exe, .dll, .node) it records: where it is, SHA-256, product name, product and file version,
// company, the current Authenticode signature, and whether it is OURS (built from this repository's
// build, to be code signed) or UPSTREAM (built by another project, shipped as is, never signed with
// SplitNest's certificate; see CODE_SIGNING.md).
//
// Our binaries must have product name "SplitNest" and the package.json version as product version
// (SignPath Foundation's metadata rules); the script exits with 1 if one doesn't.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { squirrelVersion } from './release/squirrel-version.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const out = path.resolve(root, opt('out', process.env.TW_OUT_DIR || 'out'));
const appDir = path.join(out, `${pkg.productName}-win32-x64`);
const squirrelDir = path.join(out, 'make', 'squirrel.windows', 'x64');
const PRODUCT = pkg.productName;
const VERSION = pkg.version;
// Squirrel writes Setup.exe's version in its own form (0.2.0-beta.1 -> 0.2.0-beta1); Windows may add a 4th part.
const VERSIONS = new Set([VERSION, squirrelVersion(VERSION), `${VERSION}.0`]);
const PE = /\.(exe|dll|node)$/i;

/**
 * Ours: the app executable (Electron's binary, renamed and stamped by our build), the installer, and
 * Squirrel's launcher stub generated for our app. Everything else is upstream.
 */
function classify(rel, where) {
  const name = path.basename(rel).toLowerCase();
  if (where === 'app' && rel.toLowerCase() === `${pkg.name}.exe`) return 'ours';
  if (where === 'installer' && name === `${PRODUCT.toLowerCase()}-win32-x64-setup.exe`) return 'ours';
  if (where === 'nupkg' && name === `${pkg.name}.exe`) return 'ours';
  if (where === 'nupkg' && name === `${pkg.name}_executionstub.exe`) return 'ours';
  return 'upstream';
}

function walk(dir, base = dir) {
  const files = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...walk(p, base));
    else if (PE.test(e.name)) files.push({ full: p, rel: path.relative(base, p).replace(/\\/g, '/') });
  }
  return files;
}

/** Version info and signature for many files at once (one PowerShell process). */
function describe(files) {
  if (!files.length) return [];
  const list = path.join(mkdtempSync(path.join(tmpdir(), 'tw-inv-')), 'files.txt');
  writeFileSync(list, files.map((f) => f.full).join('\n'), 'utf8');
  const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
Get-Content -LiteralPath '${list.replace(/'/g, "''")}' -Encoding UTF8 | ForEach-Object {
  $v = (Get-Item -LiteralPath $_).VersionInfo; $s = Get-AuthenticodeSignature -LiteralPath $_
  [pscustomobject]@{ product = $v.ProductName; productVersion = $v.ProductVersion; fileVersion = $v.FileVersion; company = $v.CompanyName
    signature = [string]$s.Status; signer = $(if ($s.SignerCertificate) { ($s.SignerCertificate.Subject -split ', ')[0] -replace '^CN=', '' } else { $null }) }
} | ConvertTo-Json -Compress -Depth 3`;
  const json = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', maxBuffer: 64 << 20 });
  rmSync(path.dirname(list), { recursive: true, force: true });
  const rows = JSON.parse(json);
  return Array.isArray(rows) ? rows : [rows];
}

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const entries = [];
if (!existsSync(appDir)) {
  console.error(`No packaged app at ${appDir}. Run \`npm run package\` (or \`npm run make\`) first.`);
  process.exit(2);
}
const groups = [{ where: 'app', files: walk(appDir) }];
const tempDirs = [];
if (existsSync(squirrelDir)) {
  groups.push({ where: 'installer', files: walk(squirrelDir).filter((f) => !f.rel.includes('/')) });
  for (const n of readdirSync(squirrelDir).filter((f) => f.endsWith('-full.nupkg'))) {
    // A .nupkg is a ZIP; list the binaries Squirrel will install from it.
    const x = mkdtempSync(path.join(tmpdir(), 'tw-nupkg-'));
    tempDirs.push(x);
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory('${path.join(squirrelDir, n).replace(/'/g, "''")}', '${x.replace(/'/g, "''")}')`]);
    groups.push({ where: 'nupkg', package: n, files: walk(x) });
  }
}
for (const g of groups) {
  const info = describe(g.files);
  g.files.forEach((f, i) => {
    entries.push({
      where: g.where === 'nupkg' ? `${g.package}` : g.where === 'app' ? `${pkg.productName}-win32-x64` : 'installer',
      file: f.rel,
      kind: classify(f.rel, g.where),
      bytes: statSync(f.full).size,
      sha256: sha256(f.full),
      ...info[i],
    });
  });
}
for (const d of tempDirs) rmSync(d, { recursive: true, force: true });

// Metadata rules for our binaries. Squirrel's launcher stub carries no version resource of its own.
const problems = [];
for (const e of entries.filter((x) => x.kind === 'ours')) {
  if (/_executionstub\.exe$/i.test(e.file)) continue;
  if (e.product !== PRODUCT) problems.push(`${e.where}/${e.file}: product name "${e.product}", expected "${PRODUCT}"`);
  if (!VERSIONS.has(String(e.productVersion ?? ''))) problems.push(`${e.where}/${e.file}: product version "${e.productVersion}", expected ${VERSION}`);
  if (e.company !== PRODUCT) problems.push(`${e.where}/${e.file}: company "${e.company}", expected "${PRODUCT}"`);
}

const md = [
  `# SplitNest ${VERSION}: Windows binaries`,
  '',
  'Generated by `scripts/binary-inventory.mjs`. **Ours** are built by this repository\'s release workflow and are the only files to be code signed; **upstream** files are shipped exactly as their projects publish them (see CODE_SIGNING.md).',
  '',
  '| Where | File | Ours / upstream | Product | Version | Company | Signature | SHA-256 |',
  '|---|---|---|---|---|---|---|---|',
  ...entries.map((e) => `| ${e.where} | \`${e.file}\` | ${e.kind} | ${e.product ?? ''} | ${e.productVersion ?? ''} | ${e.company ?? ''} | ${e.signature}${e.signer ? ` (${e.signer})` : ''} | \`${e.sha256.slice(0, 16)}…\` |`),
  '',
].join('\n');
const mdFile = opt('md');
const jsonFile = opt('json');
if (mdFile) writeFileSync(mdFile, md);
if (jsonFile) writeFileSync(jsonFile, JSON.stringify({ product: PRODUCT, version: VERSION, entries, problems }, null, 2));
if (!mdFile && !jsonFile) console.log(md);
const ours = entries.filter((e) => e.kind === 'ours').length;
console.log(`${entries.length} binaries: ${ours} ours, ${entries.length - ours} upstream.`);
if (problems.length) {
  console.error(`Metadata problems:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('Metadata of our binaries: OK');
