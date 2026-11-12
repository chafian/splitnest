// Measurements that need the inside view (test hooks), run on the same production bundles as the
// packaged build (`npm run package` builds .vite/) but under the development Electron runtime,
// because the packaged app disables Node inspection. Temp folders and an isolated profile only.
//   1. launch -> interactive prompt (first PowerShell prompt visible in xterm)
//   2. output throughput: a 16 MB file through `cmd /c type` and through `wsl cat` (ConPTY -> xterm),
//      CPU per process class, UI frame gaps while it streams
//   3. resize: 5 terminals with scrollback, a 20-step window drag; frame gaps and settle time
// Usage: node tests/perf/measure-dev.mjs [--runs 3] [--out result.json]   (after `npm run package`)
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
};
const RUNS = Number(arg('--runs', '3'));
const OUT = arg('--out', '');
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// CPU time (ms) per process class under the app's root process, via one PowerShell CIM query.
function cpuByClass(rootPid) {
  const ps = `
$all = Get-CimInstance Win32_Process; $kids=@{}; foreach($p in $all){ $kids[[int]$p.ParentProcessId] += ,$p }
$out=@(); $q=[System.Collections.Queue]::new(); $q.Enqueue(${rootPid}); $seen=@{}
$r = $all | ? { $_.ProcessId -eq ${rootPid} }; if($r){ $out += $r }
while($q.Count){ $id=$q.Dequeue(); foreach($c in $kids[$id]){ if(-not $seen[$c.ProcessId] -and $c.ProcessId -ne $id){ $seen[$c.ProcessId]=1; $out+=$c; $q.Enqueue([int]$c.ProcessId) } } }
$out | % { $t = try { (Get-Process -Id $_.ProcessId -ErrorAction Stop).TotalProcessorTime.TotalMilliseconds } catch { 0 }
  $type = if ([string]$_.CommandLine -match '--type=([a-z-]+)') { $Matches[1] } else { '' }
  [pscustomobject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; name=$_.Name; type=$type; cpu=[math]::Round($t) } } | ConvertTo-Json -Compress`;
  const rows = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true }) || '[]');
  const list = Array.isArray(rows) ? rows : [rows];
  const cls = {};
  for (const r of list) {
    const n = r.name.toLowerCase();
    const c =
      n === 'electron.exe' ? (r.pid === rootPid ? 'app: main' : r.type ? `app: ${r.type}` : 'app: other')
      : n === 'openconsole.exe' || n === 'conhost.exe' ? 'console host (ConPTY)'
      : n === 'powershell.exe' ? (r.ppid === rootPid ? 'app helper: agent detection' : 'shell: PowerShell')
      : n === 'cmd.exe' ? 'output source: cmd type'
      : n.startsWith('wsl') ? 'output source: wsl'
      : `other: ${n}`;
    cls[c] = (cls[c] ?? 0) + r.cpu;
  }
  return cls;
}
const diff = (a, b) => Object.fromEntries(Object.keys({ ...a, ...b }).map((k) => [k, (b[k] ?? 0) - (a[k] ?? 0)]));

async function launch(work, proj) {
  const t0 = Date.now();
  const app = await electron.launch({
    executablePath: require('electron'),
    args: ['.', `--tw-user-data=${path.join(work, 'ud')}`],
    cwd: root,
    env: { ...process.env, TW_E2E: '1', TW_E2E_PICK_FOLDER: proj },
  });
  const page = await app.firstWindow();
  const tWindow = Date.now() - t0;
  await page.setViewportSize({ width: 1600, height: 900 }).catch(() => undefined);
  await page.click('button:has-text("Open folder…")');
  const tab = await page.waitForSelector('[data-pane-id]').then(() => page.getAttribute('[data-pane-id]', 'data-active-tab'));
  await page.waitForFunction((t) => /PS perf-project>\s*$/m.test(window.__twTest?.inspect(t, 200)?.text ?? ''), tab, { timeout: 60_000 });
  return { app, page, tab, tWindow, tPrompt: Date.now() - t0 };
}

// Frame gaps in the renderer while `fn` runs (rAF intervals).
async function withFrames(page, fn) {
  await page.evaluate(() => {
    window.__frames = [];
    let last = performance.now();
    const tick = (t) => {
      window.__frames.push(t - last);
      last = t;
      if (window.__framesOn) requestAnimationFrame(tick);
    };
    window.__framesOn = true;
    requestAnimationFrame(tick);
  });
  const value = await fn();
  const gaps = await page.evaluate(() => {
    window.__framesOn = false;
    return window.__frames.slice(1);
  });
  const s = [...gaps].sort((a, b) => a - b);
  return { value, frames: s.length, p95FrameMs: Math.round(s[Math.floor(s.length * 0.95)] ?? 0), maxFrameMs: Math.round(s.at(-1) ?? 0), framesOver50ms: s.filter((g) => g > 50).length };
}

const typeIn = async (page, text) => {
  await page.click('.tabview:not([hidden]) .pane__terminal', { position: { x: 40, y: 20 } });
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};

