// Agent notifications, end to end (dev build with TW_E2E=1, temporary folder and profile only).
// Agent states arrive as real OSC 7501 status reports written into a terminal tab's output
// (`__twTest.feed`), so they can reach a tab that is not on screen. Main records Windows
// notifications in `__twNotices` instead of showing them (E2E builds only), so Windows'
// Notification Center and Start menu are never touched. Process detection is stood in for with
// `__twTest.fakeProcessAgent`.
// Usage: node tests/e2e/run-notify.mjs   (after `npm run package`, which builds .vite/build)
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const work = mkdtempSync(path.join(tmpdir(), 'tw-notify-'));
const proj = path.join(work, 'notify-ws');
mkdirSync(proj);
writeFileSync(path.join(proj, 'README.md'), '# notify\n');
const results = [];
const step = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, ...(detail ? { detail } : {}) });
    console.log(`  ✓ ${name}${detail ? ' ' + JSON.stringify(detail) : ''}`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error) });
    console.log(`  ✗ ${name}: ${error?.message ?? error}`);
  }
};
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const until = async (fn, what, timeout = 8000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.', `--tw-user-data=${path.join(work, 'ud')}`],
  cwd: root,
  env: { ...process.env, TW_E2E: '1', TW_E2E_PICK_FOLDER: proj },
});
try {
const page = await app.firstWindow();
await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
await page.click('button:has-text("Open folder…")');
await page.waitForSelector('[data-pane-id][data-status="running"]');

const selectedTab = () => page.getAttribute('[role="tab"][aria-selected="true"]', 'data-tab-id');
const agentTab = await selectedTab();
// The agent's tab gets a name of its own (F2), then a second tab is opened and shown.
await page.focus(`[data-tab-id="${agentTab}"][role="tab"]`);
await page.keyboard.press('F2');
await page.waitForSelector(`[data-tab-id="${agentTab}"] .tab__input`);
await page.keyboard.press('Control+A');
await page.keyboard.type('Backend');
await page.keyboard.press('Enter');
await page.waitForSelector(`[data-tab-id="${agentTab}"] .tab__input`, { state: 'detached' });
await page.waitForSelector(`[role="tab"][data-tab-id="${agentTab}"]:has-text("Backend")`);
await page.keyboard.press('Control+Shift+T');
await until(async () => (await selectedTab()) !== agentTab, 'second tab selected');
const otherTab = await selectedTab();

const winState = () =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return { minimized: w.isMinimized(), focused: w.isFocused(), visible: w.isVisible() };
  });
const focusWindow = async () => {
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  });
  await until(async () => (await winState()).focused && (await page.evaluate(() => window.appApi.windowFocused())), 'window focused (another program may have taken the foreground)');
};
const toBackground = async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await until(async () => (await winState()).minimized && !(await page.evaluate(() => window.appApi.windowFocused())), 'window minimized');
};
const feed = (tabId, ...bodies) => page.evaluate(([t, d]) => window.__twTest.feed(t, d), [tabId, bodies.map((b) => `\x1b]7501;${b}\x1b\\`).join('')]);
const fakeAgent = (tabId, agent) => page.evaluate(([t, a]) => window.__twTest.fakeProcessAgent(t, a), [tabId, agent]);
const windowsNotices = () => app.evaluate(() => (globalThis.__twNotices ?? []).map(({ title, body, silent, shown, closed }) => ({ title, body, silent, shown, closed })));
const inApp = () =>
  page.$$eval('.toast--agent', (els) => els.map((e) => ({ title: e.querySelector('.toast__text p')?.textContent, body: e.querySelector('.toast__detail')?.textContent, key: e.getAttribute('data-notice-key') })));
// Main's real process scan reports "no agent" for the test shell a few seconds after it starts,
// replacing the stand-in; every step sets the stand-in again first (see the spoofing step for the
// unconfirmed case).
const reset = async (agent = 'claude') => {
  await feed(agentTab, 'state=clear');
  await fakeAgent(agentTab, agent);
  await app.evaluate(() => {
    globalThis.__twNotices = [];
  });
  await page.evaluate(() => document.querySelectorAll('.toast--agent button[aria-label="Dismiss"]').forEach((b) => b.click()));
};
const setSetting = async (label, on) => {
  await page.keyboard.press('Control+,');
  await page.click('.settings-nav__item:has-text("Notifications")');
  const box = page.locator(`input[role="switch"][aria-label="${label}"]`);
  if ((await box.isChecked()) !== on) await box.click({ force: true });
  await until(async () => (await box.isChecked()) === on, `${label} = ${on}`);
  await sleep(600); // saved (250 ms debounce), so main has it too
  await page.click('.ws-item__main'); // back to the workspace
  await page.waitForSelector('.settings-nav', { state: 'hidden' });
  await page.click(`[role="tab"][data-tab-id="${otherTab}"]`);
};

