// Git status in the sidebar, end to end (dev build, temporary folders and profile only).
// A real repository is created in a temp folder and opened as a workspace; Git commands are typed
// into its terminal or run from outside. Checks what the sidebar row shows and when it changes:
//   clean (branch only) / lines added and removed / a rename (dot, explained) / untracked files /
//   a branch switch typed in the terminal (time until shown) / a commit made outside SplitNest,
//   seen on window focus and on selecting the workspace / a folder under a Git home folder that
//   is not a repository (nothing) / a "development server" printing for 40 s (number of Git
//   checks) / a WSL terminal in a C:\ workspace / a workspace inside WSL (no Git) / the setting.
// Usage: node tests/e2e/run-git.mjs [--shots dir]   (after `npm run package` or `npm run start` built .vite)
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.resolve(here, '..', '..');
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });

// ------------------------------------------------------------- folders
const work = mkdtempSync(path.join(tmpdir(), 'tw-gite2e-'));
const repo = path.join(work, 'git-check');
const plain = path.join(work, 'plain-folder');
mkdirSync(repo);
mkdirSync(plain);
git(repo, 'init', '-q', '-b', 'main');
writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
writeFileSync(path.join(repo, 'b.txt'), 'keep\n');
git(repo, 'add', '.');
git(repo, 'commit', '-q', '-m', 'first');
const shots = arg('--shots', path.join(work, 'shots'));
mkdirSync(shots, { recursive: true });

// A WSL distribution, for the WSL cases (skipped without one).
let distro = null;
try {
  distro = execFileSync('wsl.exe', ['-l', '-q'], { encoding: 'utf16le' }).split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('docker-desktop')) ?? null;
} catch {
  distro = null;
}
const wslRoot = distro ? `\\\\wsl.localhost\\${distro}\\tmp` : null;
const picks = [repo, plain, ...(wslRoot ? [wslRoot] : [])].join('|');

const app = await electron.launch({ executablePath: require('electron'), args: ['.', `--tw-user-data=${path.join(work, 'ud')}`], cwd: root, env: { ...process.env, TW_E2E: '1', TW_E2E_PICK_FOLDER: picks } });
const page = await app.firstWindow();
await page.setViewportSize({ width: 1360, height: 860 }).catch(() => undefined);
await page.click('button:has-text("Open folder…")');
await page.waitForSelector('[data-pane-id][data-status="running"]');

const results = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    const info = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, ...(info ?? {}) });
    console.log(`  ✓ ${name}${info ? ` ${JSON.stringify(info)}` : ''}`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error.message ?? error).slice(0, 500) });
    console.log(`  ✗ ${name}: ${String(error.message ?? error).slice(0, 500)}`);
    await page.screenshot({ path: path.join(shots, `git-fail-${results.length}.png`) }).catch(() => undefined);
  }
};
const row = (name) => `.ws-item:has(.ws-item__label:text-is("${name}"))`;
/** What a workspace row shows for Git (null: no Git line). */
const gitRow = (name) =>
  page.evaluate((sel) => {
    const item = [...document.querySelectorAll('.ws-item')].find((li) => li.querySelector('.ws-item__label')?.textContent === sel);
    const g = item?.querySelector('.ws-item__git');
    if (!g) return null;
    return {
      branch: g.querySelector('.ws-item__git-branch')?.textContent ?? null,
      added: g.querySelector('.ws-item__git-added')?.textContent ?? null,
      removed: g.querySelector('.ws-item__git-removed')?.textContent ?? null,
      dot: !!g.querySelector('.ws-item__git-dot'),
      tooltip: g.getAttribute('title') ?? '',
      // What assistive technology announces for the row (the row button's description).
      accessible: item.querySelector('.ws-item__main')?.getAttribute('aria-description') ?? '',
    };
  }, name);
const waitRow = async (name, pred, what, timeout = 15_000) => {
  const t0 = Date.now();
  for (;;) {
    const r = await gitRow(name);
    if (pred(r)) return { row: r, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeout) throw new Error(`${what}: row is ${JSON.stringify(r)}`);
    await sleep(100);
  }
};
const runs = () => app.evaluate(() => globalThis.__twGitRuns?.() ?? -1);
/** Recent text of the visible terminal (through the E2E hook: WebGL draws no DOM text). */
const termText = () =>
  page.evaluate(() => {
    const tab = document.querySelector('.workspace:not([hidden]) [role="tab"][aria-selected="true"]')?.getAttribute('data-tab-id');
    return tab ? (window.__twTest.inspect(tab, 60)?.text ?? '') : '';
  });
const type = async (text) => {
  await page.click('.workspace:not([hidden]) .tabview:not([hidden]) .pane__terminal', { position: { x: 40, y: 20 } });
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};

