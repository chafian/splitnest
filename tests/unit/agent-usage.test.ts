// Agent session usage: prices, the three agents' session-file parsers (hand-made lines in the
// formats measured with Claude Code 2.1.326 and Codex 0.166.0, and Gemini CLI's from its source),
// finding the files, and the service end to end over an in-memory file system.
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { costOf, modelInfo, priceFor } from '../../src/shared/agent-prices';
import { contextPercent, formatCost, formatDuration, formatTokens, parseAgentUsage, usageSummary, type AgentUsage } from '../../src/shared/agent-usage';
import { AgentUsageService, ClaudeParser, claudeProjectSlug, CodexParser, GeminiParser, LineFeeder, locateSessionFile, summarize, type UsageFileDeps, type UsageParser } from '../../src/main/agent-usage';

const T0 = Date.parse('2026-11-18T10:00:00.000Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();

// ---------------------------------------------------------------- Claude Code lines
const claudeReply = (id: string, u: Record<string, unknown>, extra: Record<string, unknown> = {}, at = 0, model = 'claude-opus-5-5') =>
  JSON.stringify({
    parentUuid: 'p',
    isSidechain: false,
    type: 'assistant',
    message: { id, model, role: 'assistant', type: 'message', content: [{ type: 'text', text: 'secret words "usage" here' }], usage: u },
    timestamp: iso(at),
    sessionId: 'x',
    ...extra,
  });
const claudeUsage = (input: number, cacheRead: number, write5m: number, write1h: number, output: number, extra: Record<string, unknown> = {}) => ({
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: write5m + write1h,
  cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h },
  output_tokens: output,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  ...extra,
});
const turn = (ms: number, at = 0) => JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: ms, timestamp: iso(at) });

// ---------------------------------------------------------------- Codex lines
const codex = (type: string, payload: Record<string, unknown>, at = 0) => JSON.stringify({ timestamp: iso(at), ordinal: 0, type, payload });
const codexCount = (total: [number, number, number, number], last: [number, number, number, number], window = 258_400, at = 0) => {
  const u = (v: [number, number, number, number]) => ({ input_tokens: v[0], cached_input_tokens: v[1], cache_write_input_tokens: 0, output_tokens: v[2], reasoning_output_tokens: v[3], total_tokens: v[0] + v[2] });
  return codex('event_msg', { type: 'token_count', info: { total_token_usage: u(total), last_token_usage: u(last), model_context_window: window }, rate_limits: { primary: { used_percent: 32 }, credits: { balance: '123.45' } } }, at);
};

// ---------------------------------------------------------------- Gemini CLI lines
const geminiMsg = (id: string, tokens: Record<string, number>, model = 'gemini-3.1-pro-preview', at = 0) => JSON.stringify({ id, timestamp: iso(at), type: 'gemini', content: [{ text: 'secret' }], thoughts: [], tokens, model });

const feed = (parser: UsageParser, lines: string[]) => {
  const f = new LineFeeder(parser);
  f.push(Buffer.from(lines.join('\n') + '\n'));
  return parser.result();
};

