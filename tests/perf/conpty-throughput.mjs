// Raw ConPTY throughput, no terminal emulator or UI (the ceiling any app on ConPTY shares):
// Usage: node tests/perf/conpty-throughput.mjs
// how long, how many bytes ConPTY emits and
// in how many chunks, for the same 16 MB file through `cmd /c type` and `wsl cat`.
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const pty = require('node-pty');
const work = mkdtempSync(path.join(tmpdir(), 'tw-conpty-tp-'));
const big = path.join(work, 'big.txt');
writeFileSync(big, Array.from({ length: 200_000 }, (_, i) => `line ${String(i).padStart(6, '0')} the quick brown fox jumps over the lazy dog 0123456789 abcdef`).join('\r\n') + '\r\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
const ps = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

async function run(useConptyDll, label, cmd, marker) {
  const p = pty.spawn(ps, ['-NoLogo', '-NoProfile', '-NoExit', '-Command', 'Set-PSReadLineOption -HistorySaveStyle SaveNothing'], { name: 'xterm-256color', cols: 120, rows: 40, cwd: work, env: process.env, useConptyDll });
  let out = '';
  p.onData((d) => (out += d));
  while (!/PS .*>\s*$/.test(plain(out))) await sleep(20);
  await sleep(800);
  let bytes = 0;
  let chunks = 0;
  let tail = '';
  const sub = p.onData((d) => {
    bytes += d.length;
    chunks++;
    tail = (tail + d).slice(-4000);
  });
  const t0 = Date.now();
  p.write(cmd + '\r');
  while (!new RegExp(marker).test(plain(tail)) && Date.now() - t0 < 120000) await sleep(5);
  const ms = Date.now() - t0;
  sub.dispose();
  p.kill();
  await sleep(500);
  return { conpty: useConptyDll ? 'bundled' : 'system', label, ms, mbEmitted: Math.round((bytes / 1048576) * 10) / 10, chunks };
}
for (const dll of [true, false]) {
  console.log(JSON.stringify(await run(dll, 'cmd type', `cmd /c type "${big}"; Write-Output ("DONE"+"-MARK")`, 'DONE-MARK')));
  console.log(JSON.stringify(await run(dll, 'wsl cat', `wsl.exe -e cat "$(wsl.exe -e wslpath -a '${big.replace(/\\/g, '\\\\')}')"; Write-Output ("DONE"+"-MARK2")`, 'DONE-MARK2')));
}
rmSync(work, { recursive: true, force: true });
process.exit(0);