const results = { machineNote: 'see docs/native-architecture-feasibility.md', startup: [], throughput: [], resize: [] };
for (let run = 1; run <= RUNS; run++) {
  const work = mkdtempSync(path.join(tmpdir(), 'tw-perfdev-'));
  const proj = path.join(work, 'perf-project');
  mkdirSync(proj);
  // 200,000 lines x ~80 chars = ~16 MB of plain text.
  const big = path.join(work, 'big.txt');
  writeFileSync(big, Array.from({ length: 200_000 }, (_, i) => `line ${String(i).padStart(6, '0')} the quick brown fox jumps over the lazy dog 0123456789 abcdef`).join('\r\n') + '\r\n');
  const { app, page, tab, tWindow, tPrompt } = await launch(work, proj);
  const rootPid = app.process().pid;
  results.startup.push({ run, windowMs: tWindow, promptMs: tPrompt });
  console.log(`run ${run}: window ${tWindow} ms, prompt ${tPrompt} ms`);
  await page.waitForTimeout(3000);

  for (const [label, cmd] of [
    ['cmd type (PowerShell tab)', `cmd /c type "${big}"; Write-Output ("DONE" + "-" + "MARK")`],
    ['wsl cat (PowerShell tab)', `wsl.exe -e cat "$(wsl.exe -e wslpath -a '${big.replace(/\\/g, '\\\\')}')"; Write-Output ("DONE" + "-" + "MARK2")`],
  ]) {
    const marker = label.startsWith('wsl') ? 'DONE-MARK2' : 'DONE-MARK';
    const cpu0 = cpuByClass(rootPid);
    const t0 = Date.now();
    const f = await withFrames(page, async () => {
      await typeIn(page, cmd);
      await page.waitForFunction(([t, m]) => new RegExp(`^${m}$`, 'm').test(window.__twTest.inspect(t, 40).text), [tab, marker], { timeout: 300_000 });
      return Date.now() - t0;
    });
    const cpu = diff(cpu0, cpuByClass(rootPid));
    const seconds = f.value / 1000;
    results.throughput.push({ run, label, wallMs: f.value, mbPerSec: Math.round((16 / seconds) * 10) / 10, cpuPctOfOneCore: Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, Math.round((v / f.value) * 1000) / 10])), ...f });
    console.log(`  ${label}: ${f.value} ms, p95 frame ${f.p95FrameMs} ms, max ${f.maxFrameMs} ms`);
    await typeIn(page, 'Clear-Host');
    await page.waitForTimeout(1500);
  }

  // Resize: 5 panes with scrollback, then a window drag.
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Control+Shift+D');
    await page.waitForFunction((c) => document.querySelectorAll('[data-pane-id]').length === c, i + 2);
  }
  const tabs = await page.$$eval('[data-pane-id]', (els) => els.map((e) => e.getAttribute('data-active-tab')));
  for (const t of tabs) await page.waitForFunction((id) => window.__twTest.status(id) === 'running' && /PS perf-project>\s*$/m.test(window.__twTest.inspect(id, 200).text), t, { timeout: 60_000 });
  for (const p of await page.$$eval('[data-pane-id]', (els) => els.map((e) => e.getAttribute('data-pane-id')))) {
    await page.click(`[data-pane-id="${p}"] .tabview:not([hidden]) .pane__terminal`, { position: { x: 20, y: 20 } });
    await page.keyboard.type('1..2000 | % { "row $_ some text to fill the scrollback buffer" }');
    await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(4000);
  const drag = await withFrames(page, async () => {
    for (let i = 1; i <= 20; i++) {
      await page.setViewportSize({ width: 1600 - i * 30, height: 900 - i * 15 }).catch(() => undefined);
      await page.waitForTimeout(16);
    }
    const t0 = Date.now();
    // Settled: every terminal's columns stay the same for 300 ms.
    let last = '';
    let stableSince = Date.now();
    while (Date.now() - t0 < 5000) {
      const cols = await page.evaluate((ids) => ids.map((id) => window.__twTest.inspect(id, 1).cols).join(','), tabs);
      if (cols !== last) {
        last = cols;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 300) break;
      await page.waitForTimeout(20);
    }
    return stableSince - t0;
  });
  results.resize.push({ run, terminals: tabs.length, settleAfterLastStepMs: drag.value, frames: drag.frames, p95FrameMs: drag.p95FrameMs, maxFrameMs: drag.maxFrameMs, framesOver50ms: drag.framesOver50ms });
  console.log(`  resize: settle ${drag.value} ms, p95 frame ${drag.p95FrameMs} ms, max ${drag.maxFrameMs} ms`);

  await app.evaluate(() => {
    globalThis.__twQuitAsk = () => Promise.resolve('discard');
  });
  await app.close().catch(() => undefined);
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    /* temp folder; Windows may still hold a handle */
  }
}
results.summary = {
  promptMsMedian: median(results.startup.map((r) => r.promptMs)),
  windowMsMedian: median(results.startup.map((r) => r.windowMs)),
};
const json = JSON.stringify(results, null, 2);
if (OUT) writeFileSync(OUT, json);
console.log(json);
process.exit(0);
