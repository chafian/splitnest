// Which conversation a terminal's agent runs (src/main/agent-sessions.ts). File shapes are the
// ones measured with Claude Code 2.1.322 and Codex 0.166.0 (docs/TESTING.md, "Agent session
// resume, phase 1"), with made-up ids and folders.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgentSessionTracker,
  geminiLegacyProjectDir,
  parseClaudeLiveFile,
  parseCodexRolloutHead,
  parseGeminiProjects,
  parseGeminiSessionHead,
  pickCodexRollout,
  resumeIdFromCommandLine,
  withinFolder,
} from '../../src/main/agent-sessions';
import { parseAgentResume } from '../../src/shared/agent-resume';
import type { ProcessInfo } from '../../src/shared/agents';

const HOME = 'C:\\Users\\me';
const A = 'ff7e99ad-614e-4263-8b68-9515e5f3d720';
const B = '3bcabe53-da40-4f9d-bb1d-f9a826fb665d';
const C = '01a1ccab-539b-7460-bcdb-517944122f4d';
const D = '01a1ccab-ec96-7240-a3bb-21a96c19d946';
const PROJECT = 'C:\\work\\car-rental';

const claudeLive = (pid: number, sessionId: string, cwd = PROJECT) =>
  JSON.stringify({ pid, sessionId, cwd, startedAt: 1, version: '2.1.322', kind: 'interactive', entrypoint: 'cli', status: 'idle', name: 'a title made from the prompt', nameSource: 'derived' });
const codexHead = (id: string, cwd: string, iso: string) =>
  JSON.stringify({ timestamp: iso, ordinal: 0, type: 'session_meta', payload: { session_id: id, id, timestamp: iso, cwd, originator: 'codex_cli', cli_version: '0.167.1', source: 'vscode', base_instructions: { text: 'instructions' } } }) +
  '\n{"type":"response_item","payload":{"content":"SECRET CONVERSATION TEXT"}}\n';

function fakeFs(files: Record<string, { text: string; mtime?: number }>) {
  const reads: string[] = [];
  return {
    reads,
    files,
    deps: (now: () => number) => ({
      home: HOME,
      now,
      readText: async (file: string, max: number) => {
        reads.push(file);
        const f = files[file];
        return f ? f.text.slice(0, max) : null;
      },
      list: async (dir: string) =>
        Object.keys(files)
          .filter((f) => path.win32.dirname(f) === dir)
          .map((f) => path.win32.basename(f)),
      mtimeMs: async (file: string) => files[file]?.mtime ?? null,
    }),
  };
}

const proc = (pid: number, name: string, cmd = name): ProcessInfo => ({ pid, ppid: 1, name, cmd });
// Gemini CLI: the shapes in its source (ChatRecordingService, ProjectRegistry), made-up values.
const geminiHead = (sessionId: string, iso: string, kind = 'main') =>
  JSON.stringify({ sessionId, projectHash: 'f'.repeat(64), startTime: iso, lastUpdated: iso, kind }) +
  '\n{"id":"m1","type":"user","content":[{"text":"SECRET CONVERSATION TEXT"}]}\n';
const geminiProjects = (map: Record<string, string>) => JSON.stringify({ projects: map }, null, 2);
const liveFile = (pid: number) => path.join(HOME, '.claude', 'sessions', `${pid}.json`);

