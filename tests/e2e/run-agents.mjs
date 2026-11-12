// Live check of AI agent detection with the real CLIs, if installed (Claude
// Code, Codex). No prompt is ever sent: each agent is started, observed and
// closed with Ctrl+C. States that need a prompt to occur (blocked, done,
// error) are exercised with real OSC 7501 sequences printed by PowerShell.
// Usage: node tests/e2e/run-agents.mjs   (after `npm run package`)
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const shots = path.join(root, 'test-results', 'screenshots');
mkdirSync(shots, { recursive: true });
const work = mkdtempSync(path.join(tmpdir(), 'tw-agents-'));
const proj = path.join(work, 'agent-playground');
mkdirSync(proj);
writeFileSync(path.join(proj, 'README.md'), '# playground\n');
const has = (cmd) => {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `if (Get-Command ${cmd} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`]);
    return true;
  } catch {
    return false;
  }
};
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

const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.', `--tw-user-data=${path.join(work, 'ud')}`],
  cwd: root,
  env: { ...process.env, TW_E2E: '1', TW_E2E_PICK_FOLDER: proj },
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 1360, height: 860 }).catch(() => undefined);
await page.click('button:has-text("Open folder…")');
await page.waitForSelector('[data-pane-id][data-status="running"]');
const activeTab = () => page.getAttribute('[role="tab"][aria-selected="true"]', 'data-tab-id');
const agentOf = (tabId) => page.evaluate((t) => window.__twTest.agent(t), tabId);
const waitAgent = (tabId, pred, what, timeout = 30_000) =>
  page
    .waitForFunction(([t, src]) => {
      const a = window.__twTest.agent(t);
      return a && src.every(([k, v]) => a[k] === v);
    }, [tabId, Object.entries(pred)], { timeout })
    .catch(async () => {
      throw new Error(`${what}: agent is ${JSON.stringify(await agentOf(tabId))}`);
    });
const type = async (text) => {
  await page.click('.tabview:not([hidden]) .pane__terminal', { position: { x: 40, y: 20 } });
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};
const quitAgent = async (tabId) => {
  await page.click('.tabview:not([hidden]) .pane__terminal', { position: { x: 40, y: 20 } });
  await page.keyboard.press('Control+C');
  await page.waitForTimeout(700);
  await page.keyboard.press('Control+C');
  await page.waitForFunction((t) => window.__twTest.agent(t) === null, tabId, { timeout: 30_000 }).catch(async () => {
    throw new Error(`agent still shown after exit: ${JSON.stringify(await agentOf(tabId))}`);
  });
};
const esc = (body) => `Write-Host -NoNewline ([char]27 + ']7501;${body}' + [char]27 + '\\')`;
const screen = (tabId) => page.evaluate((t) => window.__twTest.inspect(t, 400).text, tabId);

// This script is started from inside an agent session (Claude Code), so the app really inherits
// its markers: they must not reach SplitNest's shells. Only names are checked, never values.
await step('shells do not inherit the launching session markers (CLAUDE_CODE_CHILD_SESSION, tokens, ...)', async () => {
  const tab = await activeTab();
  const names = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_PID', 'AI_AGENT', 'TW_E2E'];
  const inherited = names.filter((n) => process.env[n] !== undefined);
  await type(`Write-Output ("LEAK" + "ED=" + ((@('${names.join("','")}') | Where-Object { Test-Path "env:$_" }) -join ','))`);
  await page.waitForFunction((t) => /LEAKED=.*$/m.test(window.__twTest.inspect(t, 50).text.split('\n').filter((l) => l.startsWith('LEAKED=')).join('\n')), tab);
  const line = (await screen(tab)).split('\n').find((l) => l.startsWith('LEAKED='));
  if (line !== 'LEAKED=') throw new Error(`visible in the shell: ${line}`);
  if (inherited.length === 0) return { note: 'launcher had none of these set, so this run proves nothing' };
  return { presentInLauncher: inherited, visibleInShell: [] };
});

await step('identity needs explicit evidence: stale "✳ Claude Code" title or a bell in a plain PowerShell tab show no agent', async () => {
  const tab = await activeTab();
  await type("$Host.UI.RawUI.WindowTitle = [char]0x2733 + ' Claude Code'");
  await page.waitForFunction((t) => (window.__twTest.title(t) ?? '').includes('Claude Code'), tab);
  await type('Write-Host -NoNewline ([char]7)');
  await page.waitForTimeout(4500); // > one process scan and the title debounce
  const a = await agentOf(tab);
  await type("$Host.UI.RawUI.WindowTitle = 'PowerShell'");
  if (a) throw new Error(`agent shown without one running: ${JSON.stringify(a)}`);
});