describe('prices', () => {
  it('matches exact model ids only, without date suffixes or other variants', () => {
    expect(modelInfo('claude-opus-5-5')?.provider).toBe('anthropic');
    expect(modelInfo('claude-haiku-4-5-20251001')?.context).toBe(200_000);
    expect(modelInfo('models/gemini-2.5-pro')?.provider).toBe('google');
    expect(modelInfo('gpt-6.1-sol-ultrafast')).toBeNull();
    expect(modelInfo('claude-opus-5-5-fast')).toBeNull();
    expect(modelInfo('<synthetic>')).toBeNull();
    expect(modelInfo(undefined)).toBeNull();
  });

  it('reproduces Claude Code’s own per-model costs with the published rates', () => {
    // Totals Claude Code recorded for one session (Opus 5.5, Fable 5.2, Sonnet 5.5): its costUSD to the cent.
    const opus = costOf(priceFor('claude-opus-5-5', T0, 0)!, { input: 54_539, cacheRead: 1_003_047_245, cacheWrite: 301_333, cacheWriteLong: 5_846_051, output: 2_806_131 });
    const fable = costOf(priceFor('claude-fable-5-2', T0, 0)!, { input: 130, cacheRead: 24_654_148, cacheWrite: 0, cacheWriteLong: 1_179_542, output: 86_350 });
    const sonnet = costOf(priceFor('claude-sonnet-5-5', T0, 0)!, { input: 268, cacheRead: 19_266_937, cacheWrite: 415_448, cacheWriteLong: 0, output: 157_508 });
    expect(opus.toFixed(2)).toBe('305.23');
    expect(fable.toFixed(2)).toBe('27.26');
    expect(sonnet.toFixed(2)).toBe('4.54');
  });

  it('uses long-prompt rates per request and dated price changes', () => {
    expect(priceFor('gpt-6.1-sol', T0, 272_000)!.input).toBe(2);
    expect(priceFor('gpt-6.1-sol', T0, 272_001)!.input).toBe(4);
    expect(priceFor('claude-haiku-5-5', T0, 100_001)!.output).toBe(2.5);
    expect(priceFor('gemini-3.1-pro-preview', T0, 250_000)!.cacheRead).toBe(0.4);
    expect(priceFor('gemini-3.8-flash', Date.parse('2026-12-31T12:00:00Z'), 0)!.input).toBe(0.75);
    expect(priceFor('gemini-3.8-flash', Date.parse('2027-01-01T00:00:00Z'), 0)!.input).toBe(1.5);
    // Cache writes default to the input rate where no write price is published.
    expect(costOf(priceFor('gpt-5.4', T0, 0)!, { input: 0, cacheRead: 0, cacheWrite: 1_000_000, cacheWriteLong: 0, output: 0 })).toBe(2.5);
    expect(costOf({ input: 1, output: 1, cacheRead: 1 }, { input: 1_000_000, cacheRead: 0, cacheWrite: 0, cacheWriteLong: 0, output: 0 }, 2)).toBe(2);
  });
});

describe('Claude Code session file', () => {
  it('counts a reply once although every content block repeats its usage, the last copy winning', () => {
    const u = claudeUsage(2, 1000, 500, 0, 10);
    const r = feed(new ClaudeParser(), [claudeReply('msg_1', u), claudeReply('msg_1', u), claudeReply('msg_1', claudeUsage(2, 1000, 500, 0, 337))]);
    const m = r.tally.models.get('claude-opus-5-5')!;
    expect(m).toMatchObject({ input: 2, cacheRead: 1000, cacheWrite: 500, output: 337, requests: 1 });
    expect(r.context).toEqual({ used: 2 + 1000 + 500 + 337, model: 'claude-opus-5-5', window: null });
  });

  it('prices 1-hour cache writes, web searches and fast mode; skips synthetic and error replies', () => {
    const lines = [
      claudeReply('a', claudeUsage(1_000_000, 0, 0, 1_000_000, 0)),
      claudeReply('b', claudeUsage(0, 0, 0, 0, 0, { server_tool_use: { web_search_requests: 3 } })),
      claudeReply('c', claudeUsage(0, 0, 0, 0, 1_000_000, { speed: 'fast' })),
      claudeReply('d', claudeUsage(5, 5, 5, 5, 5), {}, 0, '<synthetic>'),
      claudeReply('e', claudeUsage(5, 5, 5, 5, 5), { isApiErrorMessage: true }),
    ];
    const m = feed(new ClaudeParser(), lines).tally.models.get('claude-opus-5-5')!;
    // $4 input + $8 one-hour writes + 3 searches ($0.03) + fast output at 2 x $20.
    expect(m.costUsd).toBeCloseTo(4 + 8 + 0.03 + 40, 6);
    expect(m.requests).toBe(3);
  });

  it('adds turn times, keeps subagent context out, and finds the start in the first lines', () => {
    const lines = [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(-60_000) }),
      claudeReply('a', claudeUsage(1, 2, 3, 0, 4), {}, 1000),
      turn(15_000, 2000),
      claudeReply('b', claudeUsage(100, 0, 0, 0, 1), { isSidechain: true }, 3000),
      turn(5000, 4000),
    ];
    const r = feed(new ClaudeParser(), lines);
    expect(r.startedAt).toBe(T0 - 60_000);
    expect(r.lastAt).toBe(T0 + 4000);
    expect(r.workingMs).toBe(20_000);
    expect(r.context?.used).toBe(10);
    const sub = feed(new ClaudeParser(false), [claudeReply('s', claudeUsage(7, 0, 0, 0, 1))]);
    expect(sub.context).toBeNull();
  });

  it('never keeps text: only numbers, model names and times come out', () => {
    const r = feed(new ClaudeParser(), [claudeReply('a', claudeUsage(1, 2, 3, 0, 4))]);
    const out = JSON.stringify(summarize('claude', [r], r, 0, true));
    expect(out).not.toContain('secret');
  });
});

