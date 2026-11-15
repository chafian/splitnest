// Source Control panel of a normal workspace, end to end (dev build, TW_E2E=1): a temporary repository
// with a local bare repository as its remote, and a second clone standing in for someone else. Stage,
// unstage, diff tabs, commit (Ctrl+Enter), a refusing hook, push with upstream setup (confirmed), pull
// fast-forward and its refusal when both sides moved, discard (confirmed), and a repository inside WSL.
// Usage: node tests/e2e/run-git-panel.mjs   (after `npm run package`, which builds .vite/build)
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const work = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'tw-sc-e2e-')));
const repo = path.join(work, 'web app');
const bare = path.join(work, 'remote.git');
const other = path.join(work, 'other clone');
const ud = path.join(work, 'ud');
for (const d of [repo, ud]) mkdirSync(d, { recursive: true });

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const configure = (dir) => {
  for (const [k, v] of [
    ['user.name', 'Test'],
    ['user.email', 'test@example.invalid'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
  ])
    git(dir, 'config', k, v);
};
git(repo, 'init', '-q', '-b', 'main');
configure(repo);
writeFileSync(path.join(repo, 'README.md'), '# web\n');
writeFileSync(path.join(repo, 'app.js'), 'console.log(1);\n');
git(repo, 'add', '.');
git(repo, 'commit', '-q', '-m', 'first');
git(work, 'init', '-q', '--bare', '-b', 'main', bare);
git(repo, 'remote', 'add', 'origin', bare);

// WSL: a repository inside the distribution (when WSL is there).
const DISTRO = process.env.TW_E2E_WSL ?? 'Ubuntu-22.04';
let wslRepo = null;
let wslTmp = null;
const lx = (...args) => execFileSync('wsl.exe', ['--distribution', DISTRO, '--exec', ...args], { encoding: 'utf8' }).replace(/\0/g, '').trim();
if (process.env.TW_E2E_SKIP_WSL !== '1') {
  try {
    wslTmp = lx('mktemp', '-d', '/tmp/tw-e2e-sc-XXXXXX');
    if (!/^\/tmp\/tw-e2e-sc-[A-Za-z0-9]+$/.test(wslTmp)) throw new Error(`unexpected temp folder ${wslTmp}`);
    lx('sh', '-c', 'cd "$1" && mkdir lib && cd lib && git init -q -b main && git config user.name Test && git config user.email test@example.invalid && printf "a\\n" > a.txt && git add . && git commit -q -m first && printf "b\\n" > a.txt', 'sh', wslTmp);
    wslRepo = `\\\\wsl.localhost\\${DISTRO}${wslTmp}\\lib`.replace(/\//g, '\\');
  } catch {
    wslRepo = null;
  }
}

const env = { ...process.env, TW_E2E: '1', TW_E2E_PICK_FOLDER: [repo, wslRepo].filter(Boolean).join('|') };
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
const selectWorkspace = (page, name) => page.click(`.ws-item:has(.ws-item__label:text-is("${name}")) .ws-item__main`);
const row = (group, file) => `[data-testid="sc-${group}"] .sc__row:has([data-path="${file}"])`;
const listed = async (page, group) =>
  page.$$eval(`[data-testid="sc-${group}"] [data-path]`, (els) => els.map((e) => e.getAttribute('data-path'))).catch(() => []);
/** Clicks a row's action button (they show on hover). */
const rowAction = async (page, group, file, label) => {
  await page.hover(row(group, file));
  await page.click(`${row(group, file)} button[aria-label="${label} ${file}"]`);
};
const refresh = (page) => page.click('[data-testid="sc-panel"] button[aria-label="Check for changes now"]');

let app = null;
try {
  app = await electron.launch({ executablePath: require('electron'), args: ['.', `--tw-user-data=${ud}`], cwd: root, env });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
  await page.click('button:has-text("Open folder…")');
  await page.waitForSelector('.ws-item__label:text-is("web app")');

  await step('Ctrl+Shift+G shows Source Control on a normal workspace in a repository: branch, not pushed yet, clean', async () => {
    await page.waitForSelector('.ws-item--active .ws-item__git-branch', { timeout: 15_000 }); // the sidebar knows it is a repository
    await page.keyboard.press('Control+Shift+G');
    await page.waitForSelector('[data-testid="sc-panel"]', { timeout: 10_000 }).catch(async (e) => {
      await page.screenshot({ path: path.join(root, 'test-results', 'screenshots', 'sc-debug.png') });
      const labels = await page.$$eval('.titlebar button[aria-label]', (els) => els.map((x) => x.getAttribute('aria-label')));
      const saved = JSON.parse(readFileSync(path.join(ud, 'workspace-state.json'), 'utf8')).workspaces.map((w) => w.changesPanel);
      await page.click('button[aria-label="Show changes panel"]').catch(() => undefined);
      await page.waitForTimeout(1500);
      throw new Error(`${e.message}; titlebar ${labels}; saved ${JSON.stringify(saved)}; after click: ${!!(await page.$('[data-testid="sc-panel"]'))}`);
    });
    await page.waitForSelector('[data-testid="sc-clean"]', { timeout: 10_000 }).catch(async (e) => {
      throw new Error(`${e.message}; panel: ${await page.textContent('[data-testid="sc-panel"]')}`);
    });
    const branch = await page.textContent('[data-testid="sc-branch"]');
    if (!branch.includes('main') || !branch.includes('not pushed yet')) throw new Error(`branch line: ${branch}`);
  });

  await step('changes appear by themselves (folder watch); a file opens its diff as a tab', async () => {
    writeFileSync(path.join(repo, 'README.md'), '# web\nA fast web app.\n');
    writeFileSync(path.join(repo, 'notes.txt'), 'todo\n');
    await until(async () => (await listed(page, 'unstaged')).length === 2, 'two changed files listed');
    if ((await listed(page, 'unstaged')).join() !== 'README.md,notes.txt') throw new Error(`listed: ${await listed(page, 'unstaged')}`);
    await page.click(`${row('unstaged', 'README.md')} [role="option"]`);
    await page.waitForSelector('.diffview:visible .diff__row--add:has-text("A fast web app.")');
    const tab = await page.textContent('[role="tab"][data-diff-path="README.md"] .tab__shell');
    if (tab !== 'changes') throw new Error(`tab label: ${tab}`);
  });

  await step('stage one file, then unstage it; Stage all; the staged diff tab', async () => {
    await rowAction(page, 'unstaged', 'README.md', 'Stage');
    await until(async () => (await listed(page, 'staged')).join() === 'README.md', 'README.md staged');
    if (git(repo, 'diff', '--cached', '--name-only') !== 'README.md') throw new Error('git does not have it staged');
    await rowAction(page, 'staged', 'README.md', 'Unstage');
    await until(async () => (await listed(page, 'staged')).length === 0, 'unstaged again');
    await page.click('[data-testid="sc-unstaged"] .sc__group-action');
    await until(async () => (await listed(page, 'staged')).join() === 'README.md,notes.txt', 'all staged');
    await page.click(`${row('staged', 'README.md')} [role="option"]`);
    await page.waitForSelector('.diffview:visible .diffview__base:has-text("staged, against the last commit")');
    await page.click('[data-testid="sc-staged"] .sc__group-action'); // Unstage all
    await until(async () => (await listed(page, 'staged')).length === 0, 'all unstaged');
  });

  await step('commit with Ctrl+Enter commits only what is staged', async () => {
    await rowAction(page, 'unstaged', 'README.md', 'Stage');
    await until(async () => (await listed(page, 'staged')).join() === 'README.md', 'README.md staged');
    await page.fill('[data-testid="sc-message"]', 'Describe the app');
    await page.focus('[data-testid="sc-message"]');
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('[data-testid="sc-notice"]:has-text("Committed")');
    if (git(repo, 'log', '-1', '--format=%s') !== 'Describe the app') throw new Error('not committed');
    if ((await listed(page, 'unstaged')).join() !== 'notes.txt') throw new Error('notes.txt should still be a change');
    if ((await page.inputValue('[data-testid="sc-message"]')) !== '') throw new Error('message not cleared');
  });

  await step('a commit hook that refuses: its message is shown and nothing is lost', async () => {
    writeFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "lint: 2 problems in notes.txt" >&2\nexit 1\n');
    await page.fill('[data-testid="sc-message"]', 'Add notes');
    if ((await page.textContent('[data-testid="sc-commit"]')) !== 'Stage all and commit') throw new Error('button should offer Stage all and commit');
    await page.click('[data-testid="sc-commit"]');
    await page.waitForSelector('[data-testid="sc-action-error"]:has-text("lint: 2 problems in notes.txt")');
    if (git(repo, 'log', '-1', '--format=%s') !== 'Describe the app') throw new Error('a commit was made');
    if (!existsSync(path.join(repo, 'notes.txt'))) throw new Error('notes.txt lost');
    rmSync(path.join(repo, '.git', 'hooks', 'pre-commit'));
    await page.click('[data-testid="sc-commit"]');
    await page.waitForSelector('[data-testid="sc-notice"]:has-text("Committed")');
    await page.waitForSelector('[data-testid="sc-clean"]');
  });

  await step('push without an upstream asks where first, then pushes and tracks; ahead count goes to 0', async () => {
    await page.click('[data-testid="sc-push"]');
    await page.waitForSelector('dialog[open]:has-text("Push and track this branch?")');
    const text = await page.textContent('dialog[open]');
    if (!text.includes('“main”') || !text.includes('“origin”')) throw new Error(`dialog: ${text}`);
    await page.click('dialog[open] .dialog__footer button:has-text("Push")');
    await page.waitForSelector('[data-testid="sc-notice"]:has-text("Pushed and tracking origin/main")', { timeout: 30_000 });
    if (git(bare, 'log', '-1', '--format=%s', 'main') !== 'Add notes') throw new Error('remote does not have the commits');
    const branch = await page.textContent('[data-testid="sc-branch"]');
    if (!branch.includes('↑0 ↓0')) throw new Error(`branch line: ${branch}`);
  });

  await step('pull fast-forwards; when both sides moved it refuses and creates no merge', async () => {
    git(work, 'clone', '-q', bare, other);
    configure(other);
    writeFileSync(path.join(other, 'theirs.txt'), 'from a teammate\n');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'Theirs');
    git(other, 'push', '-q');
    await page.click('[data-testid="sc-pull"]');
    await page.waitForSelector('[data-testid="sc-notice"]:has-text("Pulled")', { timeout: 30_000 });
    if (!existsSync(path.join(repo, 'theirs.txt'))) throw new Error('not pulled');
    writeFileSync(path.join(other, 'theirs.txt'), 'again\n');
    git(other, 'commit', '-q', '-am', 'Theirs 2');
    git(other, 'push', '-q');
    writeFileSync(path.join(repo, 'app.js'), 'console.log(2);\n');
    await until(async () => (await listed(page, 'unstaged')).join() === 'app.js', 'app.js changed');
    await page.fill('[data-testid="sc-message"]', 'Ours');
    await page.click('[data-testid="sc-commit"]');
    await page.waitForSelector('[data-testid="sc-notice"]:has-text("Committed")');
    await page.click('[data-testid="sc-pull"]');
    await page.waitForSelector('[data-testid="sc-action-error"]:has-text("both have new commits")', { timeout: 30_000 });
    if (git(repo, 'log', '-1', '--format=%s') !== 'Ours') throw new Error('a merge was made');
  });

  await step('discard asks first: a change is undone, a new file is deleted', async () => {
    writeFileSync(path.join(repo, 'README.md'), 'oops\n');
    writeFileSync(path.join(repo, 'scratch.tmp'), 'x\n');
    await until(async () => (await listed(page, 'unstaged')).join() === 'README.md,scratch.tmp', 'both listed');
    await rowAction(page, 'unstaged', 'README.md', 'Discard changes to');
    await page.waitForSelector('dialog[open]:has-text("Discard changes?")');
    await page.click('dialog[open] .dialog__footer button:has-text("Discard changes")');
    await until(async () => (await listed(page, 'unstaged')).join() === 'scratch.tmp', 'README.md restored');
    // Restored: Git sees no change (the bytes on disk follow this machine's line-ending settings).
    const left = git(repo, 'status', '--porcelain', '--', 'README.md');
    if (left !== '') throw new Error(`README.md not restored: ${left}`);
    await rowAction(page, 'unstaged', 'scratch.tmp', 'Discard changes to');
    await page.waitForSelector('dialog[open]:has-text("Delete this new file?")');
    await page.click('dialog[open] .dialog__footer button:has-text("Delete file")');
    await until(async () => !existsSync(path.join(repo, 'scratch.tmp')), 'scratch.tmp deleted');
    await page.screenshot({ path: path.join(root, 'test-results', 'screenshots', 'sc-panel.png') }).catch(() => undefined);
  });

  if (wslRepo) {
    await step('a repository inside WSL: its own Git lists, stages and commits', async () => {
      await page.click('button[aria-label="Open folder"], .sidebar button[aria-label^="Open folder"]').catch(() => page.keyboard.press('Control+Shift+O'));
      await page.waitForSelector('.ws-item__label:text-is("lib")', { timeout: 20_000 });
      await selectWorkspace(page, 'lib');
      await page.keyboard.press('Control+Shift+G');
      await page.waitForSelector('[data-testid="sc-panel"][aria-label="Source control for lib"]');
      await refresh(page);
      await until(async () => (await listed(page, 'unstaged')).join() === 'a.txt', 'a.txt listed', 40_000);
      await page.fill('[data-testid="sc-message"]', 'From WSL');
      await page.click('[data-testid="sc-commit"]');
      await page.waitForSelector('[data-testid="sc-notice"]:has-text("Committed")', { timeout: 30_000 });
      const log = lx('git', '-C', `${wslTmp}/lib`, 'log', '-1', '--format=%s');
      if (log !== 'From WSL') throw new Error(`log: ${log}`);
    });
  }
} finally {
  if (app) {
    await app
      .evaluate(() => {
        globalThis.__twQuitAsk = async () => 'discard';
      })
      .catch(() => undefined);
    await app.close().catch(() => undefined);
  }
  if (wslTmp) {
    try {
      lx('rm', '-rf', '--', wslTmp);
    } catch {
      /* best effort */
    }
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 5 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
