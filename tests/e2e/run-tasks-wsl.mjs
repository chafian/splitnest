// Agent tasks on a repository stored inside WSL, end to end (dev build, TW_E2E=1; needs a WSL
// distribution with Git). The repository lives in a temporary folder under /tmp in Linux; the
// workspace is opened as \\wsl.localhost\<distro>\tmp\…\app. No agent is started (agent "None").
// Usage: node tests/e2e/run-tasks-wsl.mjs   (after `npm run package`)
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const DISTRO = process.env.TW_E2E_WSL ?? 'Ubuntu-22.04';
const lx = (...args) => execFileSync('wsl.exe', ['--distribution', DISTRO, '--exec', ...args], { encoding: 'utf8' }).replace(/\0/g, '').trim();
const unc = (linux) => `\\\\wsl.localhost\\${DISTRO}${linux.replace(/\//g, '\\')}`;

const work = mkdtempSync(path.join(tmpdir(), 'tw-tasks-wsl-'));
const ud = path.join(work, 'ud');
mkdirSync(ud, { recursive: true });
const tmp = lx('mktemp', '-d', '/tmp/tw-e2e-wsltask-XXXXXX');
if (!/^\/tmp\/tw-e2e-wsltask-[A-Za-z0-9]+$/.test(tmp)) throw new Error(`unexpected temp folder ${tmp}`);
lx('sh', '-c', 'cd "$1" && mkdir app && cd app && git init -q -b main && git config user.name Test && git config user.email test@example.invalid && printf "# app\\n" > README.md && git add . && git commit -q -m first', 'sh', tmp);
const repo = unc(`${tmp}/app`);
const taskLinux = `${tmp}/app.worktrees/fix-parser`;
const taskWin = unc(taskLinux);

const env = { ...process.env, TW_E2E: '1', TW_E2E_PICK_FOLDER: repo };
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
const until = async (fn, what, timeout = 30_000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};
const palette = async (page, title) => {
  await page.keyboard.press('Control+Shift+P');
  await page.keyboard.type(title);
  await page.waitForSelector(`[role="option"]:has-text("${title}")`, { timeout: 5000 });
  await page.keyboard.press('Enter');
};
const selectWorkspace = (page, name) => page.click(`.ws-item:has(.ws-item__label:text-is("${name}")) .ws-item__main`);
const termText = (page, tab) => page.evaluate((t) => window.__twTest.inspect(t, 80)?.text ?? '', tab);
const linuxExists = (p) => lx('sh', '-c', 'test -e "$1" && echo yes || echo no', 'sh', p) === 'yes';