describe('agent session capture: parsing', () => {
  it("reads Claude Code's live file only for the agent's own pid, and only an interactive session with a UUID and an absolute folder", () => {
    expect(parseClaudeLiveFile(claudeLive(5788, A), 5788)).toEqual({ sessionId: A, cwd: PROJECT, title: 'a title made from the prompt' });
    expect(parseClaudeLiveFile(claudeLive(5788, A), 9999)).toBeNull();
    expect(parseClaudeLiveFile(claudeLive(5788, 'not-a-uuid; rm -rf /'), 5788)).toBeNull();
    expect(parseClaudeLiveFile(claudeLive(5788, A, 'relative\\path'), 5788)).toBeNull();
    expect(parseClaudeLiveFile(JSON.stringify({ ...JSON.parse(claudeLive(5788, A)), kind: 'print' }), 5788)).toBeNull();
    expect(parseClaudeLiveFile('{broken', 5788)).toBeNull();
  });

  it("reads a Codex rollout's first line (session_meta) and nothing else", () => {
    const head = codexHead(C, PROJECT, '2026-11-11T22:12:22.657Z').split('\n')[0]!;
    expect(parseCodexRolloutHead(head)).toEqual({ id: C, cwd: PROJECT, startedAt: Date.parse('2026-11-11T22:12:22.657Z') });
    expect(parseCodexRolloutHead('{"type":"response_item","payload":{}}')).toBeNull();
    expect(parseCodexRolloutHead(head.replaceAll(C, '../../etc'))).toBeNull();
  });

  it('takes a session id from the agent command line only in the exact resume forms', () => {
    expect(resumeIdFromCommandLine('claude', `"C:\\bin\\claude.exe" --resume ${A} "next question"`)).toBe(A);
    expect(resumeIdFromCommandLine('claude', `claude -r ${A}`)).toBe(A);
    expect(resumeIdFromCommandLine('claude', `claude --resume=${A}`)).toBe(A);
    expect(resumeIdFromCommandLine('claude', `claude --resume`)).toBeNull(); // the picker
    expect(resumeIdFromCommandLine('claude', `claude "please resume ${A}"`)).toBeNull();
    expect(resumeIdFromCommandLine('codex', `node C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js resume ${C} "hi"`)).toBe(C);
    expect(resumeIdFromCommandLine('codex', `codex resume --last`)).toBeNull();
    expect(resumeIdFromCommandLine('codex', `codex "resume ${C}"`)).toBeNull();
  });

  it('matches folders case-insensitively and never a sibling with a common prefix', () => {
    expect(withinFolder('c:\\WORK\\car-rental\\api', PROJECT)).toBe(true);
    expect(withinFolder(PROJECT, PROJECT)).toBe(true);
    expect(withinFolder('C:\\work\\car-rental-old', PROJECT)).toBe(false);
    expect(withinFolder('D:\\work\\car-rental', PROJECT)).toBe(false);
  });

  it('picks a Codex rollout only when exactly one fits: after the agent started, in its folder, not taken by another tab', () => {
    const t = 1_000_000;
    const c1 = { id: C, cwd: PROJECT, startedAt: t + 5000 };
    const c2 = { id: D, cwd: PROJECT, startedAt: t + 8000 };
    const old = { id: A, cwd: PROJECT, startedAt: t - 60_000 };
    const elsewhere = { id: B, cwd: 'C:\\other', startedAt: t + 5000 };
    expect(pickCodexRollout([c1, old, elsewhere], t, PROJECT, new Set())).toEqual({ id: C, cwd: PROJECT });
    expect(pickCodexRollout([c1, c2], t, PROJECT, new Set())).toBeNull(); // two agents in one folder: don't guess
    expect(pickCodexRollout([c1, c2], t, PROJECT, new Set([D]))).toEqual({ id: C, cwd: PROJECT });
    expect(pickCodexRollout([old, elsewhere], t, PROJECT, new Set())).toBeNull();
  });

  it('validates a saved resume record', () => {
    const ok = { agent: 'claude', sessionId: A, cwd: PROJECT, exact: true, at: 5 };
    expect(parseAgentResume(ok)).toEqual(ok);
    expect(parseAgentResume({ ...ok, sessionId: null })).toEqual({ ...ok, sessionId: null, exact: false });
    expect(parseAgentResume({ ...ok, agent: 'aider' })).toBeNull();
    expect(parseAgentResume({ ...ok, sessionId: '$(calc)' })).toBeNull();
    expect(parseAgentResume({ ...ok, cwd: 'relative' })).toBeNull();
    expect(parseAgentResume({ ...ok, cwd: 'C:\\x\nexit' })).toBeNull();
  });
});

describe('agent session capture: Gemini CLI parsing', () => {
  it("reads Gemini CLI's project list, keeping only absolute folders and plain slugs", () => {
    expect(parseGeminiProjects(geminiProjects({ 'c:\\work\\car-rental': 'car-rental', relative: 'x', 'c:\\evil': '../..' }))).toEqual([{ folder: 'c:\\work\\car-rental', slug: 'car-rental' }]);
    expect(parseGeminiProjects('{broken')).toEqual([]);
    expect(parseGeminiProjects('{"projects": 5}')).toEqual([]);
  });

  it("reads a Gemini session file's first line: a UUID and a start time, never a subagent's", () => {
    const iso = '2026-11-13T10:00:05.000Z';
    expect(parseGeminiSessionHead(geminiHead(A, iso).split('\n')[0]!)).toEqual({ id: A, startedAt: Date.parse(iso) });
    expect(parseGeminiSessionHead(geminiHead(A, iso, 'subagent').split('\n')[0]!)).toBeNull();
    expect(parseGeminiSessionHead(geminiHead('abc; calc', iso).split('\n')[0]!)).toBeNull();
    expect(parseGeminiSessionHead(JSON.stringify({ sessionId: A }))).toBeNull();
  });

  it('older versions: the project folder is the SHA-256 of its path', () => {
    expect(geminiLegacyProjectDir(PROJECT)).toMatch(/^[0-9a-f]{64}$/);
    expect(geminiLegacyProjectDir(PROJECT)).not.toBe(geminiLegacyProjectDir(`${PROJECT}2`));
  });

  it('takes the id from `gemini --resume <id>`, `-r <id>` and `--resume=<id>` only', () => {
    expect(resumeIdFromCommandLine('gemini', `node C:\\npm\\node_modules\\@google\\gemini-cli\\dist\\index.js --resume ${A}`)).toBe(A);
    expect(resumeIdFromCommandLine('gemini', `gemini -r ${A}`)).toBe(A);
    expect(resumeIdFromCommandLine('gemini', `gemini --resume=${A}`)).toBe(A);
    expect(resumeIdFromCommandLine('gemini', 'gemini --resume 2')).toBeNull();
    expect(resumeIdFromCommandLine('gemini', 'gemini --resume')).toBeNull();
  });
});

