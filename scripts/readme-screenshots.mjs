// Regenerates the README screenshots in docs/readme/ (dev build with TW_E2E=1).
//
// Usage:
//   TW_OUT_DIR=out-readme npm run package     (builds .vite/build, which the dev launch uses)
//   node scripts/readme-screenshots.mjs
//
// Everything is invented and disposable: three demo projects with a few commits each live under
// C:\Users\Public\SplitNest-demo (no user name in any path; the folder is deleted at the end), the
// app uses a fresh profile there, and only the app window is captured. No real AI agent ever runs:
// agent states are written into terminal output as OSC 7501 reports (`__twTest.feed`), and the
// Resume shot uses a stand-in `claude.exe` (a copy of cmd.exe) in a temporary folder that comes
// first on PATH. The script checks that `claude` resolves to it before typing the name.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs', 'readme');
const base = 'C:\\Users\\Public\\SplitNest-demo';
const only = new Set(process.argv.slice(2)); // optional: names of shots to keep (e.g. hero resume)
const W = 1440;
const H = 900;

rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
mkdirSync(base, { recursive: true });
mkdirSync(outDir, { recursive: true });

// ---------- demo projects ----------
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });
const write = (dir, rel, text) => {
  const file = path.join(dir, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text.replace(/^\n/, ''));
};
const commit = (dir, message, files) => {
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', message);
};

const carRental = path.join(base, 'car-rental');
const apiGateway = path.join(base, 'api-gateway');
const docsSite = path.join(base, 'docs-site');

const pricingV1 = `
import type { Vehicle } from '../models/booking';

const DAILY_RATE: Record<Vehicle['category'], number> = {
  economy: 39,
  compact: 49,
  suv: 79,
  van: 95,
};

export interface Quote {
  days: number;
  subtotal: number;
  insurance: number;
  total: number;
}

const INSURANCE_PER_DAY = 12;

/** Whole rental days between two dates; a started day counts as a full day. */
export function rentalDays(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  if (ms <= 0) throw new RangeError('The return date must be after the pick-up date');
  return Math.ceil(ms / 86_400_000);
}

export function quote(vehicle: Vehicle, start: Date, end: Date, insured = false): Quote {
  const days = rentalDays(start, end);
  const subtotal = DAILY_RATE[vehicle.category] * days;
  const insurance = insured ? INSURANCE_PER_DAY * days : 0;
  return { days, subtotal, insurance, total: subtotal + insurance };
}
`;
const pricingV2 = pricingV1
  .replace(
    "export function quote(vehicle: Vehicle, start: Date, end: Date, insured = false): Quote {",
    `/** Saturday and Sunday nights cost 15% more. */
export function weekendSurcharge(start: Date, days: number, dailyRate: number): number {
  let weekendDays = 0;
  for (let i = 0; i < days; i++) {
    const day = new Date(start.getTime() + i * 86_400_000).getUTCDay();
    if (day === 5 || day === 6) weekendDays++;
  }
  return Math.round(weekendDays * dailyRate * 0.15);
}

export function quote(vehicle: Vehicle, start: Date, end: Date, insured = false): Quote {`,
  )
  .replace(
    "  const insurance = insured ? INSURANCE_PER_DAY * days : 0;\n  return { days, subtotal, insurance, total: subtotal + insurance };",
    `  const insurance = insured ? INSURANCE_PER_DAY * days : 0;
  const surcharge = weekendSurcharge(start, days, DAILY_RATE[vehicle.category]);
  return { days, subtotal: subtotal + surcharge, insurance, total: subtotal + surcharge + insurance };`,
  );

