// Agent session resume, end to end (dev build with TW_E2E=1; temporary folders, profile and
// agent home only). No real agent runs: `claude.exe`, `codex.exe` and `gemini.exe` in a temporary folder at the
// front of PATH are copies of cmd.exe (they keep running, so process detection finds them), and
// the agents' session records are written into a temporary home (TW_E2E_AGENT_HOME, dev only)
// in the formats measured with Claude Code 2.1.322 and Codex 0.166.0, and Gemini CLI's from its
// source. Before each Resume the script checks that `claude`/`codex`/`gemini` resolve to those
// copies, so a real agent can never start.
// Usage: node tests/e2e/run-resume.mjs   (after `npm run package`, which builds .vite/build)
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const work = mkdtempSync(path.join(tmpdir(), 'tw-resume-'));
const proj = path.join(work, 'resume-ws');
const ud = path.join(work, 'ud');
const agentHome = path.join(work, 'agent-home');
const fakebin = path.join(work, 'fakebin');
for (const d of [proj, ud, fakebin, path.join(agentHome, '.claude', 'sessions')]) mkdirSync(d, { recursive: true });
writeFileSync(path.join(proj, 'README.md'), '# resume\n');
const sys32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const fakeClaude = path.join(fakebin, 'claude.exe');
const fakeCodex = path.join(fakebin, 'codex.exe');
const fakeGemini = path.join(fakebin, 'gemini.exe');
copyFileSync(path.join(sys32, 'cmd.exe'), fakeClaude);
copyFileSync(path.join(sys32, 'cmd.exe'), fakeCodex);
copyFileSync(path.join(sys32, 'cmd.exe'), fakeGemini);

