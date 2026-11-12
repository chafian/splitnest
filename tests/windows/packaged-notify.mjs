// Packaged build, real Windows notifications, checked together with a person at the desktop.
//
//   node tests/windows/packaged-notify.mjs <path\to\splitnest.exe> <control dir>
//
// Starts the packaged SplitNest with a fresh temporary profile and a workspace "Notification Test"
// with two tabs, "Backend" and "Other". In Backend, a copy of PING.EXE named claude.exe runs, so
// SplitNest's real process detection finds "Claude Code" (no real agent, no prompt); its states
// are real OSC 7501 reports printed by a PowerShell loop in that tab when a trigger file appears.
//
// Then it waits for commands: write <control>/cmd-<n>.json = { "name": ..., "delayMs": ... }.
//   banner | taskbar | privacy  select Other, minimize SplitNest, after delayMs raise a permission
//                               request from Backend, then watch for the window to come back
//   finish                      quit SplitNest, remove this run's notifications, undo the
//                               Windows registrations the build made, delete the temp folder
// Results are appended to <control>/results.jsonl; progress goes to stderr.
//
// Privacy: every notification SplitNest shows here is tagged "<run token>-…" (--tw-notify-id), and
// everything read from Windows goes through tests/windows/notifications.ps1, which selects by
// SplitNest's app id and that tag before reading any text and outputs only ids and pass/fail.
// No screenshots, no UI Automation of Notification Center: banners are clicked by the person.
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const require = createRequire(path.join(root, 'package.json'));
const { chromium } = require('playwright-core');
const helper = path.join(here, 'notifications.ps1');
const [exeArg, controlArg] = process.argv.slice(2);
if (!exeArg || !controlArg) throw new Error('usage: packaged-notify.mjs <splitnest.exe> <control dir>');
const exe = path.resolve(exeArg);
const control = path.resolve(controlArg);
mkdirSync(control, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (m) => process.stderr.write(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}\n`);
const result = (step, data) => {
  appendFileSync(path.join(control, 'results.jsonl'), JSON.stringify({ t: new Date().toISOString(), step, ...data }) + '\n');
  log(`${step}: ${JSON.stringify(data)}`);
};
const ps = (action, args = {}) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Action', action, ...Object.entries(args).flatMap(([k, v]) => [`-${k}`, String(v)])], { encoding: 'utf8' }).trim();

const runId = randomBytes(4).toString('hex').replace(/^\d/, 'k').slice(0, 6); // [a-z0-9]{6}
const work = mkdtempSync(path.join(tmpdir(), 'tw-notify-check-'));
const wsDir = path.join(work, 'Notification Test');
const ud = path.join(work, 'profile');
const fakeDir = path.join(work, 'fake');
const triggers = path.join(work, 'triggers');
for (const d of [wsDir, ud, fakeDir, triggers]) mkdirSync(d);
writeFileSync(path.join(wsDir, 'README.md'), '# Notification Test\n');
const fake = path.join(fakeDir, 'claude.exe');
copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'PING.EXE'), fake);
const backend = randomUUID(), other = randomUUID(), pane = randomUUID(), wsId = randomUUID();
writeFileSync(
  path.join(ud, 'workspace-state.json'),
  JSON.stringify({
    schemaVersion: 3,
    activeWorkspaceId: wsId,
    workspaces: [{ id: wsId, name: 'Notification Test', rootPath: wsDir, layout: { type: 'pane', id: pane, tabs: [{ id: backend, kind: 'terminal', profileId: 'windows-powershell', name: 'Backend' }, { id: other, kind: 'terminal', profileId: 'windows-powershell', name: 'Other' }], activeTabId: backend }, activePaneId: pane }],
    settings: {},
  }),
);
const PRIVACY_MESSAGE = 'Notification Test message: violet-heron-417';

// Registrations before anything runs, so 'finish' can put them back.
// A run restarted with 'finish' { keepRegistrations: true } keeps the first run's snapshot, so the
// final cleanup still returns to the state before the first run.
const snapFile = path.join(control, 'registrations-before.json');
if (existsSync(snapFile)) result('registrations-before', { keptFromEarlierRun: true, ...JSON.parse(readFileSync(snapFile, 'utf8').replace(/^﻿/, '')), shortcut: undefined });
else result('registrations-before', JSON.parse(ps('snapshot', { File: snapFile })));
let keepRegistrations = false;

// A clean environment: Windows' standard variables and the user's PATH from the registry, nothing
// from the session that runs this script.
const keep = ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'PUBLIC', 'ALLUSERSPROFILE', 'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS', 'COMPUTERNAME', 'PSModulePath'];
const env = Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
env.Path = execFileSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"], { encoding: 'utf8' }).trim();

const port = 9300 + Math.floor(Math.random() * 500);
const app = spawn(exe, [`--tw-user-data=${ud}`, `--tw-notify-id=${runId}`, `--remote-debugging-port=${port}`], { stdio: 'ignore', env, cwd: work });
let browser = null;
let page = null;
let fakePid = null;

const until = async (fn, ms, every = 300) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(every);
  }
};
const selected = () => page.getAttribute('[role="tab"][aria-selected="true"]', 'data-tab-id');
const tabName = (id) => (id === backend ? 'Backend' : id === other ? 'Other' : id);
const winState = () => JSON.parse(ps('state', { ProcessId: app.pid }));
const report = (expect = {}) => JSON.parse(ps('history', { RunId: runId, ...expect }) || '[]');
const fire = (name) => writeFileSync(path.join(triggers, `go-${name}`), '');

async function setup() {
  const processPath = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${app.pid}").ExecutablePath`], { encoding: 'utf8' }).trim();
  result('launched', { exe, processPath, pathMatches: processPath.toLowerCase() === exe.toLowerCase(), runId, profile: 'fresh temporary folder' });
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500);
    try {
      browser ??= await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      page = browser.contexts().flatMap((c) => c.pages()).find((x) => x.url().includes('index.html')) ?? null;
    } catch {
      /* not up yet */
    }
  }
  if (!page) throw new Error('could not attach to the renderer');
  page.setDefaultTimeout(15_000);
  await page.click('.notice button:has-text("Start all shells")');
  await page.waitForFunction(() => document.querySelectorAll('[data-pane-id][data-status="running"]').length >= 1, null, { timeout: 30_000 });
  await sleep(1500);
  await page.click(`[role="tab"][data-tab-id="${backend}"]`);
  const osc = (body) => `Write-Host -NoNewline ([char]27+']7501;${body}'+[char]27+'\\')`;
  const msg = Buffer.from(PRIVACY_MESSAGE).toString('base64');
  // Each request: the agent works for 2 s first, as a real one does; printed together, SplitNest
  // would rightly see no change from the request before.
  const loop = [
    'Clear-Host',
    `$null=Start-Process '${fake}' -ArgumentList '-t','127.0.0.1' -WindowStyle Hidden -PassThru`,
    `$d='${triggers}'`,
    '$run=$true',
    'while ($run) { ' +
      [
        `if (Test-Path "$d\\go-permission") { Remove-Item "$d\\go-permission"; ${osc('state=working:app=claude-code')}; Start-Sleep -Seconds 2; ${osc('state=blocked:kind=permission:app=claude-code')} }`,
        `if (Test-Path "$d\\go-permission-msg") { Remove-Item "$d\\go-permission-msg"; ${osc('state=working:app=claude-code')}; Start-Sleep -Seconds 2; ${osc(`state=blocked:kind=permission:app=claude-code:msg=${msg}`)} }`,
        `if (Test-Path "$d\\go-stop") { Remove-Item "$d\\go-stop"; $run=$false }`,
        'Start-Sleep -Milliseconds 200',
      ].join('; ') +
      ' }',
  ].join('; ');
  await page.click('.tabview:not([hidden]) .pane__terminal', { position: { x: 40, y: 20 } });
  await page.keyboard.type(loop);
  await page.keyboard.press('Enter');
  fakePid = await until(() => Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${fake}' }).ProcessId`], { encoding: 'utf8' }).trim()) || null, 10_000);
  const detected = await until(() => page.evaluate((t) => document.querySelector(`[role="tab"][data-tab-id="${t}"]`)?.getAttribute('data-agent') === 'claude', backend), 30_000);
  const details = await page.evaluate(() => window.appApi.loadState().then((r) => r.state.settings.notifyDetails === true));
  const regs = JSON.parse(ps('snapshot', { File: path.join(control, 'registrations-after-launch.json') }));
  result('ready', { agentDetected: !!(fakePid && detected), includeWhatAgentWrote: details, notificationsSoFar: report().length, registrationsAfterLaunch: regs });
}

