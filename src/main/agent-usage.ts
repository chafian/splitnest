// Tokens, context, time and API-equivalent cost of the agent conversation in each terminal, read
// from the agents' own session files (the conversation SplitNest already finds for Resume, see
// agent-sessions.ts). Measured with Claude Code 2.1.326 and Codex 0.166.0 (docs/TESTING.md,
// "Agent session usage"); Gemini CLI's format is from its source (ChatRecordingService):
// - Claude Code: `~/.claude/projects/<folder slug>/<session id>.jsonl`. Each reply is written
//   as one line per content block, every line with the same `message.id` and the same `usage`,
//   so a reply counts once. Subagents: `<session id>/subagents/agent-*.jsonl`. Turn times:
//   `system` lines with subtype `turn_duration`.
// - Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`. `token_count` events carry the
//   running total (`total_token_usage`), the last request (`last_token_usage`) and the context
//   window; the model is in `turn_context`; `task_complete` has the turn's `duration_ms`.
// - Gemini CLI: `~/.gemini/tmp/<project>/chats/session-<time>-<id8>.jsonl`. A reply is a record
//   with `type: "gemini"`, `model` and `tokens`; a record written again with the same id replaces
//   the earlier one.
//
// These files hold the conversation. Every line is parsed only to take numbers, model names and
// times out of it; text is never kept, logged or sent anywhere, and Codex's account and rate-limit
// fields are skipped. Files are read from where the last read ended, so a long session is read
// once. Both formats are undocumented: anything unexpected is skipped.
import path from 'node:path';
import { CLAUDE_WEB_SEARCH_USD, costOf, modelInfo, priceFor, type TokenCounts } from '../shared/agent-prices';
import type { ResumableAgent } from '../shared/agent-resume';
import type { AgentUsage, ModelUsage } from '../shared/agent-usage';

export interface UsageFileDeps {
  list(dir: string): Promise<string[]>;
  stat(file: string): Promise<{ size: number; ino: number } | null>;
  /** Up to `length` bytes from `position`, or null when the file can't be read. */
  read(file: string, position: number, length: number): Promise<Buffer | null>;
  readText(file: string, maxBytes: number): Promise<string | null>;
  now(): number;
}

/** Which conversation runs in a terminal, and the home folder whose agent files hold it. */
export interface UsageSource {
  agent: ResumableAgent;
  sessionId: string;
  /** The folder the agent runs in, as the agent sees it (a Linux path in WSL). */
  cwd: string;
  /** The home folder with `.claude`, `.codex` and `.gemini` (Windows form, \\wsl.localhost\… in WSL). */
  home: string;
}

// ---------------------------------------------------------------------------------------------
// Counting

interface Request extends TokenCounts {
  model: string;
  at: number;
  /** Prompt size, for prompt-length price tiers. */
  prompt: number;
  reasoning: number;
  /** Anthropic fast mode doubles every rate. */
  multiplier: number;
  /** Charges that aren't tokens (Claude's web searches), in USD. */
  extraUsd: number;
}

interface ModelTally extends Omit<ModelUsage, 'costUsd'> {
  costUsd: number;
  /** Tokens with no known price. */
  unpriced: number;
}

/** Per-model sums for one file. Requests can be taken back (a reply written again replaces the first). */
class Tally {
  readonly models = new Map<string, ModelTally>();

  add(r: Request, sign: 1 | -1 = 1): void {
    let m = this.models.get(r.model);
    if (!m) {
      m = { model: r.model, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, requests: 0, costUsd: 0, unpriced: 0 };
      this.models.set(r.model, m);
    }
    m.input += sign * r.input;
    m.cacheRead += sign * r.cacheRead;
    m.cacheWrite += sign * (r.cacheWrite + r.cacheWriteLong);
    m.output += sign * r.output;
    m.reasoning += sign * r.reasoning;
    m.requests += sign;
    const card = priceFor(r.model, r.at, r.prompt);
    if (card) m.costUsd += sign * (costOf(card, r, r.multiplier) + r.extraUsd);
    else m.unpriced += sign * (r.input + r.cacheRead + r.cacheWrite + r.cacheWriteLong + r.output);
  }
}

export interface FileUsage {
  tally: Tally;
  context: { used: number; model: string | null; window: number | null } | null;
  startedAt: number | null;
  lastAt: number | null;
  workingMs: number | null;
}