if (has('claude')) {
  await step('Claude Code: detected, logo shown, reports its state after SplitNest answers its query', async () => {
    const tab = await activeTab();
    await type('claude');
    await waitAgent(tab, { id: 'claude' }, 'Claude Code not detected');
    // A first-run question may be open (e.g. "Claude in Chrome extension detected"); Esc answers it
    // with its non-changing default ("keep browser tools off"). Nothing is sent to the model.
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(shots, '31-agent-claude-start.png') });
    const beforeEsc = await agentOf(tab);
    await page.keyboard.press('Escape');
    // Timeline: does detection hold, and what does Claude Code report once its `?` query is answered?
    const timeline = [];
    for (let i = 0; i < 24; i++) {
      const a = await agentOf(tab);
      timeline.push(`${(i * 0.5).toFixed(1)}s ${a ? `${a.id}/${a.state}/${a.source}` : 'none'}`);
      await page.waitForTimeout(500);
    }
    const log = await page.evaluate((t) => window.__twTest.statusLog(t), tab);
    const title = await page.evaluate((t) => window.__twTest.title(t), tab);
    const a = await agentOf(tab);
    const label = await page.textContent(`[data-tab-id="${tab}"][role="tab"] .tab__label`);
    await page.screenshot({ path: path.join(shots, '31-agent-claude.png') });
    const inheritedWarning = /inherited CLAUDE_CODE_CHILD_SESSION|Transcript saving is off/.test(await screen(tab));
    const info = { beforeEsc, agent: a, tabLabel: label, title, statusReports: log, timeline: timeline.filter((_, i) => i % 4 === 0), inheritedWarning };
    console.log('  claude diagnostics', JSON.stringify(info));
    if (!a || a.id !== 'claude') throw new Error(`detection lost: ${timeline.join(', ')}`);
    if (inheritedWarning) throw new Error('Claude Code still reports an inherited child-session marker');
    await quitAgent(tab);
    // Nothing of the run is left: identity, state and session title are gone with the agent.
    const after = await agentOf(tab);
    const afterLabel = await page.textContent(`[data-tab-id="${tab}"][role="tab"] .tab__label`);
    if (after || /Claude/.test(afterLabel)) throw new Error(`left over after exit: ${JSON.stringify(after)} "${afterLabel}"`);
    return { ...info, afterExitLabel: afterLabel };
  });
} else results.push({ name: 'Claude Code', skipped: 'not installed' });

if (has('codex')) {
  await step('Codex: detected, logo shown, state reported over OSC 7501', async () => {
    await page.keyboard.press('Control+Shift+T');
    await page.waitForFunction(() => document.querySelectorAll('[role="tab"]').length === 2);
    await page.waitForSelector('[role="tab"][aria-selected="true"]');
    const tab = await activeTab();
    await page.waitForFunction((t) => window.__twTest.status(t) === 'running', tab);
    await page.waitForTimeout(1200);
    await type('codex');
    // When a newer Codex exists it first asks "Update now / Skip / Skip until next version" and
    // reports nothing until answered. Esc skips for this start only: nothing is installed and
    // Codex's settings are not changed.
    const askedToUpdate = await page
      .waitForFunction((t) => /Update now/.test(window.__twTest.inspect(t, 60).text) || window.__twTest.agent(t)?.source === 'protocol', tab, { timeout: 20_000 })
      .then(() => page.evaluate((t) => /Update now/.test(window.__twTest.inspect(t, 60).text) && window.__twTest.agent(t)?.source !== 'protocol', tab))
      .catch(() => false);
    if (askedToUpdate) await page.keyboard.press('Escape');
    await waitAgent(tab, { id: 'codex', source: 'protocol' }, 'Codex not detected via OSC 7501');
    await waitAgent(tab, { id: 'codex', state: 'idle' }, 'Codex did not settle to idle');
    const a = await agentOf(tab);
    await page.screenshot({ path: path.join(shots, '32-agent-codex.png') });
    await quitAgent(tab);
    return { agent: a };
  });
} else results.push({ name: 'Codex', skipped: 'not installed' });