describe('Codex session file', () => {
  it('adds the growth of the running totals to the current model; rate limits and credits are skipped', () => {
    const lines = [
      codex('session_meta', { id: 'x', timestamp: iso(0), cwd: 'C:\\p', base_instructions: { text: 'secret' } }, 0),
      codex('turn_context', { model: 'gpt-6.1-sol', cwd: 'C:\\p' }, 1000),
      codexCount([21_851, 13_440, 5, 0], [21_851, 13_440, 5, 0], 258_400, 2000),
      codexCount([21_851, 13_440, 5, 0], [21_851, 13_440, 5, 0], 258_400, 2500), // repeated: adds nothing
      codex('turn_context', { model: 'gpt-6-astra' }, 3000),
      codexCount([51_851, 33_440, 105, 50], [30_000, 20_000, 100, 50], 475_000, 4000),
      codex('event_msg', { type: 'task_complete', duration_ms: 3200 }, 5000),
    ];
    const r = feed(new CodexParser(), lines);
    expect(r.tally.models.get('gpt-6.1-sol')).toMatchObject({ input: 21_851 - 13_440, cacheRead: 13_440, output: 5, requests: 1 });
    expect(r.tally.models.get('gpt-6-astra')).toMatchObject({ input: 10_000, cacheRead: 20_000, output: 100, reasoning: 50, requests: 1 });
    expect(r.context).toEqual({ used: 30_100, model: 'gpt-6-astra', window: 475_000 });
    expect(r.workingMs).toBe(3200);
    expect(r.startedAt).toBe(T0);
    expect(JSON.stringify(summarize('codex', [r], r, 0, true))).not.toMatch(/secret|123\.45|used_percent/);
  });

  it('starts counting again when the totals shrink, and prices long requests at long-context rates', () => {
    const lines = [codex('turn_context', { model: 'gpt-6.1-sol' }), codexCount([300_000, 0, 0, 0], [300_000, 0, 0, 0]), codexCount([1000, 0, 0, 0], [1000, 0, 0, 0])];
    const m = feed(new CodexParser(), lines).tally.models.get('gpt-6.1-sol')!;
    expect(m.input).toBe(301_000);
    expect(m.costUsd).toBeCloseTo((300_000 * 4 + 1000 * 2) / 1e6, 9);
  });
});

