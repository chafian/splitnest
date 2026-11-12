// Agent session resume, end to end, part 2 (dev build, TW_E2E=1, temporary folders only):
// the command palette, Resume in a WSL terminal, and "Resume agents automatically".
// Same stand-ins as run-resume.mjs: claude.exe (a copy of cmd.exe) first on PATH and a temporary
// agent home. In WSL the agent's report is written into the terminal's output (__twTest.feed);
// before Resume runs there, the script checks that WSL has no `claude`, so nothing real starts.
// Usage: node tests/e2e/run-resume-more.mjs   (after `npm run package`)
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const DISTRO = process.env.TW_E2E_WSL ?? 'Ubuntu-22.04';
const work = mkdtempSync(path.join(tmpdir(), 'tw-resume2-'));
const proj = path.join(work, 'resume-ws');
const ud = path.join(work, 'ud');
const agentHome = path.join(work, 'agent-home');
const fakebin = path.join(work, 'fakebin');
for (const d of [proj, ud, fakebin, path.join(agentHome, '.claude', 'sessions')]) mkdirSync(d, { recursive: true });
writeFileSync(path.join(proj, 'README.md'), '# resume\n');
const fakeClaude = path.join(fakebin, 'claude.exe');
copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), fakeClaude);
const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'Path';
const env = { ...process.env, TW_E2E: '1', TW_E2E_PICK_FOLDER: proj, TW_E2E_AGENT_HOME: agentHome };
for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k];
env[pathKey] = `${fakebin};${process.env[pathKey]}`;

const results = [];
const step = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}${detail ? ' ' + JSON.stringify(detail) : ''}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  ✗ ${name}: ${error?.message ?? error}`);
  }
};
const until = async (fn, what, timeout = 25_000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};
const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', env }).trim();
const fakes = () => {
  const out = ps(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${fakeClaude}' } | ForEach-Object { '{0}|{1}' -f $_.ProcessId, $_.CommandLine }`);
  return out ? out.split(/\r?\n/).map((l) => ({ pid: Number(l.split('|')[0]), cmd: l.slice(l.indexOf('|') + 1) })) : [];
};
const killFakes = () => fakes().forEach((f) => ps(`Stop-Process -Id ${f.pid} -Force -ErrorAction SilentlyContinue`));
const stateFile = path.join(ud, 'workspace-state.json');
const savedTabs = () => {
  try {
    const s = JSON.parse(readFileSync(stateFile, 'utf8'));
    const tabs = [];
    const walk = (n) => (n?.type === 'pane' ? tabs.push(...n.tabs) : n?.children?.forEach(walk));
    walk(s.workspaces[0]?.layout);
    return tabs;
  } catch {
    return [];
  }
};
const claudeLive = (pid, sessionId) => writeFileSync(path.join(agentHome, '.claude', 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: proj, kind: 'interactive', status: 'idle' }));
const launch = () => electron.launch({ executablePath: require('electron'), args: ['.', `--tw-user-data=${ud}`], cwd: root, env });
const quit = async (app) => {
  await app.evaluate(() => {
    globalThis.__twQuitAsk = async () => 'discard';
  });
  await app.close();
};
const palette = async (page, title) => {
  await page.keyboard.press('Control+Shift+P');
  await page.keyboard.type(title);
  const item = await page.waitForSelector(`[role="option"]:has-text("${title}")`, { timeout: 5000 });
  const disabled = await item.getAttribute('aria-disabled');
  await page.keyboard.press('Enter');
  return disabled !== 'true';
};
const claudeOnPath = () => ps('(Get-Command claude).Source').toLowerCase() === fakeClaude.toLowerCase();
const wslHasClaude = () => execFileSync('wsl.exe', ['-d', DISTRO, '--', 'bash', '-lc', 'command -v claude || true'], { encoding: 'utf8' }).replace(/\0/g, '').trim() !== '';

