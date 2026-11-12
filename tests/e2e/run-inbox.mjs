// The agent inbox, end to end (dev build with TW_E2E=1, temporary folders and profile only).
// Two workspaces; agent states arrive as real OSC 7501 status reports written into a terminal
// tab's output (`__twTest.feed`), so they can reach tabs that are not on screen. No agent runs.
// Usage: node tests/e2e/run-inbox.mjs   (after `npm run package`, which builds .vite/build)
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const work = mkdtempSync(path.join(tmpdir(), 'tw-inbox-'));
const alpha = path.join(work, 'alpha-ws');
const beta = path.join(work, 'beta-ws');
for (const d of [alpha, beta]) {
  mkdirSync(d);
  writeFileSync(path.join(d, 'README.md'), '# inbox\n');
}
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
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, timeout = 8000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out: ${what}`);
    await sleep(100);
  }
};

const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.', `--tw-user-data=${path.join(work, 'ud')}`],
  cwd: root,
  env: { ...process.env, TW_E2E: '1', TW_E2E_PICK_FOLDER: `${alpha}|${beta}` },
});
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
  /** The selected tab of the workspace on screen. */
  const shownTab = () => page.evaluate(() => [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].find((e) => e.offsetParent !== null)?.getAttribute('data-tab-id') ?? null);
  const shownWorkspace = () => page.evaluate(() => document.querySelector('.titlebar__name')?.textContent ?? '');
  const feed = (tabId, ...bodies) => page.evaluate(([t, d]) => window.__twTest.feed(t, d), [tabId, bodies.map((b) => `\x1b]7501;${b}\x1b\\`).join('')]);
  const count = () => page.getAttribute('[data-testid="inbox-button"]', 'data-count').then(Number);
  const rows = () => page.$$eval('[data-testid="inbox-menu"] [role="menuitem"]', (els) => els.map((e) => ({ tab: e.getAttribute('data-tab-id'), kind: e.getAttribute('data-kind'), title: e.querySelector('.inbox__title')?.textContent, body: e.querySelector('.inbox__body')?.textContent })));
  const menuOpen = () => page.$('[data-testid="inbox-menu"]').then((e) => e !== null);
  const focusWindow = async () => {
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    });
    await until(() => page.evaluate(() => window.appApi.windowFocused()), 'window focused (another program may have taken the foreground)');
  };
  const showWorkspace = (name) => page.click(`.ws-item__main:has-text("${name}")`);

  // alpha-ws: Backend (Claude Code will run here) and a second tab. beta-ws: one tab (Codex).
  await page.click('button:has-text("Open folder…")');
  await page.waitForSelector('[data-pane-id][data-status="running"]');
  const a1 = await shownTab();
  await page.focus(`[data-tab-id="${a1}"][role="tab"]`);
  await page.keyboard.press('F2');
  await page.waitForSelector(`[data-tab-id="${a1}"] .tab__input`);
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Backend');
  await page.keyboard.press('Enter');
  await page.waitForSelector(`[role="tab"][data-tab-id="${a1}"]:has-text("Backend")`);
  await page.keyboard.press('Control+Shift+T');
  const a2 = await until(async () => {
    const t = await shownTab();
    return t !== a1 ? t : null;
  }, 'second tab');
  await page.keyboard.press('Control+Shift+O');
  await until(async () => (await shownWorkspace()) === 'beta-ws', 'second workspace');
  const b1 = await until(async () => {
    const t = await shownTab();
    return t && t !== a1 && t !== a2 ? t : null;
  }, 'beta tab');
  await until(() => page.evaluate((t) => window.__twTest.status(t) === 'running', b1), 'beta shell running', 20_000);
  await focusWindow();

  await step('empty: no count on the bell; Ctrl+Shift+A opens "No agents are waiting"; Escape closes it', async () => {
    if ((await count()) !== 0 || (await page.$('.inbox__count'))) throw new Error('count shown');
    await page.keyboard.press('Control+Shift+A');
    await page.waitForSelector('[data-testid="inbox-menu"] .inbox__empty');
    if ((await rows()).length) throw new Error('rows listed');
    await page.keyboard.press('Escape');
    await until(async () => !(await menuOpen()), 'menu closed');
  });

  await step('a finished turn in another workspace and a blocked agent are listed: blocked first, though it came later', async () => {
    await showWorkspace('alpha-ws');
    await page.click(`[role="tab"][data-tab-id="${a2}"]`);
    await feed(b1, 'state=working:app=codex', 'state=done:app=codex');
    await until(async () => (await count()) === 1, 'finished listed after the settle time');
    await feed(a1, 'state=working:app=claude-code', `state=blocked:kind=permission:app=claude-code:title=${b64('Secret prompt: rotate the keys')}:msg=${b64('approve Write: C:\\x\\secret.txt')}`);
    await until(async () => (await count()) === 2, 'two listed');
    await page.click('[data-testid="inbox-button"]');
    const list = await until(async () => ((await rows()).length === 2 ? rows() : null), 'two rows');
    const want = [
      { tab: a1, kind: 'permission', title: 'Claude Code needs permission', body: 'alpha-ws · Backend' },
      { tab: b1, kind: 'done', title: 'Codex finished', body: 'beta-ws · Codex' },
    ];
    if (JSON.stringify(list) !== JSON.stringify(want)) throw new Error(JSON.stringify(list));
    const label = await page.getAttribute('[data-testid="inbox-button"]', 'aria-label');
    if (label !== 'Agent inbox: 1 needs you, 1 to look at') throw new Error(label);
    if (process.env.TW_INBOX_SHOTS) await page.screenshot({ path: path.join(process.env.TW_INBOX_SHOTS, 'inbox-open.png') });
    return { label };
  });

  await step("privacy: what the agent wrote (its session title and message) is not in the list by default", async () => {
    const text = await page.textContent('[data-testid="inbox-menu"]');
    const titles = await page.$$eval('[data-testid="inbox-menu"] [role="menuitem"]', (els) => els.map((e) => e.getAttribute('title')).join('|'));
    if (/Secret|secret\.txt|rotate/.test(text + titles)) throw new Error('agent text shown');
    await page.keyboard.press('Escape');
    await until(async () => !(await menuOpen()), 'menu closed');
  });

  await step('Ctrl+Shift+U opens the blocked agent first; it stays listed while it is still blocked', async () => {
    await page.keyboard.press('Control+Shift+U');
    await until(async () => (await shownTab()) === a1, 'Backend shown');
    await sleep(400);
    if ((await count()) !== 2) throw new Error(`count ${await count()}`);
  });

  await step('again: the next one, in the other workspace; seeing a finished turn removes it', async () => {
    await page.keyboard.press('Control+Shift+U');
    await until(async () => (await shownWorkspace()) === 'beta-ws' && (await shownTab()) === b1, 'beta tab shown');
    await until(async () => (await count()) === 1, 'finished item seen');
  });

  await step('again: back to the agent that is still blocked; when it continues, the inbox is empty', async () => {
    await page.keyboard.press('Control+Shift+U');
    await until(async () => (await shownWorkspace()) === 'alpha-ws' && (await shownTab()) === a1, 'Backend shown again');
    await feed(a1, 'state=working:app=claude-code');
    await until(async () => (await count()) === 0, 'empty');
    await page.keyboard.press('Control+Shift+U');
    await page.waitForSelector('.toast:has-text("No agents are waiting for you.")');
  });

  await step('clicking a row shows that tab (an error in the other workspace) and closes the list', async () => {
    await feed(b1, 'state=error:app=codex');
    await until(async () => (await count()) === 1, 'error listed');
    await page.click('[data-testid="inbox-button"]');
    await page.click(`[data-testid="inbox-menu"] [role="menuitem"][data-tab-id="${b1}"][data-kind="error"]`);
    await until(async () => (await shownWorkspace()) === 'beta-ws' && (await shownTab()) === b1, 'beta tab shown');
    await until(async () => !(await menuOpen()) && (await count()) === 0, 'closed and seen');
  });

  await step('from Settings: a row brings the workspace back', async () => {
    await showWorkspace('alpha-ws');
    await page.click(`[role="tab"][data-tab-id="${a2}"]`);
    await feed(a1, 'state=blocked:kind=question:app=claude-code');
    await until(async () => (await count()) === 1, 'question listed');
    await page.keyboard.press('Control+,');
    await page.waitForSelector('.settings-nav');
    await page.keyboard.press('Control+Shift+U');
    await page.waitForSelector('.settings-nav', { state: 'hidden' });
    await until(async () => (await shownTab()) === a1, 'Backend shown');
  });

  await step('the command palette lists the waiting agent and "Go to the next waiting agent"', async () => {
    await page.click(`[role="tab"][data-tab-id="${a2}"]`);
    await page.keyboard.press('Control+Shift+P');
    await page.keyboard.type('has a question');
    await page.waitForSelector('[role="option"]:has-text("Claude Code has a question — alpha-ws · Backend")');
    await page.keyboard.press('Enter');
    await until(async () => (await shownTab()) === a1, 'Backend shown from the palette');
  });

  await step('closing the tab removes its item', async () => {
    // Still blocked (a question), so it is listed although its tab is on screen.
    if ((await count()) !== 1) throw new Error(`count ${await count()}`);
    await page.click(`[role="tab"][data-tab-id="${a1}"]`);
    await page.keyboard.press('Control+Shift+W');
    await page.click('button:has-text("End session and close")');
    await until(async () => (await count()) === 0, 'item gone');
  });
} catch (e) {
  results.push({ name: 'script error', ok: false });
  console.log(`  ✗ script error: ${e?.message ?? e}`);
} finally {
  await app.evaluate(() => {
    globalThis.__twQuitAsk = async () => 'discard';
  }).catch(() => undefined);
  await app.close().catch(() => undefined);
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `RESULT: ${failed} of ${results.length} steps FAILED` : `RESULT: all ${results.length} steps passed`);
process.exit(failed ? 1 : 0);