let app = null;
try {
  app = await electron.launch({ executablePath: require('electron'), args: ['.', `--tw-user-data=${ud}`], cwd: root, env });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
  await page.click('button:has-text("Open folder…")');
  await page.waitForSelector('.ws-item__label:text-is("app")');

  await step('a workspace inside WSL gets New agent task by default (it has no sidebar Git status)', async () => {
    await selectWorkspace(page, 'app');
    await page.waitForSelector('[aria-label="New agent task from app"]', { state: 'attached', timeout: 15_000 });
  });

  await step('the dialog offers only that distribution’s WSL shell and shows the Linux repository’s task folder', async () => {
    await palette(page, 'New agent task…');
    await page.fill('[data-testid="task-name"]', 'Fix parser');
    await page.click('[data-testid="task-agent-none"]');
    await until(async () => (await page.textContent('[data-testid="task-preview"]'))?.includes('splitnest/fix-parser'), 'preview', 30_000);
    await page.click('[data-testid="task-shell"]');
    const shells = await page.$$eval('[role="listbox"][aria-label="Shell"] [role="option"]', (os) => os.map((o) => o.getAttribute('data-value')));
    await page.keyboard.press('Escape');
    if (shells.join('|') !== `wsl:${DISTRO}`) throw new Error(shells.join('|'));
    const text = await page.textContent('[data-testid="task-preview"]');
    if (!text.includes(taskWin)) throw new Error(text);
    if (await page.$('[data-testid="task-wsl-note"]')) throw new Error('Windows-drive note shown for a WSL repository');
  });

  let tab = null;
  await step('Create: Linux Git makes the worktree, and Git works in the task’s WSL terminal', async () => {
    await page.click('[data-testid="task-create"]');
    await page.waitForSelector('[data-testid="task-name"]', { state: 'detached', timeout: 60_000 });
    if (lx('cat', `${taskLinux}/.git`) !== `gitdir: ${tmp}/app/.git/worktrees/fix-parser`) throw new Error('not a Linux worktree');
    tab = await until(async () => {
      const t = await page.locator('[role="tab"][aria-selected="true"]:visible').first().getAttribute('data-tab-id');
      return t && (await page.evaluate((x) => window.__twTest.status(x) === 'running', t)) ? t : null;
    }, 'task terminal', 60_000);
    await page.waitForTimeout(1500);
    await page.click(`.tabview[data-tab-id="${tab}"] .pane__terminal`, { position: { x: 40, y: 20 } });
    await page.keyboard.type('git status');
    await page.keyboard.press('Enter');
    await until(async () => (await termText(page, tab)).includes('On branch splitnest/fix-parser'), 'git status in WSL', 30_000);
  });

  await step('Review and Finish with Linux Git: commit all, merge into main (no preview with Git 2.34), clean up', async () => {
    writeFileSync(`${taskWin}\\parser.c`, 'int parse(void) { return 0; }\n');
    // The WSL task's row gets its counts from Linux Git (WSL workspaces have no sidebar Git status).
    await selectWorkspace(page, 'app');
    await selectWorkspace(page, 'Fix parser');
    await until(async () => (await page.textContent('.ws-item--task [data-testid="task-counts"]').catch(() => ''))?.replace(/\s+/g, ' ').trim() === '+1 −0', 'WSL task counts', 30_000);
    // The Changes panel is open for the new task; WSL folders aren't watched, so Refresh (or the usual triggers) updates it.
    await page.waitForSelector('[data-testid="changes-panel"]', { timeout: 15_000 });
    if (await app.evaluate(() => globalThis.__twTaskWatches())) throw new Error('a WSL folder is being watched');
    await page.click('[data-testid="changes-panel"] [aria-label="Check for changes now"]');
    await page.waitForSelector('[data-testid="changes-files"] [data-path="parser.c"]', { timeout: 30_000 });
    await page.click('[data-testid="changes-finish"]');
    await page.waitForSelector('[data-testid="finish-message"]', { timeout: 30_000 });
    await page.fill('[data-testid="finish-message"]', 'Add parser');
    await page.click('[data-testid="finish-commit"]');
    await until(async () => (await page.textContent('[data-testid="finish-step-merge"]'))?.includes('1 commit'), 'ready to merge', 30_000);
    const merge = await page.textContent('[data-testid="finish-step-merge"]');
    const version = lx('git', '--version');
    if (/2\.3[0-7]\./.test(version) && !merge.includes('can’t check for conflicts first')) throw new Error(merge);
    await page.click('[data-testid="finish-merge"]');
    await page.waitForSelector('[data-testid="finish-step-commit"]', { state: 'detached', timeout: 90_000 });
    if (!existsSync(`${repo}\\parser.c`)) throw new Error('not merged');
    if (linuxExists(taskLinux)) throw new Error('task folder left');
    if (lx('git', '-C', `${tmp}/app`, 'branch', '--list', 'splitnest/fix-parser') !== '') throw new Error('branch left');
    if (await page.$('.ws-item__label:text-is("Fix parser")')) throw new Error('still listed');
    return { git: version };
  });
} catch (e) {
  results.push({ name: 'script error', ok: false });
  console.log(`  ✗ script error: ${e?.message ?? e}`);
} finally {
  if (app) {
    await app.evaluate(() => {
      globalThis.__twQuitAsk = async () => 'discard';
    }).catch(() => undefined);
    await app.close().catch(() => undefined);
  }
  try {
    lx('rm', '-rf', tmp);
  } catch {
    // gone
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `RESULT: ${failed} of ${results.length} steps FAILED` : `RESULT: all ${results.length} steps passed`);
process.exit(failed ? 1 : 0);