await step('needs you / working / done (real OSC 7501 sequences): tab badge, sidebar summary, window title', async () => {
  const tab = await activeTab();
  const t64 = Buffer.from('Fix login redirect').toString('base64');
  await type(esc(`state=working:app=claude-code:title=${t64}`));
  await waitAgent(tab, { state: 'working', title: 'Fix login redirect' }, 'working not shown');
  await type(esc(`state=blocked:kind=permission:app=claude-code:title=${t64}`));
  await waitAgent(tab, { state: 'needs-action', kind: 'permission' }, 'blocked not shown');
  // Switch to another tab so the waiting one is in the background.
  await page.keyboard.press('Control+Tab');
  await page.waitForFunction(() => /\(1\)/.test(document.title));
  const sidebar = await page.textContent('.ws-item--active .ws-item__agents');
  const pill = await page.textContent(`[data-tab-id="${tab}"][role="tab"] .tab__state`);
  const tip = await page.getAttribute(`[data-tab-id="${tab}"][role="tab"]`, 'title');
  if (pill !== 'Needs you') throw new Error(`pill: ${pill}`);
  if (!tip.includes('Needs permission') || !tip.includes('Session: Fix login redirect')) throw new Error(`tooltip: ${tip}`);
  if (!sidebar.includes('1 agent needs you')) throw new Error(`sidebar: ${sidebar}`);
  await page.screenshot({ path: path.join(shots, '33-agent-needs-you.png') });
  // Opening the tab acknowledges notifications, but the permission is still pending.
  await page.keyboard.press('Control+Tab');
  await page.waitForTimeout(600);
  const opened = await agentOf(tab);
  if (opened?.state !== 'needs-action' || opened.kind !== 'permission') throw new Error(`opening the tab changed the agent state: ${JSON.stringify(opened)}`);
  // A bell on top of a reported state is a notification only.
  await type('Write-Host -NoNewline ([char]7)');
  await waitAgent(tab, { state: 'needs-action', attention: true }, 'bell not recorded as a notification');
  // The agent resumes once answered: only its own report ends "needs you".
  await type(esc('state=working:app=claude-code'));
  await waitAgent(tab, { state: 'working', source: 'protocol' }, 'resume not shown');
  // A bell during a reported "working" does not turn it into "needs you".
  await type('Write-Host -NoNewline ([char]7)');
  await waitAgent(tab, { state: 'working', attention: true }, 'bell changed a reported working state');
  await type(esc('state=done:app=claude-code'));
  await waitAgent(tab, { state: 'done' }, 'done not shown');
  await type(esc('state=clear'));
  await page.waitForFunction((t) => window.__twTest.agent(t) === null, tab);
  // Nothing carries over to the next program in this terminal.
  await type('Write-Output next-program');
  await page.waitForTimeout(1500);
  const next = await agentOf(tab);
  const label = await page.textContent(`[data-tab-id="${tab}"][role="tab"] .tab__label`);
  if (next || /Fix login|Claude/.test(label)) throw new Error(`inherited by the next program: ${JSON.stringify(next)} "${label}"`);
  return { sidebar, pill, windowTitleHadCount: true, afterOpen: `${opened.state}/${opened.kind}`, labelAfterClear: label };
});

await step('estimated states look different: a bell under an agent that does not report', async () => {
  // A real but non-reporting "agent" is needed for a heuristic state; fake one with the E2E hook.
  const tab = await activeTab();
  const ok = await page.evaluate((t) => window.__twTest.fakeProcessAgent?.(t, 'aider') ?? false, tab);
  if (!ok) return { skipped: 'no fake-agent hook' };
  // The bell must arrive while the tab is in the background: a bell in the tab on screen counts as
  // seen at once. Typing a command and then switching raced with its output (failed 1 run in 4), so
  // switch first and write the bell into the tab's output directly. Main's real process scan can
  // replace the stand-in agent at any time, so it is set again right before the bell.
  await page.keyboard.press('Control+Tab');
  await page.waitForFunction((t) => document.querySelector(`[data-tab-id="${t}"][role="tab"]`)?.getAttribute('aria-selected') === 'false', tab);
  await page.evaluate((t) => window.__twTest.fakeProcessAgent(t, 'aider'), tab);
  await page.evaluate((t) => window.__twTest.feed(t, '\x07'), tab);
  await waitAgent(tab, { id: 'aider', state: 'needs-action', source: 'heuristic' }, 'estimated needs-you not shown');
  const cls = await page.getAttribute(`[data-tab-id="${tab}"][role="tab"] .tab__state`, 'class');
  const text = await page.textContent(`[data-tab-id="${tab}"][role="tab"] .tab__state`);
  const tip = await page.getAttribute(`[data-tab-id="${tab}"][role="tab"]`, 'title');
  const side = await page.textContent('.ws-item--active .ws-item__agents');
  if (side !== '1 agent may need you') throw new Error(`sidebar: ${side}`);
  await page.screenshot({ path: path.join(shots, '34-agent-estimated.png') });
  await page.keyboard.press('Control+Tab');
  await page.evaluate((t) => window.__twTest.fakeProcessAgent(t, null), tab);
  if (!cls.includes('tab__state--estimated') || text !== 'Needs you?' || !tip.includes('estimated from a terminal bell')) throw new Error(`not distinct: ${cls} "${text}"`);
  return { pill: text, tooltip: 'estimated from a terminal bell' };
});

await app.evaluate(() => {
  globalThis.__twQuitAsk = () => Promise.resolve('discard');
});
await app.close().catch(() => undefined);
console.log(JSON.stringify(results, null, 2));
// Cleanup, part by part, so one held folder doesn't keep everything else:
// - the profile can be held for a few seconds after the app closes (Electron's helper processes);
// - the workspace folder can stay held by the real Codex the Codex step starts there (its shared
//   background service, which belongs to the Codex app, keeps a handle on the folder its session
//   used). That isn't SplitNest's to close; its contents are removed and the empty folder is
//   reported.
const removeWithRetry = async (target, tries) => {
  for (let i = 0; i < tries; i++) {
    try {
      rmSync(target, { recursive: true, force: true });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
};
await removeWithRetry(path.join(work, 'ud'), 30);
for (const f of readdirSync(proj)) await removeWithRetry(path.join(proj, f), 4);
if (!(await removeWithRetry(work, 10))) {
  const left = readdirSync(work, { recursive: true });
  console.log(`note: ${work} is still held by another program (${left.length ? left.join(', ') : 'empty'}); the test profile was removed`);
}
process.exit(results.some((r) => r.ok === false) ? 1 : 0);