describe('Gemini CLI session file', () => {
  it('counts each reply id once (a record written again replaces it), cached and thinking tokens apart', () => {
    const lines = [
      JSON.stringify({ sessionId: 'x', projectHash: 'f', startTime: iso(-5000), lastUpdated: iso(0), kind: 'main' }),
      JSON.stringify({ id: 'u1', timestamp: iso(0), type: 'user', content: [{ text: 'secret' }] }),
      geminiMsg('g1', { input: 1000, output: 10, cached: 400, thoughts: 0, tool: 0, total: 1010 }),
      geminiMsg('g1', { input: 1000, output: 20, cached: 400, thoughts: 30, tool: 5, total: 1055 }, 'gemini-3.1-pro-preview', 1000),
      JSON.stringify({ $set: { lastUpdated: iso(1000) } }),
    ];
    const r = feed(new GeminiParser(), lines);
    expect(r.tally.models.get('gemini-3.1-pro-preview')).toMatchObject({ input: 605, cacheRead: 400, output: 50, reasoning: 30, requests: 1 });
    expect(r.context).toEqual({ used: 1055, model: 'gemini-3.1-pro-preview', window: null });
    expect(r.startedAt).toBe(T0 - 5000);
    expect(r.workingMs).toBeNull();
    const u = summarize('gemini', [r], r, 0, true);
    expect(u.context).toEqual({ used: 1055, limit: 1_048_576 });
  });
});

describe('reading appended bytes', () => {
  it('joins a line split across reads, skips lines without markers and over-long lines', () => {
    const seen: string[] = [];
    const parser: UsageParser = { markers: [Buffer.from('"keep"')], line: (t) => void seen.push(t), result: () => null as never };
    const f = new LineFeeder(parser, 64);
    // The first five short lines are always read (where a session's start time is).
    f.push(Buffer.from('l1\nl2\nl3\nl4\nl5\n'));
    f.push(Buffer.from('{"keep":1,"a":"x'));
    f.push(Buffer.from('y"}\n{"drop":1}\n{"keep":"' + 'z'.repeat(100)));
    f.push(Buffer.from('"}\n{"keep":2}\n'));
    expect(seen.slice(5)).toEqual(['{"keep":1,"a":"xy"}', '{"keep":2}']);
  });
});

describe('the page’s copy of the numbers', () => {
  const usage: AgentUsage = {
    agent: 'claude',
    models: [{ model: 'claude-opus-5-5', input: 10, cacheRead: 1_200_000, cacheWrite: 1000, output: 5000, reasoning: 0, requests: 3, costUsd: 3.413 }],
    tokens: 1_206_010,
    costUsd: 3.413,
    costPartial: false,
    context: { used: 420_000, limit: 1_000_000 },
    startedAt: T0,
    lastAt: T0 + 1000,
    workingMs: 72 * 60_000,
    subagents: 0,
    live: true,
  };

  it('validates what main sends', () => {
    expect(parseAgentUsage(JSON.parse(JSON.stringify(usage)))).toEqual(usage);
    expect(parseAgentUsage({ ...usage, agent: 'other' })).toBeNull();
    expect(parseAgentUsage({ ...usage, models: [{ ...usage.models[0], model: '<script>' }] })).toBeNull();
    expect(parseAgentUsage({ ...usage, tokens: -1 })).toBeNull();
    expect(parseAgentUsage({ ...usage, context: { used: 5, limit: 0 } })?.context).toEqual({ used: 5, limit: null });
  });

  it('formats the readout', () => {
    expect(usageSummary(usage, true)).toBe('ctx 42% · 1.2M tokens · 1h 12m · ≈ $3.41');
    expect(usageSummary({ ...usage, context: { used: 9000, limit: null }, workingMs: null, costUsd: null }, true)).toBe('ctx 9K · 1.2M tokens · cost unknown');
    expect(usageSummary({ ...usage, costPartial: true }, false)).toBe('ctx 42% · 1.2M tokens · 1h 12m');
    expect(contextPercent({ context: { used: 2, limit: 1 } })).toBe(100);
    expect([formatTokens(950), formatTokens(12_400), formatTokens(150_000), formatTokens(3.4e9)]).toEqual(['950', '12.4K', '150K', '3.4B']);
    expect([formatCost(0.004), formatCost(0), formatCost(1234.5)]).toEqual(['<$0.01', '$0.00', '$1,235']);
    expect([formatDuration(45_000), formatDuration(12 * 60_000), formatDuration(76 * 3_600_000)]).toEqual(['45s', '12m', '3d 4h']);
  });

  it('marks a cost partial when a model has no price', () => {
    const a = feed(new ClaudeParser(), [claudeReply('a', claudeUsage(1_000_000, 0, 0, 0, 0)), claudeReply('b', claudeUsage(5, 0, 0, 0, 5), {}, 0, 'claude-future-9')]);
    const u = summarize('claude', [a], a, 0, true);
    expect(u.costUsd).toBeCloseTo(4, 9);
    expect(u.costPartial).toBe(true);
    expect(u.models.find((m) => m.model === 'claude-future-9')?.costUsd).toBeNull();
  });
});

