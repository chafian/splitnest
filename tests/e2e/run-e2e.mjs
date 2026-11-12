// End-to-end check of the real app UI with real shells, driven by Playwright.
// Runs the production build from `.vite/` (created by `npm run package`)
// with an isolated user-data folder, and writes screenshots and a JSON
// report. Usage: node tests/e2e/run-e2e.mjs [--screenshots test-results/screenshots]
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const shotsArg = process.argv.indexOf('--screenshots');
// Not committed: they show local temp folders (README images are made by scripts/readme-screenshots.mjs).
const shots = path.resolve(root, shotsArg > 0 ? process.argv[shotsArg + 1] : 'test-results/screenshots');
mkdirSync(shots, { recursive: true });

const work = mkdtempSync(path.join(tmpdir(), 'tw-e2e-'));
const userData = path.join(work, 'user-data');
const alpha = path.join(work, 'alpha-service');
const beta = path.join(work, "beta 'café' & co ⚡");
mkdirSync(alpha);
mkdirSync(beta);
writeFileSync(path.join(alpha, 'README.md'), '# alpha\n');
writeFileSync(path.join(beta, 'notes.md'), 'beta notes\n');
// Quit tests use their own folder.
const gamma = path.join(work, 'gamma-quit');
mkdirSync(gamma);
writeFileSync(path.join(gamma, 'a.txt'), 'alpha');
writeFileSync(path.join(gamma, 'b.txt'), 'beta');
// A Maven-style tree for compact folders: java-app/src/main/java/com/example/…
const javaPkg = path.join(alpha, 'java-app', 'src', 'main', 'java', 'com', 'example');
mkdirSync(javaPkg, { recursive: true });
const LONG_JAVA = 'CustomerReservationAvailabilityCalculationServiceImplementation.java';
writeFileSync(path.join(javaPkg, 'App.java'), 'package com.example;\n\npublic class App {}\n');
writeFileSync(path.join(javaPkg, LONG_JAVA), 'package com.example;\n');
for (const dir of ['src/components', 'tests/unit', 'docs', '.github/workflows']) mkdirSync(path.join(alpha, dir), { recursive: true });
for (const file of ['package.json', 'tsconfig.json', '.gitignore', 'vite.config.ts', 'src/main.ts', 'src/components/App.tsx', 'src/styles.css', 'tests/unit/app.test.ts', 'docs/notes.md', '.github/workflows/ci.yml', "src/it's & ünï ⚡.ts"]) {
  writeFileSync(path.join(alpha, file), '');
}

const report = { startedAt: new Date().toISOString(), steps: [], metrics: {} };
const step = async (name, fn) => {
  const t = Date.now();
  try {
    const detail = await fn();
    report.steps.push({ name, ok: true, ms: Date.now() - t, ...(detail ? { detail } : {}) });
    console.log(`  ✓ ${name} (${Date.now() - t} ms)${detail ? ' ' + JSON.stringify(detail) : ''}`);
  } catch (error) {
    report.steps.push({ name, ok: false, ms: Date.now() - t, error: String(error?.message ?? error).slice(0, 500) });
    await globalThis.__e2ePage?.screenshot({ path: path.join(work, 'failure.png') }).catch(() => undefined);
    const tabs = await globalThis.__e2ePage
      ?.$$eval('[data-pane-id]', (els) => els.map((e) => ({ pane: e.getAttribute('data-pane-id'), tabs: e.querySelectorAll('[role="tab"]').length, status: e.getAttribute('data-status') })))
      .catch(() => null);
    console.log('  state at failure:', JSON.stringify(tabs), `screenshot: ${path.join(work, 'failure.png')}`);
    // Which wait failed: the first stack frame in this script.
    const where = String(error?.stack ?? '').split('\n').find((l) => l.includes('run-e2e.mjs'));
    if (where) console.log(`  at ${where.trim()}`);
    // The visible pane text, to see what the shell showed when the wait gave up.
    const panes = await globalThis.__e2ePage
      ?.$$eval('[data-pane-id]', (els) => els.map((e) => e.getAttribute('data-active-tab')))
      .catch(() => []);
    for (const t of panes ?? []) {
      const text = await globalThis.__e2ePage.evaluate((id) => window.__twTest?.inspect(id, 30)?.text ?? '', t).catch(() => '');
      console.log(`  pane tail (${t}): ${JSON.stringify(text.split('\n').filter((l) => l.trim()).slice(-6))}`);
    }
    console.log(`  ✗ ${name}: ${error?.message ?? error}`);
    throw error;
  }
};

async function launch(extraEnv = {}) {
  const t = Date.now();
  const app = await electron.launch({
    executablePath: electronPath,
    args: ['.', `--tw-user-data=${userData}`],
    cwd: root,
    env: { ...process.env, TW_E2E: '1', ...extraEnv },
  });
  const page = await app.firstWindow();
  globalThis.__e2ePage = page;
  await page.waitForSelector('.app');
  await page.waitForFunction(() => !!document.querySelector('.welcome, .workspace'));
  // Test-only resize log (shown when a wait fails); sizes and timings, no terminal text.
  await page.evaluate(() => window.__twTest?.termOptions({ resizeLog: true })).catch(() => undefined);
  return { app, page, launchMs: Date.now() - t };
}

const panes = (page) => page.$$eval('.workspace:not([hidden]) [data-pane-id]', (els) => els.map((e) => e.getAttribute('data-pane-id')));
// Pane ids resolve to the pane's active tab (terminals are keyed by tab id).
const inspect = (page, id, lines = 400) =>
  page.evaluate(([i, l]) => window.__twTest.inspect(document.querySelector(`[data-pane-id="${i}"]`)?.getAttribute('data-active-tab') ?? i, l), [id, lines]);
const status = (page, id) => page.getAttribute(`[data-pane-id="${id}"]`, 'data-status');

async function waitText(page, id, pattern, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const res = await inspect(page, id);
    const text = res?.text ?? '';
    if (typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)) return text;
    if (Date.now() > deadline) {
      const tab = await page.getAttribute(`[data-pane-id="${id}"]`, 'data-active-tab').catch(() => null);
      const resizes = tab ? await page.evaluate((t) => window.__twTest.resizes(t).slice(-25), tab).catch(() => []) : [];
      throw new Error(`timeout waiting for ${pattern}; tail: ${text.slice(-300)}\n  resize log: ${resizes.map((r) => JSON.stringify(r)).join('\n    ')}`);
    }
    await page.waitForTimeout(100);
  }
}

async function waitStatus(page, id, wanted, timeout = 30_000) {
  await page.waitForSelector(`[data-pane-id="${id}"][data-status="${wanted}"]`, { timeout });
}

async function typeIn(page, id, text, enter = true) {
  await page.click(`[data-pane-id="${id}"] .tabview:not([hidden]) .pane__terminal`, { position: { x: 40, y: 20 } });
  await page.keyboard.type(text, { delay: 2 });
  if (enter) await page.keyboard.press('Enter');
}

/**
 * Does `act` (typing or pasting a command) until `pattern` shows in the terminal. On a slow machine
 * (GitHub's Windows runner) input sent right when a prompt comes back can be lost while PSReadLine
 * redraws; Escape clears anything half-typed before the next try. Only for idempotent commands.
 */
async function untilShown(page, id, act, pattern, tries = 4) {
  for (let i = 1; ; i++) {
    await act();
    try {
      return await waitText(page, id, pattern, i === tries ? 30_000 : 5000);
    } catch (e) {
      if (i === tries) throw e;
      await page.keyboard.press('Escape');
    }
  }
}

const shot = (page, name) => page.screenshot({ path: path.join(shots, name) });

const tabsIn = (page, paneId) => page.$$eval(`[data-pane-id="${paneId}"] [role="tab"]`, (els) => els.map((e) => e.getAttribute('data-tab-id')));
const visibleTabs = (page) => page.$$eval('.workspace:not([hidden]) [role="tab"]', (els) => els.map((e) => e.getAttribute('data-tab-id')));
const tabStatus = (page, tabId) => page.evaluate((t) => window.__twTest.status(t), tabId);
const tabText = (page, tabId) => page.textContent(`[data-tab-id="${tabId}"][role="tab"] .tab__name`);
// Main logs one "session started" line per created PTY session (never terminal content).
const sessionsStarted = () => {
  try {
    return (readFileSync(path.join(userData, 'logs', 'splitnest.log'), 'utf8').match(/session started/g) ?? []).length;
  } catch {
    return 0;
  }
};

/**
 * Waits until a pane's terminal has a settled width (same cols on reads
 * 150 ms apart) that satisfies `accept`, then returns it. Fails with the
 * column history and pane geometry instead of sleeping a fixed time.
 */
async function settledCols(page, paneId, accept = () => true, what = 'settled columns', timeout = 8000) {
  const deadline = Date.now() + timeout;
  const history = [];
  let previous = null;
  for (;;) {
    const cols = (await inspect(page, paneId, 1))?.cols ?? null;
    history.push(cols);
    if (cols !== null && cols === previous && accept(cols)) return cols;
    previous = cols;
    if (Date.now() > deadline) {
      const geometry = await page.$$eval('.workspace:not([hidden]) [data-pane-id]', (els) =>
        els.map((e) => `${e.getAttribute('data-pane-id').slice(0, 8)}:${Math.round(e.getBoundingClientRect().width)}px`),
      );
      throw new Error(`timed out waiting for ${what}; cols seen ${history.slice(-12).join(',')}; panes ${geometry.join(' ')}`);
    }
    await page.waitForTimeout(150);
  }
}

/** Asks the shell itself how wide its PTY is (PowerShell or bash), proving the resize reached the PTY. */
async function assertPtyCols(page, paneId, expected) {
  const label = await page.getAttribute(`[data-pane-id="${paneId}"] [role="tab"][aria-selected="true"]`, 'aria-label');
  const bash = /Ubuntu|WSL/i.test(label ?? '');
  await typeIn(page, paneId, bash ? 'echo "PTY""COLS=$(tput cols)"' : 'Write-Output ("PTY" + "COLS=" + $Host.UI.RawUI.WindowSize.Width)');
  // Not `\b`: ConPTY can leave stale characters from an earlier, wrapped prompt right after the number.
  await waitText(page, paneId, new RegExp(`PTYCOLS=${expected}(?!\\d)`), 10_000);
}

