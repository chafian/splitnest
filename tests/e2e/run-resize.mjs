// Resize correctness and flicker check for PowerShell terminals (Windows, ConPTY).
//
// What is compared, after every resize sequence and once output has settled:
//   - screen:  xterm's visible rows vs. the console's own rows, read from OUTSIDE the shell with
//              tests/e2e/console-probe.ps1 (AttachConsole + ReadConsoleOutputCharacter). Nothing is
//              typed into the shell to measure, so the probe cannot scroll or alter the screen.
//   - size:    xterm cols x rows vs. the console window size (what ConPTY/the shell uses)
//   - cursor:  xterm cursor vs. the console cursor
//   - content: 30 marker lines exist exactly once, in order (no overlap, loss or duplication)
//   - typing:  a command typed after the resizes runs and the screens still agree
// Flicker: CDP screencast frames during divider drags; a frame is "blank" when the terminal area
// suddenly holds almost no text pixels compared with the frames around it.
//
// Scenarios: A directory listing, narrow/widen 3x (+ a cancelled drag)
//            B height below the cursor, then expanded
//            C resize while output is streaming
//            D long, partially typed command, resized
//            E nested split drag, maximise/restore, sidebar collapse/expand, window resize
//            F shell started in a very narrow pane, then widened
//            S scrollback: numbered lines wrapped at ~23 cols, widen/maximise/restore/narrow/widen
//            M a wrapped line cut by the console's top edge (three placements), with real lines that
//              look like the cut part as a control; the part must go once it has scrolled off
//            H awkward output (huge cursor-forward after cursor-home) fed during a divider drag
//            P (opt-in) PSReadLine 2.0: half a command typed under a wrapped prompt, pane widened
//            W WSL tab: listing and divider drags (needs a WSL distribution)
// Exit code 1 and FAIL lines when any check fails; there are no "known failure" exceptions.
//
// Usage: node tests/e2e/run-resize.mjs [--renderer webgl|dom] [--scenarios ABCDEFW] [--scale 1.5] [--out f.json] [--shots dir] [--dump]
// Diagnostics: TW_DIAG_CONPTY=bundled runs the app with node-pty's bundled ConPTY instead.
// (after `npm run package`; temp folders and an isolated user-data directory only)
import { _electron as electron } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.resolve(here, '..', '..');
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : d;
};
const RENDERER = arg('--renderer', 'webgl');
const SCENARIOS = arg('--scenarios', 'ABCDEFSMHW');
const OUT = arg('--out', '');
const SHOTS = arg('--shots', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

// ------------------------------------------------------------- console probe
const probeProc = spawn(ps, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'console-probe.ps1')], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
const probeLines = [];
readline.createInterface({ input: probeProc.stdout }).on('line', (l) => probeLines.push(l));
while (!probeLines.length) await sleep(20);
const probe = async (pid) => {
  const n = probeLines.length;
  probeProc.stdin.write(`${pid}\n`);
  const t0 = Date.now();
  while (probeLines.length === n && Date.now() - t0 < 10000) await sleep(5);
  return JSON.parse(probeLines.at(-1));
};

// ------------------------------------------------------------- app
const work = mkdtempSync(path.join(tmpdir(), 'tw-resize-'));
const proj = path.join(work, 'resize-check');
mkdirSync(proj);
for (let i = 1; i <= 12; i++) writeFileSync(path.join(proj, `file-with-a-fairly-long-name-${String(i).padStart(2, '0')}.txt`), 'x'.repeat(i * 37));
for (const d of ['src', 'docs', 'tests']) mkdirSync(path.join(proj, d));
const shotDir = SHOTS || path.join(work, 'shots');
mkdirSync(shotDir, { recursive: true });

// --scale 1.5: SIMULATED display scaling (Chromium's device scale factor). Windows' own display
// scaling is not changed by this script; native title-bar buttons are not scaled.
const SCALE = arg('--scale', '');
// --keep-steps: also run the preserved-output check after each step of scenario E.
const KEEP_STEPS = process.argv.includes('--keep-steps');
// --drag-steps n: mouse moves per divider drag in scenario S (default 24, like a real drag).
const DRAG_STEPS = Number(arg('--drag-steps', '24'));
const scaleArgs = SCALE ? [`--force-device-scale-factor=${SCALE}`] : [];
const app = await electron.launch({ executablePath: require('electron'), args: ['.', `--tw-user-data=${path.join(work, 'ud')}`, ...scaleArgs], cwd: root, env: { ...process.env, TW_E2E: '1', TW_E2E_PICK_FOLDER: proj } });
const page = await app.firstWindow();
// Uncaught errors and console errors in the window (scenario H counts them).
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e).slice(0, 200)));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text().slice(0, 200));
});
await page.setViewportSize({ width: 1400, height: 860 }).catch(() => undefined);
await page.waitForFunction(() => !!window.__twTest);
// Test-only: record the numbers behind each anchored resize (dumped with a failing check).
await page.evaluate((dom) => window.__twTest.termOptions({ resizeLog: true, ...(dom ? { webgl: false } : {}) }), RENDERER === 'dom');
await page.click('button:has-text("Open folder…")');
await page.waitForSelector('[data-pane-id][data-status="running"]');

const paneIds = () => page.$$eval('[data-pane-id]', (els) => els.map((e) => e.getAttribute('data-pane-id')));
const tabOf = (p) => page.getAttribute(`[data-pane-id="${p}"]`, 'data-active-tab');
const text = (t, n = 400, raw = false) => page.evaluate(([id, k, r]) => window.__twTest.inspect(id, k, r)?.text ?? '', [t, n, raw]);
const focusPane = (p) => page.click(`[data-pane-id="${p}"] .tabview:not([hidden]) .pane__terminal`, { position: { x: 30, y: 15 } });
const typeIn = async (p, s, enter = true) => {
  await focusPane(p);
  await page.keyboard.type(s);
  if (enter) await page.keyboard.press('Enter');
};
const waitPrompt = (t) =>
  page.waitForFunction((id) => window.__twTest.status(id) === 'running' && /PS resize-check>\s*$/m.test(window.__twTest.inspect(id, 300)?.text ?? ''), t, { timeout: 60_000 }).catch(() => dump(`prompt in tab ${t.slice(0, 8)}`));