function createCarRental() {
  mkdirSync(carRental, { recursive: true });
  git(carRental, 'init', '-q', '-b', 'main');
  commit(carRental, 'Initial project: Express + TypeScript skeleton', {
    '.gitignore': 'node_modules\ndist\n',
    'README.md': '# car-rental\n\nBooking API for a small car rental company.\n\n```\nnpm run dev     # watch mode on :3000\nnpm test        # vitest\n```\n',
    'package.json': JSON.stringify({ name: 'car-rental', version: '0.4.0', private: true, type: 'module', scripts: { dev: 'tsx watch src/index.ts', build: 'tsc', test: 'vitest run' }, dependencies: { express: '^4.19.2' }, devDependencies: { '@types/express': '^4.17.21', tsx: '^4.7.0', typescript: '^5.4.0', vitest: '^1.5.0' } }, null, 2) + '\n',
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, outDir: 'dist' }, include: ['src', 'tests'] }, null, 2) + '\n',
    'src/index.ts': `
import express from 'express';
import { bookingRoutes } from './routes/bookings';
import { vehicleRoutes } from './routes/vehicles';

const app = express();
app.use(express.json());
app.use('/bookings', bookingRoutes);
app.use('/vehicles', vehicleRoutes);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(\`Server listening on :\${port}\`));
`,
    'src/models/booking.ts': `
export interface Vehicle {
  id: string;
  plate: string;
  category: 'economy' | 'compact' | 'suv' | 'van';
}

export interface Booking {
  id: string;
  vehicleId: string;
  customer: string;
  start: string;
  end: string;
}
`,
    'src/routes/vehicles.ts': `
import { Router } from 'express';

export const vehicleRoutes = Router();

vehicleRoutes.get('/', (_req, res) => {
  res.json([{ id: 'v1', plate: 'KR-204-LM', category: 'compact' }]);
});
`,
  });
  commit(carRental, 'Add booking routes and availability check', {
    'src/routes/bookings.ts': `
import { Router } from 'express';
import type { Booking } from '../models/booking';
import { isAvailable } from '../services/availability';

export const bookingRoutes = Router();
const bookings: Booking[] = [];

bookingRoutes.post('/', (req, res) => {
  const booking = req.body as Booking;
  if (!isAvailable(bookings, booking.vehicleId, booking.start, booking.end)) {
    return res.status(409).json({ error: 'Vehicle is not available on these dates' });
  }
  bookings.push({ ...booking, id: String(bookings.length + 1) });
  res.status(201).json(bookings.at(-1));
});

bookingRoutes.get('/', (_req, res) => res.json(bookings));
`,
    'src/services/availability.ts': `
import type { Booking } from '../models/booking';

/** A vehicle is free when no existing booking overlaps the requested dates. */
export function isAvailable(bookings: Booking[], vehicleId: string, start: string, end: string): boolean {
  return !bookings.some((b) => b.vehicleId === vehicleId && b.start < end && start < b.end);
}
`,
  });
  commit(carRental, 'Price quotes with optional insurance', {
    'src/services/pricing.ts': pricingV1,
    'tests/pricing.test.ts': `
import { describe, expect, it } from 'vitest';
import { quote, rentalDays } from '../src/services/pricing';

const compact = { id: 'v1', plate: 'KR-204-LM', category: 'compact' } as const;

describe('pricing', () => {
  it('counts a started day as a full day', () => {
    expect(rentalDays(new Date('2026-03-02T10:00Z'), new Date('2026-03-03T12:00Z'))).toBe(2);
  });

  it('adds insurance per day', () => {
    const q = quote(compact, new Date('2026-03-02'), new Date('2026-03-05'), true);
    expect(q.total).toBe(3 * 49 + 3 * 12);
  });
});
`,
  });
  commit(carRental, 'Reject bookings that end before they start', {
    'src/routes/bookings.ts': readFileSync(path.join(carRental, 'src/routes/bookings.ts'), 'utf8').replace(
      "  const booking = req.body as Booking;\n",
      "  const booking = req.body as Booking;\n  if (booking.end <= booking.start) return res.status(400).json({ error: 'End must be after start' });\n",
    ),
  });
  git(carRental, 'checkout', '-q', '-b', 'feature/weekend-pricing');
  // Uncommitted work: shows +added / -removed in the sidebar.
  write(carRental, 'src/services/pricing.ts', pricingV2);
  write(carRental, 'src/services/loyalty.ts', "export const loyaltyDiscount = (rentals: number): number => (rentals >= 10 ? 0.1 : rentals >= 5 ? 0.05 : 0);\n");
}