/** A parser for one agent's session file: decides cheaply which lines to read, then takes the numbers. */
export interface UsageParser {
  /** Lines worth parsing contain one of these byte strings. */
  readonly markers: readonly Buffer[];
  line(text: string): void;
  result(): FileUsage;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e13 ? v : 0);
const time = (v: unknown): number | null => {
  if (typeof v !== 'string' || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const parse = (text: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const MODEL_RE = /^[\w.:/@-]{1,100}$/;
const cleanModel = (v: unknown): string | null => (typeof v === 'string' && MODEL_RE.test(v) ? v : null);

/** Remembers the last few replies by id, so a reply written again replaces its first copy. */
class Recent<T> {
  private readonly map = new Map<string, T>();
  constructor(private readonly max = 512) {}
  get(id: string): T | undefined {
    return this.map.get(id);
  }
  set(id: string, v: T): void {
    this.map.delete(id);
    this.map.set(id, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
}

const B = (s: string) => Buffer.from(s, 'utf8');

export class ClaudeParser implements UsageParser {
  readonly markers = [B('"usage"'), B('"turn_duration"')];
  private readonly tally = new Tally();
  private readonly seen = new Recent<Request>();
  private context: FileUsage['context'] = null;
  private startedAt: number | null = null;
  private lastAt: number | null = null;
  private working = 0;
  private hasWorking = false;

  /** `main`: the conversation itself (its context is shown), not a subagent's. */
  constructor(private readonly main = true) {}

  line(text: string): void {
    // Only replies and turn times are parsed in full; other lines only for the session's start.
    const reply = text.includes('"assistant"') && text.includes('"usage"');
    const turn = !reply && text.includes('"turn_duration"');
    if (!reply && !turn && (this.startedAt !== null || text.length > 65_536)) return;
    const o = parse(text);
    if (!o) return;
    const at = time(o.timestamp);
    if (at !== null) {
      if (this.startedAt === null || at < this.startedAt) this.startedAt = at;
      if (this.lastAt === null || at > this.lastAt) this.lastAt = at;
    }
    if (o.type === 'system' && o.subtype === 'turn_duration') {
      this.working += num(o.durationMs);
      this.hasWorking = true;
      return;
    }
    if (o.type !== 'assistant' || o.isApiErrorMessage === true) return;
    const m = obj(o.message);
    const u = obj(m?.usage);
    const model = cleanModel(m?.model);
    if (!m || !u || !model || model === '<synthetic>') return;
    const long = num(obj(u.cache_creation)?.ephemeral_1h_input_tokens);
    const writes = num(u.cache_creation_input_tokens);
    const r: Request = {
      model,
      at: at ?? 0,
      input: num(u.input_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheWrite: Math.max(0, writes - long),
      cacheWriteLong: Math.min(long, writes),
      output: num(u.output_tokens),
      reasoning: 0,
      prompt: 0,
      multiplier: u.speed === 'fast' ? 2 : 1,
      extraUsd: num(obj(u.server_tool_use)?.web_search_requests) * CLAUDE_WEB_SEARCH_USD,
    };
    r.prompt = r.input + r.cacheRead + r.cacheWrite + r.cacheWriteLong;
    const id = typeof m.id === 'string' ? m.id : typeof o.uuid === 'string' ? o.uuid : null;
    const before = id ? this.seen.get(id) : undefined;
    if (before) this.tally.add(before, -1);
    this.tally.add(r);
    if (id) this.seen.set(id, r);
    if (this.main && o.isSidechain !== true && r.prompt + r.output > 0) this.context = { used: r.prompt + r.output, model, window: null };
  }

  result(): FileUsage {
    return { tally: this.tally, context: this.context, startedAt: this.startedAt, lastAt: this.lastAt, workingMs: this.hasWorking ? this.working : null };
  }
}

interface CodexTotals {
  input: number;
  cached: number;
  write: number;
  output: number;
  reasoning: number;
}

export class CodexParser implements UsageParser {
  readonly markers = [B('"token_count"'), B('"turn_context"'), B('"task_complete"'), B('"session_meta"')];
  private readonly tally = new Tally();
  private model: string | null = null;
  private prev: CodexTotals | null = null;
  private context: FileUsage['context'] = null;
  private startedAt: number | null = null;
  private lastAt: number | null = null;
  private working = 0;
  private hasWorking = false;

  line(text: string): void {
    const o = parse(text);
    const p = obj(o?.payload);
    if (!o || !p) return;
    const at = time(o.timestamp);
    if (at !== null) {
      if (this.startedAt === null || at < this.startedAt) this.startedAt = at;
      if (this.lastAt === null || at > this.lastAt) this.lastAt = at;
    }
    if (o.type === 'turn_context') {
      this.model = cleanModel(p.model) ?? this.model;
      return;
    }
    if (o.type !== 'event_msg') return;
    if (p.type === 'task_complete') {
      this.working += num(p.duration_ms);
      this.hasWorking = true;
      return;
    }
    if (p.type !== 'token_count') return;
    // Only the token counts: the same event also has rate limits and credits, which are skipped.
    const info = obj(p.info);
    const total = obj(info?.total_token_usage);
    const last = obj(info?.last_token_usage);
    if (!info || !total) return;
    const now: CodexTotals = { input: num(total.input_tokens), cached: num(total.cached_input_tokens), write: num(total.cache_write_input_tokens), output: num(total.output_tokens), reasoning: num(total.reasoning_output_tokens) };
    const prev = this.prev;
    // Totals only grow; a smaller one starts a new count.
    const reset = !prev || (Object.keys(now) as (keyof CodexTotals)[]).some((k) => now[k] < prev[k]);
    const d: CodexTotals = reset ? now : { input: now.input - prev.input, cached: now.cached - prev.cached, write: now.write - prev.write, output: now.output - prev.output, reasoning: now.reasoning - prev.reasoning };
    this.prev = now;
    const lastInput = num(last?.input_tokens);
    if (d.input + d.output > 0) {
      const model = this.model ?? 'unknown';
      this.tally.add({
        model,
        at: at ?? 0,
        // Input includes the cached part (and cache writes).
        input: Math.max(0, d.input - d.cached - d.write),
        cacheRead: d.cached,
        cacheWrite: d.write,
        cacheWriteLong: 0,
        output: d.output,
        reasoning: d.reasoning,
        prompt: lastInput,
        multiplier: 1,
        extraUsd: 0,
      });
    }
    if (last) {
      const used = num(last.total_tokens) || num(last.input_tokens) + num(last.output_tokens);
      const window = num(info.model_context_window);
      if (used > 0) this.context = { used, model: this.model, window: window > 0 ? window : null };
    }
  }

  result(): FileUsage {
    return { tally: this.tally, context: this.context, startedAt: this.startedAt, lastAt: this.lastAt, workingMs: this.hasWorking ? this.working : null };
  }
}

export class GeminiParser implements UsageParser {
  readonly markers = [B('"tokens"'), B('"startTime"')];
  private readonly tally = new Tally();
  private readonly seen = new Recent<Request>();
  private context: FileUsage['context'] = null;
  private startedAt: number | null = null;
  private lastAt: number | null = null;

  line(text: string): void {
    const o = parse(text);
    if (!o) return;
    const start = time(o.startTime);
    if (start !== null && (this.startedAt === null || start < this.startedAt)) this.startedAt = start;
    const t = obj(o.tokens);
    const model = cleanModel(o.model);
    if (o.type !== 'gemini' || !t || !model || typeof o.id !== 'string') return;
    const at = time(o.timestamp);
    if (at !== null && (this.lastAt === null || at > this.lastAt)) this.lastAt = at;
    // promptTokenCount includes the cached part; tool-use prompt tokens are billed as input;
    // thinking is billed as output.
    const prompt = num(t.input);
    const cached = Math.min(num(t.cached), prompt);
    const r: Request = {
      model,
      at: at ?? 0,
      input: prompt - cached + num(t.tool),
      cacheRead: cached,
      cacheWrite: 0,
      cacheWriteLong: 0,
      output: num(t.output) + num(t.thoughts),
      reasoning: num(t.thoughts),
      prompt,
      multiplier: 1,
      extraUsd: 0,
    };
    const before = this.seen.get(o.id);
    if (before) this.tally.add(before, -1);
    this.tally.add(r);
    this.seen.set(o.id, r);
    const used = num(t.total) || prompt + r.output;
    if (used > 0) this.context = { used, model, window: null };
  }

  result(): FileUsage {
    return { tally: this.tally, context: this.context, startedAt: this.startedAt, lastAt: this.lastAt, workingMs: null };
  }
}

export const newParser = (agent: ResumableAgent, main = true): UsageParser => (agent === 'claude' ? new ClaudeParser(main) : agent === 'codex' ? new CodexParser() : new GeminiParser());

const FIRST_LINES = 5;

/** Feeds a parser complete lines from appended bytes; a line split across reads waits for its end. */
export class LineFeeder {
  private rest: Buffer = Buffer.alloc(0);
  private skipping = false;
  /** The first lines are always read (where the session's start time is), if short. */
  private lines = 0;
  constructor(
    private readonly parser: UsageParser,
    private readonly maxLine = 64 * 1024 * 1024,
  ) {}

  push(chunk: Buffer): void {
    let buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    let start = 0;
    for (let nl = buf.indexOf(10, start); nl !== -1; nl = buf.indexOf(10, start)) {
      if (this.skipping) this.skipping = false;
      else this.feed(buf.subarray(start, nl));
      start = nl + 1;
    }
    buf = buf.subarray(start);
    // A line longer than any record we read is skipped up to its end.
    if (buf.length > this.maxLine) {
      this.skipping = true;
      buf = Buffer.alloc(0);
    }
    this.rest = Buffer.from(buf);
  }

  private feed(line: Buffer): void {
    const early = this.lines++ < FIRST_LINES && line.length < 65_536;
    if (line.length < 2 || (!early && !this.parser.markers.some((m) => line.includes(m)))) return;
    this.parser.line(line.toString('utf8'));
  }
}

// ---------------------------------------------------------------------------------------------
// Combining files into what the page shows

export function summarize(agent: ResumableAgent, files: FileUsage[], main: FileUsage | null, subagents: number, live: boolean): AgentUsage {
  const merged = new Map<string, ModelTally>();
  for (const f of files) {
    for (const m of f.tally.models.values()) {
      if (m.requests <= 0) continue;
      const t = merged.get(m.model);
      if (!t) merged.set(m.model, { ...m });
      else {
        t.input += m.input;
        t.cacheRead += m.cacheRead;
        t.cacheWrite += m.cacheWrite;
        t.output += m.output;
        t.reasoning += m.reasoning;
        t.requests += m.requests;
        t.costUsd += m.costUsd;
        t.unpriced += m.unpriced;
      }
    }
  }
  const round = (v: number) => Math.max(0, Math.round(v));
  const models: ModelUsage[] = [...merged.values()].map((m) => ({
    model: m.model,
    input: round(m.input),
    cacheRead: round(m.cacheRead),
    cacheWrite: round(m.cacheWrite),
    output: round(m.output),
    reasoning: round(m.reasoning),
    requests: round(m.requests),
    // A model is priced when all its tokens are.
    costUsd: m.unpriced > 0 ? null : Math.max(0, m.costUsd),
  }));
  models.sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.input + b.output - (a.input + a.output));
  const tokens = models.reduce((s, m) => s + m.input + m.cacheRead + m.cacheWrite + m.output, 0);
  const priced = models.filter((m) => m.costUsd !== null);
  const ctx = main?.context ?? null;
  const times = files.flatMap((f) => [f.startedAt, f.lastAt]).filter((t): t is number => t !== null);
  const working = files.map((f) => f.workingMs).filter((w): w is number => w !== null);
  return {
    agent,
    models: models.slice(0, 12),
    tokens,
    costUsd: priced.length ? priced.reduce((s, m) => s + m.costUsd!, 0) : null,
    costPartial: priced.length > 0 && priced.length < models.length,
    context: ctx ? { used: ctx.used, limit: ctx.window ?? modelInfo(ctx.model)?.context ?? null } : null,
    startedAt: times.length ? Math.min(...times) : null,
    lastAt: times.length ? Math.max(...times) : null,
    workingMs: working.length ? working.reduce((a, b) => a + b, 0) : null,
    subagents,
    live,
  };
}

// ---------------------------------------------------------------------------------------------
// Finding the files

/** Claude Code's folder name for a working folder: every character but letters and digits becomes "-". */
export const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DIRS = 3000;

export async function locateSessionFile(deps: UsageFileDeps, src: UsageSource): Promise<string | null> {
  if (!UUID.test(src.sessionId)) return null;
  const id = src.sessionId.toLowerCase();
  if (src.agent === 'claude') {
    const projects = path.win32.join(src.home, '.claude', 'projects');
    const name = `${src.sessionId}.jsonl`;
    const direct = path.win32.join(projects, claudeProjectSlug(src.cwd), name);
    if (await deps.stat(direct)) return direct;
    // Long folder names are shortened by Claude Code: look in every project folder.
    for (const dir of (await deps.list(projects)).slice(0, MAX_DIRS)) {
      const file = path.win32.join(projects, dir, name);
      if (await deps.stat(file)) return file;
    }
    return null;
  }
  if (src.agent === 'codex') {
    const root = path.win32.join(src.home, '.codex', 'sessions');
    const desc = (names: string[], re: RegExp) => names.filter((n) => re.test(n)).sort().reverse();
    let days = 0;
    for (const y of desc(await deps.list(root), /^\d{4}$/)) {
      for (const m of desc(await deps.list(path.win32.join(root, y)), /^\d{2}$/)) {
        for (const d of desc(await deps.list(path.win32.join(root, y, m)), /^\d{2}$/)) {
          if (++days > 400) return null;
          const dir = path.win32.join(root, y, m, d);
          const hit = (await deps.list(dir)).find((n) => n.startsWith('rollout-') && n.toLowerCase().endsWith(`-${id}.jsonl`));
          if (hit) return path.win32.join(dir, hit);
        }
      }
    }
    return null;
  }
  // Gemini CLI: the file name ends with the id's first 8 characters; its first line has the full id.
  const tmp = path.win32.join(src.home, '.gemini', 'tmp');
  const suffix = `-${id.slice(0, 8)}.jsonl`;
  for (const project of (await deps.list(tmp)).slice(0, 500)) {
    const dir = path.win32.join(tmp, project, 'chats');
    for (const n of (await deps.list(dir)).filter((x) => x.startsWith('session-') && x.toLowerCase().endsWith(suffix))) {
      const file = path.win32.join(dir, n);
      const head = await deps.readText(file, 64 * 1024);
      const first = head ? parse(head.split('\n', 1)[0]!) : null;
      if (typeof first?.sessionId === 'string' && first.sessionId.toLowerCase() === id) return file;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The service: one watch per terminal running a known conversation

interface FileState {
  parser: UsageParser;
  feeder: LineFeeder;
  offset: number;
  ino: number;
}

interface Watch {
  ownerId: number;
  src: UsageSource;
  main: string | null;
  files: Map<string, FileState>;
  live: boolean;
  lastLocate: number;
  lastSubagentList: number;
  sent: string;
  sentAt: number;
}

export interface AgentUsageDeps extends UsageFileDeps {
  enabled(): boolean;
  report(ownerId: number, sessionId: string, usage: AgentUsage | null): void;
}

const POLL_MS = 3000;
const LOCATE_RETRY_MS = 10_000;
const SUBAGENT_LIST_MS = 15_000;
const REPORT_MIN_MS = 1500;
const CHUNK = 1024 * 1024;
/** Per file per check; a long session catches up over a few checks. */
const READ_BUDGET = 64 * 1024 * 1024;

export class AgentUsageService {
  private readonly watches = new Map<string, Watch>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private stopped = false;
  private wasEnabled = true;

  constructor(private readonly deps: AgentUsageDeps) {}

  /**
   * The monitor's latest answer for a terminal: the conversation running there, or null when no
   * agent (or no known conversation) runs. A conversation that ends keeps its last numbers.
   */
  observe(ownerId: number, sessionId: string, src: UsageSource | null): void {
    if (this.stopped) return;
    if (!this.deps.enabled()) {
      this.disable();
      return;
    }
    this.wasEnabled = true;
    const w = this.watches.get(sessionId);
    if (!src) {
      if (w?.live) {
        w.live = false;
        void this.pollOne(sessionId, w, true);
      }
      return;
    }
    if (w && w.src.agent === src.agent && w.src.sessionId === src.sessionId && w.src.home === src.home) {
      w.ownerId = ownerId;
      if (!w.live) {
        w.live = true;
        this.schedule(50);
      }
      return;
    }
    // Another conversation now (a new one, /clear): the old numbers go until the new ones are read.
    if (w?.sent) this.deps.report(w.ownerId, sessionId, null);
    this.watches.set(sessionId, { ownerId, src, main: null, files: new Map(), live: true, lastLocate: 0, lastSubagentList: 0, sent: '', sentAt: 0 });
    this.schedule(50);
  }

  /** The terminal ended. */
  forget(sessionId: string): void {
    this.watches.delete(sessionId);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.watches.clear();
  }

  /** Runs one check of every watched conversation now (tests). */
  async pollNow(): Promise<void> {
    await this.poll();
  }

  private disable(): void {
    if (!this.wasEnabled) return;
    this.wasEnabled = false;
    for (const [id, w] of this.watches) if (w.sent) this.deps.report(w.ownerId, id, null);
    this.watches.clear();
  }

  private schedule(ms: number): void {
    if (this.stopped || this.polling) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), ms);
  }

  private async poll(): Promise<void> {
    this.timer = null;
    if (this.polling || this.stopped) return;
    if (!this.deps.enabled()) {
      this.disable();
      return;
    }
    this.polling = true;
    try {
      for (const [id, w] of [...this.watches]) if (w.live) await this.pollOne(id, w, false);
    } finally {
      this.polling = false;
    }
    if ([...this.watches.values()].some((w) => w.live)) this.schedule(POLL_MS);
  }

  private async pollOne(id: string, w: Watch, final: boolean): Promise<void> {
    const now = this.deps.now();
    if (!w.main && now - w.lastLocate >= LOCATE_RETRY_MS) {
      w.lastLocate = now;
      w.main = await locateSessionFile(this.deps, w.src).catch(() => null);
      if (w.main) w.files.set(w.main, this.fileState(w.src.agent, true));
    }
    if (!w.main || this.watches.get(id) !== w) return;
    if (w.src.agent === 'claude' && now - w.lastSubagentList >= SUBAGENT_LIST_MS) {
      w.lastSubagentList = now;
      const dir = path.win32.join(w.main.slice(0, -'.jsonl'.length), 'subagents');
      for (const n of (await this.deps.list(dir)).filter((x) => /^agent-[\w-]+\.jsonl$/.test(x)).slice(0, 500)) {
        const file = path.win32.join(dir, n);
        if (!w.files.has(file)) w.files.set(file, this.fileState('claude', false));
      }
    }
    for (const [file, st] of w.files) await this.readNew(file, st, w.src.agent, file === w.main);
    if (this.watches.get(id) !== w) return;
    const main = w.files.get(w.main)?.parser.result() ?? null;
    const usage = summarize(w.src.agent, [...w.files.values()].map((s) => s.parser.result()), main, w.files.size - 1, w.live && !final);
    if (usage.tokens === 0 && !w.sent) return; // nothing to show yet
    const text = JSON.stringify(usage);
    if (text === w.sent) return;
    if (!final && now - w.sentAt < REPORT_MIN_MS) return; // the next check sends it
    w.sent = text;
    w.sentAt = now;
    this.deps.report(w.ownerId, id, usage);
  }

  private fileState(agent: ResumableAgent, main: boolean): FileState {
    const parser = newParser(agent, main);
    return { parser, feeder: new LineFeeder(parser), offset: 0, ino: -1 };
  }

  /** Reads what was appended since the last read; a file that was replaced is read again from the start. */
  private async readNew(file: string, st: FileState, agent: ResumableAgent, main: boolean): Promise<void> {
    const info = await this.deps.stat(file);
    if (!info) return;
    if ((st.ino !== -1 && info.ino !== st.ino) || info.size < st.offset) {
      const fresh = this.fileState(agent, main);
      st.parser = fresh.parser;
      st.feeder = fresh.feeder;
      st.offset = 0;
    }
    st.ino = info.ino;
    let budget = READ_BUDGET;
    while (st.offset < info.size && budget > 0) {
      const len = Math.min(CHUNK, info.size - st.offset, budget);
      const buf = await this.deps.read(file, st.offset, len);
      if (!buf || buf.length === 0) return;
      st.feeder.push(buf);
      st.offset += buf.length;
      budget -= buf.length;
    }
  }
}
