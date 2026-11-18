// Tokens, context, time and API-equivalent cost of the agent session in a terminal (Claude Code,
// Codex, Gemini CLI). Read from the agents' own session files by src/main/agent-usage.ts; only
// numbers, model names and times leave that module, never conversation text.
import { isResumableAgent, type ResumableAgent } from './agent-resume';

export interface ModelUsage {
  model: string;
  /** Input tokens not read from a cache. */
  input: number;
  cacheRead: number;
  /** Cache writes (all durations). */
  cacheWrite: number;
  /** Output tokens, reasoning included. */
  output: number;
  /** Of `output`, reasoning ("thinking") tokens, when the agent records them. */
  reasoning: number;
  /** Replies (requests) counted. */
  requests: number;
  /** API-equivalent USD, or null when the model's price isn't known. */
  costUsd: number | null;
}

export interface AgentUsage {
  agent: ResumableAgent;
  /** Main conversation and (Claude Code) its subagents, most expensive first. */
  models: ModelUsage[];
  /** All tokens: input, cache reads and writes, output. */
  tokens: number;
  /** Sum over models with a known price; null when none is known. */
  costUsd: number | null;
  /** Some tokens are from a model without a known price (not in costUsd). */
  costPartial: boolean;
  /** The last request's size against the model's context window (limit null when unknown). */
  context: { used: number; limit: number | null } | null;
  /** First and last record of the session (ms since epoch). */
  startedAt: number | null;
  lastAt: number | null;
  /** Time the agent spent on turns, as it records it (Claude Code, Codex); null when it doesn't. */
  workingMs: number | null;
  /** Claude Code subagent conversations included. */
  subagents: number;
  /** The agent is still running in the terminal (false: the session's last numbers). */
  live: boolean;
}

const MAX_MODELS = 12;
const n = (v: unknown, max = 1e13): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null);
const MODEL_RE = /^[\w.:/@-]{1,100}$/;

/** Validates a usage report (from main, before the page keeps it). */
export function parseAgentUsage(v: unknown): AgentUsage | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (!isResumableAgent(r.agent) || !Array.isArray(r.models)) return null;
  const models: ModelUsage[] = [];
  for (const m of r.models.slice(0, MAX_MODELS) as unknown[]) {
    if (!m || typeof m !== 'object') return null;
    const x = m as Record<string, unknown>;
    const nums = [n(x.input), n(x.cacheRead), n(x.cacheWrite), n(x.output), n(x.reasoning), n(x.requests)];
    if (typeof x.model !== 'string' || !MODEL_RE.test(x.model) || nums.some((k) => k === null)) return null;
    const cost = x.costUsd === null ? null : n(x.costUsd, 1e9);
    if (cost === null && x.costUsd !== null) return null;
    models.push({ model: x.model, input: nums[0]!, cacheRead: nums[1]!, cacheWrite: nums[2]!, output: nums[3]!, reasoning: nums[4]!, requests: nums[5]!, costUsd: cost });
  }
  const tokens = n(r.tokens);
  const cost = r.costUsd === null ? null : n(r.costUsd, 1e9);
  if (tokens === null || (cost === null && r.costUsd !== null)) return null;
  let context: AgentUsage['context'] = null;
  if (r.context && typeof r.context === 'object') {
    const c = r.context as Record<string, unknown>;
    const used = n(c.used);
    const limit = c.limit === null ? null : n(c.limit);
    if (used !== null && (limit !== null || c.limit === null)) context = { used, limit: limit && limit > 0 ? limit : null };
  }
  const time = (t: unknown) => (t === null ? null : n(t, 8.64e15));
  return {
    agent: r.agent,
    models,
    tokens,
    costUsd: cost,
    costPartial: r.costPartial === true,
    context,
    startedAt: time(r.startedAt),
    lastAt: time(r.lastAt),
    workingMs: r.workingMs === null ? null : n(r.workingMs),
    subagents: n(r.subagents, 1e6) ?? 0,
    live: r.live !== false,
  };
}

/** 950, 12.4K, 1.2M, 3.4B. */
export function formatTokens(v: number): string {
  if (v < 1000) return String(Math.round(v));
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, unit] of units) {
    if (v >= size) {
      const x = v / size;
      return `${x >= 100 ? Math.round(x) : x.toFixed(1).replace(/\.0$/, '')}${unit}`;
    }
  }
  return String(v);
}

/** $0.004 → "<$0.01", $3.413 → "$3.41", $1234.5 → "$1,235". */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  if (usd >= 1000) return `$${Math.round(usd).toLocaleString('en-US')}`;
  return `$${usd.toFixed(2)}`;
}

/** 45s, 12m, 1h 12m, 3d 4h. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Context use in percent (0–100), or null without a known window. */
export function contextPercent(u: Pick<AgentUsage, 'context'>): number | null {
  if (!u.context?.limit) return null;
  return Math.min(100, Math.round((u.context.used / u.context.limit) * 100));
}

/** The short readout: "ctx 42% · 1.2M tokens · 1h 12m · ≈ $3.41" (cost only when asked for). */
export function usageSummary(u: AgentUsage, withCost: boolean): string {
  const parts: string[] = [];
  const pct = contextPercent(u);
  if (pct !== null) parts.push(`ctx ${pct}%`);
  else if (u.context) parts.push(`ctx ${formatTokens(u.context.used)}`);
  parts.push(`${formatTokens(u.tokens)} tokens`);
  if (u.workingMs !== null && u.workingMs > 0) parts.push(formatDuration(u.workingMs));
  if (withCost) parts.push(u.costUsd === null ? 'cost unknown' : `≈ ${formatCost(u.costUsd)}${u.costPartial ? '+' : ''}`);
  return parts.join(' · ');
}

export const USAGE_COST_NOTE =
  'API-equivalent: what these tokens would cost at the provider’s public API prices. It is not what a subscription (Claude Pro or Max, ChatGPT, Gemini) charges.';

export type { ResumableAgent };