// ---------------------------------------------------------------- an in-memory home folder
class MemFs implements UsageFileDeps {
  files = new Map<string, { data: Buffer; ino: number }>();
  private ino = 1;
  t = T0;
  write(file: string, text: string): void {
    this.files.set(path.win32.normalize(file), { data: Buffer.from(text), ino: this.ino++ });
  }
  append(file: string, text: string): void {
    const f = this.files.get(path.win32.normalize(file))!;
    f.data = Buffer.concat([f.data, Buffer.from(text)]);
  }
  async list(dir: string): Promise<string[]> {
    const d = path.win32.normalize(dir).replace(/\\$/, '') + '\\';
    const names = new Set<string>();
    for (const f of this.files.keys()) if (f.toLowerCase().startsWith(d.toLowerCase())) names.add(f.slice(d.length).split('\\')[0]!);
    return [...names];
  }
  async stat(file: string) {
    const f = this.files.get(path.win32.normalize(file));
    return f ? { size: f.data.length, ino: f.ino } : null;
  }
  async read(file: string, position: number, length: number) {
    const f = this.files.get(path.win32.normalize(file));
    return f ? f.data.subarray(position, position + length) : null;
  }
  async readText(file: string, max: number) {
    const f = this.files.get(path.win32.normalize(file));
    return f ? f.data.subarray(0, max).toString('utf8') : null;
  }
  now = () => this.t;
}

const HOME = 'C:\\Users\\dev';
const ID = '0f8b6d2e-1a2b-4c3d-8e9f-001122334455';

