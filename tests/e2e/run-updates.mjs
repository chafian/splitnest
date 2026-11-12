// Automatic updates in the app, end to end (dev build, TW_E2E=1, TW_E2E_UPDATER=1: main uses a
// recording stand-in for Electron's autoUpdater, written to <profile>/e2e-updater.log). No network.
// Checks: nothing is requested before the first-run notice is acknowledged; the notice's two
// choices; Settings › About; "Update ready" and Restart now through the normal quit flow; a
// cancelled restart never installs at a later quit; errors; the choice survives a restart.
// Usage: node tests/e2e/run-updates.mjs   (after `npm run package`, which builds .vite/build)
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const work = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'tw-updates-')));
const proj = path.join(work, 'update-ws');
mkdirSync(proj);
writeFileSync(path.join(proj, 'README.md'), '# updates\n');
const FEED = 'https://github.com/chafian/splitnest/releases/latest/download';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, timeout = 10_000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out: ${what}`);
    await sleep(150);
  }
};
const log = (ud) => (existsSync(path.join(ud, 'e2e-updater.log')) ? readFileSync(path.join(ud, 'e2e-updater.log'), 'utf8').split('\n').filter(Boolean) : []);
const launch = (ud) =>
  electron.launch({ executablePath: require('electron'), args: ['.', `--tw-user-data=${ud}`], cwd: root, env: { ...process.env, TW_E2E: '1', TW_E2E_UPDATER: '1', TW_E2E_PICK_FOLDER: proj } });
const emit = (app, event, error) => app.evaluate(({}, [e, err]) => globalThis.__twUpdater.emit(e, err), [event, error]);
const quitWith = async (app, answer) => {
  await app.evaluate(({}, a) => {
    globalThis.__twQuitAsk = async () => a;
  }, answer);
};
const openAbout = async (page) => {
  await page.keyboard.press('Control+,');
  await page.click('.settings-nav__item:has-text("About")');
  await page.waitForSelector('[data-testid="update-status"]');
};
const status = (page) => page.textContent('[data-testid="update-status"]');

const udA = path.join(work, 'profile-a');
const udB = path.join(work, 'profile-b');
let app = null;
try {
  // ---- Profile A: keep automatic updates.
  app = await launch(udA);
  let page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);

  await step('first start: the notice explains the update check; nothing is requested while it is up', async () => {
    const notice = await page.waitForSelector('[data-testid="update-notice"]', { timeout: 15_000 });
    const text = await notice.textContent();
    for (const must of ['GitHub', 'app version, platform and architecture', 'Nothing has been sent yet', 'Privacy policy']) if (!text.includes(must)) throw new Error(`notice lacks "${must}"`);
    await sleep(40_000); // longer than the first-check delay
    if (log(udA).length) throw new Error(`requests before the notice: ${log(udA)}`);
    if (process.env.TW_UPDATE_SHOTS) await page.screenshot({ path: path.join(process.env.TW_UPDATE_SHOTS, 'update-notice.png') });
    // A workspace with a running shell, so that quitting later asks first.
    await page.click('button:has-text("Open folder…")');
    await page.waitForSelector('[data-pane-id][data-status="running"]', { timeout: 20_000 });
  });

  await step('"Keep automatic updates": the first check comes about 30 s later, on the GitHub Releases feed', async () => {
    await page.click('[data-testid="update-notice-keep"]');
    await page.waitForSelector('[data-testid="update-notice"]', { state: 'detached' });
    await sleep(20_000);
    if (log(udA).length) throw new Error(`checked too early: ${log(udA)}`);
    await until(() => log(udA).includes('check'), 'first check', 20_000);
    if (log(udA)[0] !== `feed ${FEED}`) throw new Error(`feed: ${log(udA)[0]}`);
  });

  await step('Settings › About: up to date after the check; "Check now" checks again', async () => {
    await emit(app, 'update-not-available');
    await openAbout(page);
    await until(async () => /up to date/.test(await status(page)), 'up to date shown');
    await page.click('[data-testid="update-check-now"]');
    await until(() => log(udA).filter((c) => c === 'check').length === 2, 'second check');
    await until(async () => /Checking/.test(await status(page)), 'checking shown');
  });

  await step('a failed check says why, without addresses or paths, and keeps the current version', async () => {
    await emit(app, 'error', 'getaddrinfo ENOTFOUND github.com');
    await until(async () => (await status(page)).includes('No connection to GitHub.'), 'error shown');
    if ((await status(page)).includes('github.com')) throw new Error('error shows the address');
  });

  await step('an update downloads in the background, then "Update ready" offers Restart now', async () => {
    await page.click('[data-testid="update-check-now"]');
    await emit(app, 'update-available');
    await until(async () => /Downloading/.test(await status(page)), 'downloading shown');
    await emit(app, 'update-downloaded');
    await page.waitForSelector('[data-testid="update-ready"]');
    await until(async () => /ready/.test(await status(page)), 'ready shown');
    if (process.env.TW_UPDATE_SHOTS) await page.screenshot({ path: path.join(process.env.TW_UPDATE_SHOTS, 'update-about.png') });
  });

  await step('Restart now goes through the quit prompt: Cancel keeps SplitNest open and installs nothing', async () => {
    await quitWith(app, 'cancel');
    await page.click('[data-testid="update-restart"]');
    await sleep(1500);
    const prompts = await app.evaluate(() => (globalThis.__twQuitPrompts ?? []).length);
    if (prompts !== 1) throw new Error(`quit prompts: ${prompts}`);
    if (log(udA).includes('quitAndInstall')) throw new Error('installed after Cancel');
  });

  await step('after a cancelled restart, an ordinary quit just quits (no install)', async () => {
    await quitWith(app, 'discard');
    await app.close();
    app = null;
    if (log(udA).includes('quitAndInstall')) throw new Error('a later quit installed the update');
  });

  await step('the choice is remembered: no notice on the next start, and checks resume', async () => {
    app = await launch(udA);
    page = await app.firstWindow();
    await sleep(3000);
    if (await page.$('[data-testid="update-notice"]')) throw new Error('notice shown again');
  });

  await step('Restart now, confirmed: SplitNest quits through the normal flow and installs the update', async () => {
    await openAbout(page);
    await page.click('[data-testid="update-check-now"]');
    await emit(app, 'update-available');
    await emit(app, 'update-downloaded');
    await page.waitForSelector('[data-testid="update-ready"]');
    await quitWith(app, 'discard');
    const closed = app.waitForEvent('close');
    await page.click('[data-testid="update-restart"]');
    await closed;
    app = null;
    if (!log(udA).includes('quitAndInstall')) throw new Error(`not installed: ${log(udA)}`);
  });

  // ---- Profile B: turn automatic updates off.
  await step('"Turn off": no request at all, and Settings shows checks off', async () => {
    app = await launch(udB);
    page = await app.firstWindow();
    await page.waitForSelector('[data-testid="update-notice"]', { timeout: 15_000 });
    await page.click('[data-testid="update-notice-off"]');
    await sleep(40_000);
    if (log(udB).length) throw new Error(`requests with checks off: ${log(udB)}`);
    await openAbout(page);
    if (!/off/.test(await status(page))) throw new Error(await status(page));
    const on = await page.isChecked('input[role="switch"][aria-label="Check for updates automatically"]');
    if (on) throw new Error('switch is on');
  });

  await step('with checks off, "Check now" is the user asking: one check, nothing automatic after it', async () => {
    await page.click('[data-testid="update-check-now"]');
    await until(() => log(udB).includes('check'), 'manual check');
    await emit(app, 'update-not-available');
    await sleep(35_000);
    if (log(udB).filter((c) => c === 'check').length !== 1) throw new Error(`checks: ${log(udB)}`);
  });

  await step('turning the switch back on resumes automatic checks', async () => {
    await page.click('input[role="switch"][aria-label="Check for updates automatically"]', { force: true });
    await until(async () => !/off/.test(await status(page)), 'not off any more');
  });
} catch (e) {
  results.push({ name: 'script error', ok: false });
  console.log(`  ✗ script error: ${e?.message ?? e}`);
} finally {
  if (app) {
    await quitWith(app, 'discard').catch(() => undefined);
    await app.close().catch(() => undefined);
  }
  await sleep(1000);
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `RESULT: ${failed} of ${results.length} steps FAILED` : `RESULT: all ${results.length} steps passed`);
process.exit(failed ? 1 : 0);