// One check: Other on screen, SplitNest minimized, then a permission request from Backend.
async function raise(name, { delayMs = 15_000, withMessage = false, watchMs = 180_000 } = {}) {
  await page.click(`[role="tab"][data-tab-id="${other}"]`);
  ps('minimize', { ProcessId: app.pid });
  const minimized = await until(() => (winState().minimized ? true : null), 5000);
  result(`${name}:prepared`, { selected: tabName(await selected()), minimized: !!minimized, firesInMs: delayMs });
  await sleep(delayMs);
  const before = new Set(report().map((r) => r.id));
  fire(withMessage ? 'permission-msg' : 'permission');
  const firedAt = Date.now();
  const expect = withMessage ? { ExpectTitle: 'Claude Code needs permission', ExpectBody: 'Notification Test · Backend', Absent: 'violet-heron-417' } : {};
  const fresh = await until(() => report(expect).find((r) => !before.has(r.id)) ?? null, 15_000);
  result(`${name}:delivered`, fresh ? { ...fresh, msAfterTrigger: Date.now() - firedAt } : { delivered: false });
  // Watch for the person bringing SplitNest back (banner click or taskbar), then for Backend.
  const back = await until(() => {
    const s = winState();
    return !s.minimized && s.foreground ? s : null;
  }, watchMs, 250);
  const backAt = Date.now();
  result(`${name}:window`, back ? { restored: true, foreground: true, secondsAfterTrigger: +((backAt - firedAt) / 1000).toFixed(1), selectedThen: tabName(await selected()) } : { restored: false, note: `not back within ${watchMs / 1000} s` });
  if (!back) return;
  const onBackend = await until(async () => ((await selected()) === backend ? true : null), watchMs, 250);
  await sleep(800);
  const left = fresh ? !report().some((r) => r.id === fresh.id) : null;
  result(`${name}:backend`, { selectedBackend: !!onBackend, secondsAfterWindowBack: +((Date.now() - backAt) / 1000).toFixed(1), notificationGoneFromCenter: left });
}

