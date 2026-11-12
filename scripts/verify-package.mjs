// Verifies a packaged Windows build: required native files are unpacked from
// the ASAR archive and the app's headless self-test (node-pty in the PTY host
// utility process, real PowerShell, session kill) passes.
// Usage: node scripts/verify-package.mjs [out/SplitNest-win32-x64]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const appDir = path.resolve(process.argv[2] ?? 'out/SplitNest-win32-x64');
const exe = path.join(appDir, 'splitnest.exe');
const unpacked = path.join(appDir, 'resources', 'app.asar.unpacked', 'node_modules', 'node-pty');
const required = [
  exe,
  path.join(appDir, 'resources', 'app.asar'),
  path.join(unpacked, 'lib', 'index.js'),
  path.join(unpacked, 'lib', 'worker', 'conoutSocketWorker.js'),
  path.join(unpacked, 'prebuilds', 'win32-x64', 'conpty.node'),
  path.join(unpacked, 'prebuilds', 'win32-x64', 'pty.node'),
  path.join(unpacked, 'prebuilds', 'win32-x64', 'conpty', 'conpty.dll'),
  path.join(unpacked, 'prebuilds', 'win32-x64', 'conpty', 'OpenConsole.exe'),
];
const missing = required.filter((f) => !existsSync(f));
if (missing.length) {
  console.error('Missing packaged files:\n' + missing.join('\n'));
  process.exit(1);
}

const work = mkdtempSync(path.join(tmpdir(), 'tw-verify-'));
const output = path.join(work, 'self-test.json');
const run = spawnSync(exe, [`--self-test-output=${output}`, `--tw-user-data=${path.join(work, 'user-data')}`], {
  timeout: 90_000,
  windowsHide: true,
});
if (!existsSync(output)) {
  console.error(`Self-test produced no result (exit ${run.status}, ${run.error?.message ?? 'no error'})`);
  process.exit(1);
}
const result = JSON.parse(readFileSync(output, 'utf8'));
console.log(JSON.stringify(result, null, 2));
rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
process.exit(result.ok && run.status === 0 ? 0 : 1);
