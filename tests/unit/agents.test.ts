import { describe, expect, it } from 'vitest';
import { detectAgent, type ProcessInfo } from '../../src/shared/agents';
import { AgentMonitor, parseSnapshot } from '../../src/main/agent-monitor';
import {
  agentFromTitle,
  agentStateText,
  deriveAgentView,
  parseProgramStatus,
  PROGRAM_STATUS_REPLY,
  StatusRecords,
  stripTitleStatus,
  titleLooksLikeShell,
  type StatusCommand,
} from '../../src/renderer/features/terminal/agent-status';
import { tabLabel } from '../../src/renderer/features/terminal/tab-label';
import { agentSummaryText } from '../../src/renderer/features/workspaces/Sidebar';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const report = (body: string) => {
  const c = parseProgramStatus(body);
  if (!c || c.type !== 'report') throw new Error(`not a report: ${body}`);
  return c;
};

describe('Program Status Protocol (OSC 7501)', () => {
  it('parses what Codex 0.166 actually sent (recorded in a real ConPTY session)', () => {
    expect(report('state=working:app=codex').record).toMatchObject({ id: '', state: 'working', app: 'codex' });
    expect(report('state=idle:app=codex').record.state).toBe('idle');
    expect(parseProgramStatus('state=clear')).toEqual({ type: 'clear', id: '' });
  });

  it("recognises Claude Code's feature query and answers with the spec's reply", () => {
    expect(parseProgramStatus('?')).toEqual({ type: 'query' });
    expect(PROGRAM_STATUS_REPLY).toBe('\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\');
  });

  it('decodes base64 title/msg, kinds and progress; ignores unknown keys; last key wins', () => {
    const r = report(`state=blocked:kind=permission:app=claude-code:title=${b64('Fix login redirect')}:msg=${b64('Allow npm test?')}:foo=bar`).record;
    expect(r).toMatchObject({ state: 'blocked', kind: 'permission', title: 'Fix login redirect', msg: 'Allow npm test?' });
    expect(report('state=working:progress=40').record.progress).toBe(40);
    expect(report('state=working:progress=140').record.progress).toBeNull();
    expect(report('state=idle:kind=permission').record.kind).toBeNull(); // kind only with blocked
    expect(report('state=idle:state=working').record.state).toBe('working');
  });

  it('discards malformed or hostile reports whole', () => {
    expect(parseProgramStatus('state=sleeping')).toBeNull();
    expect(parseProgramStatus('app=codex')).toBeNull(); // no state
    expect(parseProgramStatus(`state=idle:title=${b64('evil\u001b[2Jtitle')}`)).toBeNull(); // control character
    expect(parseProgramStatus('state=idle:title=A')).toBeNull(); // invalid base64 (allowed characters, wrong length)
    // Characters outside the value alphabet make only that pair malformed: it is skipped, the report stays.
    expect(report('state=idle:title=%%%').record.title).toBeNull();
    expect(parseProgramStatus(`state=idle:title=${b64('x'.repeat(200))}`)).toBeNull(); // over the title cap
    expect(parseProgramStatus(`state=idle:app=${'a'.repeat(33)}`)).toBeNull();
    expect(parseProgramStatus(`state=idle:id=${Array(9).fill('a').join('/')}`)).toBeNull();
    expect(parseProgramStatus('x'.repeat(5000))).toBeNull();
    // Direction overrides and invisible formatting are neutralised rather than shown.
    expect(report(`state=idle:title=${b64('ab\u202Ecd')}`).record.title).toBe('abcd');
  });
});

describe('status records', () => {
  const apply = (r: StatusRecords, body: string) => r.apply(parseProgramStatus(body) as StatusCommand);

  it('each report replaces its record; the most urgent record wins; app is inherited', () => {
    const r = new StatusRecords();
    apply(r, 'state=working:app=claude-code');
    apply(r, 'state=blocked:id=tool/bash:kind=permission');
    expect(r.summary()).toMatchObject({ state: 'blocked', kind: 'permission', app: 'claude-code' });
    apply(r, 'state=working:id=tool/bash');
    expect(r.summary()).toMatchObject({ state: 'working' });
    apply(r, 'state=idle'); // root replaced completely: app is gone from it
    expect(r.summary()?.app).toBeNull();
  });

  it('clear removes a record and everything below it; no id clears all', () => {
    const r = new StatusRecords();
    apply(r, 'state=working:id=a');
    apply(r, 'state=working:id=a/b');
    apply(r, 'state=idle:id=c');
    apply(r, 'state=clear:id=a');
    expect(r.size).toBe(1);
    apply(r, 'state=clear');
    expect(r.size).toBe(0);
  });

  it('a new prompt / process exit drops working, blocked and idle, but keeps done and error until seen', () => {
    const r = new StatusRecords();
    apply(r, 'state=working:id=w');
    apply(r, 'state=blocked:id=b');
    apply(r, 'state=done:id=d');
    r.dropTransient();
    expect(r.summary()?.state).toBe('done');
    r.acknowledge();
    expect(r.summary()).toBeNull();
  });

  it('caps the number of records (least recently updated evicted)', () => {
    const r = new StatusRecords();
    for (let i = 0; i < 80; i++) apply(r, `state=idle:id=r${i}`);
    expect(r.size).toBe(64);
  });
});

describe('agent view', () => {
  const base = { summary: null, processAgent: null, processDetection: true, titleAgent: null, shellTitle: null, bellPending: false, recentOutput: false, reportedThisRun: false };
  const recordsOf = (...bodies: string[]) => {
    const r = new StatusRecords();
    for (const b of bodies) r.apply(parseProgramStatus(b) as StatusCommand);
    return r;
  };

  it('a bell is a notification on top of a reported state, never a replacement for it', () => {
    const idle = deriveAgentView({ ...base, summary: recordsOf('state=idle:app=claude-code').summary(), bellPending: true, reportedThisRun: true })!;
    expect(idle).toMatchObject({ state: 'idle', source: 'protocol', attention: true });
    const working = deriveAgentView({ ...base, summary: recordsOf('state=working:app=codex').summary(), bellPending: true, reportedThisRun: true })!;
    expect(working).toMatchObject({ state: 'working', attention: true });
  });

  it('looking at the tab clears the notification but not a pending permission request', () => {
    const r = recordsOf('state=working:app=claude-code', 'state=blocked:id=tool:kind=permission');
    expect(r.acknowledge()).toBe(false); // nothing finished to acknowledge
    const v = deriveAgentView({ ...base, summary: r.summary(), reportedThisRun: true })!;
    expect(v).toMatchObject({ state: 'needs-action', kind: 'permission', attention: false });
    expect(agentStateText(v)).toBe('Needs permission');
    // Only the agent ends it: it reports working again once the user answered.
    r.apply(parseProgramStatus('state=working:id=tool') as StatusCommand);
    expect(deriveAgentView({ ...base, summary: r.summary(), reportedThisRun: true })!.state).toBe('working');
  });

  it('a reporting agent whose "done" was seen is idle by its own report, not re-estimated from output', () => {
    const r = recordsOf('state=done:app=codex');
    r.acknowledge();
    expect(deriveAgentView({ ...base, summary: r.summary(), processAgent: 'codex', recentOutput: true, reportedThisRun: true })).toMatchObject({ state: 'idle', source: 'protocol' });
  });

  it('identity only from explicit evidence: output, bells and spinners alone show nothing', () => {
    expect(deriveAgentView({ ...base, recentOutput: true, bellPending: true, shellTitle: '⠴ npm run build' })).toBeNull();
    expect(agentFromTitle('me@host: ~/projects/claude code')).toBeNull(); // folder name in a bash title
    expect(agentFromTitle('Claude Code')).toBeNull(); // no status glyph: not Claude's own title
    expect(agentFromTitle('✳ Claude Code')).toBe('claude');
    expect(agentFromTitle('◐ Claude Code')).toBe('claude');
  });

  it('uses the agent-reported state when there is one', () => {
    const r = new StatusRecords();
    r.apply(parseProgramStatus('state=working:app=codex') as StatusCommand);
    expect(deriveAgentView({ ...base, summary: r.summary() })).toMatchObject({ id: 'codex', label: 'Codex', state: 'working', source: 'protocol' });
    r.apply(parseProgramStatus('state=blocked:kind=question:app=codex') as StatusCommand);
    const v = deriveAgentView({ ...base, summary: r.summary() })!;
    expect(v.state).toBe('needs-action');
    expect(agentStateText(v)).toBe('Has a question');
  });

  it('falls back to bell / title spinner / output activity when the agent does not report', () => {
    expect(deriveAgentView({ ...base, processAgent: 'aider' })).toMatchObject({ id: 'aider', state: 'idle', source: 'heuristic' });
    expect(deriveAgentView({ ...base, processAgent: 'aider', recentOutput: true })!.state).toBe('working');
    expect(deriveAgentView({ ...base, processAgent: 'codex', shellTitle: '⠴ alex' })!.state).toBe('working');
    expect(deriveAgentView({ ...base, processAgent: 'gemini', bellPending: true })!.state).toBe('needs-action');
    expect(deriveAgentView(base)).toBeNull(); // plain shell: nothing shown
  });

  it("uses Claude Code's terminal title as the session title, but not its generic name or the shell's path", () => {
    expect(deriveAgentView({ ...base, titleAgent: 'claude', shellTitle: '✳ Claude Code' })).toMatchObject({ id: 'claude', title: null }); // WSL: title only
    expect(deriveAgentView({ ...base, processAgent: 'claude', shellTitle: '✳ Fix login redirect' })!.title).toBe('Fix login redirect');
    expect(deriveAgentView({ ...base, processAgent: 'codex', shellTitle: 'alex' })!.title).toBeNull();
    expect(stripTitleStatus('◐ Claude Code')).toBe('Claude Code');
    expect(titleLooksLikeShell('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe(true);
  });

  it('tab label: your name > session title > agent > shell, without repeating', () => {
    const shell = { profileId: 'windows-powershell', shellLabel: 'Windows PowerShell' };
    expect(tabLabel({ ...shell, agentLabel: 'Claude Code' }).full).toBe('Claude Code · PowerShell');
    expect(tabLabel({ ...shell, agentLabel: 'Claude Code', agentTitle: 'Fix login redirect' }).full).toBe('Fix login redirect · Claude Code');
    expect(tabLabel({ ...shell, customName: 'Backend', agentLabel: 'Codex', agentTitle: 'x' }).full).toBe('Backend · Codex');
    expect(tabLabel(shell).full).toBe('PowerShell');
  });

  it('sidebar summary text', () => {
    expect(agentSummaryText({ needs: 1, working: 0 })).toBe('1 agent needs you');
    expect(agentSummaryText({ needs: 2, working: 1 })).toBe('2 agents need you · 1 working');
    expect(agentSummaryText({ needs: 0, working: 3 })).toBe('3 agents working');
    expect(agentSummaryText({ needs: 0, working: 0 })).toBe('');
    expect(agentSummaryText({ needs: 0, maybe: 1, working: 0 })).toBe('1 agent may need you'); // estimated
    expect(agentSummaryText({ needs: 1, maybe: 1, working: 2 })).toBe('1 agent needs you · 1 may · 2 working');
  });
});

describe('agent detection from processes', () => {
  // Shapes recorded from the real process tree under a PowerShell session.
  const shell = 100;
  const tree = (...procs: [number, number, string, string][]): ProcessInfo[] => procs.map(([pid, ppid, name, cmd]) => ({ pid, ppid, name, cmd }));

  it('finds Codex (node + native binary) and Claude Code (native exe) below the shell', () => {
    const codex = tree(
      [200, shell, 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\AppData\\Roaming\\npm/node_modules/@openai/codex/bin/codex.js'],
      [201, 200, 'codex.exe', 'C:\\...\\@openai\\codex-win32-x64\\vendor\\bin\\codex.exe'],
    );
    expect(detectAgent(codex, shell)).toBe('codex');
    expect(detectAgent(tree([300, shell, 'claude.exe', '"C:\\Users\\me\\.local\\bin\\claude.exe"']), shell)).toBe('claude');
    expect(detectAgent(tree([400, shell, 'node.exe', 'node C:\\npm\\node_modules\\@google\\gemini-cli\\dist\\index.js']), shell)).toBe('gemini');
  });

  it('ignores other processes and other shells', () => {
    expect(detectAgent(tree([500, shell, 'node.exe', 'node server.js'], [501, 999, 'claude.exe', 'claude.exe']), shell)).toBeNull();
    expect(detectAgent(tree([600, 600, 'claude.exe', '']), 600)).toBeNull(); // self-parented entries are skipped
  });

  it('parses the helper output and reports only changes, skipping WSL sessions', async () => {
    expect(parseSnapshot('10\t1\tclaude.exe\t"C:\\x\\claude.exe"\r\n<<junk>>\n')).toEqual([{ pid: 10, ppid: 1, name: 'claude.exe', cmd: '"C:\\x\\claude.exe"' }]);
    const reports: [string, string | null][] = [];
    let procs: ProcessInfo[] = tree([300, shell, 'claude.exe', 'claude.exe']);
    const monitor = new AgentMonitor({
      sessions: () => [
        { sessionId: 's1', ownerId: 1, pid: shell, wsl: false, cwd: 'C:\\p' },
        { sessionId: 'w1', ownerId: 1, pid: 777, wsl: true, cwd: 'C:\\p' },
      ],
      report: (_o, id, agent) => reports.push([id, agent]),
      powershellPath: 'unused',
      log: () => undefined,
      snapshot: async () => procs,
    });
    const tick = () => (monitor as unknown as { tick(): Promise<void> }).tick();
    await tick();
    await tick(); // unchanged: no second report
    procs = tree([310, shell, 'node.exe', 'node server.js']); // Claude exited; something else runs
    await tick();
    monitor.stop();
    expect(reports).toEqual([
      ['s1', 'claude'],
      ['s1', null],
    ]);
  });
});
