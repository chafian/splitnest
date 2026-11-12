// Release workflow: checks a release's files before (and after) they are published.
//   node scripts/release/verify-assets.mjs <assets dir> <version>
//
// - every required file is there, nothing unexpected, no empty file;
// - SHA256SUMS.txt matches every file;
// - the Squirrel update feed is consistent: RELEASES has exactly one full package line, naming
//   splitnest-<version>-full.nupkg with that file's SHA-1 and size (what Squirrel.Windows checks
//   before applying an update), and the package's .nuspec has the same version.
// (File metadata of the binaries is checked by scripts/binary-inventory.mjs when collecting.)
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const [dirArg, version] = process.argv.slice(2);
if (!dirArg || !version) throw new Error('usage: verify-assets.mjs <assets dir> <version>');
const dir = path.resolve(dirArg);
const nupkg = `splitnest-${version}-full.nupkg`;
const required = ['SplitNest-win32-x64-Setup.exe', 'SplitNest-win32-x64-portable.zip', 'RELEASES', nupkg, 'SHA256SUMS.txt', 'BINARIES.md'];
const problems = [];
const present = readdirSync(dir);
for (const f of required) if (!present.includes(f)) problems.push(`missing ${f}`);
for (const f of present) if (!required.includes(f)) problems.push(`unexpected file ${f}`);
for (const f of present) if (statSync(path.join(dir, f)).size === 0) problems.push(`empty file ${f}`);
const hash = (algo, f) => createHash(algo).update(readFileSync(path.join(dir, f))).digest('hex');

if (present.includes('SHA256SUMS.txt')) {
  const lines = readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8').trim().split(/\r?\n/);
  const listed = new Map(lines.map((l) => [l.slice(66), l.slice(0, 64)]));
  for (const f of required.filter((r) => r !== 'SHA256SUMS.txt')) {
    if (!listed.has(f)) problems.push(`SHA256SUMS.txt does not list ${f}`);
    else if (present.includes(f) && listed.get(f) !== hash('sha256', f)) problems.push(`SHA-256 mismatch for ${f}`);
  }
}

if (present.includes('RELEASES') && present.includes(nupkg)) {
  const entries = readFileSync(path.join(dir, 'RELEASES'), 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/).filter(Boolean);
  const full = entries.map((l) => l.trim().split(/\s+/)).filter((p) => p[1]?.endsWith('-full.nupkg'));
  if (full.length !== 1) problems.push(`RELEASES should list one full package, lists ${full.length}`);
  else {
    const [sha1, name, size] = full[0];
    if (name !== nupkg) problems.push(`RELEASES names ${name}, expected ${nupkg}`);
    if (sha1.toLowerCase() !== hash('sha1', nupkg)) problems.push('RELEASES SHA-1 does not match the package (Squirrel would refuse the update)');
    if (Number(size) !== statSync(path.join(dir, nupkg)).size) problems.push('RELEASES size does not match the package');
  }
  // The package's own version (its .nuspec; a .nupkg is a ZIP), read with .NET's ZIP reader.
  try {
    const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z = [IO.Compression.ZipFile]::OpenRead($env:TW_NUPKG); try { $e = $z.GetEntry('splitnest.nuspec'); $r = New-Object IO.StreamReader($e.Open()); $r.ReadToEnd() } finally { $z.Dispose() }`;
    const nuspec = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', env: { ...process.env, TW_NUPKG: path.join(dir, nupkg) } });
    const v = /<version>([^<]+)<\/version>/.exec(nuspec)?.[1];
    if (v !== version) problems.push(`package version ${v}, expected ${version}`);
  } catch {
    problems.push('could not read the package manifest (splitnest.nuspec)');
  }
}

if (problems.length) {
  console.error(`Release files are NOT ready:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`Release files for ${version}: all ${required.length} present, checksums and update feed consistent.`);