const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'Path';
const env = { ...process.env, TW_E2E: '1', TW_E2E_PICK_FOLDER: proj, TW_E2E_AGENT_HOME: agentHome };
for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k];
env[pathKey] = `${fakebin};${process.env[pathKey]}`;

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
const until = async (fn, what, timeout = 25_000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};
const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', env }).trim();
/** Our stand-in agent processes: pid and command line (only executables in our temp folder). */
const fakes = (exe) => {
  const out = ps(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${exe}' } | ForEach-Object { '{0}|{1}' -f $_.ProcessId, $_.CommandLine }`);
  return out ? out.split(/\r?\n/).map((l) => ({ pid: Number(l.split('|')[0]), cmd: l.slice(l.indexOf('|') + 1) })) : [];
};
const killFakes = () => {
  for (const exe of [fakeClaude, fakeCodex, fakeGemini]) for (const f of fakes(exe)) ps(`Stop-Process -Id ${f.pid} -Force -ErrorAction SilentlyContinue`);
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
const claudeLive = (pid, sessionId) => writeFileSync(path.join(agentHome, '.claude', 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: proj, startedAt: Date.now(), version: '2.1.322', kind: 'interactive', entrypoint: 'cli', status: 'idle', name: 'Fix login redirect', nameSource: 'derived' }));
const codexRollout = (id) => {
  const d = new Date();
  const dir = path.join(agentHome, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  mkdirSync(dir, { recursive: true });
  const iso = new Date().toISOString();
  writeFileSync(path.join(dir, `rollout-${iso.slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`), JSON.stringify({ timestamp: iso, type: 'session_meta', payload: { id, session_id: id, timestamp: iso, cwd: proj, cli_version: '0.167.1', source: 'cli' } }) + '\n');
};
// Gemini CLI: its project list maps the (lowercased) folder to a slug; the session file starts with its metadata.
const geminiSession = (id) => {
  const dir = path.join(agentHome, '.gemini', 'tmp', 'resume-ws', 'chats');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(agentHome, '.gemini', 'projects.json'), JSON.stringify({ projects: { [proj.toLowerCase()]: 'resume-ws' } }, null, 2));
  const iso = new Date().toISOString();
  writeFileSync(path.join(dir, `session-${iso.slice(0, 16).replace(/:/g, '-')}-${id.slice(0, 8)}.jsonl`), JSON.stringify({ sessionId: id, projectHash: 'f'.repeat(64), startTime: iso, lastUpdated: iso, kind: 'main' }) + '\n');
};
const typeIn = async (page, tabId, text) => {
  await page.click(`[role="tab"][data-tab-id="${tabId}"]`);
  await page.click(`.tabview[data-tab-id="${tabId}"] .pane__terminal`, { position: { x: 40, y: 20 } });
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};
const launch = () => electron.launch({ executablePath: require('electron'), args: ['.', `--tw-user-data=${ud}`], cwd: root, env });
const quit = async (app) => {
  await app.evaluate(() => {
    globalThis.__twQuitAsk = async () => 'discard';
  });
  await app.close();
};

const A = randomUUID();
const B = randomUUID();
const C = randomUUID();
const G = randomUUID();
let app = null;
try {
  await step('safety: in the app\'s environment, claude and codex resolve to the stand-ins', async () => {
    const c = ps('(Get-Command claude).Source');
    const x = ps('(Get-Command codex).Source');
    const g = ps('(Get-Command gemini).Source');
    if (c.toLowerCase() !== fakeClaude.toLowerCase() || x.toLowerCase() !== fakeCodex.toLowerCase() || g.toLowerCase() !== fakeGemini.toLowerCase()) throw new Error(`claude -> ${c}, codex -> ${x}, gemini -> ${g}`);
  });
  if (!results.every((r) => r.ok)) throw new Error('unsafe: stopping before anything runs');

  app = await launch();
  let page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
  await page.click('button:has-text("Open folder…")');
  await page.waitForSelector('[data-pane-id][data-status="running"]');
  const selectedTab = () => page.getAttribute('[role="tab"][aria-selected="true"]', 'data-tab-id');
  const claudeTab = await selectedTab();
  await page.keyboard.press('Control+Shift+T');
  await until(async () => (await selectedTab()) !== claudeTab, 'second tab');
  const codexTab = await selectedTab();
  await page.keyboard.press('Control+Shift+T');
  await until(async () => ![claudeTab, codexTab].includes(await selectedTab()), 'third tab');
  const geminiTab = await selectedTab();
  await new Promise((r) => setTimeout(r, 2500)); // their shells start

  let claudePid = 0;
  await step('Claude Code: the session of its process is saved with the tab', async () => {
    await typeIn(page, claudeTab, 'claude');
    claudePid = (await until(() => fakes(fakeClaude)[0], 'stand-in claude running')).pid;
    claudeLive(claudePid, A);
    await until(() => savedTabs().find((t) => t.id === claudeTab)?.resume?.sessionId === A, 'resume A saved');
    const r = savedTabs().find((t) => t.id === claudeTab).resume;
    if (r.agent !== 'claude' || !r.exact || r.cwd !== proj) throw new Error(JSON.stringify(r));
    return { exact: r.exact };
  });

  await step('Claude Code: /clear (a new session id) is followed', async () => {
    claudeLive(claudePid, B);
    await until(() => savedTabs().find((t) => t.id === claudeTab)?.resume?.sessionId === B, 'resume B saved');
  });

  await step('Codex: the one rollout started in its folder after it is saved with its tab', async () => {
    await typeIn(page, codexTab, 'codex');
    await until(() => fakes(fakeCodex)[0], 'stand-in codex running');
    await new Promise((r) => setTimeout(r, 1500));
    codexRollout(C);
    await until(() => savedTabs().find((t) => t.id === codexTab)?.resume?.sessionId === C, 'codex resume saved');
    const r = savedTabs().find((t) => t.id === codexTab).resume;
    return { exact: r.exact };
  });

  await step('Gemini CLI: the one session started in its project after it is saved with its tab', async () => {
    await typeIn(page, geminiTab, 'gemini');
    await until(() => fakes(fakeGemini)[0], 'stand-in gemini running');
    await new Promise((r) => setTimeout(r, 1500));
    geminiSession(G);
    await until(() => savedTabs().find((t) => t.id === geminiTab)?.resume?.sessionId === G, 'gemini resume saved');
    const r = savedTabs().find((t) => t.id === geminiTab).resume;
    if (r.agent !== 'gemini' || r.cwd.toLowerCase() !== proj.toLowerCase()) throw new Error(JSON.stringify(r));
    return { exact: r.exact, cwd: r.cwd === proj ? 'workspace spelling' : r.cwd };
  });

  await step('quitting SplitNest keeps all three conversations', async () => {
    await quit(app);
    app = null;
    killFakes();
    const tabs = savedTabs();
    const ok = tabs.find((t) => t.id === claudeTab)?.resume?.sessionId === B && tabs.find((t) => t.id === codexTab)?.resume?.sessionId === C && tabs.find((t) => t.id === geminiTab)?.resume?.sessionId === G;
    if (!ok) throw new Error(JSON.stringify(tabs));
  });

  app = await launch();
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
  await step('after a restart: "Resume agents (3)" and a Resume button saying what will run', async () => {
    const all = await page.waitForSelector('[data-testid="resume-all"]', { timeout: 15_000 });
    const label = (await all.textContent())?.trim();
    if (label !== 'Resume agents (3)') throw new Error(label);
    await page.click(`[role="tab"][data-tab-id="${claudeTab}"]`);
    const detail = await page.textContent(`.tabview[data-tab-id="${claudeTab}"] [data-testid="resume-detail"]`);
    if (!detail.includes(`claude --resume ${B}`) || !detail.includes(proj)) throw new Error(detail);
    // The conversation title (setting on by default).
    const title = await page.textContent(`.tabview[data-tab-id="${claudeTab}"] [data-testid="resume-title"]`);
    if (title !== '“Fix login redirect”') throw new Error(`title: ${title}`);
    // Nothing runs before a click.
    if (fakes(fakeClaude).length || fakes(fakeCodex).length || fakes(fakeGemini).length) throw new Error('an agent started without a click');
    await page.click(`[role="tab"][data-tab-id="${geminiTab}"]`);
    const gDetail = await page.textContent(`.tabview[data-tab-id="${geminiTab}"] [data-testid="resume-detail"]`);
    if (!gDetail.includes(`gemini --resume ${G}`)) throw new Error(gDetail);
    if (process.env.TW_RESUME_SHOTS) await page.screenshot({ path: path.join(process.env.TW_RESUME_SHOTS, 'resume-gemini.png') });
    await page.click(`[role="tab"][data-tab-id="${claudeTab}"]`);
    if (process.env.TW_RESUME_SHOTS) await page.screenshot({ path: path.join(process.env.TW_RESUME_SHOTS, 'resume-restored.png') });
  });

  await step('safety check again before Resume', async () => {
    if (ps('(Get-Command claude).Source').toLowerCase() !== fakeClaude.toLowerCase()) throw new Error('claude is not the stand-in');
  });

  await step('Resume Claude Code: a shell in the agent folder, `claude --resume <id>` typed, agent found', async () => {
    await page.click(`.tabview[data-tab-id="${claudeTab}"] [data-testid="resume-agent"]`);
    const f = await until(() => fakes(fakeClaude).find((p) => p.cmd.includes(`--resume ${B}`)), 'claude --resume B running');
    await until(() => page.evaluate((t) => document.querySelector(`[role="tab"][data-tab-id="${t}"]`)?.getAttribute('data-agent') === 'claude', claudeTab), 'agent detected on the tab');
    await new Promise((r) => setTimeout(r, 1000));
    if (await page.$(`.tabview[data-tab-id="${claudeTab}"] [data-testid="resume-not-started"]`)) throw new Error('"didn\'t start" shown');
    return { pid: f.pid };
  });

  await step('Resume agents: Codex gets `codex resume <id>`, Gemini CLI `gemini --resume <id>`', async () => {
    if (ps('(Get-Command codex).Source').toLowerCase() !== fakeCodex.toLowerCase()) throw new Error('codex is not the stand-in');
    if (ps('(Get-Command gemini).Source').toLowerCase() !== fakeGemini.toLowerCase()) throw new Error('gemini is not the stand-in');
    await page.click('[data-testid="resume-all"]');
    await until(() => fakes(fakeCodex).find((p) => p.cmd.includes(`resume ${C}`)), 'codex resume C running');
    await until(() => fakes(fakeGemini).find((p) => p.cmd.includes(`--resume ${G}`)), 'gemini --resume G running');
    // The command line names the session, so it is now exact.
    await until(() => savedTabs().find((t) => t.id === geminiTab)?.resume?.exact === true, 'gemini resume exact');
  });

  await step('the agent exiting on its own removes Resume from its tab', async () => {
    for (const f of fakes(fakeClaude)) ps(`Stop-Process -Id ${f.pid} -Force`);
    await until(() => savedTabs().find((t) => t.id === claudeTab) && !savedTabs().find((t) => t.id === claudeTab).resume, 'resume removed');
  });

  // "Didn't start": the stand-in claude now exits at once (a copy of whoami.exe).
  await step('an agent that does not start is reported, and the shell stays usable', async () => {
    // Give the Claude tab a conversation again, then quit and restart with a claude that exits at once.
    await typeIn(page, claudeTab, 'claude');
    const pid = (await until(() => fakes(fakeClaude)[0], 'stand-in claude running')).pid;
    claudeLive(pid, A);
    await until(() => savedTabs().find((t) => t.id === claudeTab)?.resume?.sessionId === A, 'resume A saved');
    await quit(app);
    app = null;
    killFakes();
    copyFileSync(path.join(sys32, 'whoami.exe'), fakeClaude);
    if (ps('(Get-Command claude).Source').toLowerCase() !== fakeClaude.toLowerCase()) throw new Error('claude is not the stand-in');
    app = await launch();
    page = await app.firstWindow();
    await page.click(`[role="tab"][data-tab-id="${claudeTab}"]`);
    await page.click(`.tabview[data-tab-id="${claudeTab}"] [data-testid="resume-agent"]`, { timeout: 15_000 });
    await page.waitForSelector(`.tabview[data-tab-id="${claudeTab}"] [data-testid="resume-not-started"]`, { timeout: 40_000 });
    if (process.env.TW_RESUME_SHOTS) await page.screenshot({ path: path.join(process.env.TW_RESUME_SHOTS, 'resume-not-started.png') });
    const status = await page.getAttribute(`[data-pane-id] [role="tab"][data-tab-id="${claudeTab}"]`, 'data-status').catch(() => null);
    return { tabStatus: status };
  });
} catch (e) {
  results.push({ name: 'script error', ok: false, error: String(e?.message ?? e) });
  console.log(`  ✗ script error: ${e?.message ?? e}`);
} finally {
  if (app) await quit(app).catch(() => undefined);
  killFakes();
  await new Promise((r) => setTimeout(r, 1000));
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `RESULT: ${failed} of ${results.length} steps FAILED` : `RESULT: all ${results.length} steps passed`);
process.exit(failed ? 1 : 0);
