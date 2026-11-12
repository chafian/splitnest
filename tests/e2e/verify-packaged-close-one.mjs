// Packaged-build check: closing ONE terminal (system ConPTY + fork guard).
//
// The packaged app has no test hooks and its inspect fuse is off, so Playwright attaches to the
// renderer page only, through Chromium's --remote-debugging-port (temporary profile, local port).
// Two PowerShell terminals side by side; `ping -t` runs in the first. Its tab's close button and
// "End session and close" are clicked like a user would. Then:
//   - the first shell, its ping and its console host have ended
//   - the second shell and its console host are still running (checked again after 3 s)
//   - no second SplitNest main process appeared at any point
//   - the fork guard answered exactly once (app log): the close went through node-pty's kill path
// Finally the window is closed and "End sessions and quit" pressed (UI Automation, native dialog);
// nothing may be left over. Only processes started here are ever stopped (last-resort cleanup).
// Usage: node tests/e2e/verify-packaged-close-one.mjs <path to splitnest.exe>
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const exe = process.argv[2];
if (!exe || !existsSync(exe)) throw new Error('usage: node tests/e2e/verify-packaged-close-one.mjs <splitnest.exe>');
const ps = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const psJson = (script) => JSON.parse(execFileSync(ps, ['-NoProfile', '-Command', script], { encoding: 'utf8' }) || 'null');

/** Processes started after `since` below `root` (pid, ppid, name). */
function tree(root, sinceIso) {
  const all = psJson(`@(Get-CimInstance Win32_Process | Where-Object { $_.CreationDate -ge [datetime]'${sinceIso}' } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name } }) | ConvertTo-Json -Compress`) ?? [];
  const list = Array.isArray(all) ? all : [all];
  const out = [];
  const queue = [root];
  while (queue.length) {
    const id = queue.shift();
    for (const p of list) if (p.ppid === id && p.pid !== id) { out.push(p); queue.push(p.pid); }
  }
  return out;
}
const alive = (pid) => psJson(`[bool](Get-Process -Id ${pid} -ErrorAction SilentlyContinue) | ConvertTo-Json`);
const mains = () => {
  const r = psJson(`@(Get-CimInstance Win32_Process -Filter "Name='splitnest.exe'" | Where-Object { $_.CommandLine -and [string]$_.CommandLine -notmatch '--type=' } | ForEach-Object { [int]$_.ProcessId }) | ConvertTo-Json -Compress`);
  return r === null ? [] : Array.isArray(r) ? r : [r];
};

const work = mkdtempSync(path.join(tmpdir(), 'tw-close1-'));
const proj = path.join(work, 'close-one');
const ud = path.join(work, 'ud');
mkdirSync(proj);
mkdirSync(ud);
const panes = [1, 2].map(() => {
  const t = randomUUID();
  return { type: 'pane', id: randomUUID(), tabs: [{ id: t, kind: 'terminal', profileId: 'windows-powershell' }], activeTabId: t };
});
const ws = randomUUID();
writeFileSync(path.join(ud, 'workspace-state.json'), JSON.stringify({ schemaVersion: 3, activeWorkspaceId: ws, workspaces: [{ id: ws, name: 'close-one', rootPath: proj, layout: { type: 'split', id: randomUUID(), direction: 'row', children: panes, sizes: [0.5, 0.5] }, activePaneId: panes[0].id }], settings: { startShellsOnRestore: true } }));