async function waitTabStatus(page, tabId, wanted, timeout = 60_000) {
  await page.waitForFunction(([t, w]) => window.__twTest.status(t) === w, [tabId, wanted], { timeout });
}

/** Types `exit` into every running terminal in the visible workspace (background tabs too). */
async function exitAllVisible(page) {
  for (const tabId of await visibleTabs(page)) {
    if ((await tabStatus(page, tabId)) !== 'running') continue;
    await page.click(`[data-tab-id="${tabId}"][role="tab"]`);
    const paneId = await page.evaluate((t) => document.querySelector(`[data-tab-id="${t}"][role="tab"]`).closest('[data-pane-id]').getAttribute('data-pane-id'), tabId);
    await typeIn(page, paneId, 'exit');
    await waitTabStatus(page, tabId, 'exited', 15_000);
  }
}

async function renameViaKeyboard(page, tabId, name) {
  await page.focus(`[data-tab-id="${tabId}"][role="tab"]`);
  await page.keyboard.press('F2');
  await page.waitForSelector(`[data-tab-id="${tabId}"] .tab__input`);
  await page.keyboard.press('Control+A');
  if (name) await page.keyboard.type(name);
  else await page.keyboard.press('Delete');
  await page.keyboard.press('Enter');
  await page.waitForSelector(`[data-tab-id="${tabId}"] .tab__input`, { state: 'detached' });
  await page.waitForTimeout(150); // Enter hands focus back to the terminal on the next frame
}

