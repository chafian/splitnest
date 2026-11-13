// Exact Resume in a WSL terminal, end to end (dev build, TW_E2E=1, temporary folders only).
// No real agent runs: the "agent" is a copy of /bin/sleep named `claude` in a temporary folder
// inside the distribution, started by its full path. Its Claude Code session file is written into
// a temporary Linux "home" (TW_E2E_WSL_AGENT_HOME, dev only), never into the real ~/.claude.
// Before Resume types `claude --resume <id>` in WSL, the script checks that the distribution has
// no `claude` command, so nothing real can start; the pane then reports that the agent didn't start.
// Usage: node tests/e2e/run-resume-wsl.mjs   (after `npm run package`; needs a WSL distribution)
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const DISTRO = process.env.TW_E2E_WSL ?? 'Ubuntu-22.04';
const wsl = (...args) => execFileSync('wsl.exe', ['--distribution', DISTRO, '--exec', ...args], { encoding: 'utf8' }).replace(/\0/g, '').trim();

const work = mkdtempSync(path.join(tmpdir(), 'tw-resume-wsl-'));
const proj = path.join(work, 'wsl-ws');
const ud = path.join(work, 'ud');
const winAgentHome = path.join(work, 'agent-home'); // the Windows-side tracker reads nothing real either
for (const d of [proj, ud, winAgentHome]) mkdirSync(d, { recursive: true });
writeFileSync(path.join(proj, 'README.md'), '# wsl resume\n');

// The temporary Linux side: bin/claude (a copy of sleep) and home/.claude/sessions.
const linuxTmp = wsl('mktemp', '-d', '/tmp/tw-e2e-wslres-XXXXXX');
if (!/^\/tmp\/tw-e2e-wslres-[A-Za-z0-9]+$/.test(linuxTmp)) throw new Error(`unexpected temp folder: ${linuxTmp}`);
wsl('sh', '-c', 'mkdir -p "$1/bin" "$1/home/.claude/sessions" && cp /bin/sleep "$1/bin/claude"', 'sh', linuxTmp);
const unc = (linuxPath) => `\\\\wsl.localhost\\${DISTRO}${linuxPath.replace(/\//g, '\\')}`;
const linuxProj = wsl('wslpath', '-u', proj);

const env = {
  ...process.env,
  TW_E2E: '1',
  TW_E2E_PICK_FOLDER: proj,
  TW_E2E_AGENT_HOME: winAgentHome,
  TW_E2E_WSL_AGENT_HOME: unc(`${linuxTmp}/home`),
};

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
const termText = (page, tab) => page.evaluate((t) => window.__twTest.inspect(t, 60)?.text ?? '', tab);
const wslHasClaude = () => wsl('bash', '-lc', 'command -v claude || true') !== '';
const standIns = () => wsl('sh', '-c', 'pgrep -f "^$1/bin/claude " || true', 'sh', linuxTmp).split(/\s+/).filter(Boolean).map(Number);