async function finish() {
  fire('stop');
  await sleep(800);
  if (fakePid) execFileSync('taskkill.exe', ['/F', '/PID', String(fakePid)], { stdio: 'ignore' });
  fakePid = null;
  for (const id of [backend, other]) {
    await page.click(`[role="tab"][data-tab-id="${id}"]`).catch(() => undefined);
    await page.click('.tabview:not([hidden]) .pane__terminal', { position: { x: 40, y: 20 } }).catch(() => undefined);
    await page.keyboard.type('exit').catch(() => undefined);
    await page.keyboard.press('Enter').catch(() => undefined);
    await sleep(800);
  }
  await browser?.close().catch(() => undefined);
  browser = null;
  ps('close-window', { ProcessId: app.pid });
  const exited = await until(() => (app.exitCode !== null ? true : null), 15_000);
  result('quit', { exited: !!exited, exitCode: app.exitCode });
}

async function cleanup() {
  await browser?.close().catch(() => undefined);
  if (app.exitCode === null) {
    try {
      execFileSync('taskkill.exe', ['/T', '/F', '/PID', String(app.pid)], { stdio: 'ignore' });
    } catch {
      /* gone */
    }
  }
  if (fakePid) {
    try {
      execFileSync('taskkill.exe', ['/F', '/PID', String(fakePid)], { stdio: 'ignore' });
    } catch {
      /* gone */
    }
  }
  await sleep(1500);
  result('cleanup', {
    removedNotifications: JSON.parse(ps('remove', { RunId: runId }) || '[]'),
    registrations: keepRegistrations ? 'kept for the next run (the snapshot from before the first run stays)' : JSON.parse(ps('restore', { File: snapFile, Exe: exe }) || '[]'),
    registrationsNow: JSON.parse(ps('snapshot', { File: path.join(control, 'registrations-after.json') })),
  });
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (e) {
    result('temp-folder-locked', { folder: work, code: e?.code ?? 'unknown' });
  }
  result('temp-folder-removed', { removed: !existsSync(work) });
}

try {
  await setup();
  for (;;) {
    if (app.exitCode !== null) throw new Error(`SplitNest quit on its own or its window was closed (exit code ${app.exitCode}); no command was running`);
    const cmds = readdirSync(control).filter((f) => /^cmd-.*\.json$/.test(f)).sort();
    if (!cmds.length) {
      await sleep(400);
      continue;
    }
    const file = path.join(control, cmds[0]);
    const cmd = JSON.parse(readFileSync(file, 'utf8'));
    unlinkSync(file);
    result('command', cmd);
    if (cmd.name === 'finish') {
      keepRegistrations = cmd.keepRegistrations === true;
      await finish();
      break;
    }
    if (cmd.name === 'banner' || cmd.name === 'taskbar') await raise(cmd.name, { delayMs: cmd.delayMs });
    else if (cmd.name === 'privacy') await raise('privacy', { delayMs: cmd.delayMs, withMessage: true });
    else result('unknown-command', { name: cmd.name });
  }
} catch (e) {
  result('error', { message: String(e?.message ?? e) });
} finally {
  await cleanup();
}
process.exit(0);