async function main() {
  console.log(`E2E work dir: ${work}`);
  // ------------------------------------------------------------- run 1
  let { app, page, launchMs } = await launch({ TW_E2E_PICK_FOLDER: `${alpha}|${beta}` });
  report.metrics.firstLaunchToWindowMs = launchMs;
  await page.setViewportSize({ width: 1360, height: 860 }).catch(() => undefined);
  await page.waitForTimeout(300);
  await step('welcome screen', async () => {
    await page.waitForSelector('text=Open a project folder');
    await shot(page, '01-welcome.png');
  });

  let ps, wsl, wsl2;
  await step('open folder creates workspace with a running PowerShell pane', async () => {
    await page.click('button:has-text("Open folder…")');
    await page.waitForSelector('[data-pane-id]');
    [ps] = await panes(page);
    await waitStatus(page, ps, 'running');
    await waitText(page, ps, /PS alpha-service>/);
  });

  await step('typing, multiline output, unicode and ANSI colours', async () => {
    await typeIn(page, ps, 'Write-Host "Hello from $((Get-Location).Path)" -ForegroundColor Cyan; 1..3 | ForEach-Object { "row $_" }');
    await waitText(page, ps, 'row 3');
    // Unicode output, typed as ASCII (character codes): on GitHub's en-US runner non-ASCII
    // keyboard input never reached the prompt in the PTY tests. Typed non-ASCII is covered by the
    // path-insertion step below.
    const uni = [0xfc, 0x6e, 0xef, 0x63, 0xf6, 0x64, 0xe9, 0x20, 0x26a1, 0x20, 0x4e2d, 0x6587].map((c) => `[char]0x${c.toString(16)}`).join(',');
    await typeIn(page, ps, `Write-Host " OK " -BackgroundColor DarkGreen -NoNewline; Write-Host (' ' + (-join @(${uni})) + ' build passed') -ForegroundColor Green`);
    await waitText(page, ps, 'ünïcödé ⚡ 中文 build passed');
  });

  await step('Ctrl+C interrupts a foreground command', async () => {
    await typeIn(page, ps, 'ping -n 30 127.0.0.1');
    await waitText(page, ps, /Reply from 127/);
    const t = Date.now();
    await page.keyboard.press('Control+C');
    await waitText(page, ps, 'Control-C', 5000);
    if ((await status(page, ps)) !== 'running') throw new Error('shell ended');
    return { interruptMs: Date.now() - t };
  });

  await step('paste with Ctrl+V and copy a selection with Ctrl+C', async () => {
    await app.evaluate(({ clipboard }) => clipboard.writeText('Write-Output ("PASTED-" + "OK")'));
    await page.click(`[data-pane-id="${ps}"] .tabview:not([hidden]) .pane__terminal`, { position: { x: 40, y: 20 } });
    // Right after the Ctrl+C step the prompt is being redrawn; a paste then could be lost.
    await untilShown(
      page,
      ps,
      async () => {
        await page.keyboard.press('Control+V');
        await page.keyboard.press('Enter');
      },
      /^PASTED-OK$/m,
    );
    await app.evaluate(({ clipboard }) => clipboard.writeText(''));
    const box = await page.locator(`[data-pane-id="${ps}"] .tabview:not([hidden]) .pane__terminal`).boundingBox();
    await page.mouse.move(box.x + 10, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + 260, box.y + 8, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.press('Control+C');
    await page.waitForTimeout(300);
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    if (!copied.trim()) throw new Error('nothing copied');
    if ((await status(page, ps)) !== 'running') throw new Error('Ctrl+C with selection interrupted the shell');
    return { copied: copied.slice(0, 40) };
  });

  await step('file explorer lists the workspace with file-type icons and inserts quoted paths', async () => {
    const row = (p) => `.workspace:not([hidden]) .explorer__row[data-path="${p}"]`;
    await page.waitForSelector(row('README.md'));
    const order = await page.$$eval('.workspace:not([hidden]) .explorer__row', (els) => els.map((e) => e.getAttribute('data-path')));
    if (order.indexOf('src') > order.indexOf('package.json')) throw new Error(`folders not first: ${order}`);
    const icons = await page.$$eval('.workspace:not([hidden]) .explorer__row img', (imgs) => new Set(imgs.map((i) => i.getAttribute('src'))).size);
    if (icons < 5) throw new Error(`expected distinct icons, got ${icons}`);
    await page.click(row('src'));
    await page.waitForSelector(row('src/components'));
    await page.click(row('src/components'));
    await page.waitForSelector(row('src/components/App.tsx'));
    // tests/ holds only unit/: shown as one compact row right away, without expanding anything.
    await page.waitForSelector(row('tests/unit'));
    if ((await page.textContent(`${row('tests/unit')} .explorer__name`)) !== 'tests/unit') throw new Error('tests/unit not compacted on load');
    // Keyboard: walk down to it with ArrowDown and expand it with ArrowRight.
    await page.click(row('docs'));
    const selectedPath = () => page.getAttribute('.workspace:not([hidden]) .explorer__row--selected', 'data-path');
    for (let i = 0; i < 30 && (await selectedPath()) !== 'tests/unit'; i++) await page.keyboard.press('ArrowDown');
    if ((await selectedPath()) !== 'tests/unit') throw new Error(`keyboard did not reach tests/unit (at ${await selectedPath()})`);
    await page.keyboard.press('ArrowRight');
    await page.waitForSelector(row('tests/unit/app.test.ts'));
    // "Insert path into terminal" puts the quoted path at the prompt without running it.
    const insert = async (p) => {
      await page.click(row(p), { button: 'right' });
      await page.click('.menu--context button:has-text("Insert path into terminal")');
    };
    await insert("src/it's & ünï ⚡.ts");
    const expected = `'${path.join(alpha, 'src', "it''s & ünï ⚡.ts")}'`;
    await waitText(page, ps, expected);
    await page.waitForTimeout(300);
    await shot(page, '00-file-explorer.png');
    await page.keyboard.press('Escape'); // PSReadLine: clear the current line
    // Insert again and run Test-Path on it to prove the quoting is exact.
    await insert("src/it's & ünï ⚡.ts");
    await page.keyboard.press('Home');
    await page.keyboard.type('Write-Output ("EXISTS=" + (Test-Path -LiteralPath ');
    await page.keyboard.press('End');
    await page.keyboard.type('))');
    await page.keyboard.press('Enter');
    await waitText(page, ps, /^EXISTS=True$/m);
  });

  const hasWsl = await page.evaluate(() => true);
  await step('open a WSL pane beside PowerShell in the mapped folder', async () => {
    await page.keyboard.press('Control+Shift+P');
    await page.keyboard.type('split left/right wsl');
    const item = page.locator('.palette__item:not(.palette__item--disabled)', { hasText: 'Split left/right (new pane on the right): WSL' }).first();
    if (!(await item.count())) {
      await page.keyboard.press('Escape');
      return { skipped: 'no WSL distribution' };
    }
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.workspace:not([hidden]) [data-pane-id]').length === 2);
    [, wsl] = await panes(page);
    await waitStatus(page, wsl, 'running', 60_000);
    await page.waitForTimeout(1500);
    await typeIn(page, wsl, `printf 'PWD=%s\\n' "$PWD"; ls -la --color=always`);
    await waitText(page, wsl, /PWD=\/.*alpha-service/, 30_000);
    await page.waitForTimeout(400);
    await shot(page, '02-powershell-and-wsl.png');
    return { hasWsl };
  });

  await step('terminal tabs: new tab, switch, drag to another pane, close', async () => {
    const tabsOf = (paneId) => page.$$eval(`[data-pane-id="${paneId}"] [role="tab"]`, (els) => els.map((e) => e.getAttribute('data-tab-id')));
    const activeOf = (paneId) => page.getAttribute(`[data-pane-id="${paneId}"]`, 'data-active-tab');
    const [firstTab] = await tabsOf(ps);
    await page.click(`[data-pane-id="${ps}"] .tabview:not([hidden]) .pane__terminal`, { position: { x: 40, y: 20 } });
    await page.keyboard.press('Control+Shift+T');
    await page.waitForFunction((id) => document.querySelectorAll(`[data-pane-id="${id}"] [role="tab"]`).length === 2, ps);
    await waitStatus(page, ps, 'running');
    await waitText(page, ps, /PS alpha-service>/);
    await typeIn(page, ps, 'Write-Output ("SECOND-" + "TAB")');
    await waitText(page, ps, /^SECOND-TAB$/m);
    if (wsl) {
      await page.keyboard.press('Control+Shift+P');
      await page.keyboard.type('new terminal current pane wsl');
      await page.keyboard.press('Enter');
      await page.waitForFunction((id) => document.querySelectorAll(`[data-pane-id="${id}"] [role="tab"]`).length === 3, ps);
      await waitStatus(page, ps, 'running', 60_000);
      await page.waitForTimeout(1200);
    }
    await page.waitForTimeout(300);
    await shot(page, '00-tabs.png');
    // The newest tab is last: Ctrl+Tab wraps to the first tab, Ctrl+Shift+Tab goes back.
    const all = await tabsOf(ps);
    if ((await activeOf(ps)) !== all.at(-1)) throw new Error('new tab not active');
    await page.keyboard.press('Control+Tab');
    await page.waitForFunction(([id, t]) => document.querySelector(`[data-pane-id="${id}"]`)?.getAttribute('data-active-tab') === t, [ps, firstTab]);
    await page.keyboard.press('Control+Shift+Tab');
    await page.waitForFunction(([id, t]) => document.querySelector(`[data-pane-id="${id}"]`)?.getAttribute('data-active-tab') === t, [ps, all.at(-1)]);
    await page.keyboard.press('Control+Tab');
    await page.waitForFunction(([id, t]) => document.querySelector(`[data-pane-id="${id}"]`)?.getAttribute('data-active-tab') === t, [ps, firstTab]);
    await waitText(page, ps, /^PASTED-OK$/m);
    if ((await status(page, ps)) !== 'running') throw new Error('first tab not running');
    const moved = { from: ps, to: wsl };
    if (wsl) {
      // Drag the WSL tab into the WSL pane; its session keeps running.
      const [, , wslTab] = await tabsOf(ps);
      await page.locator(`[data-tab-id="${wslTab}"][role="tab"]`).dragTo(page.locator(`[data-pane-id="${wsl}"] [role="tablist"]`));
      await page.waitForFunction(([id]) => document.querySelectorAll(`[data-pane-id="${id}"] [role="tab"]`).length === 2, [wsl]);
      if ((await activeOf(wsl)) !== wslTab) throw new Error('moved tab not active');
      if ((await status(page, wsl)) !== 'running') throw new Error('moved tab session not running');
      await typeIn(page, wsl, 'echo MOVED-$((20+1))');
      await waitText(page, wsl, 'MOVED-21');
      await shot(page, '00-tabs-moved.png');
      // Close the moved tab (live session -> confirmation).
      await page.keyboard.press('Control+Shift+W');
      await page.click('button:has-text("End session and close")');
      await page.waitForFunction(([id]) => document.querySelectorAll(`[data-pane-id="${id}"] [role="tab"]`).length === 1, [wsl]);
    }
    // Close the second PowerShell tab with its close button.
    const [, second] = await tabsOf(ps);
    await page.hover(`[data-tab-id="${second}"][role="tab"]`);
    await page.click(`[data-tab-id="${second}"][role="tab"] .tab__close`);
    await page.click('button:has-text("End session and close")');
    await page.waitForFunction((id) => document.querySelectorAll(`[data-pane-id="${id}"] [role="tab"]`).length === 1, ps);
    if ((await status(page, ps)) !== 'running') throw new Error('remaining tab stopped');
    return { moved: !!moved.to };
  });

  await step('rename terminals: F2 and context menu, Enter saves, Escape cancels, blank resets, long names truncate', async () => {
    const [main] = await tabsIn(page, ps);
    // A background tab that will be restored later (exited now so quitting needs no confirmation).
    await page.click(`[data-pane-id="${ps}"] .tabview:not([hidden]) .pane__terminal`, { position: { x: 40, y: 20 } });
    await page.keyboard.press('Control+Shift+T');
    await page.waitForFunction((id) => document.querySelectorAll(`[data-pane-id="${id}"] [role="tab"]`).length === 2, ps);
    const [, logs] = await tabsIn(page, ps);
    await waitTabStatus(page, logs, 'running');
    await renameViaKeyboard(page, logs, 'Logs');
    if ((await tabText(page, logs)) !== 'Logs') throw new Error(`rename failed: ${await tabText(page, logs)}`);
    // Escape cancels.
    await page.focus(`[data-tab-id="${logs}"][role="tab"]`);
    await page.keyboard.press('F2');
    await page.keyboard.type('zzz');
    await page.keyboard.press('Escape');
    await page.waitForSelector(`[data-tab-id="${logs}"] .tab__input`, { state: 'detached' });
    if ((await tabText(page, logs)) !== 'Logs') throw new Error('Escape did not cancel');
    // Shell activity (PowerShell sets the window title) must not replace the name.
    await typeIn(page, ps, '$Host.UI.RawUI.WindowTitle = "auto title"; exit');
    await waitTabStatus(page, logs, 'exited', 15_000);
    await page.waitForTimeout(400);
    if (!(await tabText(page, logs)).startsWith('Logs')) throw new Error('shell title replaced the custom name');
    // Context menu path on the main tab, with a long name.
    await page.click(`[data-tab-id="${main}"][role="tab"]`, { button: 'right' });
    await page.click('.menu--context button:has-text("Rename terminal")');
    await page.waitForSelector(`[data-tab-id="${main}"] .tab__input`);
    const long = 'Backend API server (watch mode, port 8080)';
    await page.keyboard.type(long);
    await page.keyboard.press('Enter');
    await page.waitForSelector(`[data-tab-id="${main}"] .tab__input`, { state: 'detached' });
    const nameBox = await page.$eval(`[data-tab-id="${main}"] .tab__name`, (e) => ({ text: e.textContent, truncated: e.scrollWidth > e.clientWidth, title: e.closest('[role="tab"]').title }));
    if (nameBox.text !== long.slice(0, 48)) throw new Error(`long name not stored: ${nameBox.text}`);
    if (!nameBox.truncated) throw new Error('long name is not truncated');
    if (!nameBox.title.includes(long) || !nameBox.title.includes('Shell:')) throw new Error('tooltip lacks name or shell');
    // "Name · Shell": separator shown, shell as secondary text, both in the accessible name and tooltip.
    const parts = await page.$eval(`[data-tab-id="${main}"][role="tab"]`, (e) => ({
      sep: e.querySelector('.tab__sep')?.textContent,
      shell: e.querySelector('.tab__shell')?.textContent,
      aria: e.getAttribute('aria-label'),
      title: e.title.split('\n')[0],
    }));
    // The default shell is PowerShell 7 where it is installed (GitHub's runners), else Windows PowerShell.
    if (parts.sep !== '·' || !['PowerShell', 'PowerShell 7'].includes(parts.shell)) throw new Error(`label parts: ${JSON.stringify(parts)}`);
    if (!parts.aria.startsWith(`${long}, ${parts.shell} terminal`) || parts.title !== `${long} · ${parts.shell}`) throw new Error(`label text: ${JSON.stringify(parts)}`);
    // Without a custom name the shell is not repeated.
    if (await page.$(`[data-tab-id="${(await tabsIn(page, wsl ?? ps))[0]}"][role="tab"] .tab__sep`)) throw new Error('separator without a custom name');
    if (wsl) {
      // Blank input resets to the shell's own label.
      const [wslTab] = await tabsIn(page, wsl);
      const original = await tabText(page, wslTab);
      await renameViaKeyboard(page, wslTab, 'Tmp');
      await renameViaKeyboard(page, wslTab, '');
      if ((await tabText(page, wslTab)) !== original) throw new Error(`blank did not reset: ${await tabText(page, wslTab)}`);
    }
    await page.click(`[data-tab-id="${main}"][role="tab"]`);
    await waitStatus(page, ps, 'running');
    await page.waitForTimeout(200);
    await shot(page, '15-tab-names.png');
    return { long: nameBox };
  });

  if (wsl) {
    await step('interactive full-screen program (top) in WSL', async () => {
      // ConPTY repaints full-screen programs itself, so xterm may not see an
      // alternate-screen switch; check what is rendered instead.
      await typeIn(page, wsl, 'top -d 1');
      await waitText(page, wsl, /load average/, 15_000);
      await page.waitForTimeout(1200);
      const view = await inspect(page, wsl, 60);
      await shot(page, '03-wsl-top.png');
      await page.keyboard.press('q');
      await page.waitForTimeout(500);
      await typeIn(page, wsl, 'echo TOP-$((1+1))-DONE');
      await waitText(page, wsl, 'TOP-2-DONE', 10_000);
      return { alternateBufferSeen: view.alternate };
    });

    await step('split down and resize with the divider', async () => {
      await page.click(`[data-pane-id="${wsl}"] .tabview:not([hidden]) .pane__terminal`, { position: { x: 40, y: 20 } });
      await page.keyboard.press('Control+Shift+S');
      await page.waitForFunction(() => document.querySelectorAll('.workspace:not([hidden]) [data-pane-id]').length === 3);
      wsl2 = (await panes(page))[2];
      await waitStatus(page, wsl2, 'running', 60_000);
      const before = await settledCols(page, ps, () => true, 'PowerShell pane width before dragging');
      const divider = page.locator('.workspace:not([hidden]) .divider--vertical').first();
      const b = await divider.boundingBox();
      const hit = await page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el ? `${el.tagName}.${el.className}` : 'none';
      }, [b.x + b.width / 2, b.y + b.height * 0.25]);
      if (!hit.includes('divider--vertical')) throw new Error(`divider is covered by ${hit} (box ${JSON.stringify(b)})`);
      await page.mouse.move(b.x + b.width / 2, b.y + b.height * 0.25);
      await page.mouse.down();
      await page.mouse.move(b.x - 180, b.y + b.height * 0.25, { steps: 10 });
      await page.mouse.up();
      const after = await settledCols(page, ps, (c) => c < before, `cols to shrink below ${before} after dragging the divider (box ${JSON.stringify(b)})`);
      await typeIn(page, ps, 'Write-Output ("WIDTH=" + $Host.UI.RawUI.WindowSize.Width)');
      await waitText(page, ps, `WIDTH=${after}`);
      // Keyboard resize of the focused divider.
      await divider.focus();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      return { colsBefore: before, colsAfter: after };
    });
  }

  await step('large output stream keeps the UI responsive', async () => {
    await page.evaluate(() => {
      window.__gaps = [];
      let last = performance.now();
      const tick = (now) => {
        window.__gaps.push(now - last);
        last = now;
        if (!window.__stopFrames) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const t = Date.now();
    await typeIn(page, ps, '1..100000 | ForEach-Object { "line $_ of the large output test" }; Write-Output ("BIG-" + "DONE")');
    await waitText(page, ps, /^BIG-DONE$/m, 180_000);
    const elapsed = Date.now() - t;
    const gaps = await page.evaluate(() => {
      window.__stopFrames = true;
      const g = window.__gaps.slice(1).sort((a, b) => a - b);
      return { frames: g.length, p50: g[Math.floor(g.length * 0.5)], p95: g[Math.floor(g.length * 0.95)], max: g[g.length - 1] };
    });
    report.metrics.largeOutput = { lines: 100000, elapsedMs: elapsed, frameGapMs: gaps };
    return report.metrics.largeOutput;
  });

  await step('search in terminal', async () => {
    await page.click(`[data-pane-id="${ps}"] .tabview:not([hidden]) .pane__terminal`, { position: { x: 40, y: 20 } });
    await page.keyboard.press('Control+Shift+F');
    await page.fill('.searchbar__input', 'line 99990');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const sel = await page.evaluate((id) => window.__twTest.inspect(id, 1) && document.querySelector('.searchbar__result')?.textContent, ps);
    await shot(page, '04-search.png');
    await page.keyboard.press('Escape');
    if (sel === 'No matches') throw new Error('search found nothing');
  });

  await step('second workspace in a folder with apostrophe, ampersand and unicode; sessions keep running while switched away', async () => {
    await typeIn(page, ps, '1..12 | ForEach-Object { "tick $_"; Start-Sleep -Milliseconds 400 }');
    await page.keyboard.press('Control+Shift+O');
    await page.waitForFunction(() => document.querySelectorAll('.ws-item').length === 2);
    const [betaPane] = await panes(page);
    await waitStatus(page, betaPane, 'running');
    await typeIn(page, betaPane, 'Write-Output ("CWD=[" + (Get-Location).Path + "]")');
    await waitText(page, betaPane, `CWD=[${beta}]`);
    await page.waitForTimeout(3000);
    await shot(page, '05-second-workspace.png');
    await page.click('.ws-item:nth-child(1) .ws-item__main');
    const text = await waitText(page, ps, 'tick 12', 15_000);
    if (!text.includes('tick 7')) throw new Error('missing ticks while hidden');
    if ((await status(page, ps)) !== 'running') throw new Error('session not running after switch');
  });

  await step('compact folders: java-app/src/main/java/com/example is one row; segments and files keep their real paths', async () => {
    const row = (p) => `.workspace:not([hidden]) .explorer__row[data-path="${p}"]`;
    const pkg = 'java-app/src/main/java/com/example';
    // Shown as one collapsed row from the initial load (folders are inspected lazily, one level at a time).
    await page.waitForSelector(row(pkg));
    const label = await page.textContent(`${row(pkg)} .explorer__name`);
    if (label !== pkg) throw new Error(`compact label: ${label}`);
    if ((await page.getAttribute(row(pkg), 'aria-expanded')) !== 'false') throw new Error('compact row should start collapsed');
    await page.click(row(pkg));
    await page.waitForSelector(row(`${pkg}/App.java`));
    const depths = await page.$$eval('.workspace:not([hidden]) .explorer__row', (els) =>
      els.filter((e) => e.getAttribute('data-path')?.startsWith('java-app')).map((e) => [e.getAttribute('data-path'), e.getAttribute('aria-level')]),
    );
    if (depths.length !== 3) throw new Error(`expected 1 folder row + 2 files, got ${JSON.stringify(depths)}`);
    // Long names truncate, with the full path in the tooltip.
    const longRow = row(`${pkg}/${LONG_JAVA}`);
    const info = await page.$eval(longRow, (e) => ({ truncated: e.querySelector('.explorer__name').scrollWidth > e.querySelector('.explorer__name').clientWidth, title: e.title }));
    if (!info.truncated || !info.title.endsWith(`com\\example\\${LONG_JAVA}`)) throw new Error(`long name: ${JSON.stringify(info)}`);
    // Right-clicking one segment acts on that real folder.
    await page.click(`${row(pkg)} [data-segment-path="java-app/src/main"]`, { button: 'right' });
    await page.click('.menu--context button:has-text("Copy relative path")');
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
    if (clip !== 'java-app\\src\\main') throw new Error(`segment path: ${clip}`);
    // Keyboard: Left on the expanded compact row collapses it; Right expands it again.
    await page.click(row(pkg));
    await page.waitForSelector(row(`${pkg}/App.java`), { state: 'detached' });
    await page.keyboard.press('ArrowRight');
    await page.waitForSelector(row(`${pkg}/App.java`));
    await page.keyboard.press('ArrowDown');
    const selected = await page.getAttribute('.workspace:not([hidden]) .explorer__row--selected', 'data-path');
    if (selected !== `${pkg}/${LONG_JAVA}` && selected !== `${pkg}/App.java`) throw new Error(`arrow selection: ${selected}`);
    await page.waitForTimeout(200);
    await shot(page, '27-compact-folders.png');
    // Collapse again so later steps see the same tree as before.
    await page.click(row(pkg));
    // A new file in a middle folder breaks the chain after a refresh; a second folder breaks it higher up.
    writeFileSync(path.join(alpha, 'java-app', 'src', 'main', 'NOTES.md'), '');
    await page.click('.workspace:not([hidden]) .explorer button[aria-label="Refresh file list"]');
    await page.waitForSelector(row('java-app/src/main'));
    if ((await page.textContent(`${row('java-app/src/main')} .explorer__name`)) !== 'java-app/src/main') throw new Error('chain not broken by a file');
    await page.click(row('java-app/src/main'));
    await page.waitForSelector(row('java-app/src/main/java/com/example')); // the rest of the chain stays compact below
    await page.waitForSelector(row('java-app/src/main/NOTES.md'));
    await page.click(row('java-app/src/main'));
    mkdirSync(path.join(alpha, 'java-app', 'docs'));
    await page.click('.workspace:not([hidden]) .explorer button[aria-label="Refresh file list"]');
    await page.waitForFunction(() => document.querySelector('.workspace:not([hidden]) .explorer__row[data-path="java-app"] .explorer__name')?.textContent === 'java-app');
    return { rows: depths };
  });

  await step('file editor: click opens beside the terminal, edit, Ctrl+S, conflicts, reload, close with unsaved changes', async () => {
    const row = (p) => `.workspace:not([hidden]) .explorer__row[data-path="${p}"]`;
    const fileTab = (p) => `.workspace:not([hidden]) [role="tab"][data-file-path="${p}"]`;
    const tabIdOf = (p) => page.getAttribute(fileTab(p), 'data-tab-id');
    const waitEditor = (id, field, value) =>
      page
        .waitForFunction(([t, k, v]) => window.__twEditor.state(t)?.[k] === v, [id, field, value], { timeout: 10_000 })
        .catch(() => {
          throw new Error(`editor never reached ${field}=${value}`);
        });
    const readme = path.join(alpha, 'README.md');
    const before = (await panes(page)).length;
    await page.click(row('README.md'));
    await page.waitForSelector(fileTab('README.md'));
    const id = await tabIdOf('README.md');
    await page.waitForFunction((t) => window.__twEditor.text(t) === '# alpha\n', id);
    if ((await panes(page)).length !== before + 1) throw new Error('file did not open in a new pane beside the terminal');
    await page.waitForFunction(() => !!document.activeElement?.closest('.cm-editor'));
    // Edit and save.
    await page.keyboard.press('Control+End');
    await page.keyboard.type('edited in SplitNest');
    await page.waitForSelector(`${fileTab('README.md')}[data-dirty="true"]`);
    await page.keyboard.press('Control+S');
    await page.waitForSelector(`${fileTab('README.md')}[data-dirty="false"]`);
    if (readFileSync(readme, 'utf8') !== '# alpha\nedited in SplitNest') throw new Error(`saved content: ${JSON.stringify(readFileSync(readme, 'utf8'))}`);
    const saveState = () => page.getAttribute('.workspace:not([hidden]) .tabview--file:not([hidden]) .editor-status__save', 'data-save-state');
    if ((await saveState()) !== 'saved') throw new Error(`status after save: ${await saveState()}`);
    // Clicking the same file again shows the open tab instead of a second copy.
    await page.click(row('README.md'));
    if ((await page.$$(fileTab('README.md'))).length !== 1) throw new Error('file opened twice');
    // SplitNest's own save must not come back as an "external change" from the watcher.
    await page.waitForTimeout(700); // longer than the watcher debounce: an echo would have arrived by now
    if ((await saveState()) !== 'saved' || (await page.$('.workspace:not([hidden]) .editor-banner--warning'))) throw new Error('own save reported as an external change');
    const editorContent = '.workspace:not([hidden]) .tabview--file:not([hidden]) .cm-content';
    const nl = '`n';
    // A command in SplitNest's own terminal changes the clean file while the window stays focused: it reloads.
    const focusedBefore = await page.evaluate(() => document.hasFocus());
    await typeIn(page, ps, `[IO.File]::WriteAllText('${readme}', "# changed by another tool${nl}")`);
    await page.waitForFunction((t) => window.__twEditor.text(t) === '# changed by another tool\n', id, { timeout: 10_000 }).catch(() => {
      throw new Error('clean buffer did not reload after a change made in the integrated terminal');
    });
    if (!focusedBefore || !(await page.evaluate(() => document.hasFocus()))) throw new Error('window was not focused during the check');
    // The terminal replaces the file atomically (temp file + rename) while there are unsaved edits:
    // the conflict is reported at once, the edits stay, and nothing is written.
    await page.click(editorContent);
    await page.keyboard.press('Control+End');
    await page.keyboard.type('mine');
    await typeIn(page, ps, `[IO.File]::WriteAllText('${readme}.tmp', "# theirs${nl}"); Move-Item -Force -LiteralPath '${readme}.tmp' -Destination '${readme}'`);
    await waitEditor(id, 'conflict', 'changed-on-disk');
    await page.waitForSelector('.workspace:not([hidden]) .editor-banner--warning');
    if (!(await page.evaluate((t) => window.__twEditor.text(t), id)).endsWith('mine')) throw new Error('local edits lost on external change');
    await page.click(editorContent);
    await page.keyboard.press('Control+S'); // independent check before writing: still refused
    await waitEditor(id, 'saveState', 'failed');
    if (readFileSync(readme, 'utf8') !== '# theirs\n') throw new Error('conflicting save overwrote the file');
    await shot(page, '23-editor-conflict.png');
    // "Keep my edits" keeps the buffer and the disk file; a later save still asks before overwriting.
    await page.click('.workspace:not([hidden]) button:has-text("Keep my edits")');
    await page.waitForSelector('.workspace:not([hidden]) .editor-banner--warning', { state: 'detached' });
    if (!(await page.evaluate((t) => window.__twEditor.text(t), id)).endsWith('mine')) throw new Error('local edits lost');
    if (readFileSync(readme, 'utf8') !== '# theirs\n') throw new Error('keep-my-edits touched the disk');
    await page.click('.workspace:not([hidden]) .tabview--file:not([hidden]) .cm-content');
    await page.keyboard.press('Control+S');
    await page.waitForSelector('.workspace:not([hidden]) button:has-text("Overwrite file")');
    await page.click('.workspace:not([hidden]) button:has-text("Overwrite file")');
    await page.waitForSelector('.dialog__footer button:has-text("Overwrite file")'); // explicit confirmation
    if (readFileSync(readme, 'utf8') !== '# theirs\n') throw new Error('overwrote before confirming');
    await page.click('.dialog__footer button:has-text("Overwrite file")');
    await page.waitForSelector(`${fileTab('README.md')}[data-dirty="false"]`);
    if (readFileSync(readme, 'utf8') !== '# changed by another tool\nmine') throw new Error(`overwrite content: ${JSON.stringify(readFileSync(readme, 'utf8'))}`);
    // A failed save keeps the file open, the edits in the buffer, and says so.
    chmodSync(readme, 0o444);
    try {
      await page.click('.workspace:not([hidden]) .tabview--file:not([hidden]) .cm-content');
      await page.keyboard.press('Control+End');
      await page.keyboard.type(' unsaved');
      await page.keyboard.press('Control+S');
      await waitEditor(id, 'saveState', 'failed');
      if ((await saveState()) !== 'failed') throw new Error('failure not shown');
      await page.waitForSelector('.workspace:not([hidden]) .editor-banner--error');
      await shot(page, '24-save-failed.png');
      // "Save and close" with a failing save closes nothing.
      await page.keyboard.press('Control+Shift+W');
      await page.click('.dialog__footer button:has-text("Save and close")');
      await page.waitForSelector('.toast:has-text("could not be saved, so nothing was closed")');
      if (!(await page.$(fileTab('README.md')))) throw new Error('tab closed although saving failed');
      if (!(await page.evaluate((t) => window.__twEditor.text(t), id)).endsWith('mine unsaved')) throw new Error('edits lost after failed save');
    } finally {
      chmodSync(readme, 0o666);
    }
    await page.click('.workspace:not([hidden]) .tabview--file:not([hidden]) .cm-content');
    await page.keyboard.press('Control+S');
    await waitEditor(id, 'saveState', 'saved');
    if (readFileSync(readme, 'utf8') !== '# changed by another tool\nmine unsaved') throw new Error('retry save content wrong');
    // Deleted by a terminal command: reported, buffer kept. Put back with the same content: the notice clears.
    await typeIn(page, ps, `Remove-Item -LiteralPath '${readme}'`);
    await waitEditor(id, 'conflict', 'deleted');
    if (!(await page.evaluate((t) => window.__twEditor.text(t), id)).endsWith('mine unsaved')) throw new Error('buffer lost when the file was deleted');
    await shot(page, '29-file-deleted.png');
    await typeIn(page, ps, `[IO.File]::WriteAllText('${readme}', "# changed by another tool${nl}mine unsaved")`);
    await waitEditor(id, 'conflict', null);
    // A second file goes into the same editor pane, with syntax highlighting.
    await page.click(row('src/components/App.tsx'));
    await page.waitForSelector(fileTab('src/components/App.tsx'));
    const appId = await tabIdOf('src/components/App.tsx');
    await waitEditor(appId, 'status', 'ready');
    await waitEditor(appId, 'language', 'TypeScript JSX');
    if ((await panes(page)).length !== before + 1) throw new Error('second file opened a new pane');
    await page.keyboard.type('export const answer: number = 42;\n');
    await page.waitForTimeout(300);
    const highlighted = await page.$$eval('.workspace:not([hidden]) .tabview--file:not([hidden]) .cm-line span', (s) => s.length);
    await shot(page, '22-file-editor.png');
    // Maximise the editor pane and restore: the buffer (unsaved) and the terminals are untouched.
    const cells = () => page.$$eval('.workspace:not([hidden]) .split__cell', (els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    const cellsBefore = await cells();
    await page.keyboard.press('Control+Shift+M');
    await page.waitForSelector('.workspace:not([hidden]) .pane--maximized');
    const maxBox = await page.$eval('.workspace:not([hidden]) .pane--maximized', (e) => e.getBoundingClientRect().width);
    const bodyBox = await page.$eval('.workspace:not([hidden]) .workspace__body', (e) => e.getBoundingClientRect().width);
    if (Math.abs(maxBox - bodyBox) > 2) throw new Error(`maximised pane ${maxBox} != body ${bodyBox}`);
    const hidden = await page.$$eval('.workspace:not([hidden]) .pane:not(.pane--maximized)', (els) => els.every((e) => getComputedStyle(e).visibility === 'hidden'));
    if (!hidden) throw new Error('other panes still visible');
    await shot(page, '25-editor-maximised.png');
    if ((await status(page, ps)) !== 'running') throw new Error('hidden terminal stopped');
    await page.keyboard.press('Control+Shift+M');
    await page.waitForSelector('.workspace:not([hidden]) .pane--maximized', { state: 'detached' });
    if ((await cells()).join() !== cellsBefore.join()) throw new Error(`layout changed: ${cellsBefore} -> ${await cells()}`);
    if (!(await page.evaluate((t) => window.__twEditor.text(t), appId)).includes('answer')) throw new Error('editor text lost on maximise');
    // Sidebar collapse and focus mode resize everything; the editor keeps text, dirty state and cursor, the terminal refits back.
    const psCols = await settledCols(page, ps, () => true, 'terminal width before sidebar changes');
    const cursorOf = () => page.evaluate((t) => { const s = window.__twEditor.state(t); return `${s.line}:${s.column}:${s.dirty}`; }, appId);
    const cursorBefore = await cursorOf();
    await page.keyboard.press('Control+Shift+B');
    await page.waitForFunction(() => document.querySelector('.sidebar')?.classList.contains('sidebar--collapsed'));
    await page.keyboard.press('Control+Shift+Enter');
    await page.waitForSelector('.sidebar', { state: 'hidden' });
    await settledCols(page, ps, (c) => c > psCols, `terminal to widen beyond ${psCols} in focus mode`);
    await page.keyboard.press('Control+Shift+Enter');
    await page.waitForSelector('.sidebar', { state: 'visible' });
    await page.keyboard.press('Control+Shift+B');
    await page.waitForFunction(() => !document.querySelector('.sidebar')?.classList.contains('sidebar--collapsed'));
    await settledCols(page, ps, (c) => c === psCols, `terminal to refit back to ${psCols}`);
    if ((await cursorOf()) !== cursorBefore) throw new Error(`editor state changed: ${cursorBefore} -> ${await cursorOf()}`);
    if ((await status(page, ps)) !== 'running') throw new Error('terminal stopped during sidebar changes');
    // Closing with unsaved changes offers Save / Discard / Cancel. Cancel keeps everything.
    await page.click('.workspace:not([hidden]) .tabview--file:not([hidden]) .cm-content');
    await page.keyboard.press('Control+Shift+W');
    await page.waitForSelector('.dialog__footer button:has-text("Save and close")');
    await shot(page, '26-save-discard-cancel.png');
    await page.click('.dialog__footer button:has-text("Cancel")');
    await page.waitForTimeout(300);
    if (!(await page.$(`${fileTab('src/components/App.tsx')}[data-dirty="true"]`))) throw new Error('cancelled close lost the tab or edits');
    // Discard leaves the file on disk untouched.
    await page.keyboard.press('Control+Shift+W');
    await page.click('.dialog__footer button:text-is("Discard")');
    await page.waitForSelector(fileTab('src/components/App.tsx'), { state: 'detached' });
    if (readFileSync(path.join(alpha, 'src', 'components', 'App.tsx'), 'utf8') !== '') throw new Error('discarded edits reached the disk');
    // Closing the last file closes the editor pane; terminals are untouched.
    await page.click(fileTab('README.md'));
    await page.keyboard.press('Control+Shift+W');
    await page.waitForFunction((n) => document.querySelectorAll('.workspace:not([hidden]) [data-pane-id]').length === n, before);
    if ((await status(page, ps)) !== 'running') throw new Error('terminal affected by the editor');
    // Leave a file open in the second workspace to check it is restored after relaunch.
    await page.click('.ws-item:nth-child(2) .ws-item__main');
    await page.click(row('notes.md'));
    await page.waitForSelector(fileTab('notes.md'));
    await page.waitForFunction((t) => window.__twEditor.text(t) === 'beta notes\n', await tabIdOf('notes.md'));
    await page.click('.ws-item:nth-child(1) .ws-item__main');
    return { highlightedSpans: highlighted };
  });

  await step('command palette, settings and shortcut reference', async () => {
    await page.keyboard.press('Control+Shift+P');
    await page.waitForSelector('.palette__input');
    await page.keyboard.type('split');
    await page.waitForTimeout(200);
    await shot(page, '06-command-palette.png');
    await page.keyboard.press('Escape');
    // Settings is a page in the main area with a row under the workspaces, not a modal.
    const running = () => page.$$eval('.workspace [data-pane-id]', (els) => els.map((e) => e.getAttribute('data-status')).filter((s) => s === 'running').length);
    const runningBefore = await running();
    await page.keyboard.press('Control+Comma');
    await page.waitForSelector('.settings-view:not([hidden]) .settings-nav');
    if (await page.$('dialog[open]')) throw new Error('settings opened as a modal');
    await page.waitForSelector('.ws-item--page.ws-item--active');
    if (await page.$('.ws-item--active:not(.ws-item--page)')) throw new Error('a workspace row is still selected');
    if (!(await page.textContent('.titlebar__name')).includes('Settings')) throw new Error('title bar does not say Settings');
    // Appearance (the first section): themes apply instantly to the page and the terminals.
    await page.waitForSelector('.settings-nav__item--active:has-text("Appearance")');
    const anyTab = await page.getAttribute('.workspace [data-pane-id]', 'data-active-tab');
    const look = () =>
      page.evaluate((t) => ({
        bg: getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim(),
        body: getComputedStyle(document.body).backgroundColor,
        term: window.__twTest.termBackground(t),
        checked: document.querySelector('.theme-card[aria-checked="true"]')?.getAttribute('data-theme-id'),
      }), anyTab);
    const graphite = await look();
    if (graphite.bg !== '#0c0c0e' || graphite.term !== '#0c0c0e' || graphite.checked !== 'graphite') throw new Error(`default theme: ${JSON.stringify(graphite)}`);
    await page.click('.theme-card[data-theme-id="light"]');
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim() === '#f3f4f8');
    const light = await look();
    if (light.term !== '#ffffff' || light.checked !== 'light' || (await page.getAttribute('.segmented__item[aria-checked="true"]', 'class')).indexOf('segmented') < 0) throw new Error(`light theme: ${JSON.stringify(light)}`);
    if (!(await page.textContent('.segmented__item[aria-checked="true"]')).includes('Light')) throw new Error('mode did not switch to Light');
    await shot(page, '07a-appearance-light.png');
    await page.click('.theme-card[data-theme-id="ember"]');
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim() === '#100c0a');
    if ((await look()).term !== '#100c0a') throw new Error('terminals did not follow Ember');
    await shot(page, '07b-appearance-ember.png');
    await page.click('button:has-text("Reset to default")');
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim() === '#0c0c0e');
    if ((await look()).checked !== 'graphite') throw new Error('reset did not select Graphite');
    await page.click('.settings-nav__item:has-text("Workspaces")');
    await page.waitForSelector('text=Start fresh shells automatically');
    await page.click('.settings-nav__item:has-text("Terminal")');
    await page.waitForSelector('.setting:has-text("Short folder names") [role="switch"]');
    await shot(page, '07-settings.png');
    if ((await running()) !== runningBefore) throw new Error('terminals stopped while settings was shown');
    // Back to the workspace by clicking it; the Settings row stays until closed.
    await page.click('.ws-item:not(.ws-item--page) .ws-item__main');
    await page.waitForSelector('.settings-view', { state: 'hidden' });
    await page.waitForSelector('.workspace:not([hidden])');
    if (!(await page.$('.ws-item--page:not(.ws-item--active)'))) throw new Error('settings row gone after switching to the workspace');
    await page.click('.ws-item--page .ws-item__main');
    await page.waitForSelector('.settings-view:not([hidden])');
    await page.hover('.ws-item--page');
    await page.click('.ws-item--page button[aria-label="Close settings"]');
    await page.waitForSelector('.ws-item--page', { state: 'detached' });
    await page.waitForSelector('.workspace:not([hidden])');
    await page.keyboard.press('Control+Shift+Slash');
    await page.waitForSelector('text=Inside a terminal');
    await shot(page, '08-shortcuts.png');
    await page.keyboard.press('Escape');
  });

  if (wsl2) {
    await step('closing a pane with a live session asks first and leaves other panes running', async () => {
      await page.click(`[data-pane-id="${wsl2}"] .tabview:not([hidden]) .pane__terminal`, { position: { x: 40, y: 20 } });
      await typeIn(page, wsl2, 'sleep 600');
      await page.keyboard.press('Control+Shift+W');
      await page.waitForSelector('text=End session and close');
      await shot(page, '09-confirm-close.png');
      await page.click('button:has-text("End session and close")');
      await page.waitForFunction(() => document.querySelectorAll('.workspace:not([hidden]) [data-pane-id]').length === 2);
      for (const id of [ps, wsl]) if ((await status(page, id)) !== 'running') throw new Error(`pane ${id} stopped`);
      await typeIn(page, wsl, 'echo STILL-$((2*21))');
      await waitText(page, wsl, 'STILL-42');
    });
  }

  await step('memory use', async () => {
    const metrics = await app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => ({ type: m.type, name: m.name, ws: m.memory.workingSetSize })));
    const totalMb = Math.round(metrics.reduce((s, m) => s + m.ws, 0) / 1024);
    report.metrics.memoryWithSessions = { totalWorkingSetMb: totalMb, processes: metrics.length, panes: (await page.$$('[data-pane-id]')).length };
    return report.metrics.memoryWithSessions;
  });

  const layoutBefore = await page.$$eval('.workspace:not([hidden]) [data-pane-id]', (els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
  await step('shells exit cleanly, exit is detected, app closes', async () => {
    for (const id of await page.$$eval('[data-pane-id][data-status="running"]', (els) => els.map((e) => e.getAttribute('data-pane-id')))) {
      const wsIndex = await page.evaluate((pid) => [...document.querySelectorAll('.workspace')].findIndex((w) => w.querySelector(`[data-pane-id="${pid}"]`)), id);
      await page.click(`.ws-item:nth-child(${wsIndex + 1}) .ws-item__main`);
      await typeIn(page, id, 'exit');
      await waitStatus(page, id, 'exited', 15_000);
    }
    await shot(page, '10-exited.png').catch(() => undefined);
    await app.close();
  });

  // ------------------------------------------------------------- run 2: restore
  ({ app, page, launchMs } = await launch());
  report.metrics.relaunchToWindowMs = launchMs;
  await step('layout restored with placeholders, no processes started', async () => {
    await page.waitForSelector('.workspace:not([hidden]) .pane');
    await page.click('.ws-item:nth-child(1) .ws-item__main');
    await page.waitForTimeout(300);
    const count = await page.$$eval('.ws-item', (e) => e.length);
    const statuses = await page.$$eval('[data-pane-id]', (els) => els.map((e) => e.getAttribute('data-status')));
    if (count !== 2) throw new Error(`expected 2 workspaces, got ${count}`);
    // Editor panes report "file"; every terminal must still be idle.
    if (!statuses.every((s) => s === 'idle' || s === 'file')) throw new Error(`unexpected statuses ${statuses}`);
    const tabIds = await visibleTabs(page);
    for (const t of tabIds) if ((await tabStatus(page, t)) !== 'idle') throw new Error(`tab ${t} started on restore`);
    const notice = await page.textContent('.workspace:not([hidden]) .notice');
    if (!notice.includes('Layout restored. Start new shells to continue.')) throw new Error(`notice: ${notice}`);
    if (!notice.includes(`Start all shells (${tabIds.length})`)) throw new Error(`start-all count: ${notice}`);
    const ready = await page.$$eval('.workspace:not([hidden]) .tabview:not([hidden]) .ready__title', (els) => els.map((e) => e.textContent));
    if (ready.length < 1 || !ready.every((t) => t === 'Ready to start')) throw new Error(`ready state: ${ready}`);
    if (await page.$('text=earlier processes were not resumed')) throw new Error('old per-pane paragraph still shown');
    const names = await page.$$eval('.workspace:not([hidden]) [role="tab"]', (els) => els.map((e) => e.getAttribute('data-tab-name')));
    if (!names.includes('Logs') || !names.some((n) => n.startsWith('Backend API'))) throw new Error(`names not restored: ${names}`);
    const widths = await page.$$eval('.workspace:not([hidden]) [data-pane-id]', (els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    await shot(page, '11-restored-layout.png');
    // Dismissing the notice starts and removes nothing (checked again after the reload below).
    return { workspaces: count, panes: statuses.length, tabs: tabIds.length, widthsBefore: layoutBefore, widthsAfter: widths };
  });

  await step('open files are restored as editor tabs (content re-read from disk)', async () => {
    await page.click('.ws-item:nth-child(2) .ws-item__main');
    const sel = '.workspace:not([hidden]) [role="tab"][data-file-path="notes.md"]';
    await page.waitForSelector(sel);
    const id = await page.getAttribute(sel, 'data-tab-id');
    await page.waitForFunction((t) => window.__twEditor.text(t) === 'beta notes\n', id, { timeout: 10_000 });
    await page.click('.ws-item:nth-child(1) .ws-item__main');
    await page.waitForTimeout(200);
  });

  await step('focus mode hides both sidebars and restores them; sidebar resize and collapse', async () => {
    const width = (sel) => page.$eval(sel, (e) => (e.hidden || !e.isConnected ? 0 : Math.round(e.getBoundingClientRect().width))).catch(() => 0);
    await page.focus('.sidebar .panel-handle');
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
    const sidebar = await width('.sidebar');
    const explorer = await width('.workspace:not([hidden]) .explorer');
    if (sidebar < 260) throw new Error(`keyboard resize did not widen the sidebar: ${sidebar}`);
    // The pane must first reach its narrower geometry and the terminal settle on it.
    const firstPane = (await panes(page))[0];
    const cols = await settledCols(page, firstPane, () => true, 'terminal width after widening the sidebar');
    await page.keyboard.press('Control+Shift+Enter');
    await page.waitForSelector('.sidebar', { state: 'hidden' });
    if (await page.$('.workspace:not([hidden]) .explorer')) throw new Error('explorer still visible in focus mode');
    const colsFocus = await settledCols(page, firstPane, (c) => c > cols, `terminal to widen beyond ${cols} in focus mode`);
    await shot(page, '16-focus-mode.png');
    await page.click('.titlebar button[aria-label="Exit focus mode"]');
    await page.waitForSelector('.sidebar', { state: 'visible' });
    await page.waitForFunction(
      ([s, e]) => Math.round(document.querySelector('.sidebar').getBoundingClientRect().width) === s && Math.round(document.querySelector('.workspace:not([hidden]) .explorer')?.getBoundingClientRect().width ?? 0) === e,
      [sidebar, explorer],
      { timeout: 5000 },
    ).catch(async () => {
      throw new Error(`widths not restored: ${await width('.sidebar')}/${await width('.workspace:not([hidden]) .explorer')} vs ${sidebar}/${explorer}`);
    });
    await settledCols(page, firstPane, (c) => c === cols, `terminal to refit back to ${cols} (was ${colsFocus} in focus mode)`);
    await page.keyboard.press('Control+Shift+B');
    await page.waitForFunction(() => document.querySelector('.sidebar')?.classList.contains('sidebar--collapsed'));
    await shot(page, '17-sidebar-collapsed.png');
    await page.keyboard.press('Control+Shift+B');
    await page.waitForFunction((w) => Math.round(document.querySelector('.sidebar').getBoundingClientRect().width) === w, sidebar);
    return { sidebar, explorer, cols, colsFocus };
  });

  await step('Start all shells: background tabs included, concurrent starts never duplicate, notice disappears', async () => {
    const tabIds = await visibleTabs(page);
    const [first] = await panes(page);
    const before = sessionsStarted();
    // Click the pane's own Start, then "Start all" twice, in the same task: all three race.
    await page.evaluate((paneId) => {
      const pane = document.querySelector(`[data-pane-id="${paneId}"]`);
      const own = pane.querySelector('.tabview:not([hidden]) .ready button');
      const all = [...document.querySelectorAll('.workspace:not([hidden]) .notice button')].find((b) => b.textContent.includes('Start all'));
      own.click();
      all.click();
      all.click();
      own.click();
    }, first);
    await page.waitForSelector('.workspace:not([hidden]) .notice__meta', { timeout: 5000 }).catch(() => undefined);
    await shot(page, '18-starting.png').catch(() => undefined);
    for (const t of tabIds) await waitTabStatus(page, t, 'running', 90_000);
    await page.waitForSelector('.workspace:not([hidden]) .notice', { state: 'detached', timeout: 10_000 });
    await page.waitForTimeout(1500);
    const created = sessionsStarted() - before;
    if (created !== tabIds.length) throw new Error(`expected ${tabIds.length} new sessions, log shows ${created}`);
    return { terminals: tabIds.length, sessionsCreated: created };
  });

  await step('four panes: focused pane is marked and follows Ctrl+Alt+arrows; screenshots at 1920x1080 and 1280x800', async () => {
    const [first] = await panes(page);
    await page.click(`[data-pane-id="${first}"] .tabview:not([hidden]) .pane__terminal`, { position: { x: 40, y: 20 } });
    while ((await panes(page)).length < 4) {
      const n = (await panes(page)).length;
      await page.keyboard.press(n % 2 ? 'Control+Shift+S' : 'Control+Shift+D');
      await page.waitForFunction((c) => document.querySelectorAll('.workspace:not([hidden]) [data-pane-id]').length === c + 1, n);
    }
    for (const t of await visibleTabs(page)) await waitTabStatus(page, t, 'running', 90_000);
    await page.waitForTimeout(800);
    const focused = () =>
      page.evaluate(() => ({
        active: document.querySelector('.workspace:not([hidden]) .pane--active')?.getAttribute('data-pane-id'),
        focusIn: document.activeElement?.closest('[data-pane-id]')?.getAttribute('data-pane-id'),
      }));
    const start = await focused();
    if (start.active !== start.focusIn) throw new Error(`active ${start.active} != focused ${start.focusIn}`);
    await page.keyboard.press('Control+Alt+ArrowLeft');
    await page.waitForTimeout(200);
    const moved = await focused();
    if (moved.active === start.active || moved.active !== moved.focusIn) throw new Error(`focus did not move: ${JSON.stringify([start, moved])}`);
    const outline = await page.$eval('.workspace:not([hidden]) .pane--active', (e) => getComputedStyle(e, '::after').boxShadow);
    if (!outline.includes('rgb(47, 107, 255')) throw new Error(`no focus outline: ${outline}`);
    // Shell count in the sidebar = running sessions (all tabs of this workspace, background ones too).
    const counted = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('.workspace:not([hidden]) [role="tab"][data-tab-id]')].map((e) => e.getAttribute('data-tab-id'));
      return ids.filter((t) => window.__twTest.status(t) === 'running').length;
    });
    const live = await page.textContent('.ws-item--active .ws-item__live');
    if (live !== (counted === 1 ? '1 shell running' : `${counted} shells running`)) throw new Error(`sidebar says "${live}", running=${counted}`);
    // Maximise the focused terminal: it fills the layout, others keep running hidden, restore brings back the same split.
    const target = moved.active;
    await typeIn(page, target, 'echo MAX-$((3*3))-MARK');
    await waitText(page, target, 'MAX-9-MARK');
    const cells = () => page.$$eval('.workspace:not([hidden]) .split__cell', (els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    const cellsBefore = await cells();
    const colsBefore = await settledCols(page, target, () => true, 'terminal width before maximising');
    // Through the pane's ⋯ menu (the toolbar icon is hidden in panes this narrow).
    await page.click(`[data-pane-id="${target}"] button[aria-label="More pane actions"]`);
    await page.click('.menu--context button:has-text("Maximise pane")');
    await page.waitForSelector(`[data-pane-id="${target}"].pane--maximized`);
    const colsMax = await settledCols(page, target, (c) => c > colsBefore, `maximised terminal to widen beyond ${colsBefore}`);
    // Checked before typing more: ConPTY redraws its screen after a resize and can overwrite parts of
    // lines that are still on its screen (a ConPTY behaviour, documented in TESTING.md).
    if (!(await inspect(page, target)).text.includes('MAX-9-MARK')) throw new Error('scrollback lost when maximised');
    await assertPtyCols(page, target, colsMax); // the shell sees the new size, not only xterm
    for (const t of await visibleTabs(page)) if ((await tabStatus(page, t)) !== 'running') throw new Error('a hidden terminal stopped');
    await shot(page, '28-terminal-maximised.png');
    await page.keyboard.press('Control+Shift+M');
    await page.waitForSelector('.workspace:not([hidden]) .pane--maximized', { state: 'detached' });
    await page
      .waitForFunction((w) => [...document.querySelectorAll('.workspace:not([hidden]) .split__cell')].map((e) => Math.round(e.getBoundingClientRect().width)).join() === w, cellsBefore.join(), { timeout: 5000 })
      .catch(async () => {
        throw new Error(`split changed: ${cellsBefore} -> ${await cells()}`);
      });
    await settledCols(page, target, (c) => c === colsBefore, `terminal to refit back to ${colsBefore} after restore`);
    await assertPtyCols(page, target, colsBefore);
    // Earlier output is still in xterm's buffer (session not restarted, nothing cleared).
    if (!(await inspect(page, target)).text.includes('MAX-9-')) throw new Error('scrollback lost after restore');
    await page.setViewportSize({ width: 1920, height: 1080 }).catch(() => undefined);
    await page.waitForTimeout(500);
    await shot(page, '19-four-panes-1920.png');
    await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
    await page.waitForTimeout(500);
    await shot(page, '20-four-panes-1280.png');
    // Keyboard focus visible on title bar controls.
    await page.focus('.titlebar button[aria-label="Collapse workspace sidebar"]');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(100);
    await shot(page, '21-keyboard-focus.png');
    await page.setViewportSize({ width: 1360, height: 860 }).catch(() => undefined);
    await exitAllVisible(page);
    return { start, moved };
  });
  const log = readFileSync(path.join(userData, 'logs', 'splitnest.log'), 'utf8');
  report.metrics.windowShownMs = [...log.matchAll(/window shown (\d+) ms/g)].map((m) => Number(m[1]));
  await app.close();

  // ------------------------------------------------------------- run 3: missing folder + missing shell
  const stateFile = path.join(userData, 'workspace-state.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const firstPane = (node) => (node.type === 'pane' ? node : firstPane(node.children[0]));
  firstPane(state.workspaces[0].layout).tabs[0].profileId = 'wsl:Not-Installed-Distro';
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  renameSync(beta, `${beta}-moved`);
  ({ app, page } = await launch());
  await step('restored sidebar width persisted; dismissing the notice starts and removes nothing', async () => {
    await page.waitForSelector('.workspace:not([hidden]) .notice');
    const sidebar = await page.$eval('.sidebar', (e) => Math.round(e.getBoundingClientRect().width));
    if (sidebar < 260) throw new Error(`sidebar width not persisted: ${sidebar}`);
    const tabsBefore = await visibleTabs(page);
    await page.click('.workspace:not([hidden]) .notice button[aria-label="Dismiss notice"]');
    await page.waitForSelector('.workspace:not([hidden]) .notice', { state: 'detached' });
    await page.waitForTimeout(500);
    const tabsAfter = await visibleTabs(page);
    if (tabsAfter.join() !== tabsBefore.join()) throw new Error('dismiss changed the tabs');
    for (const t of tabsAfter) if ((await tabStatus(page, t)) !== 'idle') throw new Error('dismiss started a terminal');
    return { sidebar, tabs: tabsAfter.length };
  });
  await step('missing shell profile is explained and can be changed', async () => {
    const id = firstPane(state.workspaces[0].layout).id;
    const tabId = firstPane(state.workspaces[0].layout).tabs[0].id;
    await page.click(`[data-tab-id="${tabId}"][role="tab"]`);
    const view = `.tabview[data-tab-id="${tabId}"]`;
    await page.waitForSelector(`${view} option:has-text("not available")`, { state: 'attached' });
    await shot(page, '12-missing-shell.png');
    await page.selectOption(`${view} select`, 'windows-powershell');
    await page.click(`${view} button:has-text("Start Windows PowerShell")`);
    await waitTabStatus(page, tabId, 'running');
    await typeIn(page, id, 'exit');
    await waitTabStatus(page, tabId, 'exited');
  });
  await step('missing workspace folder: Start all reports the failure per terminal with Retry; home start recovers', async () => {
    await page.click('.ws-item:nth-child(2) .ws-item__main');
    await page.waitForSelector('.banner--warning');
    const [id] = await panes(page);
    await page.click('.workspace:not([hidden]) .notice button:has-text("Start all shells")');
    await page.waitForSelector('.workspace:not([hidden]) .notice__failures li');
    const failure = await page.textContent('.workspace:not([hidden]) .notice__failures li');
    if (!(await page.$('.workspace:not([hidden]) .notice__failures button:has-text("Retry")'))) throw new Error('no retry action');
    await page.waitForSelector(`[data-pane-id="${id}"] button:has-text("Start in home directory instead")`);
    await shot(page, '13-missing-folder.png');
    // Retry fails the same way (the folder is still missing) and stays reported.
    await page.click('.workspace:not([hidden]) .notice__failures button:has-text("Retry")');
    await page.waitForSelector('.workspace:not([hidden]) .notice__failures li');
    await page.click(`[data-pane-id="${id}"] button:has-text("Start in home directory instead")`);
    await waitStatus(page, id, 'running');
    await page.waitForSelector('.workspace:not([hidden]) .notice', { state: 'detached' });
    await typeIn(page, id, 'exit');
    await waitStatus(page, id, 'exited');
    return { failure };
  });
  await app.close();
  renameSync(`${beta}-moved`, beta);

  // ------------------------------------------------------------- run 4: corrupt state
  writeFileSync(stateFile, '{"schemaVersion":1,"workspaces":[{"id":');
  ({ app, page } = await launch());
  await step('corrupt state file is preserved and the app recovers', async () => {
    await page.waitForSelector('text=could not be read');
    await page.waitForSelector('text=Open a project folder');
    const backups = readdirSync(userData).filter((f) => f.includes('.corrupt-'));
    if (backups.length !== 1) throw new Error('backup not found');
    await shot(page, '14-corrupt-recovery.png');
    return { backup: backups[0] };
  });
  await app.close();

  // ------------------------------------------------------------- run 5: quitting with unsaved files
  // The native dialog can't be clicked by automation; unpackaged E2E builds let the test answer it
  // through `globalThis.__twQuitAsk` in the main process (see main.ts). Everything else is real.
  ({ app, page } = await launch({ TW_E2E_PICK_FOLDER: gamma }));
  const answerQuit = (choice, delayMs = 0) =>
    app.evaluate(
      (_electron, [c, d]) => {
        globalThis.__twQuitAsk = () => new Promise((resolve) => setTimeout(() => resolve(c), d));
      },
      [choice, delayMs],
    );
  const quitPrompts = () => app.evaluate(() => globalThis.__twQuitPrompts ?? []);
  const closeWindow = (times = 1) =>
    app.evaluate((_electron, n) => {
      for (let i = 0; i < n; i++) _electron.BrowserWindow.getAllWindows()[0]?.close();
    }, times);
  const fileTabG = (p) => `.workspace:not([hidden]) [role="tab"][data-file-path="${p}"]`;
  const editFile = async (p, text) => {
    await page.click(`.workspace:not([hidden]) .explorer__row[data-path="${p}"]`);
    await page.waitForSelector(fileTabG(p));
    const id = await page.getAttribute(fileTabG(p), 'data-tab-id');
    await page.waitForFunction((t) => window.__twEditor.state(t)?.status === 'ready', id);
    await page.click('.workspace:not([hidden]) .tabview--file:not([hidden]) .cm-content');
    await page.keyboard.press('Control+End');
    await page.keyboard.type(text);
    await page.waitForSelector(`${fileTabG(p)}[data-dirty="true"]`);
    return id;
  };
  // Waits for a new "stayed open" toast (earlier ones may still be on screen).
  const stayedOpenToasts = () => page.$$eval('.toast', (els) => els.filter((e) => e.textContent.includes('stayed open')).length);
  const waitStayedOpen = async (before) => {
    await page.waitForFunction((n) => [...document.querySelectorAll('.toast')].filter((e) => e.textContent.includes('stayed open')).length > n, before, { timeout: 15_000 });
  };
  let gammaPs;
  let aId;
  await step('quit: Cancel keeps editors and shells; repeated close requests show one dialog', async () => {
    await page.click('button:has-text("Open folder…")');
    await page.waitForSelector('[data-pane-id]');
    [gammaPs] = await panes(page);
    await waitStatus(page, gammaPs, 'running');
    aId = await editFile('a.txt', ' +A');
    await editFile('b.txt', ' +B');
    await answerQuit('cancel', 400);
    await closeWindow(3); // Alt+F4 pressed repeatedly
    // Absence check: give the (400 ms) dialog time to answer and any duplicate dialog time to appear.
    await new Promise((r) => setTimeout(r, 900));
    const prompts = await quitPrompts();
    if (prompts.length !== 1) throw new Error(`expected one quit dialog, got ${prompts.length}`);
    if (prompts[0].liveSessions !== 1 || prompts[0].unsavedFiles !== 2) throw new Error(`prompt: ${JSON.stringify(prompts[0])}`);
    if (page.isClosed()) throw new Error('window closed after Cancel');
    if ((await page.$$('.workspace:not([hidden]) [role="tab"][data-dirty="true"]')).length !== 2) throw new Error('edits lost after Cancel');
    if ((await status(page, gammaPs)) !== 'running') throw new Error('terminal ended after Cancel');
    return { prompt: prompts[0] };
  });
  await step('quit: Save all keeps the app open when one file cannot be written; others are saved', async () => {
    chmodSync(path.join(gamma, 'b.txt'), 0o444);
    try {
      await answerQuit('save');
      const toasts = await stayedOpenToasts();
      await closeWindow();
      await waitStayedOpen(toasts);
      if (readFileSync(path.join(gamma, 'a.txt'), 'utf8') !== 'alpha +A') throw new Error('a.txt was not saved');
      if (readFileSync(path.join(gamma, 'b.txt'), 'utf8') !== 'beta') throw new Error('b.txt changed although it is read-only');
      if (!(await page.$(`${fileTabG('b.txt')}[data-dirty="true"]`))) throw new Error('b.txt edits lost');
      if ((await status(page, gammaPs)) !== 'running') throw new Error('terminal ended although quitting was stopped');
      await shot(page, '30-quit-save-failed.png');
    } finally {
      chmodSync(path.join(gamma, 'b.txt'), 0o666);
    }
  });
  await step('quit: Save all stays open on an unresolved external change (no silent overwrite)', async () => {
    await editFile('a.txt', ' again');
    writeFileSync(path.join(gamma, 'a.txt'), 'changed outside');
    await page.waitForFunction((t) => window.__twEditor.state(t)?.conflict === 'changed-on-disk', aId, { timeout: 10_000 });
    await answerQuit('save');
    const toasts = await stayedOpenToasts();
    await closeWindow();
    await waitStayedOpen(toasts);
    if (readFileSync(path.join(gamma, 'a.txt'), 'utf8') !== 'changed outside') throw new Error('external change overwritten while quitting');
    if (page.isClosed()) throw new Error('quit despite conflict');
  });
  await step('quit: after resolving, Save all writes every file and the app quits', async () => {
    await page.click(fileTabG('a.txt'));
    await page.click('.workspace:not([hidden]) .tabview--file:not([hidden]) button:has-text("Reload from disk")');
    await page.click('.dialog__footer button:has-text("Discard and reload")');
    await page.waitForSelector(`${fileTabG('a.txt')}[data-dirty="false"]`);
    await answerQuit('save');
    const closed = app.waitForEvent('close', { timeout: 30_000 });
    await closeWindow();
    await closed;
    if (readFileSync(path.join(gamma, 'b.txt'), 'utf8') !== 'beta +B') throw new Error(`b.txt: ${readFileSync(path.join(gamma, 'b.txt'), 'utf8')}`);
    if (readFileSync(path.join(gamma, 'a.txt'), 'utf8') !== 'changed outside') throw new Error('a.txt changed');
  });

  // ------------------------------------------------------------- run 6: app.quit() with Discard
  ({ app, page } = await launch());
  await step('quit via app.quit(): Discard and quit writes nothing', async () => {
    await page.waitForSelector(fileTabG('b.txt'), { timeout: 15_000 });
    await page.click(fileTabG('b.txt'));
    const id = await page.getAttribute(fileTabG('b.txt'), 'data-tab-id');
    await page.waitForFunction((t) => window.__twEditor.state(t)?.status === 'ready', id);
    await page.click('.workspace:not([hidden]) .tabview--file:not([hidden]) .cm-content');
    await page.keyboard.type('discard me ');
    await page.waitForSelector(`${fileTabG('b.txt')}[data-dirty="true"]`);
    await answerQuit('discard');
    const closed = app.waitForEvent('close', { timeout: 30_000 });
    await app.evaluate(({ app: a }) => a.quit());
    await closed;
    if (readFileSync(path.join(gamma, 'b.txt'), 'utf8') !== 'beta +B') throw new Error('discarded edits were written');
  });

  report.finishedAt = new Date().toISOString();
  report.ok = report.steps.every((s) => s.ok);
  writeFileSync(path.join(work, 'e2e-report.json'), JSON.stringify(report, null, 2));
  console.log(`\nReport: ${path.join(work, 'e2e-report.json')}`);
  console.log(JSON.stringify(report.metrics, null, 2));
}

main()
  .then(() => {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    if (existsSync(work)) console.log('note: work dir not fully removed');
    process.exit(report.ok ? 0 : 1);
  })
  .catch((error) => {
    report.ok = false;
    writeFileSync(path.join(work, 'e2e-report.json'), JSON.stringify(report, null, 2));
    console.error('E2E failed:', error?.message ?? error);
    console.error(`Artifacts kept in ${work}`);
    process.exit(1);
  });
