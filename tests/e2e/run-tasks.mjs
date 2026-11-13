// Agent tasks (M2), end to end (dev build, TW_E2E=1; temporary repository, profile and agent home
// only). No real agent runs: `claude.exe` and `codex.exe` in a temporary folder at the front of
// PATH are copies of cmd.exe (they keep running, so process detection finds them). Before each
// step that types an agent's name the script checks that it resolves to those copies.
// Usage: node tests/e2e/run-tasks.mjs   (after `npm run package`, which builds .vite/build)
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
// The long path: Git reports folders that way.
const work = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'tw-tasks-e2e-')));
const proj = path.join(work, 'shop app');
const plain = path.join(work, 'not a repo');
const ud = path.join(work, 'ud');
const agentHome = path.join(work, 'agent-home');
const fakebin = path.join(work, 'fakebin');
for (const d of [proj, plain, ud, fakebin, path.join(agentHome, '.claude', 'sessions')]) mkdirSync(d, { recursive: true });
const sys32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const fakeClaude = path.join(fakebin, 'claude.exe');
const fakeCodex = path.join(fakebin, 'codex.exe');
copyFileSync(path.join(sys32, 'cmd.exe'), fakeClaude);
copyFileSync(path.join(sys32, 'cmd.exe'), fakeCodex);

const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
git(proj, 'init', '-q', '-b', 'main');
writeFileSync(path.join(proj, 'README.md'), '# shop\n');
git(proj, 'add', '.');
git(proj, 'commit', '-q', '-m', 'first');
// Uncommitted work in the workspace: not part of a task.
writeFileSync(path.join(proj, 'notes.txt'), 'draft\n');