await step('a clean repository: the branch only, nothing else', async () => {
  const { row: r } = await waitRow('git-check', (r) => r?.branch === 'main', 'branch not shown', 20_000);
  if (r.added !== null || r.removed !== null || r.dot) throw new Error(`not quiet: ${JSON.stringify(r)}`);
  if (!r.tooltip.includes('No changes')) throw new Error(`tooltip: ${r.tooltip}`);
  return { row: r.branch };
});

await step('a branch switch typed in the terminal appears promptly', async () => {
  await sleep(1500);
  await type('git switch -c feature/login');
  const { ms } = await waitRow('git-check', (r) => r?.branch === 'feature/login', 'new branch not shown');
  if (ms > 4000) throw new Error(`took ${ms} ms`);
  return { msAfterEnter: ms };
});

await step('lines added and removed: +added −removed', async () => {
  await type("Set-Content a.txt -Value 'one','TWO','three'");
  const { row: r, ms } = await waitRow('git-check', (r) => r?.added === '+2' && r?.removed === '−1', 'line totals not shown');
  if (r.dot) throw new Error('dot shown together with line totals');
  await page.screenshot({ path: path.join(shots, '35-git-status.png'), clip: { x: 0, y: 0, width: 300, height: 260 } });
  return { shown: `${r.added} ${r.removed}`, ms };
});

await step('a rename without changed lines: a dot, explained', async () => {
  await type('git checkout -- a.txt; git mv b.txt renamed.txt');
  const { row: r } = await waitRow('git-check', (r) => r?.dot === true, 'dot not shown');
  if (r.added !== null) throw new Error(`line totals shown: ${JSON.stringify(r)}`);
  if (!/1 changed file, no lines added or removed \(for example a renamed file/.test(r.tooltip)) throw new Error(`tooltip: ${r.tooltip}`);
  return { tooltip: r.tooltip.split('\n')[1] };
});

await step('a folder of three untracked files: a dot; "Untracked files present" in tooltip and accessible text, no count', async () => {
  await type("git mv renamed.txt b.txt; New-Item -ItemType Directory drafts | Out-Null; 1..3 | % { Set-Content \"drafts\\$_.txt\" -Value $_ }");
  const { row: r } = await waitRow('git-check', (r) => r?.dot === true && /untracked/i.test(r.tooltip) && !/changed file/.test(r.tooltip), 'untracked not shown');
  const counts = /\b\d+ (new|untracked) files?\b/i;
  if (!r.tooltip.includes('Untracked files present (their lines are not counted)')) throw new Error(`tooltip: ${r.tooltip}`);
  if (!r.accessible.includes('Git branch feature/login, untracked files present')) throw new Error(`accessible: ${r.accessible}`);
  if (counts.test(r.tooltip) || counts.test(r.accessible)) throw new Error(`a count is shown: ${r.tooltip} | ${r.accessible}`);
  if (r.added !== null) throw new Error(`line totals shown for untracked files: ${JSON.stringify(r)}`);
  return { tooltip: r.tooltip.split('\n').find((l) => l.includes('Untracked')), accessible: r.accessible.slice(r.accessible.indexOf('Git branch')) };
});

await step('the same folder plus a tracked edit: line totals; "Untracked files present" still in tooltip and accessible text', async () => {
  await type("Add-Content a.txt -Value 'three'");
  const { row: r } = await waitRow('git-check', (r) => r?.added === '+1', 'line totals not shown');
  if (r.removed !== '−0' || r.dot) throw new Error(`row: ${JSON.stringify(r)}`);
  if (!r.tooltip.includes('1 changed file: 1 lines added, 0 removed') && !r.tooltip.includes('1 changed file: 1 lines added')) throw new Error(`tooltip: ${r.tooltip}`);
  if (!r.tooltip.includes('Untracked files present (their lines are not counted)')) throw new Error(`tooltip: ${r.tooltip}`);
  if (!r.accessible.includes('Git branch feature/login, 1 lines added, 0 removed, untracked files present')) throw new Error(`accessible: ${r.accessible}`);
  return { shown: `${r.added} ${r.removed}`, accessible: r.accessible.slice(r.accessible.indexOf('Git branch')) };
});

await step('a commit made outside SplitNest is seen when the window gets focus again', async () => {
  await type('git checkout -- a.txt; Remove-Item -Recurse drafts');
  await waitRow('git-check', (r) => r && !r.dot && r.added === null, 'not clean again');
  await sleep(1200);
  appendFileSync(path.join(repo, 'a.txt'), 'outside\n');
  await sleep(1500);
  const r0 = await gitRow('git-check');
  if (r0?.added) throw new Error(`changed without any trigger: ${JSON.stringify(r0)}`);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const { ms } = await waitRow('git-check', (r) => r?.added === '+1', 'not seen on focus', 5000);
  return { msAfterFocus: ms };
});

await step('a folder that is not a repository (below a home folder that is one): no Git line', async () => {
  await page.keyboard.press('Control+Shift+O');
  await page.waitForSelector(row('plain-folder'));
  await sleep(2500);
  const r = await gitRow('plain-folder');
  if (r !== null) throw new Error(`shown: ${JSON.stringify(r)}`);
  return { homeIsRepository: (() => { try { return !!git(process.env.USERPROFILE, 'rev-parse', '--show-toplevel').trim(); } catch { return false; } })() };
});

await step('a change made while another workspace is shown is seen on selecting the workspace', async () => {
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'outside');
  await sleep(1200);
  const before = await gitRow('git-check');
  if (before?.added !== '+1') throw new Error(`expected the old state still shown, got ${JSON.stringify(before)}`);
  await page.click(`${row('git-check')} .ws-item__main`);
  const { ms } = await waitRow('git-check', (r) => r?.branch === 'feature/login' && r.added === null && !r.dot, 'not refreshed on select', 5000);
  return { msAfterSelect: ms };
});