const W = randomUUID();
let app = null;
try {
  await step(`safety: ${DISTRO} has no \`claude\` command (Resume types one there)`, async () => {
    if (wslHasClaude()) throw new Error(`${DISTRO} has claude; stopping before anything runs`);
    return { linuxTmp, linuxProj };
  });
  if (!results.every((r) => r.ok)) throw new Error('unsafe');

  app = await launch();
  let page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
  await page.click('button:has-text("Open folder…")');
  await page.waitForSelector('[data-pane-id][data-status="running"]');
  const selected = () => page.getAttribute('[role="tab"][aria-selected="true"]', 'data-tab-id');
  const psTab = await selected();
  let tab = null;

  await step('WSL tab: the agent is found among its Linux processes, and its conversation (by Linux pid) is saved in Windows form', async () => {
    if (!(await palette(page, `New terminal in current pane: WSL · ${DISTRO}`))) throw new Error('no WSL profile');
    tab = await until(async () => {
      const t = await selected();
      return t !== psTab ? t : null;
    }, 'wsl tab');
    await until(() => page.evaluate((t) => window.__twTest.status(t) === 'running', tab), 'wsl running', 40_000);
    await page.waitForTimeout(1500);
    await page.click(`.tabview[data-tab-id="${tab}"] .pane__terminal`, { position: { x: 40, y: 20 } });
    await page.keyboard.type(`${linuxTmp}/bin/claude 600`);
    await page.keyboard.press('Enter');
    await until(() => page.evaluate((t) => document.querySelector(`[role="tab"][data-tab-id="${t}"]`)?.getAttribute('data-agent') === 'claude', tab), 'claude detected on the tab', 20_000);
    const pid = (await until(() => standIns()[0], 'stand-in pid')) ?? 0;
    writeFileSync(unc(`${linuxTmp}/home/.claude/sessions/${pid}.json`), JSON.stringify({ pid, sessionId: W, cwd: linuxProj, kind: 'interactive', status: 'idle', name: 'Fix the WSL build' }));
    const r = await until(() => savedTabs().find((t) => t.id === tab && t.resume?.sessionId === W)?.resume, 'exact resume saved', 20_000);
    if (!r.wsl || !r.exact || r.cwd.toLowerCase() !== proj.toLowerCase() || r.title !== 'Fix the WSL build') throw new Error(JSON.stringify(r));
    return { pid, cwd: r.cwd };
  });

  await step('quitting keeps it', async () => {
    await quit(app);
    app = null;
    const r = savedTabs().find((t) => t.id === tab)?.resume;
    if (r?.sessionId !== W || !r.wsl) throw new Error(JSON.stringify(r));
  });
  // The stand-in may outlive the quit as a WSL process; it ends with the cleanup below at the latest.
  wsl('sh', '-c', 'pkill -f "^$1/bin/claude " || true', 'sh', linuxTmp);

  app = await launch();
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);

  await step('after a restart the WSL tab offers that exact conversation, saying what will run', async () => {
    await page.click(`[role="tab"][data-tab-id="${tab}"]`);
    const detail = await page.textContent(`.tabview[data-tab-id="${tab}"] [data-testid="resume-detail"]`, { timeout: 15_000 });
    if (!detail.includes(`claude --resume ${W}`)) throw new Error(detail);
    const title = await page.textContent(`.tabview[data-tab-id="${tab}"] [data-testid="resume-title"]`);
    if (!title.includes('Fix the WSL build')) throw new Error(title);
  });

  await step('Resume starts WSL in the agent folder and types `claude --resume <id>` (it does not start: no claude there)', async () => {
    if (wslHasClaude()) throw new Error('unsafe');
    await page.click(`.tabview[data-tab-id="${tab}"] [data-testid="resume-agent"]`);
    await until(async () => (await termText(page, tab)).includes(`claude --resume ${W}`), 'typed in WSL', 40_000);
    await page.waitForSelector(`.tabview[data-tab-id="${tab}"] [data-testid="resume-not-started"]`, { timeout: 45_000 });
    await page.click(`.tabview[data-tab-id="${tab}"] .pane__terminal`, { position: { x: 40, y: 20 } });
    await page.keyboard.type('printf "AT=%s\\n" "$PWD"');
    await page.keyboard.press('Enter');
    await until(async () => (await termText(page, tab)).includes(`AT=${linuxProj}`), `shell in ${linuxProj}`, 15_000);
  });
} catch (e) {
  results.push({ name: 'script error', ok: false });
  console.log(`  ✗ script error: ${e?.message ?? e}`);
} finally {
  if (app) await quit(app).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1000));
  try {
    wsl('sh', '-c', 'pkill -f "^$1/bin/claude " ; rm -rf "$1"', 'sh', linuxTmp);
  } catch {
    // already gone
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `RESULT: ${failed} of ${results.length} steps FAILED` : `RESULT: all ${results.length} steps passed`);
process.exit(failed ? 1 : 0);
