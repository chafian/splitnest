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
// Commit all and merges in the app commit as the repository's own (test) identity, not the user's.
git(proj, 'config', 'user.name', 'Test');
git(proj, 'config', 'user.email', 'test@example.invalid');
git(proj, 'config', 'commit.gpgsign', 'false');
git(proj, 'config', 'core.autocrlf', 'false');
writeFileSync(path.join(proj, 'README.md'), '# shop\n');
// What the folder watch must ignore (an agent's npm install, for example).
writeFileSync(path.join(proj, '.gitignore'), 'node_modules/\n');
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

  await step('on by default: the task button on a repository’s row and the palette command', async () => {
    await page.waitForSelector('[aria-label="New agent task from shop app"]', { state: 'attached', timeout: 15_000 });
    if (!(await hasCommand(page, 'New agent task'))) throw new Error('command not listed');
  });

  await step('Settings › Workspaces › Agent tasks off hides them, and on brings them back', async () => {
    await page.keyboard.press('Control+Comma');
    await page.click('.settings-nav__item:has-text("Workspaces")');
    await page.click('.setting:has-text("Agent tasks") [role="switch"]');
    await until(() => saved()?.settings?.agentTasks === false, 'setting saved off');
    await selectWorkspace(page, 'shop app');
    if (await page.$('[aria-label="New agent task from shop app"]')) throw new Error('button shown while off');
    if (await hasCommand(page, 'New agent task')) throw new Error('command listed while off');
    await page.keyboard.press('Control+Comma');
    await page.click('.settings-nav__item:has-text("Workspaces")');
    await page.click('.setting:has-text("Agent tasks") [role="switch"]');
    await until(() => saved()?.settings?.agentTasks === true, 'setting saved on');
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

  await step('the compact task row shows +added −removed as work happens (uncommitted new files included), details in its tooltip', async () => {
    const row = '.ws-item--task:has(.ws-item__label:text-is("Fix login"))';
    const counts = () => page.textContent(`${row} [data-testid="task-counts"]`).catch(() => null);
    const tooltip = () => page.getAttribute(`${row} .ws-item__main`, 'title');
    // A new, untracked 3-line file: counted right away, before any commit.
    writeFileSync(path.join(fixRoot, 'login.js'), 'export const login = () => true;\n// a\n// b\n');
    await selectWorkspace(page, 'shop app');
    await selectWorkspace(page, 'Fix login');
    await until(async () => (await counts())?.replace(/\s+/g, ' ').trim() === '+3 −0', '+3 −0', 20_000);
    let tip = await tooltip();
    if (!tip.includes('Branch splitnest/fix-login, from main') || !tip.includes('No commits yet') || !tip.includes('1 change not committed yet')) throw new Error(tip);
    if (!tip.includes('compared with where the task left main: committed and uncommitted changes, new files included')) throw new Error(tip);
    // Committed and trimmed to one line: the counts follow, and the commit shows in the tooltip.
    writeFileSync(path.join(fixRoot, 'login.js'), 'export const login = () => true;\n');
    git(fixRoot, 'add', '.');
    git(fixRoot, 'commit', '-q', '-m', 'Fix login');
    await selectWorkspace(page, 'shop app');
    await selectWorkspace(page, 'Fix login');
    await until(async () => (await tooltip())?.includes('1 commit that main doesn’t have'), '1 commit in tooltip', 20_000);
    if ((await counts())?.replace(/\s+/g, ' ').trim() !== '+1 −0') throw new Error(await counts());
    tip = await tooltip();
    if (tip.includes('not committed yet')) throw new Error(tip);
    // The row is one line: no path, no branch line, no TASK tag.
    if (await page.$(`${row} .ws-item__path`)) throw new Error('path line shown');
    if (await page.$(`${row} .ws-item__git`)) throw new Error('branch line shown');
    // Summaries follow Git status checks; they never run more often.
    const runs = await app.evaluate(() => ({ git: globalThis.__twGitRuns(), summaries: globalThis.__twSummaryRuns() }));
    if (runs.summaries > runs.git) throw new Error(JSON.stringify(runs));
    return runs;
  });

  await step('the Changes panel is docked next to the terminal and follows the agent’s edits by itself (no click, no Refresh)', async () => {
    await selectWorkspace(page, 'Fix login');
    await page.waitForSelector('[data-testid="changes-panel"]', { timeout: 15_000 });
    if (!(await page.isVisible(`.tabview[data-tab-id="${fixTab}"] .pane__terminal`))) throw new Error('terminal hidden by the panel');
    await until(() => app.evaluate(() => globalThis.__twTaskWatches()), 'folder watched while the panel is shown');
    await page.waitForSelector('[data-testid="changes-files"] [data-path="login.js"]', { timeout: 15_000 });
    // Uncommitted work on top of the commit, written "by the agent" (outside SplitNest): it appears by itself.
    writeFileSync(path.join(fixRoot, 'login.js'), 'export const login = () => true;\nexport const logout = () => false;\n');
    writeFileSync(path.join(fixRoot, 'notes.md'), '# notes\n');
    // Output never settles while an agent works; the folder watch must carry it.
    await page.waitForSelector('[data-testid="changes-files"] [data-path="notes.md"]', { timeout: 15_000 });
    await until(async () => (await page.textContent('[data-testid="changes-totals"]'))?.replace(/\s+/g, ' ').trim() === '+3 −0', 'totals', 15_000);
    const facts = await page.textContent('[data-testid="changes-facts"]');
    if (!facts.includes('2 not committed') || !facts.includes('1 to merge')) throw new Error(facts);
    // Ignored files never trigger anything (node_modules/ is in .gitignore).
    const before = await app.evaluate(() => globalThis.__twGitRuns());
    mkdirSync(path.join(fixRoot, 'node_modules', 'x'), { recursive: true });
    for (let i = 0; i < 20; i++) writeFileSync(path.join(fixRoot, 'node_modules', 'x', `f${i}.js`), '//\n');
    await page.waitForTimeout(4500);
    const after = await app.evaluate(() => globalThis.__twGitRuns());
    if (after - before > 1) throw new Error(`ignored writes caused ${after - before} checks`);
    if (process.env.TW_TASK_SHOTS) await page.screenshot({ path: path.join(process.env.TW_TASK_SHOTS, 'task-changes-panel.png') });
  });

  await step('a file’s changes open as a diff tab in a pane beside the terminal; opening it again focuses that tab; Enter opens the next in the same pane', async () => {
    const diffTabs = () => page.$$eval('[role="tab"][data-diff-path]', (els) => els.map((e) => e.getAttribute('data-diff-path')));
    await page.click('[data-testid="changes-files"] [data-path="login.js"]');
    await page.waitForSelector('[role="tab"][data-diff-path="login.js"]', { timeout: 10_000 });
    await until(async () => (await page.textContent('.diffview:not([hidden]) [data-testid="diff-body"]').catch(() => ''))?.includes('export const logout'), 'login.js diff');
    // The terminal stays in view: the diff got its own pane.
    if (!(await page.isVisible(`.tabview[data-tab-id="${fixTab}"] .pane__terminal`))) throw new Error('terminal hidden');
    const panes = await page.$$eval('.workspace:not([hidden]) [data-pane-id]', (els) => els.length);
    if (panes !== 2) throw new Error(`${panes} panes`);
    await page.click('[data-testid="changes-files"] [data-path="login.js"]');
    if ((await diffTabs()).join('|') !== 'login.js') throw new Error(`duplicate: ${(await diffTabs()).join('|')}`);
    // Choosing an open file focuses its tab on the next frame: wait for that before using the keyboard in the list.
    await until(() => page.evaluate(() => !!document.activeElement?.closest('.diffview')), 'focus moved to the open diff');
    await page.focus('[data-testid="changes-files"] [data-path="login.js"]');
    await page.keyboard.press('ArrowDown');
    if ((await page.evaluate(() => document.activeElement?.getAttribute('data-path'))) !== 'notes.md') throw new Error('arrow didn’t move');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[role="tab"][data-diff-path="notes.md"]', { timeout: 10_000 });
    const sameDiffPane = await page.$$eval('[data-pane-id]', (els) => els.filter((e) => e.querySelector('[data-diff-path]')).map((e) => e.querySelectorAll('[data-diff-path]').length));
    if (sameDiffPane.join() !== '2') throw new Error(`diff tabs per pane: ${sameDiffPane.join()}`);
    await until(async () => (await page.textContent('.diffview:not([hidden]) [data-testid="diff-body"]').catch(() => ''))?.includes('# notes'), 'notes.md diff');
    if (process.env.TW_TASK_SHOTS) await page.screenshot({ path: path.join(process.env.TW_TASK_SHOTS, 'task-diff-tab.png') });
    await page.focus('[data-testid="changes-files"] [data-path="notes.md"]');
    await page.keyboard.press('Escape');
    if (!(await page.evaluate(() => !!document.activeElement?.closest('.tabview')))) throw new Error('Escape didn’t return to the terminal');
  });

  await step('an open diff follows the agent’s edits; a file with no changes anymore says so; diff tabs are never in the saved state', async () => {
    await page.click('[role="tab"][data-diff-path="login.js"]');
    writeFileSync(path.join(fixRoot, 'login.js'), 'export const login = () => true;\nexport const logout = () => false;\n// session timeout\n');
    await until(async () => (await page.textContent('.diffview:not([hidden]) [data-testid="diff-body"]').catch(() => ''))?.includes('// session timeout'), 'diff refreshed by itself', 20_000);
    // notes.md goes away: its tab says so instead of going blank.
    rmSync(path.join(fixRoot, 'notes.md'));
    await page.click('[role="tab"][data-diff-path="notes.md"]');
    await until(async () => (await page.textContent('.diffview:not([hidden]) [data-testid="diff-note"]').catch(() => ''))?.includes('no changes in the task anymore'), 'no-longer-changed note', 20_000);
    writeFileSync(path.join(fixRoot, 'notes.md'), '# notes\n');
    // Saved: no diff tab anywhere, and the pane that held only diffs isn't saved either.
    await until(() => {
      const w = saved()?.workspaces?.find((x) => x.name === 'Fix login');
      if (!w) return false;
      const tabs = [];
      const walk = (n) => (n?.type === 'pane' ? tabs.push(...n.tabs) : n?.children?.forEach(walk));
      walk(w.layout);
      return tabs.length > 0 && !tabs.some((t) => t.kind === 'diff') && w.layout.type === 'pane';
    }, 'saved without diff tabs');
  });

  await step('Ctrl+Shift+G hides and shows it (the folder watch stops while hidden); keyboard resizing is saved for this workspace', async () => {
    await page.keyboard.press('Control+Shift+G');
    await page.waitForSelector('[data-testid="changes-panel"]', { state: 'detached' });
    await until(async () => (await app.evaluate(() => globalThis.__twTaskWatches())) === 0, 'watch stopped');
    await page.keyboard.press('Control+Shift+G');
    await page.waitForSelector('[data-testid="changes-panel"]');
    await until(async () => (await page.evaluate(() => !!document.activeElement?.closest('.changes'))) === true, 'panel takes the keyboard');
    const w0 = await page.$eval('[data-testid="changes-panel"]', (e) => e.getBoundingClientRect().width);
    await page.focus('[data-testid="changes-handle"]');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
    const w1 = await page.$eval('[data-testid="changes-panel"]', (e) => e.getBoundingClientRect().width);
    if (Math.round(w1 - w0) !== 30) throw new Error(`${w0} → ${w1}`);
    await until(() => saved()?.workspaces?.find((w) => w.name === 'Fix login')?.changesPanel?.width === Math.round(w1), 'width saved');
    // Writing while hidden then showing again: the list catches up at once.
    await page.keyboard.press('Control+Shift+G');
    writeFileSync(path.join(fixRoot, 'later.txt'), 'later\n');
    await page.keyboard.press('Control+Shift+G');
    await page.waitForSelector('[data-testid="changes-files"] [data-path="later.txt"]', { timeout: 15_000 });
    return { from: Math.round(w0), to: Math.round(w1) };
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

  await step('a task with no changes says so in its panel; the palette command opens the panel, and is off outside a task', async () => {
    await selectWorkspace(page, 'Add tests');
    await page.keyboard.press('Control+Shift+G'); // hide, then the palette shows it again
    await page.waitForSelector('[data-testid="changes-panel"]', { state: 'detached' });
    if (!(await palette(page, 'Review task changes'))) throw new Error('command disabled');
    await page.waitForSelector('[data-testid="changes-empty"]', { timeout: 15_000 });
    // Each task keeps its own panel state: Fix login's width is unchanged.
    const fix = saved()?.workspaces?.find((w) => w.name === 'Fix login')?.changesPanel;
    const add = saved()?.workspaces?.find((w) => w.name === 'Add tests')?.changesPanel;
    if (!fix || !add || fix.width === add.width) throw new Error(JSON.stringify({ fix, add }));
    await selectWorkspace(page, 'shop app');
    if (await page.$('[data-testid="changes-panel"]')) throw new Error('panel on a non-task workspace');
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
    // Diff tabs aren't restored (they were never saved); the panel comes back open, at the width it had.
    if (await page.$('[role="tab"][data-diff-path]')) throw new Error('a diff tab was restored');
    const want = saved()?.workspaces?.find((w) => w.name === 'Fix login')?.changesPanel?.width;
    await page.waitForSelector('[data-testid="changes-panel"]', { timeout: 15_000 });
    const got = Math.round(await page.$eval('[data-testid="changes-panel"]', (e) => e.getBoundingClientRect().width));
    if (got !== want) throw new Error(`width after restart ${got}, saved ${want}`);
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

  // ---- Finish (M4)
  const stepText = (name) => page.textContent(`[data-testid="finish-step-${name}"]`);
  const openFinish = async (name) => {
    await selectWorkspace(page, name);
    if (!(await palette(page, 'Finish task'))) throw new Error('Finish disabled');
    await page.waitForSelector('[data-testid="finish-step-commit"]', { timeout: 20_000 });
  };
  const createTask = async (name) => {
    await selectWorkspace(page, 'shop app');
    await page.click('[aria-label="New agent task from shop app"]');
    await page.fill('[data-testid="task-name"]', name);
    await page.click('[data-testid="task-agent-none"]');
    await until(async () => (await page.$eval('[data-testid="task-create"]', (b) => !b.disabled)) === true, 'create enabled');
    await page.click('[data-testid="task-create"]');
    await page.waitForSelector('[data-testid="task-name"]', { state: 'detached', timeout: 30_000 });
    return path.join(`${proj}.worktrees`, name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  };

  await step('Finish names uncommitted files and the running terminal; Commit all commits them', async () => {
    await openFinish('Fix login');
    const c = await stepText('commit');
    if (!c.includes('3 files aren’t committed') || !c.includes('later.txt')) throw new Error(c);
    if (!(await stepText('clean')).includes('Its terminal is ended first')) throw new Error(await stepText('clean'));
    if (!(await page.$eval('[data-testid="finish-merge"]', (b) => b.disabled))) throw new Error('merge enabled with uncommitted files');
    await page.fill('[data-testid="finish-message"]', 'Fix login: logout and notes');
    await page.click('[data-testid="finish-commit"]');
    await until(async () => (await page.textContent('[data-testid="finish-note"]').catch(() => ''))?.startsWith('Committed'), 'committed');
    if (git(fixRoot, 'log', '-1', '--format=%s') !== 'Fix login: logout and notes') throw new Error('commit message');
    if (git(fixRoot, 'status', '--porcelain') !== '') throw new Error('not everything committed');
    await until(async () => (await stepText('merge'))?.includes('2 commits merge cleanly into main'), 'merge ready');
    if (process.env.TW_TASK_SHOTS) await page.screenshot({ path: path.join(process.env.TW_TASK_SHOTS, 'task-finish.png') });
  });

  await step('Merge into main and clean up: main has the work; the folder, branch, terminal and workspace are gone', async () => {
    await page.click('[data-testid="finish-merge"]');
    await page.waitForSelector('[data-testid="finish-step-commit"]', { state: 'detached', timeout: 60_000 });
    if (!readFileSync(path.join(proj, 'login.js'), 'utf8').includes('logout')) throw new Error('not merged into main');
    if (git(proj, 'symbolic-ref', '--short', 'HEAD') !== 'main') throw new Error('main changed branch');
    if (existsSync(fixRoot)) throw new Error('task folder still there');
    if (git(proj, 'branch', '--list', 'splitnest/fix-login') !== '') throw new Error('branch still there');
    if (await page.$('.ws-item__label:text-is("Fix login")')) throw new Error('still listed');
    if (fakes(fakeClaude).length > 0) throw new Error('the task’s agent still runs');
    // The workspace's own uncommitted file was never touched.
    if (readFileSync(path.join(proj, 'notes.txt'), 'utf8') !== 'draft\n') throw new Error('notes.txt changed');
  });

  await step('conflicts with main: Finish names them; Bring in main leaves them in the task; resolved and committed, it merges', async () => {
    const root = await createTask('Conflict');
    writeFileSync(path.join(root, 'README.md'), '# shop (task)\n');
    git(root, 'commit', '-q', '-am', 'task readme');
    writeFileSync(path.join(proj, 'README.md'), '# shop (main)\n');
    git(proj, 'commit', '-q', '-am', 'main readme');
    await openFinish('Conflict');
    await until(async () => (await stepText('merge'))?.includes('would conflict with main'), 'conflict preview');
    if (!(await stepText('merge')).includes('README.md')) throw new Error(await stepText('merge'));
    if (!(await page.$eval('[data-testid="finish-merge"]', (b) => b.disabled))) throw new Error('merge enabled despite conflicts');
    await page.click('[data-testid="finish-update"]');
    await until(async () => (await page.textContent('[data-testid="finish-note"]').catch(() => ''))?.includes('Conflicts are now in the task folder'), 'conflicts in task');
    if (git(proj, 'status', '--porcelain', '--untracked-files=no') !== '' || readFileSync(path.join(proj, 'README.md'), 'utf8') !== '# shop (main)\n') throw new Error('main touched');
    if (!(await stepText('commit')).includes('conflicts from bringing in main')) throw new Error(await stepText('commit'));
    writeFileSync(path.join(root, 'README.md'), '# shop (both)\n');
    await page.fill('[data-testid="finish-message"]', 'Bring in main');
    await page.click('[data-testid="finish-commit"]');
    await until(async () => (await stepText('merge'))?.includes('merge cleanly into main'), 'clean after resolving', 20_000);
    await page.click('[data-testid="finish-merge"]');
    await page.waitForSelector('[data-testid="finish-step-commit"]', { state: 'detached', timeout: 60_000 });
    if (readFileSync(path.join(proj, 'README.md'), 'utf8') !== '# shop (both)\n') throw new Error('resolution not merged');
    if (existsSync(root)) throw new Error('folder left');
  });

  await step('Discard lists what is lost, then deletes the folder and the unmerged branch', async () => {
    const root = await createTask('Throwaway');
    writeFileSync(path.join(root, 'idea.txt'), 'maybe\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'idea');
    writeFileSync(path.join(root, 'draft.txt'), 'uncommitted\n');
    await openFinish('Throwaway');
    await page.click('[data-testid="finish-discard"]');
    const box = await page.textContent('[data-testid="finish-discard-box"]');
    if (!box.includes('draft.txt') || !box.includes('1 commit that main doesn’t have') || !box.includes('splitnest/throwaway')) throw new Error(box);
    await page.click('[data-testid="finish-discard-confirm"]');
    await page.waitForSelector('[data-testid="finish-discard-box"]', { state: 'detached', timeout: 60_000 });
    if (existsSync(root)) throw new Error('folder left');
    if (git(proj, 'branch', '--list', 'splitnest/throwaway') !== '') throw new Error('branch left');
    if (existsSync(path.join(proj, 'idea.txt'))) throw new Error('discarded work reached main');
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
