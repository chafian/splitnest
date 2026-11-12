// Layout check at several device scale factors and window sizes.
//
// IMPORTANT: this does not change Windows display scaling. 100% is the
// machine's real setting; 125% and 150% are simulated with Chromium's
// --force-device-scale-factor, which scales the page like Windows DPI
// scaling does, but not the native title-bar buttons or other OS chrome.
//
// Usage: node tests/e2e/run-scaling.mjs   (after `npm run package`)
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const shots = path.join(root, 'test-results', 'screenshots', 'scaling');
mkdirSync(shots, { recursive: true });

const work = mkdtempSync(path.join(tmpdir(), 'tw-scale-'));
const proj = path.join(work, 'reservation-service');
const pkg = path.join(proj, 'src', 'main', 'java', 'com', 'example', 'reservations');
mkdirSync(pkg, { recursive: true });
const LONG = 'CustomerReservationAvailabilityCalculationServiceImplementation.java';
writeFileSync(path.join(pkg, LONG), 'package com.example.reservations;\n\npublic class X {}\n');
writeFileSync(path.join(pkg, 'App.java'), 'package com.example.reservations;\n');
writeFileSync(path.join(proj, 'pom.xml'), '<project/>\n');

const configs = [];
for (const scale of [1, 1.25, 1.5]) for (const size of [{ w: 1600, h: 1000 }, { w: 1280, h: 800 }]) configs.push({ scale, ...size });

const results = [];