describe('finding the session file', () => {
  it('Claude Code: the folder’s slug, else any project folder', async () => {
    const fs = new MemFs();
    expect(claudeProjectSlug('C:\\Users\\dev\\Desktop\\my app')).toBe('C--Users-dev-Desktop-my-app');
    expect(claudeProjectSlug('/home/dev/proj')).toBe('-home-dev-proj');
    fs.write(`${HOME}\\.claude\\projects\\shortened-123\\${ID}.jsonl`, '');
    expect(await locateSessionFile(fs, { agent: 'claude', sessionId: ID, cwd: 'C:\\x', home: HOME })).toBe(`${HOME}\\.claude\\projects\\shortened-123\\${ID}.jsonl`);
    fs.write(`${HOME}\\.claude\\projects\\C--x\\${ID}.jsonl`, '');
    expect(await locateSessionFile(fs, { agent: 'claude', sessionId: ID, cwd: 'C:\\x', home: HOME })).toBe(`${HOME}\\.claude\\projects\\C--x\\${ID}.jsonl`);
    expect(await locateSessionFile(fs, { agent: 'claude', sessionId: 'not-a-uuid', cwd: 'C:\\x', home: HOME })).toBeNull();
  });

  it('Codex: newest day folders first, by the id in the name', async () => {
    const fs = new MemFs();
    fs.write(`${HOME}\\.codex\\sessions\\2026\\10\\02\\rollout-2026-10-02T09-00-00-${ID}.jsonl`, '');
    fs.write(`${HOME}\\.codex\\sessions\\2026\\11\\18\\rollout-2026-11-18T09-00-00-ffffffff-1a2b-4c3d-8e9f-001122334455.jsonl`, '');
    expect(await locateSessionFile(fs, { agent: 'codex', sessionId: ID, cwd: 'C:\\x', home: HOME })).toBe(`${HOME}\\.codex\\sessions\\2026\\10\\02\\rollout-2026-10-02T09-00-00-${ID}.jsonl`);
  });

  it('Gemini CLI: the short id in the name, confirmed by the first line', async () => {
    const fs = new MemFs();
    const other = ID.slice(0, 8) + '-ffff-4c3d-8e9f-001122334455';
    fs.write(`${HOME}\\.gemini\\tmp\\a\\chats\\session-2026-11-18T09-00-${ID.slice(0, 8)}.jsonl`, JSON.stringify({ sessionId: other }) + '\n');
    expect(await locateSessionFile(fs, { agent: 'gemini', sessionId: ID, cwd: 'C:\\x', home: HOME })).toBeNull();
    fs.write(`${HOME}\\.gemini\\tmp\\b\\chats\\session-2026-11-18T10-00-${ID.slice(0, 8)}.jsonl`, JSON.stringify({ sessionId: ID }) + '\n');
    expect(await locateSessionFile(fs, { agent: 'gemini', sessionId: ID, cwd: 'C:\\x', home: HOME })).toBe(`${HOME}\\.gemini\\tmp\\b\\chats\\session-2026-11-18T10-00-${ID.slice(0, 8)}.jsonl`);
  });
});

describe('the usage service', () => {
  const setup = (enabled = { on: true }) => {
    const fs = new MemFs();
    const reports: { sessionId: string; usage: AgentUsage | null }[] = [];
    const svc = new AgentUsageService({ list: (d) => fs.list(d), stat: (f) => fs.stat(f), read: (f, p, l) => fs.read(f, p, l), readText: (f, m) => fs.readText(f, m), now: fs.now, enabled: () => enabled.on, report: (_o, sessionId, usage) => void reports.push({ sessionId, usage }) });
    const file = `${HOME}\\.claude\\projects\\C--proj\\${ID}.jsonl`;
    const src = { agent: 'claude' as const, sessionId: ID, cwd: 'C:\\proj', home: HOME };
    return { fs, reports, svc, file, src };
  };

  it('reports, reads only what is appended, and keeps the last numbers when the agent exits', async () => {
    const { fs, reports, svc, file, src } = setup();
    fs.write(file, claudeReply('a', claudeUsage(1_000_000, 0, 0, 0, 0)) + '\n');
    fs.write(`${HOME}\\.claude\\projects\\C--proj\\${ID}\\subagents\\agent-a1.jsonl`, claudeReply('s', claudeUsage(0, 0, 0, 0, 1_000_000), {}, 0, 'claude-sonnet-5-5') + '\n');
    svc.observe(1, 'term-1', src);
    await svc.pollNow();
    expect(reports.at(-1)?.usage).toMatchObject({ agent: 'claude', tokens: 2_000_000, costUsd: 14, subagents: 1, live: true });
    fs.append(file, claudeReply('b', claudeUsage(0, 0, 0, 0, 1_000_000)) + '\n');
    fs.t += 2000;
    await svc.pollNow();
    expect(reports.at(-1)?.usage).toMatchObject({ tokens: 3_000_000, costUsd: 34 });
    const count = reports.length;
    fs.t += 2000;
    await svc.pollNow();
    expect(reports.length).toBe(count); // nothing new, nothing sent
    svc.observe(1, 'term-1', null);
    await new Promise((r) => setTimeout(r, 20));
    expect(reports.at(-1)?.usage).toMatchObject({ tokens: 3_000_000, live: false });
    svc.stop();
  });

  it('reads a replaced file again from the start', async () => {
    const { fs, reports, svc, file, src } = setup();
    fs.write(file, claudeReply('a', claudeUsage(10, 0, 0, 0, 0)) + '\n' + claudeReply('b', claudeUsage(10, 0, 0, 0, 0)) + '\n');
    svc.observe(1, 'term-1', src);
    await svc.pollNow();
    expect(reports.at(-1)?.usage?.tokens).toBe(20);
    fs.write(file, claudeReply('a', claudeUsage(10, 0, 0, 0, 0)) + '\n' + claudeReply('c', claudeUsage(5, 0, 0, 0, 0)) + '\n' + claudeReply('d', claudeUsage(5, 0, 0, 0, 0)) + '\n');
    fs.t += 2000;
    await svc.pollNow();
    expect(reports.at(-1)?.usage?.tokens).toBe(20);
    expect(reports.at(-1)?.usage?.models[0]?.requests).toBe(3);
    svc.stop();
  });

  it('clears the old numbers for a new conversation, and everything when turned off', async () => {
    const enabled = { on: true };
    const { fs, reports, svc, file, src } = setup(enabled);
    fs.write(file, claudeReply('a', claudeUsage(10, 0, 0, 0, 0)) + '\n');
    svc.observe(1, 'term-1', src);
    await svc.pollNow();
    const other = '11111111-2222-4333-8444-555555555555';
    svc.observe(1, 'term-1', { ...src, sessionId: other });
    expect(reports.at(-1)).toEqual({ sessionId: 'term-1', usage: null });
    fs.write(`${HOME}\\.claude\\projects\\C--proj\\${other}.jsonl`, claudeReply('z', claudeUsage(7, 0, 0, 0, 0)) + '\n');
    await svc.pollNow();
    expect(reports.at(-1)?.usage?.tokens).toBe(7);
    enabled.on = false;
    svc.observe(1, 'term-1', { ...src, sessionId: other });
    expect(reports.at(-1)).toEqual({ sessionId: 'term-1', usage: null });
    svc.stop();
  });
});

