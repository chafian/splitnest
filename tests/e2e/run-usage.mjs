// Agent session usage, end to end (dev build with TW_E2E=1; temporary folders, profile and agent
// home only). No real agent runs: `claude.exe`, `codex.exe` and `gemini.exe` in a temporary folder
// at the front of PATH are copies of cmd.exe (they keep running, so process detection finds them),
// and their session files are written into a temporary home (TW_E2E_AGENT_HOME, dev only) in the
// formats measured with Claude Code 2.1.326 and Codex 0.166.0, and Gemini CLI's from its source.
// Usage: node tests/e2e/run-usage.mjs   (after `npm run package`, which builds .vite/build)
//        TW_USAGE_SHOTS=<folder> also saves screenshots.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const work = mkdtempSync(path.join(tmpdir(), 'tw-usage-'));
const proj = path.join(work, 'usage-ws');
const ud = path.join(work, 'ud');
const agentHome = path.join(work, 'agent-home');
const fakebin = path.join(work, 'fakebin');
for (const d of [proj, ud, fakebin, path.join(agentHome, '.claude', 'sessions')]) mkdirSync(d, { recursive: true });
writeFileSync(path.join(proj, 'README.md'), '# usage\n');
const sys32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const fakeClaude = path.join(fakebin, 'claude.exe');
const fakeCodex = path.join(fakebin, 'codex.exe');
const fakeGemini = path.join(fakebin, 'gemini.exe');
for (const f of [fakeClaude, fakeCodex, fakeGemini]) copyFileSync(path.join(sys32, 'cmd.exe'), f);
const shots = process.env.TW_USAGE_SHOTS;
const SECRET = 'PROMPT-TEXT-THAT-MUST-NOT-LEAVE-THE-FILE';

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
const until = async (fn, what, timeout = 45_000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};
const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', env }).trim();
const fakes = (exe) => {
  const out = ps(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${exe}' } | ForEach-Object { '{0}|{1}' -f $_.ProcessId, $_.CommandLine }`);
  return out ? out.split(/\r?\n/).map((l) => ({ pid: Number(l.split('|')[0]), cmd: l.slice(l.indexOf('|') + 1) })) : [];
};
const killFakes = () => {
  for (const exe of [fakeClaude, fakeCodex, fakeGemini]) for (const f of fakes(exe)) ps(`Stop-Process -Id ${f.pid} -Force -ErrorAction SilentlyContinue`);
};

// ---- the agents' files
const iso = () => new Date().toISOString();
const claudeLive = (pid, sessionId) => writeFileSync(path.join(agentHome, '.claude', 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: proj, startedAt: Date.now(), version: '2.1.326', kind: 'interactive', entrypoint: 'cli', status: 'idle' }));
const claudeFile = (id) => path.join(agentHome, '.claude', 'projects', proj.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
const claudeReply = (msgId, usage) => {
  // One line per content block, every one with the reply's usage (as Claude Code writes it).
  const line = (block) => JSON.stringify({ parentUuid: randomUUID(), isSidechain: false, type: 'assistant', message: { id: msgId, model: 'claude-opus-5-5', role: 'assistant', type: 'message', content: [block], usage }, timestamp: iso(), sessionId: 'x', cwd: proj });
  return [line({ type: 'thinking', thinking: '' }), line({ type: 'text', text: SECRET }), line({ type: 'tool_use', id: 't', name: 'Bash', input: { command: SECRET } })].join('\n') + '\n';
};
const claudeUsage = (input, cacheRead, output) => ({ input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, output_tokens: output, server_tool_use: { web_search_requests: 0 } });
const codexRollout = (id) => {
  const d = new Date();
  const dir = path.join(agentHome, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  mkdirSync(dir, { recursive: true });
  const usage = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
  const lines = [
    { timestamp: iso(), type: 'session_meta', payload: { id, session_id: id, timestamp: iso(), cwd: proj, cli_version: '0.166.0', source: 'cli', base_instructions: { text: SECRET } } },
    { timestamp: iso(), type: 'turn_context', payload: { model: 'gpt-6.1-sol', cwd: proj } },
    { timestamp: iso(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: SECRET }] } },
    { timestamp: iso(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(50_000, 40_000, 1000), last_token_usage: usage(50_000, 40_000, 1000), model_context_window: 258_400 }, rate_limits: { credits: { balance: '99.99' } } } },
    { timestamp: iso(), type: 'event_msg', payload: { type: 'task_complete', duration_ms: 65_000 } },
  ];
  writeFileSync(path.join(dir, `rollout-${iso().slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
};
const geminiSession = (id) => {
  const dir = path.join(agentHome, '.gemini', 'tmp', 'usage-ws', 'chats');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(agentHome, '.gemini', 'projects.json'), JSON.stringify({ projects: { [proj.toLowerCase()]: 'usage-ws' } }));
  const lines = [
    { sessionId: id, projectHash: 'f'.repeat(64), startTime: iso(), lastUpdated: iso(), kind: 'main' },
    { id: randomUUID(), timestamp: iso(), type: 'user', content: [{ text: SECRET }] },
    { id: 'g1', timestamp: iso(), type: 'gemini', content: [{ text: SECRET }], thoughts: [], tokens: { input: 20_000, output: 500, cached: 0, thoughts: 500, tool: 0, total: 21_000 }, model: 'gemini-3.1-pro-preview' },
  ];
  writeFileSync(path.join(dir, `session-${iso().slice(0, 16).replace(/:/g, '-')}-${id.slice(0, 8)}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
};

const typeIn = async (page, tabId, text) => {
  await page.click(`[role="tab"][data-tab-id="${tabId}"]`);
  await page.click(`.tabview[data-tab-id="${tabId}"] .pane__terminal`, { position: { x: 40, y: 20 } });
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};
const chipText = async (page) => (await page.$('[data-testid="usage-chip"]')) && (await page.textContent('[data-testid="usage-chip"]'))?.trim();
const launch = () => electron.launch({ executablePath: require('electron'), args: ['.', `--tw-user-data=${ud}`], cwd: root, env });
const quit = async (app) => {
  await app.evaluate(() => {
    globalThis.__twQuitAsk = async () => 'discard';
  });
  await app.close();
};
const setSetting = async (page, label, on) => {
  await page.keyboard.press('Control+Comma');
  await page.click('.settings-nav__item:has-text("Workspaces")');
  await page.waitForSelector(`input[role="switch"][aria-label="${label}"]`, { state: 'attached' });
  const box = page.locator(`input[role="switch"][aria-label="${label}"]`);
  if ((await box.isChecked()) !== on) await box.click({ force: true });
  await until(async () => (await box.isChecked()) === on, `${label} ${on}`, 5000);
  await new Promise((r) => setTimeout(r, 600)); // saved, so main has it too
  await page.click('.ws-item__main'); // back to the workspace
  await page.waitForSelector('.settings-nav', { state: 'hidden' });
};

const A = randomUUID();
const C = randomUUID();
const G = randomUUID();
let app = null;
try {
  await step('safety: in the app\'s environment, claude, codex and gemini resolve to the stand-ins', async () => {
    const c = ps('(Get-Command claude).Source');
    const x = ps('(Get-Command codex).Source');
    const g = ps('(Get-Command gemini).Source');
    if (c.toLowerCase() !== fakeClaude.toLowerCase() || x.toLowerCase() !== fakeCodex.toLowerCase() || g.toLowerCase() !== fakeGemini.toLowerCase()) throw new Error(`claude -> ${c}, codex -> ${x}, gemini -> ${g}`);
  });
  if (!results.every((r) => r.ok)) throw new Error('unsafe: stopping before anything runs');

  app = await launch();
  const page = await app.firstWindow();
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
  await new Promise((r) => setTimeout(r, 2500));

  let claudePid = 0;
  await step('Claude Code: context, tokens and cost appear in the pane header, each reply counted once', async () => {
    await typeIn(page, claudeTab, 'claude');
    claudePid = (await until(() => fakes(fakeClaude)[0], 'stand-in claude running')).pid;
    claudeLive(claudePid, A);
    mkdirSync(path.dirname(claudeFile(A)), { recursive: true });
    // 1,000 input + 99,000 cache reads + 2,000 output on Opus 5.5: $0.0638; context 102K of 1M.
    writeFileSync(claudeFile(A), JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: iso() }) + '\n' + claudeReply('msg_1', claudeUsage(1000, 99_000, 2000)));
    const text = await until(async () => {
      const t = await chipText(page);
      return t === 'ctx 10% · 102K tokens · $0.06' && t;
    }, 'usage chip ctx 10% · 102K tokens · $0.06');
    return { chip: text };
  });

  await step('a new reply updates it (only appended lines are read)', async () => {
    // + 200,000 cache reads and 10,000 output: $0.24 more; context 210K.
    appendFileSync(claudeFile(A), claudeReply('msg_2', claudeUsage(0, 200_000, 10_000)));
    await until(async () => (await chipText(page)) === 'ctx 21% · 312K tokens · $0.30', 'usage chip 21%');
  });

  await step('details: per-model tokens, API-equivalent cost and what it is', async () => {
    await page.click('[data-testid="usage-chip"]');
    const panel = await page.waitForSelector('[data-testid="usage-panel"]');
    const text = await panel.textContent();
    for (const want of ['Claude Code session', 'running', 'claude-opus-5-5', '299K', 'API-equivalent cost', '≈ $0.30', 'not what a subscription', 'nothing is sent anywhere']) if (!text.includes(want)) throw new Error(`missing "${want}" in ${text}`);
    if (shots) await page.screenshot({ path: path.join(shots, 'usage-panel.png') });
    await page.keyboard.press('Escape');
    await until(async () => !(await page.$('[data-testid="usage-panel"]')), 'panel closed', 5000);
  });

  await step('tab tooltip and sidebar tooltip carry the summary', async () => {
    const tip = await page.getAttribute(`[role="tab"][data-tab-id="${claudeTab}"]`, 'title');
    if (!tip.includes('Usage: ctx 21% · 312K tokens · ≈ $0.30')) throw new Error(tip);
    const ws = await page.getAttribute('.ws-item__main', 'title');
    if (!ws.includes('1 agent session: 312K tokens, ≈ $0.30 API-equivalent')) throw new Error(ws);
  });

  await step('Codex: from its running totals, with the context window it records', async () => {
    await typeIn(page, codexTab, 'codex');
    await until(() => fakes(fakeCodex)[0], 'stand-in codex running');
    await new Promise((r) => setTimeout(r, 1500));
    codexRollout(C);
    // 10,000 input + 40,000 cached + 1,000 output on gpt-6.1-sol: $0.034; context 51K of 258.4K.
    await until(async () => (await chipText(page)) === 'ctx 20% · 51K tokens · $0.03', 'codex chip 20%');
    const tip = await page.getAttribute(`[role="tab"][data-tab-id="${codexTab}"]`, 'title');
    if (!tip.includes('Usage: ctx 20% · 51K tokens · 1m · ≈ $0.03')) throw new Error(tip);
  });

  await step('Gemini CLI: from its replies’ token counts', async () => {
    await typeIn(page, geminiTab, 'gemini');
    await until(() => fakes(fakeGemini)[0], 'stand-in gemini running');
    await new Promise((r) => setTimeout(r, 1500));
    geminiSession(G);
    // 20,000 input + 1,000 output (thinking included) on gemini-3.1-pro-preview: $0.052; 21K of 1,048,576.
    await until(async () => (await chipText(page)) === 'ctx 2% · 21K tokens · $0.05', 'gemini chip 2%');
    if (shots) await page.screenshot({ path: path.join(shots, 'usage-chip.png') });
    const ws = await page.getAttribute('.ws-item__main', 'title');
    if (!ws.includes('3 agent sessions: 384K tokens, ≈ $0.39 API-equivalent')) throw new Error(ws);
  });

  await step('Settings: cost off hides the dollars; usage off hides the readout', async () => {
    await setSetting(page, 'Show API-equivalent cost', false);
    await until(async () => (await chipText(page)) === 'ctx 2% · 21K tokens', 'chip without cost', 10_000);
    await setSetting(page, 'Show agent session usage', false);
    await until(async () => !(await page.$('[data-testid="usage-chip"]')), 'chip hidden', 10_000);
    await setSetting(page, 'Show agent session usage', true);
    await setSetting(page, 'Show API-equivalent cost', true);
    await until(async () => (await chipText(page)) === 'ctx 2% · 21K tokens · $0.05', 'chip back', 45_000);
  });

  await step('the agent exiting keeps its last numbers, marked as ended', async () => {
    await page.click(`[role="tab"][data-tab-id="${claudeTab}"]`);
    await until(async () => (await chipText(page)) === 'ctx 21% · 312K tokens · $0.30', 'claude chip', 45_000);
    ps(`Stop-Process -Id ${claudePid} -Force`);
    await until(() => page.$('[data-testid="usage-chip"].usage-chip--ended'), 'chip marked ended');
    if ((await chipText(page)) !== 'ctx 21% · 312K tokens · $0.30') throw new Error(await chipText(page));
  });

  await step('privacy: the conversation’s text is in no page, state file or log', async () => {
    const html = await page.content();
    if (html.includes(SECRET)) throw new Error('secret text in the page');
    const files = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(json|log|txt)$/i.test(e.name)) files.push(p);
      }
    };
    walk(ud);
    for (const f of files) if (readFileSync(f, 'utf8').includes(SECRET)) throw new Error(`secret text in ${path.relative(ud, f)}`);
    return { filesChecked: files.length };
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