async function run({ scale, w, h }) {
  const tag = `${Math.round(scale * 100)}pct-${w}x${h}`;
  const userData = path.join(work, `ud-${tag}`);
  const app = await electron.launch({
    executablePath: require('electron'),
    args: ['.', `--tw-user-data=${userData}`, `--force-device-scale-factor=${scale}`],
    cwd: root,
    env: { ...process.env, TW_E2E: '1', TW_E2E_PICK_FOLDER: proj },
  });
  const page = await app.firstWindow();
  const problems = [];
  try {
    await page.waitForSelector('.app');
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.unmaximize();
      win.setContentSize(cw, ch);
      win.center();
    }, [w, h]);
    await page.waitForFunction(([cw]) => Math.abs(window.innerWidth - cw) <= 2, [w], { timeout: 5000 }).catch(() => problems.push(`window is ${'?'} wide, not ${w}`));
    await page.click('button:has-text("Open folder…")');
    await page.waitForSelector('[data-pane-id][data-status="running"]', { timeout: 30_000 });

    // Long tab name, then three panes (two of them narrow) and an editor with unsaved text.
    const firstTab = await page.getAttribute('[role="tab"]', 'data-tab-id');
    await page.focus(`[data-tab-id="${firstTab}"][role="tab"]`);
    await page.keyboard.press('F2');
    await page.keyboard.type('Reservation API server (watch mode, port 8080)');
    await page.keyboard.press('Enter');
    await page.click('.tabview:not([hidden]) .pane__terminal', { position: { x: 30, y: 20 } });
    await page.keyboard.press('Control+Shift+D');
    await page.waitForFunction(() => document.querySelectorAll('[data-pane-id]').length === 2);
    await page.keyboard.press('Control+Shift+D');
    await page.waitForFunction(() => document.querySelectorAll('[data-pane-id]').length === 3);
    const chain = '.explorer__row[data-path="src/main/java/com/example/reservations"]';
    await page.waitForSelector(chain);
    await page.click(chain);
    await page.waitForSelector(`.explorer__row[data-path$="${LONG}"]`);
    await page.click(`.explorer__row[data-path$="${LONG}"]`);
    await page.waitForSelector('.tabview--file:not([hidden]) .cm-content');
    await page.click('.tabview--file:not([hidden]) .cm-content');
    await page.keyboard.press('Control+End');
    await page.keyboard.type('// edited');
    await page.waitForSelector('[role="tab"][data-dirty="true"]');

    const dpr = await page.evaluate(() => window.devicePixelRatio);
    if (Math.abs(dpr - scale) > 0.01) problems.push(`devicePixelRatio ${dpr}, expected ${scale}`);

    // Layout checks (CSS pixels).
    const layout = await page.evaluate(() => {
      const out = [];
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (document.documentElement.scrollWidth > vw + 1) out.push(`page scrolls horizontally (${document.documentElement.scrollWidth} > ${vw})`);
      const visible = (e) => !!e.offsetParent && getComputedStyle(e).visibility !== 'hidden';
      const controls = document.querySelector('.titlebar__controls-space').getBoundingClientRect();
      for (const b of document.querySelectorAll('.titlebar button')) {
        if (!visible(b)) continue;
        const r = b.getBoundingClientRect();
        if (r.right > controls.left + 1 || r.left < 0) out.push(`title-bar button "${b.getAttribute('aria-label') ?? b.textContent}" under the window buttons or off screen`);
        if (r.width < 24 || r.height < 24) out.push(`title-bar button "${b.getAttribute('aria-label')}" only ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      for (const pane of document.querySelectorAll('[data-pane-id]')) {
        const pr = pane.getBoundingClientRect();
        for (const b of pane.querySelectorAll('.pane__bar button')) {
          if (!visible(b)) continue;
          const r = b.getBoundingClientRect();
          if (r.right > pr.right + 1 || r.left < pr.left - 1) out.push(`pane button "${b.getAttribute('aria-label') ?? b.title}" clipped (pane ${Math.round(pr.width)}px)`);
        }
        const more = pane.querySelector('button[aria-label="More pane actions"]');
        if (!more || !visible(more)) out.push(`pane ${Math.round(pr.width)}px wide has no reachable ⋯ menu`);
        const sel = pane.querySelector('[role="tab"][aria-selected="true"] .tab__name');
        if (sel && parseFloat(getComputedStyle(sel).fontSize) < 12) out.push('tab name below 12px');
      }
      for (const el of document.querySelectorAll('.explorer__name, .ws-item__path, .editor-status, .tab__shell')) {
        if (parseFloat(getComputedStyle(el).fontSize) < 12) out.push(`${el.className} text below 12px`);
      }
      const status = document.querySelector('.editor-status');
      if (status) {
        const r = status.getBoundingClientRect();
        if (r.bottom > vh + 1) out.push('editor status bar off screen');
      }
      return { problems: out, vw, vh, panes: [...document.querySelectorAll('[data-pane-id]')].map((p) => Math.round(p.getBoundingClientRect().width)) };
    });
    problems.push(...layout.problems);
    await page.screenshot({ path: path.join(shots, `${tag}-layout.png`) });

    // Keyboard focus is visible on a title-bar control.
    await page.focus('.titlebar button[aria-label^="Collapse workspace sidebar"]');
    await page.keyboard.press('Tab');
    const focusStyle = await page.evaluate(() => {
      const e = document.activeElement;
      const s = getComputedStyle(e);
      return { outline: `${s.outlineStyle} ${s.outlineWidth}`, label: e.getAttribute('aria-label') };
    });
    // Measured in device pixels: Chromium snaps outlines to whole device pixels (2 CSS px at 125% = 2 device px = "1.6px").
    const ringDevicePx = parseFloat(focusStyle.outline.split(' ')[1]) * dpr;
    if (!focusStyle.outline.startsWith('solid') || ringDevicePx < 1.9) problems.push(`focus ring not visible on ${focusStyle.label}: ${focusStyle.outline} (${ringDevicePx} device px)`);
    await page.screenshot({ path: path.join(shots, `${tag}-focus.png`), clip: { x: 0, y: 0, width: Math.min(layout.vw, 700), height: 60 } });

    // Save / Discard / Cancel dialog: all buttons reachable.
    await page.click('.tabview--file:not([hidden]) .cm-content');
    await page.keyboard.press('Control+Shift+W');
    await page.waitForSelector('.dialog__footer button:has-text("Save and close")');
    const dialog = await page.evaluate(() =>
      [...document.querySelectorAll('.dialog__footer button')].map((b) => {
        const r = b.getBoundingClientRect();
        return { text: b.textContent, inside: r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight && r.top >= 0 };
      }),
    );
    for (const b of dialog) if (!b.inside) problems.push(`dialog button "${b.text}" off screen`);
    const dialogScrolls = await page.$eval('.dialog__body', (e) => e.scrollWidth > e.clientWidth + 1);
    if (dialogScrolls) problems.push('dialog content scrolls horizontally (long name not wrapped)');
    const wsNameTruncation = await page.$eval('.ws-item__label', (e) => (e.scrollWidth > e.clientWidth ? getComputedStyle(e).textOverflow : 'fits'));
    if (wsNameTruncation !== 'fits' && wsNameTruncation !== 'ellipsis') problems.push('workspace name cut off without an ellipsis');
    await page.screenshot({ path: path.join(shots, `${tag}-save-dialog.png`) });
    await page.click('.dialog__footer button:has-text("Cancel")');

    // External change while dirty: the conflict banner and its three choices fit.
    writeFileSync(path.join(pkg, LONG), 'package com.example.reservations;\n// changed elsewhere\n');
    await page.waitForSelector('.tabview--file:not([hidden]) .editor-banner--warning', { timeout: 10_000 });
    const banner = await page.evaluate(() =>
      [...document.querySelectorAll('.tabview--file:not([hidden]) .editor-banner--warning button')].map((b) => {
        const r = b.getBoundingClientRect();
        const pane = b.closest('[data-pane-id]').getBoundingClientRect();
        return { text: b.textContent, inside: r.left >= pane.left - 1 && r.right <= pane.right + 1 };
      }),
    );
    if (banner.length !== 3) problems.push(`conflict banner shows ${banner.length} buttons`);
    for (const b of banner) if (!b.inside) problems.push(`conflict button "${b.text}" clipped`);
    await page.screenshot({ path: path.join(shots, `${tag}-conflict.png`) });
    // Restore the fixture file for the next configuration.
    writeFileSync(path.join(pkg, LONG), 'package com.example.reservations;\n\npublic class X {}\n');

    results.push({ config: tag, devicePixelRatio: dpr, viewport: `${layout.vw}x${layout.vh}`, paneWidths: layout.panes, problems });
  } finally {
    await app.evaluate(() => {
      globalThis.__twQuitAsk = () => Promise.resolve('discard');
    });
    await app.close().catch(() => undefined);
  }
}

for (const c of configs) {
  try {
    await run(c);
  } catch (error) {
    results.push({ config: `${c.scale * 100}%-${c.w}x${c.h}`, error: String(error?.message ?? error).slice(0, 300) });
  }
  console.log(JSON.stringify(results.at(-1)));
}
rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
const failed = results.filter((r) => r.error || r.problems?.length);
console.log(failed.length ? `\n${failed.length} configuration(s) with problems` : '\nall configurations passed');
process.exit(failed.length ? 1 : 0);