const result = { exe };
const since = new Date(Date.now() - 1000).toISOString();
const mainsBefore = mains();
const port = 9300 + Math.floor(Math.random() * 500);
const app = spawn(exe, [`--tw-user-data=${ud}`, `--remote-debugging-port=${port}`], { detached: false, stdio: 'ignore' });
const extra = new Set();
const watchMains = () => { for (const m of mains()) if (m !== app.pid && !mainsBefore.includes(m)) extra.add(m); };
let watched = [];
let browser;
try {
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500);
    try {
      browser ??= await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('index.html'));
    } catch { /* not listening yet */ }
  }
  if (!page) throw new Error('could not attach to the renderer');
  await page.waitForFunction(() => document.querySelectorAll('[data-pane-id][data-status="running"]').length === 2, null, { timeout: 60_000 });
  await sleep(2500);
  const [first, second] = await page.$$eval('[data-pane-id]', (els) => els.map((e) => e.getAttribute('data-pane-id')));
  await page.click(`[data-pane-id="${first}"] .pane__terminal`, { position: { x: 30, y: 15 } });
  await page.keyboard.type('ping -t 127.0.0.1');
  await page.keyboard.press('Enter');
  let ping;
  let procs = [];
  for (let i = 0; i < 30 && !ping; i++) {
    await sleep(500);
    procs = tree(app.pid, since);
    ping = procs.find((p) => p.name === 'PING.EXE');
  }
  if (!ping) throw new Error('ping did not start');
  const closing = procs.find((p) => p.pid === ping.ppid);
  const other = procs.find((p) => p.name === 'powershell.exe' && p.pid !== closing.pid && p.ppid === closing.ppid);
  const hostsBefore = procs.filter((p) => /^(conhost|OpenConsole)\.exe$/i.test(p.name) && p.ppid === closing.ppid);
  watched = procs.filter((p) => /^(powershell|PING|conhost|OpenConsole)\.exe$/i.test(p.name) && p.ppid !== app.pid);
  result.before = `shells ${closing.pid} (ping ${ping.pid}) and ${other?.pid}; console hosts under the PTY host: ${hostsBefore.length}`;

  // Close the first terminal with its tab's close button, and confirm.
  await page.click(`[data-pane-id="${first}"] button[aria-label^="Close terminal"]`);
  await page.click('dialog[open] button:has-text("End session and close")');
  result.confirmPressed = true;
  for (let i = 0; i < 50 && (alive(closing.pid) || alive(ping.pid)); i++) {
    watchMains();
    await sleep(200);
  }
  await sleep(3000);
  watchMains();
  const hostsAfter = tree(app.pid, since).filter((p) => /^(conhost|OpenConsole)\.exe$/i.test(p.name) && p.ppid === closing.ppid);
  result.closedShellEnded = !alive(closing.pid);
  result.pingEnded = !alive(ping.pid);
  result.otherShellRunning = !!other && alive(other.pid);
  result.otherPaneStillShown = (await page.$$eval('[data-pane-id]', (els) => els.map((e) => e.getAttribute('data-pane-id')))).includes(second);
  result.consoleHosts = `${hostsBefore.length} -> ${hostsAfter.length}`;
  result.secondInstanceAfterClose = extra.size > 0;
  const log = path.join(ud, 'logs', 'splitnest.log');
  const answers = () => (existsSync(log) ? (readFileSync(log, 'utf8').match(/console-list request answered in-process/g) ?? []).length : -1);
  result.guardAnswersAfterClose = answers();
  await browser.close().catch(() => undefined); // detaches only; the app keeps running

  // Quit normally: the remaining session ends too.
  const quit = execFileSync(ps, ['-NoProfile', '-Command', `
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $A = [System.Windows.Automation.AutomationElement]
    $proc = Get-Process -Id ${app.pid}; 'window=' + $proc.MainWindowHandle + ' closed=' + $proc.CloseMainWindow()
    $byPid = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, ${app.pid})
    $byName = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, 'End sessions and quit')
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline) {
      foreach ($w in $A::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $byPid)) {
        $b = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $byName)
        if ($b) {
          $p = $null
          if ($b.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke() }
          else { $b.SetFocus(); Start-Sleep -Milliseconds 150; (New-Object -ComObject WScript.Shell).SendKeys('{ENTER}') } # the message box's buttons have no Invoke pattern
          'pressed'; exit
        }
      }
      Start-Sleep -Milliseconds 300
    }
    'not found'`], { encoding: 'utf8' }).trim();
  result.quitLog = quit.split(/\r?\n/).join(' | ');
  result.quitPressed = /pressed$/.test(quit);
  for (let i = 0; i < 100 && app.exitCode === null; i++) {
    watchMains();
    await sleep(200);
  }
  await sleep(3000);
  result.appExited = app.exitCode !== null;
  const left = watched.filter((p) => alive(p.pid));
  result.leftOverAfterQuit = left.map((p) => `${p.name} ${p.pid}`).join(', ');
  result.guardAnswersTotal = answers();
  result.secondInstanceSeen = extra.size > 0;
  result.ok =
    result.closedShellEnded && result.pingEnded && result.otherShellRunning && result.otherPaneStillShown &&
    hostsAfter.length === hostsBefore.length - 1 && result.guardAnswersAfterClose === 1 &&
    result.quitPressed && result.appExited && left.length === 0 && !result.secondInstanceSeen;
} finally {
  await browser?.close().catch(() => undefined);
  if (app.exitCode === null) {
    try { execFileSync('taskkill.exe', ['/T', '/F', '/PID', String(app.pid)], { stdio: 'ignore' }); } catch { /* gone */ }
  }
  for (const p of watched) { try { process.kill(p.pid); } catch { /* gone */ } }
  await sleep(1000);
  rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