const settle = async (tabs) => {
  // Output quiet for 600 ms in every pane, then 300 ms for the last PTY size to apply.
  let last = '';
  let since = Date.now();
  const t0 = Date.now();
  while (Date.now() - t0 < 20_000) {
    const now = (await Promise.all(tabs.map((t) => text(t, 60, true)))).join('\u0000');
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since > 600) break;
    await sleep(100);
  }
  await sleep(300);
};
const pids = new Map();
const wslTabs = new Set();
const setupPane = async (p) => {
  const t = await tabOf(p);
  await waitPrompt(t);
  await typeIn(p, 'Write-Output ("PI" + "D=" + $PID)');
  await page.waitForFunction((id) => /^PID=\d+$/m.test(window.__twTest.inspect(id, 300).text), t).catch(() => dump(`PID in tab ${t.slice(0, 8)}`));
  pids.set(t, Number((await text(t, 300)).match(/^PID=(\d+)$/m)[1]));
  await typeIn(p, 'Clear-Host');
  await sleep(600);
  return t;
};

const results = [];
let shotN = 0;
/** Windows PIDs of running processes with this image name. */
function listPids(name) {
  const out = execFileSync(ps, ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process -Filter "Name='${name}'" | % { $_.ProcessId }) -join ','`], { encoding: 'utf8' }).trim();
  return out ? out.split(',').map(Number) : [];
}
/** A wait failed: keep a screenshot and every pane's last lines, then stop with that context. */
async function dump(what) {
  const file = path.join(shotDir, `${RENDERER}-dump-${++shotN}.png`);
  await page.screenshot({ path: file }).catch(() => undefined);
  const tails = [];
  for (const p of await paneIds()) {
    const t = await tabOf(p);
    const st = await page.evaluate((id) => window.__twTest.status(id), t);
    tails.push(`${p.slice(0, 8)} [${st}]: ${JSON.stringify((await text(t, 40)).split('\n').filter((l) => l.trim()).slice(-4))}`);
  }
  throw new Error(`${what} timed out. Screenshot ${file}\n  ${tails.join('\n  ')}`);
}
async function check(scenario, label, panes) {
  const tabs = await Promise.all(panes.map(tabOf));
  await settle(tabs);
  for (const t of tabs) {
    const g = await page.evaluate((id) => window.__twTest.geometry(id), t);
    const view = (await text(t, g.rows, true)).split('\n').map((l) => l.trimEnd());
    const c = await probe(pids.get(t));
    if (!c.ok) {
      results.push({ scenario, label, tab: t, ok: false, error: c.error });
      continue;
    }
    const mism = [];
    for (let y = 0; y < Math.max(view.length, c.lines.length); y++) if ((view[y] ?? '') !== (c.lines[y] ?? '')) mism.push(y);
    const r = {
      scenario,
      label,
      tab: t.slice(0, 8),
      xterm: `${g.cols}x${g.rows}`,
      console: `${c.cols}x${c.rows}`,
      sizeAgrees: g.cols === c.cols && g.rows === c.rows,
      // After a character in the last column the cursor waits there to wrap: xterm reports that
      // as column = cols, the console API as the last column. The same state, named as such.
      cursorAgrees: g.cursorY === c.cursorY && (g.cursorX === c.cursorX || (g.cursorX === g.cols && c.cursorX === g.cols - 1 && (view[g.cursorY] ?? '').length >= g.cols - 1)),
      ...(g.cursorX === g.cols ? { cursorWaitsToWrap: true } : {}),
      cursor: `xterm ${g.cursorX},${g.cursorY} / console ${c.cursorX},${c.cursorY}`,
      mismatchedRows: mism.length,
      firstMismatch: mism.length ? { row: mism[0], xterm: (view[mism[0]] ?? '').slice(0, 60), console: (c.lines[mism[0]] ?? '').slice(0, 60) } : null,
      atBottom: g.atBottom,
    };
    r.ok = r.sizeAgrees && r.cursorAgrees && mism.length === 0;
    if (!r.ok && process.argv.includes('--dump')) r.rows = { xterm: view, console: c.lines };
    results.push(r);
    if (!r.ok) {
      const file = path.join(shotDir, `${RENDERER}-${scenario}-${++shotN}.png`);
      await page.screenshot({ path: file }).catch(() => undefined);
      r.screenshot = file;
    }
  }
}
async function checkKeep(scenario, p, strict = false) {
  // The 30 marker lines: each exactly once, in order (logical lines, wrapped rows joined).
  const t = await tabOf(p);
  const lines = (await text(t, 5000)).split('\n').map((l) => l.trimEnd());
  const idx = [];
  const counts = [];
  for (let i = 1; i <= 30; i++) {
    const want = `KEEP-${String(i).padStart(2, '0')} preserved output line for the resize check`;
    const hits = lines.flatMap((l, j) => (l === want ? [j] : []));
    counts.push(hits.length);
    idx.push(hits[0] ?? -1);
  }
  const ordered = idx.every((v, i) => i === 0 || v > idx[i - 1]);
  const ok = counts.every((n) => n === 1) && ordered;
  const which = (pred) => counts.flatMap((n, i) => (pred(n) ? [i + 1] : []));
  const first = Math.max(0, Math.min(...idx.filter((v) => v >= 0)) - 3);
  const resizes = ok ? undefined : (await page.evaluate((id) => window.__twTest.resizes(id), t)).slice(-60);
  results.push({
    scenario, label: 'preserved output', tab: t.slice(0, 8), ok, ...(resizes ? { resizes } : {}),
    missing: counts.filter((n) => n === 0).length, duplicated: counts.filter((n) => n > 1).length, ordered,
    ...(ok ? {} : { missingIds: which((n) => n === 0), duplicatedIds: which((n) => n > 1), around: lines.slice(first, first + 45) }),
  });
  await checkFragments(scenario, 'preserved output', t, lines, Array.from({ length: 30 }, (_, i) => `KEEP-${String(i + 1).padStart(2, '0')} preserved output line for the resize check`), strict);
}
/**
 * Partial duplicates: a line of its own that repeats the END of a marker line (the console's part
 * of a line cut by its top edge). The full lines can all be present once while such a tail shows
 * up again; recorded as its own failing check so it is never hidden by the exact-line counts.
 */
async function checkFragments(scenario, label, t, lines, wanted, strict = false) {
  const full = new Set(wanted);
  const tails = lines.filter((l) => l.length >= 3 && !full.has(l) && wanted.some((w) => w.endsWith(l)));
  // One such line is expected while the console itself shows it: the line on the screen's top row,
  // when the console's top edge cut a wrapped line (the console has only that part and draws it).
  // It is reported (never silently dropped) and must be gone once it has scrolled off the screen;
  // scenario M checks that. Any other partial duplicate fails.
  const top = ((await page.evaluate((id) => window.__twTest.geometry(id), t))?.topLine ?? '').trimEnd();
  // `strict`: after output has scrolled the screen, nothing may be left, on the top row either.
  const onTopRow = !strict && top && tails.filter((l) => l === top).length === 1 ? top : null;
  const failing = tails.filter((l) => l !== onTopRow);
  results.push({
    scenario, label: `no partial duplicates: ${label}`, tab: t.slice(0, 8), ok: failing.length === 0,
    ...(failing.length ? { tails: failing.slice(0, 5), around: lines.slice(Math.max(0, lines.indexOf(failing[0]) - 3), lines.indexOf(failing[0]) + 3), resizes: (await page.evaluate((id) => window.__twTest.resizes(id), t)).slice(-120) } : {}),
    ...(onTopRow ? { pendingOnConsoleTopRow: onTopRow } : {}),
  });
}
/** Numbered lines 1..n (logical lines, wrapped rows joined): each exactly once, in order. */
async function checkNumbered(scenario, label, p, prefix, n, make, fragments = true) {
  const t = await tabOf(p);
  await settle([t]);
  const lines = (await text(t, 20_000)).split('\n').map((l) => l.trimEnd());
  const counts = [];
  const idx = [];
  const changed = [];
  for (let i = 1; i <= n; i++) {
    const want = make(i);
    const hits = lines.flatMap((l, j) => (l === want ? [j] : []));
    counts.push(hits.length);
    idx.push(hits[0] ?? -1);
    // A numbered line present but with different text (overwritten or merged).
    if (!hits.length && lines.some((l) => l.includes(`${prefix}-${String(i).padStart(3, '0')}`))) changed.push(i);
  }
  const which = (pred) => counts.flatMap((c, i) => (pred(c) ? [i + 1] : []));
  const present = idx.filter((v) => v >= 0);
  const ordered = present.every((v, i) => i === 0 || v > present[i - 1]);
  const ok = counts.every((c) => c === 1) && ordered;
  const r = { scenario, label: `numbered lines: ${label}`, tab: t.slice(0, 8), ok, missing: which((c) => c === 0), duplicated: which((c) => c > 1), changed, ordered };
  if (fragments) await checkFragments(scenario, label, t, lines, Array.from({ length: n }, (_, i) => make(i + 1)), fragments === 'strict');
  if (!ok) {
    // Context around the first bad number: the lines as joined, and the raw rows.
    const bad = [...r.missing, ...r.duplicated][0] ?? 1;
    const tag = (i) => `${prefix}-${String(i).padStart(3, '0')}`;
    const at = Math.max(0, lines.findIndex((l) => l.includes(tag(bad)) || l.includes(tag(bad - 1))));
    r.around = lines.slice(Math.max(0, at - 3), at + 8);
    const raw = (await text(t, 20_000, true)).split('\n');
    const rawAt = Math.max(0, raw.findIndex((l) => l.includes(tag(bad - 1))));
    r.aroundRaw = raw.slice(Math.max(0, rawAt - 2), rawAt + 12);
    r.resizes = (await page.evaluate((id) => window.__twTest.resizes(id), t)).slice(-40);
  }
  results.push(r);
}
/** Drag pane p's right-hand divider until the terminal has about `cols` columns. */
async function dragToCols(p, cols) {
  const t = await tabOf(p);
  for (let attempt = 0; attempt < 4; attempt++) {
    await settle([t]);
    const g = await page.evaluate((id) => window.__twTest.geometry(id), t);
    if (Math.abs(g.cols - cols) <= 1) return;
    const b = await page.locator(`[data-pane-id="${p}"] .tabview:not([hidden]) .pane__terminal`).boundingBox();
    const px = b.width / g.cols;
    // The vertical divider on the pane's left edge (found by position: nested splits add more).
    const xs = await page.$$eval('.divider--vertical', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, top: r.top, bottom: r.bottom }; }));
    const edge = xs
      .map((d, i) => ({ i, dist: Math.abs(d.x - b.x), spans: d.top <= b.y + 5 && d.bottom >= b.y + b.height - 5 }))
      .filter((d) => d.spans)
      .sort((a, z) => a.dist - z.dist)[0];
    if (!edge || edge.dist > 20) throw new Error(`no divider on the left edge of pane ${p.slice(0, 8)}`);
    // Moving the left divider right makes the pane narrower.
    await drag('.divider--vertical', edge.i, (g.cols - cols) * px, 0, DRAG_STEPS);
  }
}
/** Prints enough lines in pane p to scroll everything now on its screen off the screen. */
async function scrollScreenOff(p, tag) {
  const t = await tabOf(p);
  await settle([t]);
  const g = await page.evaluate((id) => window.__twTest.geometry(id), t);
  const n = 2 * g.rows - g.cursorY + 2;
  await typeIn(p, `1..${n} | % { "${tag}-$_" }`);
  await page.waitForFunction(([id, m]) => new RegExp(`^${m} *$`, 'm').test(window.__twTest.inspect(id, 300).text), [t, `${tag}-${n}`], { timeout: 20_000 }).catch(() => dump(`scrolling (${tag})`));
  await settle([t]);
}
async function checkTyping(scenario, panes) {
  for (const p of panes) {
    const t = await tabOf(p);
    const mark = `NEW-${scenario}-${Math.random().toString(36).slice(2, 7)}`;
    // The marker is split in the command so only the output line matches; bash in WSL tabs has no Write-Output.
    await typeIn(p, wslTabs.has(t) ? `echo "${mark.slice(0, 4)}""${mark.slice(4)}"` : `Write-Output ("${mark.slice(0, 4)}" + "${mark.slice(4)}")`);
    // A corrupted screen can merge the output into older text, so "not found as its own line"
    // is a recorded failure (with a screenshot), not an abort.
    const seen = await page
      .waitForFunction(([id, m]) => new RegExp(`^${m} *$`, 'm').test(window.__twTest.inspect(id, 300).text), [t, mark], { timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    const n = (await text(t, 2000)).split('\n').filter((l) => l.trimEnd() === mark).length;
    const r = { scenario, label: 'new command output appears once, on its own line', tab: t.slice(0, 8), ok: seen && n === 1, count: n };
    if (!r.ok) {
      r.screenshot = path.join(shotDir, `${RENDERER}-${scenario}-typed-${++shotN}.png`);
      await page.screenshot({ path: r.screenshot }).catch(() => undefined);
      r.tail = (await text(t, 40, true)).split('\n').filter((l) => l.trim()).slice(-6);
    }
    results.push(r);
  }
  await check(scenario, 'after typing a new command', panes);
}

// ------------------------------------------------------------- dragging and frames
const cdp = await page.context().newCDPSession(page);
const frames = [];
let recording = false;
cdp.on('Page.screencastFrame', async (f) => {
  if (recording) frames.push(f.data);
  await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
});
const flicker = [];
async function recordFrames(label, rect, fn) {
  frames.length = 0;
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  recording = true;
  await fn();
  await sleep(300);
  recording = false;
  await cdp.send('Page.stopScreencast');
  const dir = path.join(work, `frames-${flicker.length}`);
  mkdirSync(dir);
  frames.forEach((d, i) => writeFileSync(path.join(dir, `${String(i).padStart(4, '0')}.png`), Buffer.from(d, 'base64')));
  const ink = JSON.parse(execFileSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'frame-ink.ps1'), dir, String(rect.x), String(rect.y), String(rect.w), String(rect.h)], { encoding: 'utf8' }));
  const values = Array.isArray(ink) ? ink : [ink];
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const blank = values.filter((v) => median > 0.01 && v < median * 0.25).length;
  flicker.push({ label, frames: values.length, medianInk: Math.round(median * 1000) / 1000, blankFrames: blank });
}
async function drag(selector, index, dx, dy, steps = 24, delay = 16, cancel = false) {
  const box = await page.locator(selector).nth(index).boundingBox();
  const x0 = box.x + box.width / 2;
  const y0 = box.y + box.height / 2;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x0 + (dx * i) / steps, y0 + (dy * i) / steps);
    await sleep(delay);
  }
  if (cancel) {
    await page.locator(selector).nth(index).dispatchEvent('pointercancel', { pointerId: 1, bubbles: true });
  }
  await page.mouse.up();
}
const termRect = async (p) => {
  const b = await page.locator(`[data-pane-id="${p}"] .tabview:not([hidden]) .pane__terminal`).boundingBox();
  return { x: Math.round(b.x + 4), y: Math.round(b.y + 4), w: Math.round(b.width - 8), h: Math.round(Math.min(b.height - 8, 260)) };
};

// ------------------------------------------------------------- scenarios
const [p1] = await paneIds();
const t1 = await setupPane(p1);
await typeIn(p1, '1..30 | % { "KEEP-{0:D2} preserved output line for the resize check" -f $_ }');
await page.waitForFunction((id) => /KEEP-30/.test(window.__twTest.inspect(id, 300).text), t1);
await typeIn(p1, 'Get-ChildItem');
await page.keyboard.press('Control+Shift+D');
await page.waitForFunction(() => document.querySelectorAll('[data-pane-id]').length === 2);
const p2 = (await paneIds()).find((p) => p !== p1);
await setupPane(p2);
await typeIn(p2, 'Get-ChildItem');
await check('setup', 'two panes side by side', [p1, p2]);

const vdiv = '.split--row > .divider--vertical';
if (SCENARIOS.includes('A')) {
  const narrowRect = await termRect(p1);
  narrowRect.w = Math.min(narrowRect.w, 220);
  for (let i = 1; i <= 3; i++) {
    const narrow = () => drag(vdiv, 0, -420, 0);
    if (i === 1) await recordFrames('A: divider drag (narrow)', narrowRect, narrow);
    else await narrow();
    await check('A', `narrow ${i}`, [p1, p2]);
    const widen = () => drag(vdiv, 0, 640, 0);
    if (i === 1) await recordFrames('A: divider drag (widen)', narrowRect, widen);
    else await widen();
    await check('A', `widen ${i}`, [p1, p2]);
  }
  await drag(vdiv, 0, -300, 0, 12, 16, true);
  await check('A', 'drag cancelled midway', [p1, p2]);
  await checkKeep('A', p1);
}
if (SCENARIOS.includes('B')) {
  await typeIn(p1, '1..40 | % { "fill line $_" }');
  await sleep(1200);
  await focusPane(p1);
  await page.keyboard.press('Control+Shift+S');
  await page.waitForFunction(() => document.querySelectorAll('[data-pane-id]').length === 3);
  const p3 = (await paneIds()).find((p) => p !== p1 && p !== p2);
  await setupPane(p3);
  const hdiv = `[data-pane-id="${p1}"]`;
  void hdiv;
  // The horizontal divider between p1 (top) and p3 (bottom).
  const hsel = '.split--column > .divider--horizontal';
  await drag(hsel, 0, 0, -300);
  await check('B', 'shorter than the cursor row', [p1, p3]);
  await drag(hsel, 0, 0, 380);
  await check('B', 'expanded again', [p1, p3]);
  await checkKeep('B', p1);
}
if (SCENARIOS.includes('C')) {
  await typeIn(p1, '1..6000 | % { "stream {0:D5} the quick brown fox jumps over the lazy dog" -f $_ }; Write-Output ("STREAM" + "-END")');
  await sleep(150);
  const rect = await termRect(p1);
  rect.w = Math.min(rect.w, 220);
  await recordFrames('C: divider drag while streaming', rect, async () => {
    for (let i = 0; i < 3; i++) {
      await drag(vdiv, 0, -360, 0, 16, 16);
      await drag(vdiv, 0, 360, 0, 16, 16);
    }
  });
  await page.waitForFunction((id) => /^STREAM-END$/m.test(window.__twTest.inspect(id, 200).text), t1, { timeout: 120_000 });
  await check('C', 'after streaming with resizes', [p1, p2]);
}
if (SCENARIOS.includes('D')) {
  await typeIn(p1, 'Clear-Host');
  await sleep(500);
  const long = 'Get-ChildItem -Path . -Recurse -Filter *.txt | Where-Object { $_.Length -gt 100 } | Sort-Object Length -Descending | Select-Object -First 5 Name, Length';
  await typeIn(p1, long, false);
  await sleep(500);
  await check('D', 'long command typed (not run)', [p1]);
  for (let i = 0; i < 2; i++) {
    await drag(vdiv, 0, -380, 0);
    await check('D', `partially typed, narrowed ${i + 1}`, [p1]);
    await drag(vdiv, 0, 380, 0);
    await check('D', `partially typed, widened ${i + 1}`, [p1]);
  }
  await focusPane(p1);
  await page.keyboard.press('Enter');
  await sleep(1500);
  await check('D', 'long command run after resizes', [p1]);
}
if (SCENARIOS.includes('E')) {
  if (SCENARIOS.includes('D')) {
    // D ends with Clear-Host in this pane: print the marker lines again so E's content check is valid.
    await typeIn(p1, '1..30 | % { "KEEP-{0:D2} preserved output line for the resize check" -f $_ }');
    await page.waitForFunction((id) => /KEEP-30/.test(window.__twTest.inspect(id, 300).text), t1);
  }
  const before = await paneIds();
  await focusPane(p2);
  await page.keyboard.press('Control+Shift+S');
  await page.waitForFunction((n) => document.querySelectorAll('[data-pane-id]').length === n, before.length + 1, { timeout: 10_000 }).catch(async () => {
    await page.screenshot({ path: path.join(shotDir, 'E-split-failed.png') });
    const toast = await page.textContent('.toasts').catch(() => '');
    throw new Error(`split down in the right pane did not add a pane (toast: "${toast}")`);
  });
  const p4 = (await paneIds()).find((p) => !before.includes(p));
  const t4 = await setupPane(p4);
  void t4;
  await typeIn(p4, 'Get-ChildItem');
  const all = await paneIds();
  // Nested divider inside the right column.
  const nested = '.split--row .split--column > .divider--horizontal';
  const count = await page.locator(nested).count();
  await drag(nested, count - 1, 0, -200);
  await drag(nested, count - 1, 0, 260);
  await check('E', 'nested split dragged', all);
  if (KEEP_STEPS) await checkKeep('E:after nested drag', p1);
  await focusPane(p1);
  await page.keyboard.press('Control+Shift+M');
  await page.waitForSelector('.pane--maximized');
  await check('E', 'pane maximised', [p1]);
  await page.keyboard.press('Control+Shift+M');
  await page.waitForSelector('.pane--maximized', { state: 'detached' });
  await check('E', 'maximise restored', all);
  if (KEEP_STEPS) await checkKeep('E:after maximise', p1);
  const sideBtn = '.titlebar button[aria-label*="workspace sidebar"]';
  await page.click(sideBtn);
  await check('E', 'sidebar collapsed', all);
  await page.click(sideBtn);
  await check('E', 'sidebar expanded', all);
  if (KEEP_STEPS) await checkKeep('E:after sidebar', p1);
  for (let i = 1; i <= 16; i++) {
    await page.setViewportSize({ width: 1400 - i * 30, height: 860 - i * 18 }).catch(() => undefined);
    await sleep(16);
  }
  await check('E', 'window made smaller (drag-like)', all);
  if (KEEP_STEPS) await checkKeep('E:after window smaller', p1);
  for (let i = 15; i >= 0; i--) {
    await page.setViewportSize({ width: 1400 - i * 30, height: 860 - i * 18 }).catch(() => undefined);
    await sleep(16);
  }
  await check('E', 'window back to full size', all);
  await checkKeep('E', p1);
  // Once output has scrolled the screen, no part of a cut line may be left anywhere.
  await scrollScreenOff(p1, 'scroll-E');
  await check('E', 'after scrolling the screen off', [p1]);
  await checkKeep('E:after scrolling the screen off', p1, true);
}
if (SCENARIOS.includes('F')) {
  // A shell started in a very narrow pane (prompt wrapped from the start), then widened.
  const before = await paneIds();
  await focusPane(p1);
  for (let i = 0; i < 3; i++) {
    const n = (await paneIds()).length;
    await page.keyboard.press('Control+Shift+D');
    await page.waitForFunction((c) => document.querySelectorAll('[data-pane-id]').length === c + 1, n);
  }
  const born = (await paneIds()).filter((p) => !before.includes(p)).at(-1);
  await setupPane(born);
  await typeIn(born, 'Write-Output born-narrow-1');
  await sleep(600);
  await check('F', 'shell started narrow', [born]);
  for (const p of (await paneIds()).filter((id) => !before.includes(id) && id !== born)) {
    await typeIn(p, 'exit');
    await page.waitForFunction((id) => document.querySelector(`[data-pane-id="${id}"]`)?.getAttribute('data-status') === 'exited', p);
    await page.click(`[data-pane-id="${p}"] button[aria-label="More pane actions"]`);
    await page.click('.menu--context button:has-text("Close pane")');
    await page.waitForFunction((id) => !document.querySelector(`[data-pane-id="${id}"]`), p);
  }
  await check('F', 'widened after starting narrow', [born]);
}
if (SCENARIOS.includes('W')) {
  // WSL: a tab in pane 2, a long listing, divider drags. The probe attaches to wsl.exe's console.
  const wslBefore = new Set(listPids('wsl.exe'));
  await focusPane(p2);
  await page.keyboard.press('Control+Shift+P');
  await page.keyboard.type('new terminal current pane wsl');
  await page.keyboard.press('Enter');
  const wt = await page.waitForFunction((p) => {
    const pane = document.querySelector(`[data-pane-id="${p}"]`);
    const tabs = [...(pane?.querySelectorAll('[role="tab"]') ?? [])];
    const last = tabs.at(-1);
    return tabs.length >= 2 && last?.getAttribute('aria-selected') === 'true' ? last.getAttribute('data-tab-id') : null;
  }, p2, { timeout: 30_000 }).then((h) => h.jsonValue()).catch(() => null);
  if (!wt) {
    results.push({ scenario: 'W', label: 'WSL tab', ok: false, error: 'no WSL profile or the tab did not open' });
  } else {
    await page.waitForFunction((id) => window.__twTest.status(id) === 'running' && /\$\s*$/m.test(window.__twTest.inspect(id, 100)?.text ?? ''), wt, { timeout: 90_000 }).catch(() => dump('WSL prompt'));
    let wslPid = null;
    for (let i = 0; i < 50 && !wslPid; i++) {
      wslPid = listPids('wsl.exe').find((p) => !wslBefore.has(p)) ?? null;
      if (!wslPid) await sleep(200);
    }
    pids.set(wt, wslPid);
    wslTabs.add(wt);
    await typeIn(p2, 'ls -la /etc | head -40');
    await sleep(1000);
    await check('W', 'WSL listing', [p2]);
    for (let i = 1; i <= 2; i++) {
      await drag(vdiv, 0, 300, 0);
      await check('W', `WSL narrowed ${i}`, [p2]);
      await drag(vdiv, 0, -300, 0);
      await check('W', `WSL widened ${i}`, [p2]);
    }
    await typeIn(p2, 'echo NEW-$((40+2))-WSL');
    await sleep(800);
    const n = (await text(wt, 2000)).split('\n').filter((l) => l.trimEnd() === 'NEW-42-WSL').length;
    results.push({ scenario: 'W', label: 'WSL: new command output appears once', ok: n === 1, count: n });
    await check('W', 'WSL after typing', [p2]);
    // Close the WSL tab again so later scenarios type PowerShell into pane 2.
    await typeIn(p2, 'exit');
    await page.waitForFunction((id) => window.__twTest.status(id) === 'exited', wt, { timeout: 15_000 });
    wslTabs.delete(wt);
    await focusPane(p2);
    await page.keyboard.press('Control+Shift+W');
    await page.waitForFunction((p) => document.querySelectorAll(`[data-pane-id="${p}"] [role="tab"]`).length === 1, p2, { timeout: 10_000 }).catch(() => dump('closing the WSL tab'));
  }
}
if (SCENARIOS.includes('S')) {
  // Scrollback across reflow: numbered lines that wrap in a ~23-column pane, then widen, maximise,
  // restore, narrow and widen again. After every step each numbered line must exist exactly once
  // and in order (all of them: 150 lines x 3 rows is far below the 10,000-row scrollback), and the
  // screen and cursor must agree with the console.
  await focusPane(p2);
  const t = await tabOf(p2);
  await dragToCols(p2, 23);
  await typeIn(p2, 'Clear-Host');
  await sleep(500);
  await typeIn(p2, '1..150 | % { "SB-{0:D3} " -f $_ + ("abcdefghij" * 4) + " end" }');
  await page.waitForFunction((id) => /SB-150/.test(window.__twTest.inspect(id, 400).text), t, { timeout: 30_000 }).catch(() => dump('numbered lines (S)'));
  const step = async (label) => {
    await check('S', label, [p2]);
    await checkNumbered('S', label, p2, 'SB', 150, (i) => `SB-${String(i).padStart(3, '0')} ${'abcdefghij'.repeat(4)} end`);
  };
  await step('printed at ~23 cols');
  await dragToCols(p2, 55);
  await step('widened to ~55 cols');
  await focusPane(p2);
  await page.keyboard.press('Control+Shift+M');
  await page.waitForSelector('.pane--maximized');
  await step('maximised');
  await page.keyboard.press('Control+Shift+M');
  await page.waitForSelector('.pane--maximized', { state: 'detached' });
  await step('maximise restored');
  await dragToCols(p2, 23);
  await step('narrowed to ~23 cols again');
  await dragToCols(p2, 55);
  await step('widened again');
  await checkTyping('S', [p2]);
  await checkNumbered('S', 'after typing', p2, 'SB', 150, (i) => `SB-${String(i).padStart(3, '0')} ${'abcdefghij'.repeat(4)} end`);
  // Once output has scrolled the screen, no part of a cut line may be left anywhere.
  await scrollScreenOff(p2, 'scroll-S');
  await check('S', 'after scrolling the screen off', [p2]);
  await checkNumbered('S', 'after scrolling the screen off', p2, 'SB', 150, (i) => `SB-${String(i).padStart(3, '0')} ${'abcdefghij'.repeat(4)} end`, 'strict');
}
if (SCENARIOS.includes('M')) {
  // A wrapped line cut by the console's top edge, with a control. Every numbered line (3 rows at
  // ~22 columns) is followed by a line the program really prints whose text equals the numbered
  // line's last row ("hij end" at 22 columns). Filler lines place the screen's top row
  //   tail3:  on the last row of a numbered line  (the console keeps only "hij end")
  //   tail2:  on its second row                   (the console keeps the last two rows)
  //   legit:  on a real "hij end" line            (nothing is cut: nothing may be removed)
  // Then the pane is widened. While the console shows its part of the cut line on its top row,
  // xterm shows the same there, below the complete line in scrollback. Once it has scrolled off,
  // it must be gone, with every numbered line and all 150 real control lines exactly once.
  const t = await tabOf(p2);
  const full = (i) => `SB-${String(i).padStart(3, '0')} ${'abcdefghij'.repeat(4)} end`;
  const count = (lines, s) => lines.filter((l) => l === s).length;
  const allLines = async () => (await text(t, 20_000)).split('\n').map((l) => l.trimEnd());
  for (const [name, c] of [['tail3', 1], ['tail2', 2], ['legit', 0]]) {
    const sc = `M:${name}`;
    await focusPane(p2);
    await dragToCols(p2, 22);
    await typeIn(p2, 'Clear-Host');
    await sleep(600);
    const g = await page.evaluate((id) => window.__twTest.geometry(id), t);
    const tail3 = full(1).slice(2 * g.cols);
    const tail2 = full(1).slice(g.cols);
    if (Math.ceil(full(1).length / g.cols) !== 3 || tail3.length < 3) {
      results.push({ scenario: sc, label: 'setup', ok: false, error: `pane is ${g.cols} columns: a numbered line does not take 3 rows` });
      continue;
    }
    // Rows above the prompt, from the bottom: fillers, then groups of [3 rows, control line].
    const fillers = (((g.rows - 2 - c) % 4) + 4) % 4;
    await typeIn(p2, `1..150 | % { "SB-{0:D3} " -f $_ + ("abcdefghij" * 4) + " end"; "${tail3}" }; 1..${fillers} | ? { ${fillers} -gt 0 } | % { "fill-$_" }`);
    await page.waitForFunction((id) => /SB-150/.test(window.__twTest.inspect(id, 400).text), t, { timeout: 30_000 }).catch(() => dump(`numbered lines (${sc})`));
    await settle([t]);
    const before = await probe(pids.get(t));
    const expectTop = { tail3, tail2: full(1).slice(g.cols, 2 * g.cols), legit: tail3 }[name];
    results.push({ scenario: sc, label: 'setup: the console\'s top row is where the case needs it', ok: before.ok && before.lines[0] === expectTop, consoleTopRow: before.lines?.[0], expected: expectTop, size: `${g.cols}x${g.rows}`, fillers });
    await check(sc, 'printed', [p2]);
    await checkNumbered(sc, 'printed', p2, 'SB', 150, full, false);
    results.push({ scenario: sc, label: 'control lines: printed', ok: count(await allLines(), tail3) === 150, count: count(await allLines(), tail3) });

    await dragToCols(p2, 55);
    await check(sc, 'widened', [p2]);
    await checkNumbered(sc, 'widened', p2, 'SB', 150, full, false);
    {
      const lines = await allLines();
      const top = (await page.evaluate((id) => window.__twTest.geometry(id), t)).topLine.trimEnd();
      const after = await probe(pids.get(t));
      // What the console shows on its top row now is what xterm must show there.
      const r = { scenario: sc, label: 'widened: top row as on the console', ok: after.ok && after.lines[0] === top, xtermTop: top, consoleTop: after.lines?.[0] };
      if (name === 'tail3') Object.assign(r, { ok: r.ok && top === tail3 && count(lines, tail3) === 151, controlPlusPart: count(lines, tail3) });
      if (name === 'tail2') Object.assign(r, { ok: r.ok && top === tail2 && count(lines, tail2) === 1 && count(lines, tail3) === 150, part: count(lines, tail2), control: count(lines, tail3) });
      if (name === 'legit') Object.assign(r, { ok: r.ok && top === tail3 && count(lines, tail3) === 150, control: count(lines, tail3) });
      results.push(r);
    }

    // Enough output to scroll the top row off the screen (the widened screen has blank rows below
    // the prompt: the lines got shorter).
    const g2 = await page.evaluate((id) => window.__twTest.geometry(id), t);
    const more = g2.rows - g2.cursorY + 6;
    const scroll = async () => {
      await typeIn(p2, `1..${more} | % { "after-${name}-$_" }`);
      await page.waitForFunction(([id, m]) => new RegExp(`^${m} *$`, 'm').test(window.__twTest.inspect(id, 300).text), [t, `after-${name}-${more}`], { timeout: 15_000 }).catch(() => dump(`scroll (${sc})`));
    };
    if (name === 'tail3') await recordFrames(`${sc}: output scrolls the cut line's part off`, await termRect(p2), scroll);
    else await scroll();
    await check(sc, 'after scrolling', [p2]);
    await checkNumbered(sc, 'after scrolling', p2, 'SB', 150, full, false);
    {
      const lines = await allLines();
      const afterLines = Array.from({ length: more }, (_, i) => count(lines, `after-${name}-${i + 1}`));
      const g3 = await page.evaluate((id) => window.__twTest.geometry(id), t);
      results.push({ scenario: sc, label: 'after scrolling: the screen did scroll (prompt on the last row)', ok: g3.cursorY === g3.rows - 1, cursorRow: g3.cursorY, rows: g3.rows });
      results.push({ scenario: sc, label: 'after scrolling: the console\'s part of the cut line is gone, the 150 real lines remain', ok: count(lines, tail3) === 150 && count(lines, tail2) === 0, control: count(lines, tail3), part: name === 'tail2' ? count(lines, tail2) : count(lines, tail3) - 150 });
      results.push({ scenario: sc, label: 'after scrolling: new output once, in place', ok: afterLines.every((n) => n === 1), counts: afterLines.join('') });
    }
    await checkTyping(sc, [p2]);
    await checkNumbered(sc, 'after typing', p2, 'SB', 150, full, false);
  }
}
if (SCENARIOS.includes('H')) {
  // Awkward session output while a pane is being resized: a cursor-forward with an absurd count
  // right after cursor-home (what the redraw reader looks at), fed as session output every few
  // milliseconds during a divider drag. Wrapped in save/restore cursor so the screen is unchanged.
  // Nothing may throw, and output afterwards must be processed as usual.
  const t = await tabOf(p1);
  await focusPane(p1);
  const errorsBefore = pageErrors.length;
  const fed = await page.evaluate((id) => {
    window.__hostile = { n: 0, timer: setInterval(() => { if (window.__twTest.feed(id, '\x1b7\x1b[H\x1b[9999999999C\x1b8')) window.__hostile.n++; }, 3) };
    return true;
  }, t);
  await drag(vdiv, 0, -220, 0);
  await drag(vdiv, 0, 220, 0);
  const n = await page.evaluate(() => { clearInterval(window.__hostile.timer); return window.__hostile.n; });
  await settle([t]);
  const errors = pageErrors.slice(errorsBefore);
  results.push({ scenario: 'H', label: 'awkward output during a resize: no errors', ok: fed && n > 20 && errors.length === 0, chunksFed: n, errors: errors.length, first: errors.slice(0, 2) });
  await check('H', 'after the drags', [p1]);
  await checkTyping('H', [p1]);
}
if (SCENARIOS.includes('P')) {
  // PSReadLine 2.0 (Windows PowerShell 5.1) with a prompt that itself wraps: half a command typed
  // in a ~12-column pane, the pane widened, the rest typed. Separates three things:
  //   - is the command line drawn intact (prompt + everything typed, once)?
  //   - does the command run with the full text (its output appears once)?
  //   - is earlier output (numbered lines) intact, i.e. no scrollback loss?
  // Opt-in (not in the default set): it reproduces a known, unresolved PSReadLine issue.
  await focusPane(p2);
  const t = await tabOf(p2);
  await dragToCols(p2, 12);
  await typeIn(p2, 'Clear-Host');
  await sleep(500);
  await typeIn(p2, '1..20 | % { "PR-{0:D3} numbered line for the prompt check" -f $_ }');
  await page.waitForFunction((id) => /PR-020/.test(window.__twTest.inspect(id, 400).text), t, { timeout: 30_000 });
  await settle([t]);
  await typeIn(p2, 'Write-Output ("PR" +', false);
  await settle([t]);
  await dragToCols(p2, 55);
  await focusPane(p2);
  await page.keyboard.type(' "-DONE")');
  await settle([t]);
  const screenBefore = (await text(t, 400)).split('\n').map((l) => l.trimEnd());
  const promptLine = screenBefore.filter((l) => l.includes('Write-Output') || l.includes('-DONE')).slice(-3);
  const intact = screenBefore.some((l) => /PS resize-check> Write-Output \("PR" \+ "-DONE"\)$/.test(l));
  results.push({ scenario: 'P', label: 'PSReadLine: typed command drawn intact after the resize', ok: intact, lines: promptLine });
  await check('P', 'screen agrees with the console (typed line pending)', [p2]);
  await page.keyboard.press('Enter');
  const ran = await page
    .waitForFunction((id) => /^PR-DONE$/m.test(window.__twTest.inspect(id, 400).text), t, { timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  const n = (await text(t, 2000)).split('\n').filter((l) => l.trimEnd() === 'PR-DONE').length;
  results.push({ scenario: 'P', label: 'PSReadLine: the command ran with the full text (output once)', ok: ran && n === 1, count: n });
  await check('P', 'after Enter', [p2]);
  await checkNumbered('P', 'earlier output intact', p2, 'PR', 20, (i) => `PR-${String(i).padStart(3, '0')} numbered line for the prompt check`);
  const shot = path.join(shotDir, `${RENDERER}-P-psreadline-${++shotN}.png`);
  await page.screenshot({ path: shot }).catch(() => undefined);
  results.push({ scenario: 'P', label: 'screenshot', ok: true, screenshot: shot });
}
await checkTyping('final', await paneIds());

// ------------------------------------------------------------- report
const failed = results.filter((r) => !r.ok);
const summary = {
  renderer: RENDERER,
  checks: results.length,
  failed: failed.length,
  // Reported, not failed: the console's own part of a cut line, while it is on the top row.
  pendingOnConsoleTopRow: results.filter((r) => r.pendingOnConsoleTopRow).length,
  byScenario: Object.fromEntries([...new Set(results.map((r) => r.scenario))].map((s) => [s, `${results.filter((r) => r.scenario === s && r.ok).length}/${results.filter((r) => r.scenario === s).length} ok`])),
  flicker,
};
console.log(JSON.stringify(summary, null, 1));
for (const f of failed) console.log('FAIL', JSON.stringify(f));
if (OUT) writeFileSync(OUT, JSON.stringify({ summary, results }, null, 1));
await app.evaluate(() => {
  globalThis.__twQuitAsk = () => Promise.resolve('discard');
});
await app.close().catch(() => undefined);
probeProc.stdin.end();
try {
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
} catch {
  /* temp folder; Windows may still hold a handle */
}
console.log(failed.length ? `RESULT: ${failed.length} of ${results.length} checks FAILED (see FAIL lines)` : `RESULT: all ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