await fakeAgent(agentTab, 'claude');
const permission = `state=blocked:kind=permission:app=claude-code:title=${b64('Secret prompt: refactor auth')}:msg=${b64('approve Write: C:\\x\\y.txt')}`;

await step('focused, another tab shown: an in-app notice (no Windows notification) with SplitNest wording', async () => {
  await focusWindow();
  await feed(agentTab, 'state=working:app=claude-code', permission);
  const n = await until(async () => (await inApp()).find((x) => x.key === agentTab), 'in-app notice');
  if (n.title !== 'Claude Code needs permission' || n.body !== 'notify-ws · Backend') throw new Error(JSON.stringify(n));
  if ((await windowsNotices()).length) throw new Error(`unexpected Windows notification: ${JSON.stringify(await windowsNotices())}`);
  const live = await page.getAttribute('.toasts', 'aria-live');
  return { ...n, ariaLive: live };
});

await step('"Show" opens exactly that tab and the notice goes', async () => {
  await page.click(`.toast--agent[data-notice-key="${agentTab}"] button:has-text("Show")`);
  await until(async () => (await selectedTab()) === agentTab, 'agent tab selected');
  await until(async () => !(await inApp()).length, 'notice gone');
});

await step('looking at the tab: nothing at all', async () => {
  await feed(agentTab, 'state=working:app=claude-code', 'state=blocked:kind=question:app=claude-code');
  await sleep(2500);
  const shown = [...(await inApp()), ...(await windowsNotices())];
  if (shown.length) throw new Error(JSON.stringify(shown));
});

await step('the agent moving on withdraws the in-app notice', async () => {
  await reset();
  await page.click(`[role="tab"][data-tab-id="${otherTab}"]`);
  await feed(agentTab, 'state=working:app=claude-code', 'state=blocked:kind=permission:app=claude-code');
  await until(async () => (await inApp()).length === 1, 'notice');
  await feed(agentTab, 'state=working:app=claude-code');
  await until(async () => !(await inApp()).length, 'notice withdrawn');
});

let clickIndex = -1;
await step('minimized: a Windows notification; title and second line written by main, without the session title or message', async () => {
  await reset();
  await toBackground();
  await feed(agentTab, 'state=working:app=claude-code', permission);
  const n = await until(async () => (await windowsNotices()).find((x) => x.shown), 'Windows notification');
  if (n.title !== 'Claude Code needs permission' || n.body !== 'notify-ws · Backend' || n.silent !== false) throw new Error(JSON.stringify(n));
  if ((await inApp()).length) throw new Error('in-app notice as well');
  clickIndex = (await windowsNotices()).length - 1;
  return n;
});

await step('clicking it restores the window and shows exactly that tab, even from Settings', async () => {
  // Settings open and the other tab selected before going to the background.
  await focusWindow();
  await page.keyboard.press('Control+,');
  await page.waitForSelector('.settings-nav');
  await reset();
  await toBackground();
  await feed(agentTab, 'state=working:app=claude-code', 'state=blocked:kind=permission:app=claude-code');
  await until(async () => (await windowsNotices()).some((x) => x.shown), 'notification');
  clickIndex = (await windowsNotices()).length - 1;
  await app.evaluate((_e, i) => globalThis.__twNoticeClick(i), clickIndex);
  await until(async () => !(await winState()).minimized, 'window restored');
  await until(async () => (await selectedTab()) === agentTab && !(await page.isVisible('.settings-nav')), 'agent tab shown');
  const closed = (await windowsNotices())[clickIndex].closed;
  if (!closed) throw new Error('clicked notification still open');
  return await winState();
});

