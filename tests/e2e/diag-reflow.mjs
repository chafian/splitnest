// Resize diagnostic for PowerShell under ConPTY: are prompts intact after a pane
// is widened, and do xterm and the shell agree on the cursor row after a pane
// gets taller? Runs the app's settings and, as a control, xterm's old default for
// the cursor line, each in a fresh app with a temp folder.
// Usage: node tests/e2e/diag-reflow.mjs [--current]   (after `npm run package`)
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const PROMPT = 'PS reservation-service>';
const only = process.argv.includes('--current'); // just the app's own settings
// Diagnostics: force xterm's windowsPty mode (ConPTY-style row handling) on every terminal.
const forceWindowsPty = process.argv.includes('--windows-pty');

async function variant(opts) {
  const work = mkdtempSync(path.join(tmpdir(), 'tw-reflow-'));
  const proj = path.join(work, 'reservation-service');
  mkdirSync(proj);
  const app = await electron.launch({
    executablePath: require('electron'),
    args: ['.', `--tw-user-data=${path.join(work, 'ud')}`],
    cwd: root,
    env: { ...process.env, TW_E2E: '1', TW_E2E_PICK_FOLDER: proj },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
  await page.waitForFunction(() => !!window.__twTest);
  const effective = { ...(opts ?? {}), ...(forceWindowsPty ? { windowsPtyBuild: 26300 } : {}) };
  if (Object.keys(effective).length) await page.evaluate((o) => window.__twTest.termOptions(o), effective);
  await page.click('button:has-text("Open folder…")');
  await page.waitForSelector('[data-pane-id][data-status="running"]');
  const paneIds = () => page.$$eval('[data-pane-id]', (els) => els.map((e) => e.getAttribute('data-pane-id')));
  const tabOf = (p) => page.getAttribute(`[data-pane-id="${p}"]`, 'data-active-tab');
  const waitPrompt = (t) => page.waitForFunction((id) => window.__twTest.status(id) === 'running' && /service>\s*$/m.test(window.__twTest.inspect(id, 300).text), t, { timeout: 60_000 });
  const typeIn = async (p, text) => {
    await page.click(`[data-pane-id="${p}"] .tabview:not([hidden]) .pane__terminal`, { position: { x: 10, y: 10 } });
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
  };
  const viewport = async (t) => {
    const r = await page.evaluate((id) => {
      const size = window.__twTest.inspect(id, 1, true);
      return window.__twTest.inspect(id, size.rows, true);
    }, t);
    return { rows: r.text.split('\n'), cols: r.cols };
  };
  const brokenRows = ({ rows, cols }) => (cols > PROMPT.length + 2 ? rows.filter((l) => l.trim() && l.trim() !== PROMPT && !l.startsWith(PROMPT) && PROMPT.includes(l.trim())).length : 0);
  // The check: xterm's screen vs. the console's own screen (read back by PowerShell). ConPTY
  // places output at absolute positions on *its* screen, so if the two differ, new output lands
  // on the wrong rows in xterm. (Asking the shell for its cursor row and looking where the answer
  // appears proves nothing: the answer is always drawn on the row the shell names.)
  let shot = 0;
  const screenSync = async (p, t) => {
    const cursor = await page.evaluate((id) => window.__twTest.cursorRow(id), t);
    const file = path.join(work, `screen-${++shot}.txt`);
    await typeIn(
      p,
      `$r=$Host.UI.RawUI;$w=$r.WindowPosition;$z=$r.WindowSize;$b=$r.GetBufferContents((New-Object Management.Automation.Host.Rectangle 0,$w.Y,($z.Width-1),($w.Y+$z.Height-1)));(0..($z.Height-1)|%{$y=$_;-join(0..($z.Width-1)|%{$b[$y,$_].Character})})|Set-Content -Encoding utf8 '${file}'`,
    );
    const t0 = Date.now();
    while (!existsSync(file) && Date.now() - t0 < 15000) await page.waitForTimeout(100);
    await page.waitForTimeout(300);
    const consoleRows = readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trimEnd());
    // Same moment on both sides: the probe's own (long, wrapping) command line may have scrolled
    // the screen, so take xterm's rows now and compare everything above that command line.
    const now = await viewport(t);
    const probeRow = now.rows.findLastIndex((l) => l.startsWith(`${PROMPT} $r=$Host`));
    const upTo = probeRow >= 0 ? probeRow : cursor;
    const mismatched = [];
    for (let y = 0; y < upTo; y++) {
      const a = (now.rows[y] ?? '').trimEnd();
      const b = consoleRows[y] ?? '';
      if (a !== b) mismatched.push({ row: y, xterm: a.slice(0, 40), console: b.slice(0, 40) });
    }
    return { rowsCompared: upTo, mismatchedRows: mismatched.length, inSync: mismatched.length === 0, firstMismatch: mismatched[0] ?? null };
  };
  const cursorSync = screenSync;
  const closePane = async (p) => {
    await typeIn(p, 'exit');
    await page.waitForFunction((id) => document.querySelector(`[data-pane-id="${id}"]`)?.getAttribute('data-status') === 'exited', p);
    await page.click(`[data-pane-id="${p}"] button[aria-label="More pane actions"]`);
    await page.click('.menu--context button:has-text("Close pane")');
    await page.waitForFunction((id) => !document.querySelector(`[data-pane-id="${id}"]`), p);
  };

  // Width: a shell born about 10 columns wide, used there, then widened.
  const [first] = await paneIds();
  await page.click(`[data-pane-id="${first}"] .tabview:not([hidden]) .pane__terminal`, { position: { x: 10, y: 10 } });
  for (let n = 1; n < 4; n++) {
    await page.keyboard.press('Control+Shift+D');
    await page.waitForFunction((c) => document.querySelectorAll('[data-pane-id]').length === c, n + 1);
  }
  const narrow = (await paneIds()).at(-1);
  const narrowTab = await tabOf(narrow);
  await waitPrompt(narrowTab);
  const narrowCols = (await viewport(narrowTab)).cols;
  await typeIn(narrow, 'Write-Output narrow-1');
  await page.waitForTimeout(700);
  for (const p of (await paneIds()).filter((id) => id !== narrow)) await closePane(p);
  await page.waitForTimeout(1500);
  const widened = await viewport(narrowTab);
  const width = { fromCols: narrowCols, toCols: widened.cols, brokenRows: brokenRows(widened), sync: await cursorSync(narrow, narrowTab) };

  // Partly filled screen (the user's case: a short listing, then resizing): shorter and taller
  // by a split and by the window, the cursor row must stay in sync each time.
  await typeIn(narrow, 'Clear-Host');
  await page.waitForTimeout(800);
  await typeIn(narrow, '1..8 | ForEach-Object { "item $_" }');
  await page.waitForFunction((id) => /item 8/.test(window.__twTest.inspect(id, 300).text), narrowTab);
  await page.waitForTimeout(500);
  const partial = { start: await cursorSync(narrow, narrowTab) };
  await page.keyboard.press('Control+Shift+S');
  await page.waitForFunction(() => document.querySelectorAll('[data-pane-id]').length === 2);
  const below2 = (await paneIds()).find((id) => id !== narrow);
  await waitPrompt(await tabOf(below2));
  await page.waitForTimeout(800);
  partial.splitShorter = await cursorSync(narrow, narrowTab);
  await closePane(below2);
  await page.waitForTimeout(1200);
  partial.splitTaller = await cursorSync(narrow, narrowTab);
  await page.setViewportSize({ width: 1280, height: 420 }).catch(() => undefined);
  await page.waitForTimeout(1200);
  partial.windowShorter = await cursorSync(narrow, narrowTab);
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
  await page.waitForTimeout(1200);
  partial.windowTaller = await cursorSync(narrow, narrowTab);
  await page.setViewportSize({ width: 760, height: 520 }).catch(() => undefined);
  await page.waitForTimeout(1200);
  partial.windowSmallerBoth = await cursorSync(narrow, narrowTab);
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
  await page.waitForTimeout(1200);
  partial.windowBack = await cursorSync(narrow, narrowTab);
  // A drag: many quick intermediate sizes (one per frame), like dragging the window edge.
  const drag = async (from, to) => {
    const steps = 14;
    for (let i = 1; i <= steps; i++) {
      await page.setViewportSize({ width: 1280, height: Math.round(from + ((to - from) * i) / steps) }).catch(() => undefined);
      await page.waitForTimeout(16);
    }
  };
  await typeIn(narrow, 'Clear-Host');
  await page.waitForTimeout(800);
  await typeIn(narrow, '1..8 | ForEach-Object { "item $_" }');
  await page.waitForFunction((id) => /item 8/.test(window.__twTest.inspect(id, 300).text), narrowTab);
  await page.waitForTimeout(500);
  await drag(800, 260);
  await drag(260, 800);
  await page.waitForTimeout(1200);
  partial.dragShorterTaller = await cursorSync(narrow, narrowTab);
  await drag(800, 300);
  await page.waitForTimeout(1200);
  partial.dragShorter = await cursorSync(narrow, narrowTab);
  await drag(300, 800);
  await page.waitForTimeout(1200);
  partial.dragTaller = await cursorSync(narrow, narrowTab);

  // The screenshot's case: an `ls` (lines longer than a narrow pane), pane narrowed so they wrap,
  // then widened again. Both sides must agree on the rows afterwards.
  await typeIn(narrow, "Clear-Host; New-Item -ItemType Directory -Force main, test | Out-Null; Clear-Host");
  await page.waitForTimeout(1200);
  await typeIn(narrow, 'ls');
  await page.waitForFunction((id) => /\btest\s*$/m.test(window.__twTest.inspect(id, 300).text), narrowTab);
  await page.waitForTimeout(600);
  const lsWide = (await viewport(narrowTab)).cols;
  await page.keyboard.press('Control+Shift+D');
  await page.waitForFunction(() => document.querySelectorAll('[data-pane-id]').length === 2);
  await page.click(`[data-pane-id="${narrow}"] .tabview:not([hidden]) .pane__terminal`, { position: { x: 10, y: 10 } });
  await page.keyboard.press('Control+Shift+D');
  await page.waitForFunction(() => document.querySelectorAll('[data-pane-id]').length === 3);
  await page.waitForTimeout(1500);
  const lsNarrow = (await viewport(narrowTab)).cols;
  for (const p of (await paneIds()).filter((id) => id !== narrow)) await closePane(p);
  await page.waitForTimeout(1500);
  partial.lsNarrowThenWide = { cols: `${lsWide} -> ${lsNarrow} -> ${(await viewport(narrowTab)).cols}`, ...(await cursorSync(narrow, narrowTab)) };

  // Shorter than the cursor row, then tall again: the screen scrolls up, then must come back the
  // same way on both sides (xterm pulls rows back from scrollback; does ConPTY?).
  await typeIn(narrow, 'Clear-Host');
  await page.waitForTimeout(800);
  await typeIn(narrow, '1..10 | ForEach-Object { "row $_" }');
  await page.waitForFunction((id) => /row 10/.test(window.__twTest.inspect(id, 300).text), narrowTab);
  await page.waitForTimeout(500);
  partial.belowCursorStart = await cursorSync(narrow, narrowTab);
  await page.setViewportSize({ width: 1280, height: 190 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  const tinyRows = (await viewport(narrowTab)).rows.length;
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  partial.belowCursorThenTall = { tinyRows, ...(await cursorSync(narrow, narrowTab)) };

  // Height: 60 lines of scrollback, pane made shorter (split below) and taller again (close it).
  await typeIn(narrow, '1..60 | ForEach-Object { "line $_" }');
  await page.waitForFunction((id) => /line 60/.test(window.__twTest.inspect(id, 300).text), narrowTab);
  await page.waitForTimeout(500);
  const rowsBefore = (await viewport(narrowTab)).rows.length;
  await page.keyboard.press('Control+Shift+S');
  await page.waitForFunction(() => document.querySelectorAll('[data-pane-id]').length === 2);
  const below = (await paneIds()).find((id) => id !== narrow);
  await waitPrompt(await tabOf(below));
  await page.waitForTimeout(800);
  const shorter = { rows: (await viewport(narrowTab)).rows.length, sync: await cursorSync(narrow, narrowTab) };
  await closePane(below);
  await page.waitForTimeout(1500);
  const taller = await viewport(narrowTab);
  const height = { rowsBefore, rowsShort: shorter.rows, rowsAfter: taller.rows.length, syncShort: shorter.sync, syncTall: await cursorSync(narrow, narrowTab) };
  const tallRows = (await viewport(narrowTab)).rows;
  const dupes = tallRows.filter((l) => /^line \d+$/.test(l)).length - new Set(tallRows.filter((l) => /^line \d+$/.test(l))).size;

  await app.evaluate(() => {
    globalThis.__twQuitAsk = () => Promise.resolve('discard');
  });
  await app.close().catch(() => undefined);
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    /* temp folder; Windows may still hold a handle */
  }
  return { options: opts ?? 'app defaults', width, partial, height: { ...height, duplicatedLines: dupes } };
}

// The app's own settings must keep prompts intact and the cursor in sync. The old default
// (xterm's reflowCursorLine off) is run too, to show the check still detects the problem.
const results = [];
for (const v of only ? [null] : [null, { reflowCursorLine: false }]) {
  const r = await variant(v);
  console.log(JSON.stringify(r));
  const checks = { width: r.width.sync, ...r.partial, heightShort: r.height.syncShort, heightTall: r.height.syncTall };
  const bad = Object.entries(checks).filter(([, s]) => s && s.inSync === false);
  console.log(`SCREENS: ${bad.length} of ${Object.keys(checks).length} differ, ${bad.reduce((n, [, s]) => n + (s.mismatchedRows ?? 0), 0)} rows` + (bad.length ? ` (${bad.map(([k, s]) => `${k}:${s.mismatchedRows}`).join(', ')})` : ''));
  results.push(r);
}
const app = results[0];
// No known exceptions: with the system ConPTY and the ordered resize path every case agrees.
// Limitation of THIS diagnostic: it reads the console by typing a $Host.UI.RawUI command into the
// shell, which itself scrolls the screen and prints a prompt before the comparison is made, so a
// pass here is weaker evidence. tests/e2e/run-resize.mjs compares without touching the shell
// (console-probe.ps1 attaches to the console) and also checks scrollback and typed commands.
const screens = { width: app.width.sync, ...app.partial, heightShort: app.height.syncShort, heightTall: app.height.syncTall };
const ok = app.width.brokenRows === 0 && app.height.duplicatedLines === 0 && Object.values(screens).every((s) => s.inSync);
console.log(ok ? `ok: these ${Object.keys(screens).length} screen comparisons agree (intrusive measurement; see run-resize.mjs for the full check)` : 'FAIL: see app defaults above');
if (results[1]) console.log(results[1].width.brokenRows > 0 ? 'control: old default still shows broken rows (check is sensitive)' : 'control: old default showed no broken rows this time');
process.exit(ok ? 0 : 1);