const authV1 = `
package com.example.gateway;

/** Checks the bearer token of every request. */
class AuthFilter {
    private final TokenStore tokens;

    AuthFilter(TokenStore tokens) {
        this.tokens = tokens;
    }

    boolean allows(String header) {
        if (header == null) return false;
        Token token = tokens.lookup(header);
        return token != null && token.isValid();
    }
}
`;
const authV2 = authV1
  .replace(
    '        return token != null && token.isValid();\n    }',
    `        if (token == null) return false;
        if (token.isExpired()) return refresh(token);
        return true;
    }

    /** Renews a token that expired under 30 s ago. */
    private boolean refresh(Token token) {
        return token.secondsSinceExpiry() < 30
            && tokens.renew(token);
    }`,
  );

function createApiGateway() {
  mkdirSync(apiGateway, { recursive: true });
  git(apiGateway, 'init', '-q', '-b', 'main');
  const pkg = 'src/main/java/com/example/gateway';
  commit(apiGateway, 'Gateway skeleton with routing table', {
    'README.md': '# api-gateway\n\nA small reverse proxy with token auth and rate limiting.\n',
    'pom.xml': '<project>\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>com.example</groupId>\n  <artifactId>api-gateway</artifactId>\n  <version>1.2.0</version>\n</project>\n',
    [`${pkg}/Gateway.java`]: 'package com.example.gateway;\n\npublic class Gateway {\n    public static void main(String[] args) {\n        System.out.println("Gateway started on :8080");\n    }\n}\n',
    [`${pkg}/AuthFilter.java`]: authV1,
  });
  commit(apiGateway, 'Add per-client rate limiter', {
    [`${pkg}/RateLimiter.java`]: 'package com.example.gateway;\n\nimport java.util.concurrent.ConcurrentHashMap;\n\nclass RateLimiter {\n    private final ConcurrentHashMap<String, Integer> hits = new ConcurrentHashMap<>();\n\n    boolean tryAcquire(String client, int limit) {\n        return hits.merge(client, 1, Integer::sum) <= limit;\n    }\n}\n',
  });
  git(apiGateway, 'checkout', '-q', '-b', 'fix/token-refresh');
  write(apiGateway, `${pkg}/AuthFilter.java`, authV2);
}