await step('the agent continuing withdraws its Windows notification', async () => {
  await reset();
  await page.click(`[role="tab"][data-tab-id="${otherTab}"]`);
  await toBackground();
  await feed(agentTab, 'state=working:app=claude-code', 'state=blocked:kind=permission:app=claude-code');
  await until(async () => (await windowsNotices()).some((x) => x.shown && !x.closed), 'notification');
  await feed(agentTab, 'state=working:app=claude-code');
  await until(async () => (await windowsNotices()).every((x) => x.closed), 'withdrawn');
});

await step('Codex-style finish (`done`, then `idle` 0.8 s later): one "Codex finished"; start-up working → idle: nothing', async () => {
  await reset('codex');
  await feed(agentTab, 'state=idle:app=codex', 'state=working:app=codex');
  await sleep(500);
  await feed(agentTab, 'state=idle:app=codex');
  await sleep(2500);
  if ((await windowsNotices()).length) throw new Error(`start-up notified: ${JSON.stringify(await windowsNotices())}`);
  await feed(agentTab, 'state=working:app=codex', 'state=done:app=codex');
  await sleep(800);
  await feed(agentTab, 'state=idle:app=codex');
  const n = await until(async () => (await windowsNotices()).find((x) => x.shown), 'finished');
  await sleep(2000);
  const all = await windowsNotices();
  if (n.title !== 'Codex finished' || all.length !== 1) throw new Error(JSON.stringify(all));
  return n;
});

await step('a report naming Claude Code where process detection found no agent raises no Windows notification', async () => {
  await reset(null);
  await feed(agentTab, 'state=working:app=claude-code', 'state=blocked:kind=permission:app=claude-code');
  await sleep(3000);
  if ((await windowsNotices()).length) throw new Error(JSON.stringify(await windowsNotices()));
  // Once detection confirms it, the waiting event is delivered.
  await fakeAgent(agentTab, 'claude');
  await until(async () => (await windowsNotices()).some((x) => x.title === 'Claude Code needs permission'), 'delivered after confirmation');
});

await step('"Include what the agent wrote" on: the message is added (the tab name still wins over the session title)', async () => {
  await reset();
  await focusWindow();
  await setSetting('Include what the agent wrote', true);
  await toBackground();
  await feed(agentTab, 'state=working:app=claude-code', permission);
  const n = await until(async () => (await windowsNotices()).find((x) => x.shown), 'notification');
  await focusWindow();
  await setSetting('Include what the agent wrote', false);
  if (n.body !== 'notify-ws · Backend\napprove Write: C:\\x\\y.txt') throw new Error(JSON.stringify(n));
  return n;
});

await step('"Notify when an agent needs you" off: nothing, in-app or Windows', async () => {
  await reset();
  await setSetting('Notify when an agent needs you', false);
  await toBackground();
  await feed(agentTab, 'state=working:app=claude-code', 'state=blocked:kind=permission:app=claude-code');
  await sleep(2500);
  const any = [...(await windowsNotices()), ...(await inApp())];
  await focusWindow();
  await setSetting('Notify when an agent needs you', true);
  if (any.length) throw new Error(JSON.stringify(any));
});

await step('Settings › Notifications: the test notification reports what Windows said; clicking it comes back to that page', async () => {
  await reset();
  await page.keyboard.press('Control+,');
  await page.click('.settings-nav__item:has-text("Notifications")');
  await page.click('button:has-text("Send a test notification")');
  const text = await until(async () => {
    const t = await page.textContent('[data-testid="notification-test-result"]');
    return t && !/Sending/.test(t) && /Windows accepted/.test(t) ? t : null;
  }, 'test result');
  await page.click('.settings-nav__item:has-text("About")');
  const i = (await windowsNotices()).length - 1;
  await app.evaluate((_e, idx) => globalThis.__twNoticeClick(idx), i);
  await until(() => page.$('.settings-nav__item--active:has-text("Notifications")'), 'back on Settings › Notifications');
  return { text: text.slice(0, 60) };
});

} catch (error) {
  results.push({ name: 'setup', ok: false, error: String(error?.message ?? error) });
  console.log(`  ✗ setup: ${error?.message ?? error}`);
} finally {
  // Shells are running, so quitting asks first; the E2E hook answers it (no unsaved files here).
  await app.evaluate(() => {
    globalThis.__twQuitAsk = async () => 'discard';
  }).catch(() => undefined);
  await app.close().catch(() => undefined);
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `RESULT: ${failed} of ${results.length} steps FAILED` : `RESULT: all ${results.length} steps passed`);
process.exit(failed ? 1 : 0);