describe('the agent scan tells the usage service which conversation runs where', () => {
  it('passes the tracker’s conversation and home, and null once the agent exits', async () => {
    const { AgentMonitor } = await import('../../src/main/agent-monitor');
    const { AgentSessionTracker } = await import('../../src/main/agent-sessions');
    const PROJ = 'C:\\proj';
    const live = path.win32.join(HOME, '.claude', 'sessions', '500.json');
    const files: Record<string, string> = { [live]: JSON.stringify({ pid: 500, sessionId: ID, cwd: PROJ, kind: 'interactive' }) };
    const tracker = new AgentSessionTracker({ home: HOME, readText: async (f) => files[f] ?? null, list: async () => [], mtimeMs: async () => null, now: () => T0 });
    let processes = [
      { pid: 100, ppid: 1, name: 'pwsh.exe', cmd: 'pwsh' },
      { pid: 500, ppid: 100, name: 'claude.exe', cmd: 'claude' },
    ];
    const seen: unknown[] = [];
    const monitor = new AgentMonitor({
      sessions: () => [{ sessionId: 's1', ownerId: 1, pid: 100, wsl: false, cwd: PROJ }],
      report: () => undefined,
      powershellPath: 'unused',
      log: () => undefined,
      snapshot: async () => processes,
      resume: { tracker, report: () => undefined },
      usage: { observe: (_o, id, src) => void seen.push([id, src]), forget: () => undefined },
    });
    const tick = () => (monitor as unknown as { tick(): Promise<void> }).tick();
    await tick();
    processes = processes.slice(0, 1); // Claude Code exited
    await tick();
    monitor.stop();
    expect(seen).toEqual([
      ['s1', { agent: 'claude', sessionId: ID, cwd: PROJ, home: HOME }],
      ['s1', null],
    ]);
  });
});
