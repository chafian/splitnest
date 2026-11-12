// Real end-to-end check of agent state tracking with a small task (sends a prompt, so it uses
// the agent account; not part of the routine test runs). In a temp folder, each installed agent
// is asked to create hello.txt in a mode that must ask permission first, so the full cycle
// working -> needs you (permission) -> working -> done/idle comes from the real agent.
// - Permission is granted once ("Yes" for this action only). Nothing else is answered.
// - A folder-trust dialog stops the run instead: answering it would change the agent's config.
// Usage: node tests/e2e/run-agent-tasks.mjs [claude|codex]   (after `npm run package`)
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const shots = path.join(root, 'test-results', 'screenshots');
mkdirSync(shots, { recursive: true });
const which = process.argv[2];
const has = (cmd) => {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `if (Get-Command ${cmd} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`]);
    return true;
  } catch {
    return false;
  }
};
const TASK = 'Create a file named hello.txt in the current folder containing exactly the text hi. Do nothing else.';
const AGENTS = [
  { id: 'claude', cmd: 'claude --permission-mode default', shot: '35-task-claude-permission.png' },
  { id: 'codex', cmd: 'codex --sandbox read-only --ask-for-approval on-request', shot: '36-task-codex-permission.png' },
].filter((a) => (!which || a.id === which) && has(a.id));

async function runTask(agent) {
  const work = mkdtempSync(path.join(tmpdir(), 'tw-task-'));
  const proj = path.join(work, `${agent.id}-task`);
  mkdirSync(proj);
  writeFileSync(path.join(proj, 'README.md'), '# temp task folder\n');
  const app = await electron.launch({
    executablePath: require('electron'),
    args: ['.', `--tw-user-data=${path.join(work, 'ud')}`],
    cwd: root,
    env: { ...process.env, TW_E2E: '1', TW_E2E_PICK_FOLDER: proj },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1360, height: 860 }).catch(() => undefined);
  await page.click('button:has-text("Open folder…")');
  await page.waitForSelector('[data-pane-id][data-status="running"]');
  const tab = await page.getAttribute('[role="tab"][aria-selected="true"]', 'data-tab-id');
  const view = () => page.evaluate((t) => window.__twTest.agent(t), tab);
  const screen = () => page.evaluate((t) => window.__twTest.inspect(t, 120).text, tab);
  const focus = () => page.click('.tabview:not([hidden]) .pane__terminal', { position: { x: 40, y: 20 } });
  const timeline = [];
  let last = '';
  const t0 = Date.now();
  const sample = async () => {
    const a = await view();
    const s = a ? `${a.state}${a.kind ? `:${a.kind}` : ''}/${a.source}` : 'none';
    if (s !== last) timeline.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
    last = s;
    return a;
  };
  const until = async (pred, ms, what) => {
    const end = Date.now() + ms;
    for (;;) {
      const a = await sample();
      if (await pred(a)) return a;
      if (Date.now() > end) throw new Error(`${what} (timeline: ${timeline.join(', ')})`);
      await page.waitForTimeout(250);
    }
  };
  const result = { agent: agent.id, command: agent.cmd };
  try {
    await page.waitForFunction((t) => /task>\s*$/m.test(window.__twTest.inspect(t, 200).text), tab, { timeout: 30_000 });
    await focus();
    await page.keyboard.type(agent.cmd);
    await page.keyboard.press('Enter');
    // Ready = the agent reports idle. Known first-run notices are dismissed with their default.
    await until(
      async (a) => {
        const text = await screen();
        if (/trust (the files in )?this folder|Do you trust|allow Codex to work in this folder/i.test(text)) throw new Error('folder-trust dialog shown; stopped without answering');
        if (/Claude in Chrome extension detected/.test(text) && !result.dismissedChrome) {
          result.dismissedChrome = true;
          await page.keyboard.press('Escape');
        }
        return a?.id === agent.id && a.source === 'protocol' && a.state === 'idle';
      },
      60_000,
      'agent did not report idle',
    );
    result.inheritedWarning = /inherited CLAUDE_CODE_CHILD_SESSION|Transcript saving is off/.test(await screen());
    await focus();
    await page.keyboard.type(TASK);
    // Codex treats fast typing followed at once by Enter as a paste (Enter becomes a newline).
    await page.waitForTimeout(1200);
    await page.keyboard.press('Enter');
    await until(async (a) => a?.state === 'working', 30_000, 'never reported working');
    // Either the permission request arrives, or the file appears without one.
    const blocked = await until(async (a) => a?.state === 'needs-action' || existsSync(path.join(proj, 'hello.txt')), 180_000, 'no permission request and no file');
    if (blocked?.state === 'needs-action') {
      result.permission = { kind: blocked.kind, message: blocked.message, tabPill: await page.textContent(`[data-tab-id="${tab}"][role="tab"] .tab__state`).catch(() => null) };
      await page.screenshot({ path: path.join(shots, agent.shot) });
      // Opening/focusing the tab must not clear it: it is still pending until answered.
      await focus();
      await page.waitForTimeout(800);
      const stillPending = await sample();
      result.permission.stillPendingAfterFocus = stillPending?.state === 'needs-action';
      await page.keyboard.press('Enter'); // first option: yes, this action only
      await until(async (a) => a?.state !== 'needs-action', 30_000, 'stayed "needs you" after granting');
    } else {
      result.permission = 'none requested (file written directly)';
    }
    const end = await until(async (a) => (a?.state === 'done' || a?.state === 'idle') && existsSync(path.join(proj, 'hello.txt')), 180_000, 'did not finish');
    result.finalState = `${end.state}/${end.source}`;
    const file = path.join(proj, 'hello.txt');
    result.file = existsSync(file) ? JSON.stringify(readFileSync(file, 'utf8').trim()) : 'missing';
    // Exit: identity, state and title must all go.
    await focus();
    await page.keyboard.press('Control+C');
    await page.waitForTimeout(700);
    await page.keyboard.press('Control+C');
    await until(async (a) => a === null, 30_000, 'agent still shown after exit');
    result.labelAfterExit = await page.textContent(`[data-tab-id="${tab}"][role="tab"] .tab__label`);
    // From the agent's first report to its exit, no state may be an estimate.
    const firstReport = timeline.findIndex((l) => l.endsWith('/protocol'));
    result.estimatesAfterReports = timeline.slice(firstReport).filter((l) => l.endsWith('/heuristic'));
    if (result.estimatesAfterReports.length) throw new Error(`estimated states after the agent reported: ${result.estimatesAfterReports.join(', ')}`);
    result.ok = true;
  } catch (error) {
    result.ok = false;
    result.error = String(error?.message ?? error);
    await page.screenshot({ path: path.join(work, 'failure.png') }).catch(() => undefined);
    result.failureShot = path.join(work, 'failure.png');
  }
  result.timeline = timeline;
  result.statusReports = await page.evaluate((t) => window.__twTest.statusLog(t), tab).catch(() => []);
  await app.evaluate(() => {
    globalThis.__twQuitAsk = () => Promise.resolve('discard');
  });
  await app.close().catch(() => undefined);
  if (result.ok) rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  return result;
}

const results = [];
for (const a of AGENTS) {
  const r = await runTask(a);
  console.log(JSON.stringify(r, null, 2));
  results.push(r);
}
if (AGENTS.length === 0) console.log('no agent CLI installed');
process.exit(results.every((r) => r.ok) ? 0 : 1);