describe('agent session capture: tracking a tab', () => {
  it('Claude Code: the exact session of its process, following /clear, and nothing once it exits', async () => {
    let now = 1000;
    const fs = fakeFs({ [liveFile(5788)]: { text: claudeLive(5788, A) } });
    const tracker = new AgentSessionTracker(fs.deps(() => now));
    const claude = { id: 'claude', process: proc(5788, 'claude.exe') };
    expect(await tracker.update('s1', PROJECT, claude)).toEqual({ agent: 'claude', sessionId: A, cwd: PROJECT, exact: true, at: 1000, title: 'a title made from the prompt' });
    now = 2000;
    expect(await tracker.update('s1', PROJECT, claude)).toBeUndefined(); // unchanged
    fs.files[liveFile(5788)] = { text: claudeLive(5788, B) }; // /clear
    expect(await tracker.update('s1', PROJECT, claude)).toMatchObject({ sessionId: B, exact: true });
    delete fs.files[liveFile(5788)]; // briefly missing while Claude rewrites it: keep the id
    expect(await tracker.update('s1', PROJECT, claude)).toBeUndefined();
    expect(await tracker.update('s1', PROJECT, null)).toBeNull(); // exited
    expect(await tracker.update('s1', PROJECT, null)).toBeUndefined();
    expect(fs.reads.every((f) => f === liveFile(5788))).toBe(true);
  });

  it('Claude Code: two tabs in the same folder each get their own session', async () => {
    const fs = fakeFs({ [liveFile(10)]: { text: claudeLive(10, A) }, [liveFile(20)]: { text: claudeLive(20, B) } });
    const tracker = new AgentSessionTracker(fs.deps(() => 1));
    expect(await tracker.update('s1', PROJECT, { id: 'claude', process: proc(10, 'claude.exe') })).toMatchObject({ sessionId: A });
    expect(await tracker.update('s2', PROJECT, { id: 'claude', process: proc(20, 'claude.exe') })).toMatchObject({ sessionId: B });
  });

  it('Codex: the id from `codex resume <id>`, else the one rollout that fits, else none (the picker)', async () => {
    const started = Date.parse('2026-11-11T22:12:10.000Z');
    let now = started;
    const day = path.join(HOME, '.codex', 'sessions', ...(() => {
      const d = new Date(started);
      return [String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')];
    })());
    const fs = fakeFs({});
    const tracker = new AgentSessionTracker(fs.deps(() => now));
    const codex = (pid: number, cmd = 'codex.exe') => ({ id: 'codex', process: proc(pid, 'codex.exe', cmd) });

    // Not sent anything yet: no rollout, so no id.
    expect(await tracker.update('s1', PROJECT, codex(38))).toEqual({ agent: 'codex', sessionId: null, cwd: PROJECT, exact: false, at: now });
    // First message: Codex's app-server writes the rollout.
    fs.files[path.join(day, `rollout-2026-11-11T23-12-22-${C}.jsonl`)] = { text: codexHead(C, PROJECT, '2026-11-11T22:12:22.657Z'), mtime: started + 13_000 };
    now = started + 15_000;
    expect(await tracker.update('s1', PROJECT, codex(38))).toEqual({ agent: 'codex', sessionId: C, cwd: PROJECT, exact: false, at: now });

    // A second Codex tab in the same folder: C is taken, and its own rollout is the only one left.
    fs.files[path.join(day, `rollout-2026-11-11T23-12-40-${D}.jsonl`)] = { text: codexHead(D, PROJECT, '2026-11-11T22:12:40.000Z'), mtime: started + 31_000 };
    expect(await tracker.update('s2', PROJECT, codex(55))).toMatchObject({ sessionId: D });

    // A resumed tab: the command line says which.
    expect(await tracker.update('s3', PROJECT, codex(77, `codex resume ${C}`))).toMatchObject({ sessionId: C, exact: true });

    // Only first lines were used; the conversation lines are never parsed or returned.
    expect(JSON.stringify(await tracker.update('s4', PROJECT, codex(99)))).not.toContain('SECRET');
  });

  it('Gemini CLI: the id from `gemini --resume <id>`, else the one session that fits in a project inside the folder, else none', async () => {
    const started = Date.parse('2026-11-13T10:00:00.000Z');
    let now = started;
    const gemini = (pid: number, cmd = 'gemini.exe') => ({ id: 'gemini', process: proc(pid, 'gemini.exe', cmd) });
    const chats = (slug: string) => path.join(HOME, '.gemini', 'tmp', slug, 'chats');
    const fs = fakeFs({
      [path.join(HOME, '.gemini', 'projects.json')]: {
        text: geminiProjects({ 'c:\\work\\car-rental': 'car-rental', 'c:\\work\\car-rental\\api': 'api', 'c:\\work\\car-rental-old': 'car-rental-old' }),
      },
      // An older session in the folder, and a new one in a sibling folder with a common prefix.
      [path.join(chats('car-rental'), `session-2026-11-12T09-00-${A.slice(0, 8)}.jsonl`)]: { text: geminiHead(A, '2026-11-12T09:00:00.000Z'), mtime: started - 86_400_000 },
      [path.join(chats('car-rental-old'), `session-2026-11-13T10-00-${D.slice(0, 8)}.jsonl`)]: { text: geminiHead(D, '2026-11-13T10:00:02.000Z'), mtime: started + 2_000 },
    });
    const tracker = new AgentSessionTracker(fs.deps(() => now));

    expect(await tracker.update('s1', PROJECT, gemini(40))).toEqual({ agent: 'gemini', sessionId: null, cwd: PROJECT, exact: false, at: now });
    // Gemini writes the session file as it starts.
    fs.files[path.join(chats('car-rental'), `session-2026-11-13T10-00-${B.slice(0, 8)}.jsonl`)] = { text: geminiHead(B, '2026-11-13T10:00:03.000Z'), mtime: started + 3_000 };
    now = started + 5_000;
    expect(await tracker.update('s1', PROJECT, gemini(40))).toEqual({ agent: 'gemini', sessionId: B, cwd: PROJECT, exact: false, at: now });

    // A second tab started in a subfolder project: its session there is the only one left, and the
    // folder keeps the workspace's spelling.
    fs.files[path.join(chats('api'), `session-2026-11-13T10-00-${C.slice(0, 8)}.jsonl`)] = { text: geminiHead(C, '2026-11-13T10:00:06.000Z'), mtime: started + 6_000 };
    expect(await tracker.update('s2', PROJECT, gemini(41))).toEqual({ agent: 'gemini', sessionId: C, cwd: `${PROJECT}\\api`, exact: false, at: now });

    // Older Gemini CLI versions: the SHA-256 folder.
    const legacy = new AgentSessionTracker(
      fakeFs({ [path.join(chats(geminiLegacyProjectDir(PROJECT)), `session-2026-11-13T10-00-${D.slice(0, 8)}.jsonl`)]: { text: geminiHead(D, '2026-11-13T10:00:01.000Z'), mtime: started + 1_000 } }).deps(() => started + 2_000),
    );
    expect(await legacy.update('s9', PROJECT, gemini(50))).toMatchObject({ sessionId: D, cwd: PROJECT });

    // A resumed tab: the command line says which.
    expect(await tracker.update('s3', PROJECT, gemini(77, `gemini --resume ${A}`))).toMatchObject({ sessionId: A, exact: true });

    // Two new sessions that could both be this tab's: no guess.
    fs.files[path.join(chats('car-rental'), `session-2026-11-13T10-01-${'11111111'}.jsonl`)] = { text: geminiHead('11111111-1111-4111-8111-111111111111', '2026-11-13T10:01:00.000Z'), mtime: started + 60_000 };
    fs.files[path.join(chats('car-rental'), `session-2026-11-13T10-01-${'22222222'}.jsonl`)] = { text: geminiHead('22222222-2222-4222-8222-222222222222', '2026-11-13T10:01:01.000Z'), mtime: started + 61_000 };
    now = started + 59_000;
    expect(await tracker.update('s4', PROJECT, gemini(88))).toMatchObject({ sessionId: null });

    // Only first lines were used.
    expect(JSON.stringify(await tracker.update('s5', PROJECT, gemini(99)))).not.toContain('SECRET');
  });

  it('other agents are not tracked', async () => {
    const tracker = new AgentSessionTracker(fakeFs({}).deps(() => 1));
    expect(await tracker.update('s1', PROJECT, { id: 'aider', process: proc(5, 'aider.exe') })).toBeUndefined();
  });
});