await step('a development server printing for 40 s causes only occasional Git checks', async () => {
  await sleep(4000);
  const start = await runs();
  // About 20 lines a second for 40 seconds, then quiet.
  await type('1..800 | % { "GET /api/items 200 $_ ms"; Start-Sleep -Milliseconds 50 }');
  const t0 = Date.now();
  while (!/GET \/api\/items 200 800 ms/.test(await termText()) && Date.now() - t0 < 120_000) await sleep(100);
  const printing = (Date.now() - t0) / 1000;
  const during = (await runs()) - start;
  await sleep(4000);
  const after = (await runs()) - start - during;
  // At most one check per 30 s while it prints (plus one at its start: the command line's echo),
  // and one after it stops.
  const limit = Math.ceil(printing / 30) + 1;
  if (during > limit) throw new Error(`${during} checks during ${printing.toFixed(0)} s of output (limit ${limit})`);
  if (after !== 1) throw new Error(`${after} checks after the output stopped (expected 1)`);
  return { secondsPrinting: Math.round(printing), checksWhilePrinting: during, checksAfter: after };
});

if (distro) {
  await step('a WSL terminal in a C:\\ workspace: its output triggers Git checks of the workspace', async () => {
    await page.keyboard.press('Control+Shift+P');
    await page.keyboard.type('new terminal current pane wsl');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.workspace:not([hidden]) [role="tab"]').length >= 2, null, { timeout: 30_000 });
    await sleep(6000); // WSL start
    await type("printf 'from wsl\\n' >> a.txt");
    const { ms } = await waitRow('git-check', (r) => r?.added === '+1', 'WSL change not shown', 15_000);
    return { distro, msAfterEnter: ms };
  });
  await step('a workspace inside WSL (\\\\wsl.localhost\\...): no Git line, Git never run for it', async () => {
    const start = await runs();
    await page.keyboard.press('Control+Shift+O');
    await page.waitForSelector(row('tmp'), { timeout: 20_000 });
    await page.click(`${row('tmp')} .ws-item__main`);
    await sleep(3000);
    const r = await gitRow('tmp');
    if (r !== null) throw new Error(`shown: ${JSON.stringify(r)}`);
    return { checksMeanwhile: (await runs()) - start };
  });
} else {
  results.push({ name: 'WSL cases', ok: true, skipped: 'no WSL distribution' });
}

await step('the setting turns the Git line off and on', async () => {
  await page.click(`${row('git-check')} .ws-item__main`);
  await page.keyboard.press('Control+Comma');
  await page.click('.settings-nav__item:has-text("Workspaces")');
  await page.waitForSelector('input[aria-label="Show Git status in the sidebar"]', { state: 'attached' });
  const sw = page.locator('input[aria-label="Show Git status in the sidebar"]');
  const hint = await page.evaluate(() => document.querySelector('input[aria-label="Show Git status in the sidebar"]')?.closest('.setting')?.textContent ?? '');
  if (!hint.includes('\\\\wsl$\\') || !hint.includes('\\\\wsl.localhost\\')) throw new Error(`WSL limitation not documented: ${hint.slice(0, 200)}`);
  await sw.click({ force: true });
  await waitRow('git-check', (r) => r === null, 'still shown after turning it off', 5000);
  await sw.click({ force: true });
  await waitRow('git-check', (r) => r !== null, 'not back after turning it on', 10_000);
  return {};
});

await app.evaluate(() => {
  globalThis.__twQuitAsk = () => Promise.resolve('discard');
});
await app.close().catch(() => undefined);
try {
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
} catch {
  console.log(`(temp folder kept: ${work})`);
}
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `RESULT: ${failed.length} of ${results.length} steps FAILED` : `RESULT: all ${results.length} steps passed`);
process.exit(failed.length ? 1 : 0);