const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'Path';
const env = { ...process.env, TW_E2E: '1', TW_E2E_PICK_FOLDER: `${proj}|${plain}`, TW_E2E_AGENT_HOME: agentHome };
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
const fakes = (exe) => {
  const out = ps(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${exe}' } | ForEach-Object { $_.ProcessId }`);
  return out ? out.split(/\r?\n/).map(Number) : [];
};
const killFakes = () => {
  for (const exe of [fakeClaude, fakeCodex]) for (const pid of fakes(exe)) ps(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`);
};
const standInsOnly = () => {
  if (ps('(Get-Command claude).Source').toLowerCase() !== fakeClaude.toLowerCase()) throw new Error('claude is not the stand-in');
  if (ps('(Get-Command codex).Source').toLowerCase() !== fakeCodex.toLowerCase()) throw new Error('codex is not the stand-in');
};
const saved = () => {
  try {
    return JSON.parse(readFileSync(path.join(ud, 'workspace-state.json'), 'utf8'));
  } catch {
    return null;
  }
};
const tabsOf = (w) => {
  const tabs = [];
  const walk = (n) => (n?.type === 'pane' ? tabs.push(...n.tabs) : n?.children?.forEach(walk));
  walk(w?.layout);
  return tabs;
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
const hasCommand = async (page, title) => {
  await page.keyboard.press('Control+Shift+P');
  await page.keyboard.type(title);
  await page.waitForTimeout(300);
  const found = !!(await page.$(`[role="option"]:has-text("${title}")`));
  await page.keyboard.press('Escape');
  return found;
};
const visibleTab = (page) => page.locator('[role="tab"][aria-selected="true"]:visible').first().getAttribute('data-tab-id');
const termText = (page, tab) => page.evaluate((t) => window.__twTest.inspect(t, 80)?.text ?? '', tab);
const agentOf = (page, tab) => page.getAttribute(`[role="tab"][data-tab-id="${tab}"]`, 'data-agent');
const typeIn = async (page, tab, text) => {
  await page.click(`.tabview[data-tab-id="${tab}"] .pane__terminal`, { position: { x: 40, y: 20 } });
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};
const selectWorkspace = (page, name) => page.click(`.ws-item:has(.ws-item__label:text-is("${name}")) .ws-item__main`);

const fixRoot = path.join(`${proj}.worktrees`, 'fix-login');
const testsRoot = path.join(`${proj}.worktrees`, 'add-tests');
const SESSION = randomUUID();
let app = null;
let fixTab = null;
try {
  await step('safety: in the app’s environment, claude and codex resolve to the stand-ins', async () => standInsOnly());

  app = await launch();
  let page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
  await page.click('button:has-text("Open folder…")');
  await page.waitForSelector('[data-pane-id][data-status="running"]');

  await step('off by default: no New agent task command and no task button', async () => {
    if (await hasCommand(page, 'New agent task')) throw new Error('command listed');
    if (await page.$('[aria-label^="New agent task from"]')) throw new Error('button shown');
  });

  await step('Settings › Workspaces › Agent tasks (preview) turns it on', async () => {
    await page.keyboard.press('Control+Comma');
    await page.click('.settings-nav__item:has-text("Workspaces")');
    await page.click('.setting:has-text("Agent tasks (preview)") [role="switch"]');
    await until(() => saved()?.settings?.agentTasks === true, 'setting saved');
    await selectWorkspace(page, 'shop app');
    await page.waitForSelector('[aria-label="New agent task from shop app"]', { state: 'attached', timeout: 15_000 });
  });

  await step('the dialog shows what will be made before anything is created, and names uncommitted changes', async () => {
    if (!(await palette(page, 'New agent task…'))) throw new Error('command disabled');
    await page.waitForSelector('[data-testid="task-name"]');
    await page.fill('[data-testid="task-name"]', 'Fix login');
    await until(async () => (await page.textContent('[data-testid="task-preview"]'))?.includes('splitnest/fix-login'), 'preview with branch');
    const text = await page.textContent('[data-testid="task-preview"]');
    if (!text.includes(fixRoot) || !text.includes('from main')) throw new Error(text);
    await page.waitForSelector('[data-testid="task-uncommitted"]', { timeout: 10_000 });
    if (existsSync(`${proj}.worktrees`)) throw new Error('created before Create');
    if (process.env.TW_TASK_SHOTS) await page.screenshot({ path: path.join(process.env.TW_TASK_SHOTS, 'task-dialog.png') });
    return { preview: text.slice(0, 120) };
  });

  await step('Create: a worktree on splitnest/fix-login, a task workspace under its parent, and Claude Code started there', async () => {
    standInsOnly();
    await page.click('[data-testid="task-agent-claude"]');
    await page.click('[data-testid="task-create"]');
    await page.waitForSelector('[data-testid="task-name"]', { state: 'detached', timeout: 30_000 });
    if (git(fixRoot, 'symbolic-ref', '--short', 'HEAD') !== 'splitnest/fix-login') throw new Error('branch');
    if (existsSync(path.join(fixRoot, 'notes.txt'))) throw new Error('uncommitted file copied');
    const rows = await page.$$eval('.sidebar__list .ws-item:not(.ws-item--page)', (els) => els.map((e) => `${e.classList.contains('ws-item--task') ? 'task:' : ''}${e.querySelector('.ws-item__label')?.textContent}`));
    if (rows.join('|') !== 'shop app|task:Fix login') throw new Error(rows.join('|'));
    fixTab = await until(async () => {
      const t = await visibleTab(page);
      return t && (await page.evaluate((x) => window.__twTest.status(x) === 'running', t)) ? t : null;
    }, 'task terminal running');
    await until(async () => (await agentOf(page, fixTab)) === 'claude', 'claude detected in the task tab', 30_000);
    // The stand-in is cmd.exe: `cd` prints its folder, the task's folder.
    await typeIn(page, fixTab, 'cd');
    await until(async () => (await termText(page, fixTab)).toLowerCase().includes(fixRoot.toLowerCase()), 'agent runs in the task folder');
    const w = saved()?.workspaces?.find((x) => x.task);
    if (!w || w.rootPath !== fixRoot || w.task.branch !== 'splitnest/fix-login' || w.task.agent !== 'claude') throw new Error(JSON.stringify(w?.task));
  });

  await step('the task shows its branch and commits against main as work happens', async () => {
    await until(async () => (await page.textContent('.ws-item--task [data-testid="task-progress"]'))?.includes('no commits yet'), 'no commits yet', 20_000);
    writeFileSync(path.join(fixRoot, 'login.js'), 'export const login = () => true;\n');
    git(fixRoot, 'add', '.');
    git(fixRoot, 'commit', '-q', '-m', 'Fix login');
    await selectWorkspace(page, 'shop app');
    await selectWorkspace(page, 'Fix login');
    await until(async () => (await page.textContent('.ws-item--task [data-testid="task-progress"]'))?.includes('1 commit'), '1 commit', 20_000);
    const branch = await page.textContent('.ws-item--task .ws-item__git-branch');
    if (branch !== 'splitnest/fix-login') throw new Error(branch);
  });

  await step('Review lists what the task changed against main, committed or not, and shows each file’s diff', async () => {
    // Uncommitted work on top of the commit: an edit and a new file.
    writeFileSync(path.join(fixRoot, 'login.js'), 'export const login = () => true;\nexport const logout = () => false;\n');
    writeFileSync(path.join(fixRoot, 'notes.md'), '# notes\n');
    await page.hover('.ws-item:has(.ws-item__label:text-is("Fix login"))');
    await page.click('[aria-label="Review changes in Fix login"]');
    await page.waitForSelector('[data-testid="review-files"]', { timeout: 15_000 });
    const files = await page.$$eval('[data-testid="review-files"] [role="option"]', (els) => els.map((e) => e.getAttribute('data-path')));
    if (files.join('|') !== 'login.js|notes.md') throw new Error(files.join('|'));
    const summary = await page.textContent('[data-testid="review-summary"]');
    if (!/splitnest\/fix-login against main/.test(summary) || !summary.includes('2 files') || !summary.includes('2 not committed')) throw new Error(summary);
    await until(async () => (await page.textContent('[data-testid="review-diff"]'))?.includes('export const logout'), 'login.js diff');
    const added = await page.$$eval('[data-testid="review-diff"] .diff__row--add .diff__text', (els) => els.map((e) => e.textContent));
    if (!added.includes('export const logout = () => false;')) throw new Error(added.join('|'));
    await page.click('[data-testid="review-files"] [data-path="notes.md"]');
    await until(async () => (await page.textContent('[data-testid="review-diff"]'))?.includes('# notes'), 'notes.md diff');
    // Changes made while it is open show after Refresh.
    writeFileSync(path.join(fixRoot, 'later.txt'), 'later\n');
    await page.click('[data-testid="review-refresh"]');
    await page.waitForSelector('[data-testid="review-files"] [data-path="later.txt"]', { timeout: 10_000 });
    if (process.env.TW_TASK_SHOTS) await page.screenshot({ path: path.join(process.env.TW_TASK_SHOTS, 'task-review.png') });
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="review-files"]', { state: 'detached' });
  });

  await step('a second task runs in parallel with Codex, listed under the same workspace', async () => {
    standInsOnly();
    await selectWorkspace(page, 'shop app');
    await page.click('[aria-label="New agent task from shop app"]');
    await page.fill('[data-testid="task-name"]', 'Add tests');
    await page.click('[data-testid="task-agent-codex"]');
    await until(async () => (await page.textContent('[data-testid="task-preview"]'))?.includes('splitnest/add-tests'), 'preview');
    await page.click('[data-testid="task-create"]');
    await page.waitForSelector('[data-testid="task-name"]', { state: 'detached', timeout: 30_000 });
    const tab = await until(async () => {
      const t = await visibleTab(page);
      return t && t !== fixTab ? t : null;
    }, 'second task tab');
    await until(async () => (await agentOf(page, tab)) === 'codex', 'codex detected', 30_000);
    if ((await agentOf(page, fixTab)) !== 'claude') throw new Error('first task lost its agent');
    const rows = await page.$$eval('.sidebar__list .ws-item:not(.ws-item--page) .ws-item__label', (els) => els.map((e) => e.textContent));
    if (rows.join('|') !== 'shop app|Fix login|Add tests') throw new Error(rows.join('|'));
    if (git(testsRoot, 'symbolic-ref', '--short', 'HEAD') !== 'splitnest/add-tests') throw new Error('branch');
    if (process.env.TW_TASK_SHOTS) await page.screenshot({ path: path.join(process.env.TW_TASK_SHOTS, 'task-sidebar.png') });
  });

  await step('Review of a task with no changes yet says so (palette command)', async () => {
    await selectWorkspace(page, 'Add tests');
    if (!(await palette(page, 'Review task changes…'))) throw new Error('command disabled');
    await page.waitForSelector('[data-testid="review-empty"]', { timeout: 15_000 });
    await page.keyboard.press('Escape');
    await selectWorkspace(page, 'shop app');
    await page.keyboard.press('Control+Shift+P');
    await page.keyboard.type('Review task changes');
    const item = await page.waitForSelector('[role="option"]:has-text("Review task changes")');
    if ((await item.getAttribute('aria-disabled')) !== 'true') throw new Error('enabled outside a task');
    await page.keyboard.press('Escape');
  });

  await step('a name that is taken gets the next free one', async () => {
    await selectWorkspace(page, 'shop app');
    await page.click('[aria-label="New agent task from shop app"]');
    await page.fill('[data-testid="task-name"]', 'Fix login');
    await until(async () => (await page.textContent('[data-testid="task-preview"]'))?.includes('splitnest/fix-login-2'), 'fix-login-2');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="task-name"]', { state: 'detached' });
    if (existsSync(path.join(`${proj}.worktrees`, 'fix-login-2'))) throw new Error('created on cancel');
  });

  await step('a workspace that is not a Git repository: the dialog says so and Create stays off', async () => {
    await page.click('button[aria-label^="New workspace from folder"]');
    await until(async () => (await page.$$('.sidebar__list .ws-item:not(.ws-item--page)')).length === 4, 'plain workspace');
    if (await page.$('[aria-label="New agent task from not a repo"]')) throw new Error('task button on a folder without Git');
    if (!(await palette(page, 'New agent task…'))) throw new Error('command disabled');
    await page.fill('[data-testid="task-name"]', 'x');
    const problem = await page.waitForSelector('[data-testid="task-problem"]', { timeout: 10_000 });
    if (!(await problem.textContent()).includes('isn’t in a Git repository')) throw new Error(await problem.textContent());
    if (!(await page.$eval('[data-testid="task-create"]', (b) => b.disabled))) throw new Error('Create enabled');
    await page.keyboard.press('Escape');
  });

  await step('main refuses a saved task it didn’t create (the page can’t change a task’s branch or folders)', async () => {
    const r = await page.evaluate(async () => {
      const { state } = await window.appApi.loadState();
      const forged = structuredClone(state);
      const t = forged.workspaces.find((w) => w.task);
      // A branch that looks like a task branch but isn't the one main created.
      t.task.branch = 'splitnest/other';
      const a = await window.appApi.saveState(forged);
      const forged2 = structuredClone(state);
      forged2.workspaces.find((w) => w.task).task.worktreePath = 'C:\\Windows';
      const b = await window.appApi.saveState(forged2);
      const c = await window.appApi.saveState(state);
      return [a.ok ? 'ok' : a.error.code, b.ok ? 'ok' : b.error.code, c.ok ? 'ok' : c.error.code];
    });
    // Another branch or another folder: refused. (A record that isn't a valid task at all, e.g. branch `main`, is dropped by validation,
    // which only turns the workspace into an ordinary one: main never acts on a task it didn't create.)
    if (r.join(',') !== 'FORBIDDEN,FORBIDDEN,ok') throw new Error(r.join(','));
    if (saved().workspaces.find((w) => w.name === 'Fix login')?.task?.branch !== 'splitnest/fix-login') throw new Error('saved task changed');
    return { results: r };
  });

  await step('the Claude Code conversation in the task is saved for Resume, in the task folder', async () => {
    const pid = (await until(() => fakes(fakeClaude)[0], 'stand-in claude pid')) ?? 0;
    writeFileSync(path.join(agentHome, '.claude', 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: SESSION, cwd: fixRoot, startedAt: Date.now(), version: '2.1.322', kind: 'interactive', entrypoint: 'cli', status: 'idle', name: 'Fix login', nameSource: 'derived' }));
    const r = await until(() => tabsOf(saved()?.workspaces?.find((w) => w.name === 'Fix login')).find((t) => t.id === fixTab && t.resume?.sessionId === SESSION)?.resume, 'resume saved', 20_000);
    if (r.cwd.toLowerCase() !== fixRoot.toLowerCase()) throw new Error(r.cwd);
  });

  await step('after a restart the tasks are back under their workspace, and Resume reopens the conversation in the task folder', async () => {
    await quit(app);
    app = null;
    killFakes();
    app = await launch();
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
    await page.waitForSelector('.ws-item--task');
    const rows = await page.$$eval('.sidebar__list .ws-item:not(.ws-item--page)', (els) => els.map((e) => `${e.classList.contains('ws-item--task') ? 'task:' : ''}${e.querySelector('.ws-item__label')?.textContent}`));
    if (rows.join('|') !== 'shop app|task:Fix login|task:Add tests|not a repo') throw new Error(rows.join('|'));
    await selectWorkspace(page, 'Fix login');
    await page.click(`[role="tab"][data-tab-id="${fixTab}"]`);
    const detail = await page.textContent(`.tabview[data-tab-id="${fixTab}"] [data-testid="resume-detail"]`, { timeout: 15_000 });
    if (!detail.includes(`claude --resume ${SESSION}`)) throw new Error(detail);
    standInsOnly();
    await page.click(`.tabview[data-tab-id="${fixTab}"] [data-testid="resume-agent"]`);
    await until(async () => (await termText(page, fixTab)).includes(`claude --resume ${SESSION}`), 'resume typed', 30_000);
    await until(async () => (await agentOf(page, fixTab)) === 'claude', 'claude running again', 30_000);
    await typeIn(page, fixTab, 'cd');
    await until(async () => (await termText(page, fixTab)).toLowerCase().split(fixRoot.toLowerCase()).length > 1, 'resumed in the task folder');
  });

  await step('removing a task from the list keeps its folder and branch, and says so', async () => {
    await page.hover('.ws-item:has(.ws-item__label:text-is("Add tests"))');
    await page.click('[aria-label="Remove Add tests from the list"]');
    const text = await page.textContent('dialog[open]');
    if (!text.includes('are kept as they are') || !text.includes('splitnest/add-tests')) throw new Error(text);
    await page.click('dialog[open] button:has-text("Remove workspace")');
    await until(async () => !(await page.$('.ws-item__label:text-is("Add tests")')), 'row removed');
    if (!existsSync(testsRoot) || git(testsRoot, 'symbolic-ref', '--short', 'HEAD') !== 'splitnest/add-tests') throw new Error('worktree touched');
  });
} catch (e) {
  results.push({ name: 'script error', ok: false });
  console.log(`  ✗ script error: ${e?.message ?? e}`);
} finally {
  if (app) await quit(app).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1000));
  try {
    killFakes();
  } catch {
    // gone
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `RESULT: ${failed} of ${results.length} steps FAILED` : `RESULT: all ${results.length} steps passed`);
process.exit(failed ? 1 : 0);
