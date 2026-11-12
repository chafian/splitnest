// WSL output throughput as a SplitNest user experiences it, in the PACKAGED app, for both ConPTY
// variants: system (the default) and bundled (TW_DIAG_CONPTY=bundled). Same machine, same file,
// same window size, alternating variants run by run.
//
// Per run: a fresh temporary profile with one WSL terminal; the same file (default 16 MB of base64
// text, 76-column lines) is printed with `cat` in it. Two numbers:
//   bash - bash's `time` for cat. SplitNest's flow control pauses the PTY while the terminal has
//          not processed what it was sent, so cat finishes only when the terminal has (nearly)
//          caught up: this is the throughput a user sees.
//   wall - from pressing Enter until a marker file written after cat exists (polled every
//          ~100 ms with wsl.exe, so it includes that polling).
// Commands are typed through the renderer page (Chromium --remote-debugging-port, local, temporary
// profile); nothing is read from the screen.
// Usage: node tests/perf/measure-packaged-wsl.mjs <splitnest.exe> [--distro Ubuntu-22.04] [--runs 3] [--mb 16]
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const exe = process.argv[2];
if (!exe || !existsSync(exe)) throw new Error('usage: node tests/perf/measure-packaged-wsl.mjs <splitnest.exe>');
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : d;
};
const distro = arg('--distro', 'Ubuntu-22.04');
const runs = Number(arg('--runs', '3'));
const mb = Number(arg('--mb', '16'));
const ps = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wsl = (cmd) => execFileSync('wsl.exe', ['-d', distro, '--', 'sh', '-c', cmd], { encoding: 'utf8' }).trim();
const exists = (f) => {
  try {
    execFileSync('wsl.exe', ['-d', distro, '--', 'test', '-f', f], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const tag = randomUUID().slice(0, 8);
const file = `/tmp/tw-perf-${tag}.txt`;
wsl(`head -c ${Math.round((mb * 1024 * 1024 * 3) / 4)} /dev/urandom | base64 -w 76 > ${file}`);
const bytes = Number(wsl(`stat -c %s ${file}`));

async function oneRun(variant, run) {
  const work = mkdtempSync(path.join(tmpdir(), `tw-perf-${variant}-`));
  const proj = path.join(work, 'perf');
  const ud = path.join(work, 'ud');
  mkdirSync(proj);
  mkdirSync(ud);
  const t = randomUUID();
  const p = randomUUID();
  const w = randomUUID();
  writeFileSync(path.join(ud, 'workspace-state.json'), JSON.stringify({ schemaVersion: 3, activeWorkspaceId: w, workspaces: [{ id: w, name: 'perf', rootPath: proj, layout: { type: 'pane', id: p, tabs: [{ id: t, kind: 'terminal', profileId: `wsl:${distro}` }], activeTabId: t }, activePaneId: p }], settings: { startShellsOnRestore: true } }));
  const port = 9300 + Math.floor(Math.random() * 500);
  const env = { ...process.env };
  if (variant === 'bundled') env.TW_DIAG_CONPTY = 'bundled';
  else delete env.TW_DIAG_CONPTY;
  const app = spawn(exe, [`--tw-user-data=${ud}`, `--remote-debugging-port=${port}`], { env, stdio: 'ignore' });
  let browser;
  const key = `${tag}-${variant}-${run}`;
  try {
    let page;
    for (let i = 0; i < 60 && !page; i++) {
      await sleep(500);
      try {
        browser ??= await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        page = browser.contexts().flatMap((c) => c.pages()).find((x) => x.url().includes('index.html'));
      } catch { /* not listening yet */ }
    }
    if (!page) throw new Error('could not attach to the renderer');
    await page.waitForSelector('[data-pane-id][data-status="running"]', { timeout: 90_000 });
    const size = await page.$eval('[data-pane-id] .pane__terminal', (e) => `${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}px`);
    await page.click('[data-pane-id] .pane__terminal', { position: { x: 30, y: 15 } });
    // Wait until bash reads input: it creates a file.
    for (let i = 0; i < 60 && !exists(`/tmp/tw-ready-${key}`); i++) {
      await page.keyboard.type(`touch /tmp/tw-ready-${key}`);
      await page.keyboard.press('Enter');
      await sleep(1000);
    }
    await page.keyboard.type("TIMEFORMAT='%R'; clear");
    await page.keyboard.press('Enter');
    await sleep(1500);
    await page.keyboard.type(`{ time cat ${file}; } 2> /tmp/tw-perf-${key}.time; touch /tmp/tw-perf-${key}.done`);
    const t0 = Date.now();
    await page.keyboard.press('Enter');
    while (!exists(`/tmp/tw-perf-${key}.done`) && Date.now() - t0 < 180_000) await sleep(50);
    const wall = (Date.now() - t0) / 1000;
    const bash = Number(wsl(`cat /tmp/tw-perf-${key}.time`));
    await browser.close().catch(() => undefined);
    // Quit (the native dialog asks because a shell is running).
    execFileSync(ps, ['-NoProfile', '-Command', `
      Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
      $A = [System.Windows.Automation.AutomationElement]
      [void](Get-Process -Id ${app.pid}).CloseMainWindow()
      $byPid = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, ${app.pid})
      $byName = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, 'End sessions and quit')
      $deadline = (Get-Date).AddSeconds(15)
      while ((Get-Date) -lt $deadline) {
        foreach ($w in $A::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $byPid)) {
          $b = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $byName)
          if ($b) { $b.SetFocus(); Start-Sleep -Milliseconds 150; (New-Object -ComObject WScript.Shell).SendKeys('{ENTER}'); exit }
        }
        Start-Sleep -Milliseconds 300
      }`], { stdio: 'ignore' });
    for (let i = 0; i < 100 && app.exitCode === null; i++) await sleep(200);
    return { conpty: variant, run, bashSeconds: bash, wallSeconds: Math.round(wall * 100) / 100, MBps: Math.round((bytes / 1048576 / bash) * 10) / 10, terminal: size };
  } finally {
    await browser?.close().catch(() => undefined);
    if (app.exitCode === null) {
      try { execFileSync('taskkill.exe', ['/T', '/F', '/PID', String(app.pid)], { stdio: 'ignore' }); } catch { /* gone */ }
    }
    try { wsl(`rm -f /tmp/tw-ready-${key} /tmp/tw-perf-${key}.time /tmp/tw-perf-${key}.done`); } catch { /* ignore */ }
    await sleep(1000);
    rmSync(work, { recursive: true, force: true });
  }
}

const results = [];
try {
  for (let run = 1; run <= runs; run++) {
    for (const variant of run % 2 ? ['system', 'bundled'] : ['bundled', 'system']) {
      const r = await oneRun(variant, run);
      console.log(JSON.stringify(r));
      results.push(r);
    }
  }
} finally {
  wsl(`rm -f ${file}`);
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log(`file: ${(bytes / 1048576).toFixed(1)} MB through \`cat\` in a WSL (${distro}) terminal, ${runs} runs per variant, packaged app`);
for (const v of ['system', 'bundled']) {
  const r = results.filter((x) => x.conpty === v);
  console.log(`${v.padEnd(8)} median bash ${median(r.map((x) => x.bashSeconds)).toFixed(2)} s, median wall ${median(r.map((x) => x.wallSeconds)).toFixed(2)} s (runs: ${r.map((x) => x.bashSeconds).join(', ')})`);
}