function createDocsSite() {
  mkdirSync(docsSite, { recursive: true });
  git(docsSite, 'init', '-q', '-b', 'main');
  commit(docsSite, 'Docs site: index and getting started', {
    'README.md': '# docs-site\n\nProduct documentation, built with a static site generator.\n',
    'package.json': JSON.stringify({ name: 'docs-site', private: true, scripts: { dev: 'vitepress dev docs', build: 'vitepress build docs' } }, null, 2) + '\n',
    'docs/index.md': '---\nlayout: home\n---\n\n# Welcome\n\nEverything you need to get started.\n',
    'docs/guide/getting-started.md': '# Getting started\n\n1. Install the CLI\n2. Run `init`\n3. Deploy\n',
    'docs/guide/configuration.md': '# Configuration\n\nAll options live in `config.json`.\n',
  });
}

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, timeout = 20_000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out: ${what}`);
    await sleep(150);
  }
};
const ps = (cmd, env) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', env }).trim();
const esc = (n) => `\x1b[${n}m`;
const C = { r: esc(0), dim: esc(2), b: esc(1), red: esc(31), grn: esc(32), yel: esc(33), blu: esc(34), mag: esc(35), cyn: esc(36), org: '\x1b[38;5;209m', gry: '\x1b[38;5;245m' };
const screen = (...lines) => `\x1b[2J\x1b[H${lines.join('\r\n')}\r\n`;
const shots = [];

async function launch(env, userData) {
  const app = await electron.launch({ executablePath: require('electron'), args: ['.', `--tw-user-data=${userData}`], cwd: root, env });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [W, H]);
  await page.setViewportSize({ width: W, height: H }).catch(() => undefined);
  await focusWindow(app, page);
  return { app, page };
}
const quit = async (app) => {
  await app.evaluate(() => {
    globalThis.__twQuitAsk = async () => 'discard';
  });
  await app.close();
};
const focusWindow = async (app, page) => {
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  });
  await until(() => page.evaluate(() => window.appApi.windowFocused()), 'window focused (another program has the foreground)');
};
const visibleTabs = (page) => page.evaluate(() => [...document.querySelectorAll('.workspace:not([hidden]) [role="tab"]')].map((e) => e.getAttribute('data-tab-id')));
const selectedTab = (page) => page.evaluate(() => [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].find((e) => e.offsetParent !== null)?.getAttribute('data-tab-id') ?? null);
/** Run a key combination that adds a tab; returns the new tab's id. */
async function addTab(page, keys) {
  const before = new Set(await visibleTabs(page));
  await page.keyboard.press(keys);
  return until(async () => (await visibleTabs(page)).find((t) => !before.has(t)), `new tab after ${keys}`);
}
async function rename(page, tabId, name) {
  await until(() => page.evaluate((t) => window.__twTest.status(t) === 'running', tabId), `shell ${tabId} running`, 30_000);
  const tab = `[role="tab"][data-tab-id="${tabId}"]`;
  const input = `[data-tab-id="${tabId}"] .tab__input`;
  for (let attempt = 0; attempt < 5; attempt++) {
    // Selecting a tab moves the focus to its terminal a moment later; F2 must come after that.
    await page.click(tab);
    await sleep(900);
    await page.focus(tab);
    await page.keyboard.press('F2');
    if (!(await page.waitForSelector(input, { timeout: 1500 }).catch(() => null))) continue;
    await page.keyboard.press('Control+A');
    await page.keyboard.type(name);
    await page.keyboard.press('Enter');
    if (await page.waitForSelector(`${tab}:has-text("${name}")`, { timeout: 2000 }).catch(() => null)) return;
  }
  throw new Error(`could not rename ${tabId} to ${name}`);
}
const running = (page, tabId) => until(() => page.evaluate((t) => window.__twTest.status(t) === 'running', tabId), `shell ${tabId} running`, 30_000);
const feed = (page, tabId, data) => page.evaluate(([t, d]) => window.__twTest.feed(t, d), [tabId, data]);
const report = (page, tabId, ...bodies) => feed(page, tabId, bodies.map((b) => `\x1b]7501;${b}\x1b\\`).join(''));
const fakeAgent = (page, tabId, agent) => page.evaluate(([t, a]) => window.__twTest.fakeProcessAgent(t, a), [tabId, agent]);
async function typeIn(page, tabId, text) {
  await page.click(`[role="tab"][data-tab-id="${tabId}"]`);
  await page.click(`.tabview[data-tab-id="${tabId}"] .pane__terminal`, { position: { x: 40, y: 20 } });
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}
const dismissToasts = (page) => page.evaluate(() => document.querySelectorAll('.toast button[aria-label="Dismiss"]').forEach((b) => b.click()));
async function shot(page, name) {
  if (only.size && !only.has(name)) return;
  await page.mouse.move(W - 60, H - 40);
  await sleep(500);
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  shots.push(file);
  console.log(`  shot ${name}.png (${Math.round(statSync(file).size / 1024)} KB)`);
}
const explorerRow = (page, name) => page.locator('.explorer__row', { has: page.locator('.explorer__name', { hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }) }).first();

// ---------- phase 1: Resume (stand-in agent processes, two app runs) ----------
async function resumeShot() {
  const work = path.join(base, '_resume');
  const ud = path.join(work, 'profile');
  const agentHome = path.join(work, 'agent-home');
  const fakebin = path.join(work, 'fakebin');
  for (const d of [ud, fakebin, path.join(agentHome, '.claude', 'sessions')]) mkdirSync(d, { recursive: true });
  const sys32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const fakeClaude = path.join(fakebin, 'claude.exe');
  const fakeCodex = path.join(fakebin, 'codex.exe');
  copyFileSync(path.join(sys32, 'cmd.exe'), fakeClaude);
  copyFileSync(path.join(sys32, 'cmd.exe'), fakeCodex);
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'Path';
  const env = { ...process.env, TW_E2E: '1', TW_E2E_PICK_FOLDER: carRental, TW_E2E_AGENT_HOME: agentHome };
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k];
  env[pathKey] = `${fakebin};${process.env[pathKey]}`;
  const fakes = (exe) => {
    const out = ps(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${exe}' } | ForEach-Object { '{0}' -f $_.ProcessId }`, env);
    return out ? out.split(/\r?\n/).map(Number) : [];
  };
  const killFakes = () => {
    for (const exe of [fakeClaude, fakeCodex]) for (const pid of fakes(exe)) ps(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`, env);
  };
  const savedTabs = () => {
    try {
      const s = JSON.parse(readFileSync(path.join(ud, 'workspace-state.json'), 'utf8'));
      const tabs = [];
      const walk = (n) => (n?.type === 'pane' ? tabs.push(...n.tabs) : n?.children?.forEach(walk));
      walk(s.workspaces[0]?.layout);
      return tabs;
    } catch {
      return [];
    }
  };
  const sessionId = 'c0ffee00-1234-4abc-9def-0123456789ab';
  const codexId = 'dec0de00-5678-4abc-9def-0123456789cd';
  let app = null;
  try {
    // Safety: the stand-ins must be what `claude` and `codex` resolve to in the app's environment.
    if (ps('(Get-Command claude).Source', env).toLowerCase() !== fakeClaude.toLowerCase() || ps('(Get-Command codex).Source', env).toLowerCase() !== fakeCodex.toLowerCase()) throw new Error('unsafe: claude/codex do not resolve to the stand-ins');
    let page;
    ({ app, page } = await launch(env, ud));
    await page.click('button:has-text("Open folder…")');
    await page.waitForSelector('[data-pane-id][data-status="running"]');
    const claudeTab = await selectedTab(page);
    await rename(page, claudeTab, 'Backend');
    const codexTab = await addTab(page, 'Control+Shift+D');
    await rename(page, codexTab, 'Refactor');
    await running(page, claudeTab);
    await running(page, codexTab);
    await sleep(2500);
    await typeIn(page, claudeTab, 'claude');
    const pid = await until(() => fakes(fakeClaude)[0], 'stand-in claude running');
    writeFileSync(path.join(agentHome, '.claude', 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: carRental, startedAt: Date.now(), version: '2.1.322', kind: 'interactive', entrypoint: 'cli', status: 'idle', name: 'Add weekend pricing', nameSource: 'derived' }));
    await until(() => savedTabs().find((t) => t.id === claudeTab)?.resume?.sessionId === sessionId, 'claude resume saved');
    await typeIn(page, codexTab, 'codex');
    await until(() => fakes(fakeCodex)[0], 'stand-in codex running');
    await sleep(1500);
    const d = new Date();
    const dir = path.join(agentHome, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    mkdirSync(dir, { recursive: true });
    const iso = d.toISOString();
    writeFileSync(path.join(dir, `rollout-${iso.slice(0, 19).replace(/:/g, '-')}-${codexId}.jsonl`), JSON.stringify({ timestamp: iso, type: 'session_meta', payload: { id: codexId, session_id: codexId, timestamp: iso, cwd: carRental, cli_version: '0.167.1', source: 'cli' } }) + '\n');
    await until(() => savedTabs().find((t) => t.id === codexTab)?.resume?.sessionId === codexId, 'codex resume saved');
    await quit(app);
    app = null;
    killFakes();

    ({ app, page } = await launch(env, ud));
    await page.waitForSelector('[data-testid="resume-all"]', { timeout: 15_000 });
    await page.waitForSelector(`.tabview[data-tab-id="${claudeTab}"] [data-testid="resume-agent"]`);
    await page.click(`[role="tab"][data-tab-id="${claudeTab}"]`);
    await sleep(800);
    if (fakes(fakeClaude).length || fakes(fakeCodex).length) throw new Error('an agent started without a click');
    await shot(page, 'resume');
  } finally {
    if (app) await quit(app).catch(() => undefined);
    killFakes();
    await sleep(1000);
  }
}

// ---------- phase 2: the main shots (no stand-ins on PATH) ----------
async function mainShots() {
  const ud = path.join(base, '_profile');
  mkdirSync(ud, { recursive: true });
  const env = { ...process.env, TW_E2E: '1', TW_E2E_PICK_FOLDER: [carRental, apiGateway, docsSite].join('|') };
  const { app, page } = await launch(env, ud);
  // Simulated screens live only in the terminal widget (the real console never saw them), so a
  // resize repaints them away; they are written again after every layout change.
  const screens = new Map();
  const setScreen = (tabId, data) => {
    screens.set(tabId, data);
    return feed(page, tabId, data);
  };
  const refeed = async () => {
    for (const [tabId, data] of screens) await feed(page, tabId, data);
    await sleep(300);
  };
  const showWorkspace = async (name) => {
    await page.click(`.ws-item__main:has-text("${name}")`);
    await until(async () => (await page.textContent('.titlebar__name')) === name, `${name} shown`);
  };
  try {
    // car-rental: Backend | API tests / Shell + Dev server
    await page.click('button:has-text("Open folder…")');
    await page.waitForSelector('[data-pane-id][data-status="running"]');
    const crBackend = await selectedTab(page);
    await rename(page, crBackend, 'Backend');
    const crCodex = await addTab(page, 'Control+Shift+D');
    await rename(page, crCodex, 'API tests');
    const crShell = await addTab(page, 'Control+Shift+S');
    await rename(page, crShell, 'Git');
    const crDev = await addTab(page, 'Control+Shift+T');
    await rename(page, crDev, 'Dev');
    for (const t of [crBackend, crDev, crCodex, crShell]) await running(page, t);

    // api-gateway: Auth (Claude) + Shell
    await page.keyboard.press('Control+Shift+O');
    await until(async () => (await page.textContent('.titlebar__name')) === 'api-gateway', 'api-gateway shown');
    const agAuth = await until(async () => (await visibleTabs(page))[0], 'api-gateway tab');
    await rename(page, agAuth, 'Auth');
    const agShell = await addTab(page, 'Control+Shift+T');
    await rename(page, agShell, 'Shell');
    for (const t of [agAuth, agShell]) await running(page, t);

    // docs-site: Docs (Codex)
    await page.keyboard.press('Control+Shift+O');
    await until(async () => (await page.textContent('.titlebar__name')) === 'docs-site', 'docs-site shown');
    const dsDocs = await until(async () => (await visibleTabs(page))[0], 'docs-site tab');
    await rename(page, dsDocs, 'Docs');
    await running(page, dsDocs);

    await showWorkspace('car-rental');
    await sleep(3000); // let every shell print its first prompt before anything is fed in

    // Real, harmless commands in the Shell pane.
    for (const cmd of ['git log --oneline -5', 'git status -sb', "Write-Host 'PASS pricing' -F Green"]) {
      await typeIn(page, crShell, cmd);
      await sleep(1200);
    }
    // Simulated screens (output only; nothing runs).
    await setScreen(
      crBackend,
      screen(
        ` ${C.org}✻ Claude Code${C.r}  ${C.gry}feature/weekend-pricing${C.r}`,
        '',
        ` ${C.gry}>${C.r} Add a weekend surcharge to the quote`,
        '   and cover it with a test',
        '',
        ` ${C.grn}●${C.r} Read(src/services/pricing.ts)`,
        `   ${C.gry}⎿  Read 33 lines${C.r}`,
        ` ${C.grn}●${C.r} Update(src/services/pricing.ts)`,
        `   ${C.gry}⎿  Added 12 lines, removed 2 lines${C.r}`,
        `   ${C.gry}25${C.r} ${C.red}- return RATE[cat] * days;${C.r}`,
        `   ${C.gry}25${C.r} ${C.grn}+ const extra = weekendSurcharge(${C.r}`,
        `   ${C.gry}  ${C.r} ${C.grn}+   start, days, RATE[cat]);${C.r}`,
        `   ${C.gry}26${C.r} ${C.grn}+ return RATE[cat] * days + extra;${C.r}`,
        '',
        ` ${C.yel}Do you want to make this edit?${C.r}`,
        ` ${C.cyn}❯ 1. Yes${C.r}`,
        '   2. Yes, allow all edits this session',
        '   3. No, and tell Claude what to do',
      ),
    );
    await setScreen(
      crDev,
      screen(
        `${C.gry}$ npm run dev${C.r}`,
        '',
        `${C.gry}> car-rental@0.4.0 dev${C.r}`,
        `${C.gry}> tsx watch src/index.ts${C.r}`,
        '',
        `${C.grn}Server listening on :3000${C.r}`,
        `${C.gry}12:04:11${C.r} GET  /vehicles   ${C.grn}200${C.r}  4 ms`,
        `${C.gry}12:04:13${C.r} POST /bookings   ${C.grn}201${C.r}  9 ms`,
        `${C.gry}12:04:13${C.r} POST /bookings   ${C.yel}409${C.r}  3 ms`,
        `${C.gry}12:04:19${C.r} GET  /bookings   ${C.grn}200${C.r}  2 ms`,
        `${C.gry}12:05:02${C.r} ${C.cyn}[tsx]${C.r} change in pricing.ts`,
        `${C.gry}12:05:02${C.r} ${C.cyn}[tsx]${C.r} restarting`,
        `${C.grn}Server listening on :3000${C.r}`,
      ),
    );
    await setScreen(
      crCodex,
      screen(
        ` ${C.b}>_ OpenAI Codex${C.r}`,
        '',
        ` ${C.gry}user${C.r}  Add tests for the booking routes`,
        '',
        ` ${C.dim}•${C.r} Explored`,
        `   ${C.gry}└ Read src/routes/bookings.ts${C.r}`,
        ` ${C.dim}•${C.r} Edited tests/bookings.test.ts ${C.grn}(+38${C.r} ${C.red}-0)${C.r}`,
        ` ${C.dim}•${C.r} Ran npm test -- bookings`,
        `   ${C.gry}└${C.r} ${C.grn}✓${C.r} creates a booking`,
        `     ${C.grn}✓${C.r} rejects overlapping dates`,
        `     ${C.grn}✓${C.r} returns 400 when end is before start`,
        '',
        ` ${C.cyn}◦ Working (38s • esc to interrupt)${C.r}`,
      ),
    );
    await setScreen(agAuth, screen(` ${C.org}✻ Claude Code${C.r}  ${C.gry}fix/token-refresh${C.r}`, '', ` ${C.grn}●${C.r} Update(AuthFilter.java)`, `   ${C.gry}⎿  Added 8 lines, removed 1 line${C.r}`));
    await setScreen(dsDocs, screen(` ${C.b}>_ OpenAI Codex${C.r}`, '', ` ${C.dim}•${C.r} Updated docs/guide/configuration.md`));

    // Agent states.
    await report(page, crBackend, 'state=working:app=claude-code', 'state=blocked:kind=permission:app=claude-code');
    await report(page, crCodex, 'state=working:app=codex');
    await report(page, agAuth, 'state=working:app=claude-code');
    await sleep(500);

    // --- hero ---
    await focusWindow(app, page);
    await page.click(`[role="tab"][data-tab-id="${crShell}"]`);
    await page.click(`[role="tab"][data-tab-id="${crBackend}"]`);
    await explorerRow(page, 'src').click();
    await explorerRow(page, 'services').click().catch(() => undefined);
    await explorerRow(page, 'routes').click().catch(() => undefined);
    await dismissToasts(page);
    const stand = async () => {
      await fakeAgent(page, crBackend, 'claude');
      await fakeAgent(page, crCodex, 'codex');
      await fakeAgent(page, agAuth, 'claude');
    };
    await stand();
    await refeed();
    await shot(page, 'hero');

    // --- agent inbox: needs permission, has a question, finished ---
    await report(page, agAuth, 'state=blocked:kind=question:app=claude-code');
    await report(page, dsDocs, 'state=working:app=codex', 'state=done:app=codex');
    await sleep(2500);
    await dismissToasts(page);
    await stand();
    await page.click('[data-testid="inbox-button"]');
    await until(async () => (await page.$$('[data-testid="inbox-menu"] [role="menuitem"]')).length === 3, 'three inbox rows');
    await shot(page, 'agent-inbox');
    await page.keyboard.press('Escape');

    // --- notification: a finished turn while another tab is shown ---
    await page.click(`[role="tab"][data-tab-id="${crDev}"]`);
    await sleep(600);
    await refeed();
    await report(page, agAuth, 'state=working:app=claude-code', 'state=done:app=claude-code');
    await until(() => page.$('.toast--agent'), 'in-app notice', 8000);
    await stand();
    await shot(page, 'notification');
    await dismissToasts(page);

    // --- command palette ---
    await page.click(`[role="tab"][data-tab-id="${crShell}"]`);
    await sleep(600);
    await page.keyboard.press('Control+Shift+P');
    await page.keyboard.type('agent');
    await page.waitForSelector('[role="option"]');
    await sleep(400);
    await shot(page, 'palette');
    await page.keyboard.press('Escape');

    // --- editor next to a terminal (api-gateway: compact folders, a modified file) ---
    await showWorkspace('api-gateway');
    await page.keyboard.press('Control+Shift+B'); // icon rail: more room for the editor
    await typeIn(page, agShell, 'git log --oneline -3');
    await sleep(1000);
    await typeIn(page, agShell, "Write-Host '[INFO] 14 tests, 0 failures' -Fo Green");
    await sleep(1000);
    await page.locator('.explorer__row', { hasText: 'gateway' }).first().click();
    await page.locator('.explorer__row', { hasText: 'AuthFilter.java' }).first().click();
    await page.waitForSelector('.cm-editor');
    await sleep(1200);
    await shot(page, 'editor');
    await page.keyboard.press('Control+Shift+B');

    // --- light theme (Settings -> Appearance), on the first workspace again ---
    await showWorkspace('car-rental');
    await page.keyboard.press('Control+,');
    await page.waitForSelector('[data-theme-id="light"]');
    await page.click('[data-theme-id="light"]');
    await sleep(600);
    await showWorkspace('car-rental');
    await page.waitForSelector('.settings-nav', { state: 'hidden' });
    // The Settings row stays under the workspaces until it is closed.
    await page.keyboard.press('Control+Shift+P');
    await page.keyboard.type('Close settings');
    await page.waitForSelector('[role="option"]');
    await page.keyboard.press('Enter');
    await sleep(500);
    await page.click(`[role="tab"][data-tab-id="${crBackend}"]`);
    await sleep(800);
    await refeed();
    await stand();
    await shot(page, 'light-theme');
  } finally {
    await quit(app).catch(() => undefined);
  }
}

try {
  createCarRental();
  createApiGateway();
  createDocsSite();
  if (!only.size || only.has('resume')) await resumeShot();
  if (!only.size || [...only].some((n) => n !== 'resume')) await mainShots();
  console.log(`Done: ${shots.length} screenshots in ${outDir}`);
} finally {
  await sleep(1000);
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  console.log(`Removed ${base}`);
}