const A = randomUUID();
let app = null;
try {
  if (!claudeOnPath()) throw new Error('unsafe: claude is not the stand-in');
  app = await launch();
  let page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
  await page.click('button:has-text("Open folder…")');
  await page.waitForSelector('[data-pane-id][data-status="running"]');
  const selected = () => page.getAttribute('[role="tab"][aria-selected="true"]', 'data-tab-id');
  const psTab = await selected();

  await step('PowerShell tab: Claude Code conversation captured', async () => {
    await page.click(`.tabview[data-tab-id="${psTab}"] .pane__terminal`, { position: { x: 40, y: 20 } });
    await page.keyboard.type('claude');
    await page.keyboard.press('Enter');
    const pid = (await until(() => fakes()[0], 'stand-in running')).pid;
    claudeLive(pid, A);
    await until(() => savedTabs().find((t) => t.id === psTab)?.resume?.sessionId === A, 'saved');
  });

  let wslTab = null;
  await step('WSL tab: an agent reporting itself there is kept for Resume (its own list; folder = workspace)', async () => {
    if (!(await palette(page, `New terminal in current pane: WSL · ${DISTRO}`))) throw new Error('no WSL profile');
    wslTab = await until(async () => {
      const t = await selected();
      return t !== psTab ? t : null;
    }, 'wsl tab');
    await until(() => page.evaluate((t) => window.__twTest.status(t) === 'running', wslTab), 'wsl running', 40_000);
    await page.evaluate((t) => window.__twTest.feed(t, '\x1b]7501;state=working:app=claude-code\x1b\\'), wslTab);
    const r = await until(() => savedTabs().find((t) => t.id === wslTab)?.resume, 'wsl resume saved');
    if (r.agent !== 'claude' || r.sessionId !== null || r.cwd !== proj) throw new Error(JSON.stringify(r));
  });

  await step('quitting keeps both (the WSL record too)', async () => {
    await quit(app);
    app = null;
    killFakes();
    const tabs = savedTabs();
    if (tabs.find((t) => t.id === psTab)?.resume?.sessionId !== A || tabs.find((t) => t.id === wslTab)?.resume?.agent !== 'claude') throw new Error(JSON.stringify(tabs));
  });

  app = await launch();
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
  await page.waitForSelector('[data-testid="resume-all"]', { timeout: 15_000 });

  await step('palette: "Resume Claude Code in this terminal" resumes the active terminal', async () => {
    await page.click(`[role="tab"][data-tab-id="${psTab}"]`);
    if (!claudeOnPath()) throw new Error('unsafe');
    if (!(await palette(page, 'Resume Claude Code in this terminal'))) throw new Error('command disabled');
    await until(() => fakes().find((f) => f.cmd.includes(`--resume ${A}`)), 'claude --resume A');
  });

  await step('WSL tab: Resume opens the agent list (`claude --resume`), says so first, and reports it if it does not start', async () => {
    await page.click(`[role="tab"][data-tab-id="${wslTab}"]`);
    const detail = await page.textContent(`.tabview[data-tab-id="${wslTab}"] [data-testid="resume-detail"]`);
    if (!detail.includes("list of earlier conversations")) throw new Error(detail);
    if (wslHasClaude()) throw new Error(`unsafe: ${DISTRO} has claude; not running Resume there`);
    await page.click(`.tabview[data-tab-id="${wslTab}"] [data-testid="resume-agent"]`);
    await until(async () => ((await page.evaluate((t) => window.__twTest.inspect(t, 40)?.text, wslTab)) ?? '').includes('claude --resume'), 'typed in WSL', 40_000);
    await page.waitForSelector(`.tabview[data-tab-id="${wslTab}"] [data-testid="resume-not-started"]`, { timeout: 45_000 });
  });

  await step('"Resume agents automatically": agent terminals resume as SplitNest opens, without a click', async () => {
    // Claude runs again in the PowerShell tab (resumed above), so it is kept through this quit.
    await until(() => savedTabs().find((t) => t.id === psTab)?.resume?.sessionId === A, 'still saved');
    await quit(app);
    app = null;
    killFakes();
    const s = JSON.parse(readFileSync(stateFile, 'utf8'));
    s.settings.resumeAutomatically = true;
    // Only the PowerShell terminal: WSL would run a real `codex` through interop if it were Codex.
    const walk = (n) => (n?.type === 'pane' ? n.tabs.forEach((t) => t.id === wslTab && delete t.resume) : n?.children?.forEach(walk));
    walk(s.workspaces[0].layout);
    writeFileSync(stateFile, JSON.stringify(s));
    if (!claudeOnPath()) throw new Error('unsafe');
    app = await launch();
    page = await app.firstWindow();
    await until(() => fakes().find((f) => f.cmd.includes(`--resume ${A}`)), 'resumed without a click', 40_000);
    // The other terminal is left as it was (no fresh shell, no Resume).
    const st = await page.evaluate((t) => window.__twTest.status(t), wslTab);
    if (st !== 'idle') throw new Error(`WSL tab ${st}`);
  });

  // The stand-in claude runs in the PowerShell tab again (resumed automatically above).
  const relaunchWith = async (settings) => {
    await until(() => savedTabs().find((t) => t.id === psTab)?.resume?.sessionId === A, 'record saved');
    await quit(app);
    app = null;
    killFakes();
    const s = JSON.parse(readFileSync(stateFile, 'utf8'));
    Object.assign(s.settings, settings);
    writeFileSync(stateFile, JSON.stringify(s));
    app = await launch();
    page = await app.firstWindow();
    await page.waitForFunction(() => !!window.__twTest && document.querySelector('[role="tab"]') !== null, null, { timeout: 20_000 });
  };

  await step('"Start PowerShell only" forgets the conversation: no Resume for it after the next restart', async () => {
    await relaunchWith({ resumeAutomatically: false });
    await page.click(`[role="tab"][data-tab-id="${psTab}"]`);
    await page.click(`.tabview[data-tab-id="${psTab}"] .ready__row button:has-text("only")`);
    await until(() => page.evaluate((t) => window.__twTest.status(t) === 'running', psTab), 'plain shell running');
    await until(() => savedTabs().find((t) => t.id === psTab) && !savedTabs().find((t) => t.id === psTab).resume, 'record removed', 15_000);
    if (fakes().length) throw new Error('an agent started');
  });

  await step('"Start fresh shells automatically" on: an agent terminal still offers Resume instead of starting a plain shell', async () => {
    // The agent runs in that shell again, so there is a conversation to keep.
    await page.click(`.tabview[data-tab-id="${psTab}"] .pane__terminal`, { position: { x: 40, y: 20 } });
    await page.keyboard.type('claude');
    await page.keyboard.press('Enter');
    claudeLive((await until(() => fakes()[0], 'stand-in running')).pid, A);
    await relaunchWith({ startShellsOnRestore: true });
    await until(() => page.evaluate((t) => window.__twTest.status(t) === 'running', wslTab), 'the other terminal started by itself', 40_000);
    await page.click(`[role="tab"][data-tab-id="${psTab}"]`);
    await page.waitForSelector(`.tabview[data-tab-id="${psTab}"] [data-testid="resume-agent"]`, { timeout: 10_000 });
    if ((await page.evaluate((t) => window.__twTest.status(t), psTab)) !== 'idle') throw new Error('the agent terminal started on its own');
    if (fakes().length) throw new Error('an agent started without a click');
  });
} catch (e) {
  results.push({ name: 'script error', ok: false });
  console.log(`  ✗ script error: ${e?.message ?? e}`);
} finally {
  if (app) await quit(app).catch(() => undefined);
  killFakes();
  await new Promise((r) => setTimeout(r, 1000));
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `RESULT: ${failed} of ${results.length} steps FAILED` : `RESULT: all ${results.length} steps passed`);
process.exit(failed ? 1 : 0);
