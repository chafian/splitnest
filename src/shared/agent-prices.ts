// API list prices, used only to show what an agent session's tokens would cost on the API
// ("API-equivalent"); it is not what a subscription charges. Shipped with the app and updated
// with releases: no network request. Sources, as of PRICES_AS_OF:
// - Anthropic: the Claude API model and pricing reference (first-party rates). Checked against
//   Claude Code's own per-model cost totals, which these rates reproduce to the cent.
// - OpenAI: developers.openai.com/api/docs/pricing (Standard tier). Requests over 272K input
//   tokens use the long-context rates.
// - Google: the Gemini Developer API pricing page (paid tier). Gemini 3.1 Pro and 2.5 Pro have
//   higher rates for prompts over 200K tokens; some prices change on a set date.
// A model missing here has an unknown cost (shown as such, never guessed). Rates are USD per
// 1M tokens.

export const PRICES_AS_OF = '2026-11-18';

export interface PriceCard {
  /** Input not read from a cache. */
  input: number;
  output: number;
  /** Input read from a cache. */
  cacheRead: number;
  /** Writing to a cache: Anthropic's 5-minute cache, OpenAI's 30-minute one. Default: the input rate. */
  cacheWrite?: number;
  /** Anthropic's 1-hour cache writes. Default: cacheWrite. */
  cacheWriteLong?: number;
}

interface PricedCard extends PriceCard {
  /** A request whose prompt is longer than `over` tokens uses `card` instead. */
  long?: { over: number; card: PriceCard };
}

export interface ModelInfo {
  provider: 'anthropic' | 'openai' | 'google';
  /** Context window in tokens, when known (Codex records its own). */
  context: number | null;
  price: PricedCard;
  /** Prices that apply from a date (UTC, YYYY-MM-DD), latest last. */
  changes?: { from: string; price: PricedCard }[];
}

/** Claude: cache reads and writes as published per model; fast mode is twice every rate. */
const claude = (input: number, output: number, cacheRead: number, context = 1_000_000): ModelInfo => ({
  provider: 'anthropic',
  context,
  price: { input, output, cacheRead, cacheWrite: input * 1.25, cacheWriteLong: input * 2 },
});

/** OpenAI: short context is up to 272K input tokens, long context above (the page's rows). */
const openai = (s: [number, number, number, number?], l?: [number, number, number, number?]): ModelInfo => ({
  provider: 'openai',
  context: null,
  price: {
    input: s[0],
    cacheRead: s[1],
    output: s[2],
    ...(s[3] !== undefined ? { cacheWrite: s[3] } : {}),
    ...(l ? { long: { over: 272_000, card: { input: l[0], cacheRead: l[1], output: l[2], ...(l[3] !== undefined ? { cacheWrite: l[3] } : {}) } } } : {}),
  },
});

const GEMINI_CONTEXT = 1_048_576;
const gemini = (input: number, output: number, cacheRead: number, context: number | null = GEMINI_CONTEXT, long?: { over: number; card: PriceCard }): ModelInfo => ({
  provider: 'google',
  context,
  price: { input, output, cacheRead, ...(long ? { long } : {}) },
});

const MODELS: Record<string, ModelInfo> = {
  // Anthropic
  'claude-fable-5-2': claude(8, 40, 0.2),
  'claude-mythos-5-2': claude(8, 40, 0.2),
  'claude-fable-5-1': claude(10, 50, 0.25),
  'claude-mythos-5-1': claude(10, 50, 0.25),
  'claude-fable-5': claude(10, 50, 1),
  'claude-mythos-5': claude(10, 50, 1),
  'claude-opus-5-5': claude(4, 20, 0.2),
  'claude-opus-5': claude(5, 25, 0.5),
  'claude-opus-4-8': claude(5, 25, 0.5),
  'claude-opus-4-7': claude(5, 25, 0.5),
  'claude-opus-4-6': claude(5, 25, 0.5),
  'claude-opus-4-5': claude(5, 25, 0.5, 200_000),
  'claude-sonnet-5-5': claude(2, 10, 0.1),
  'claude-sonnet-5': claude(2, 10, 0.2),
  'claude-sonnet-4-6': claude(3, 15, 0.3),
  'claude-sonnet-4-5': claude(3, 15, 0.3, 200_000),
  'claude-haiku-5-5': {
    provider: 'anthropic',
    context: 1_000_000,
    price: {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      cacheWriteLong: 0.2,
      long: { over: 100_000, card: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625, cacheWriteLong: 1 } },
    },
  },
  'claude-haiku-4-5': claude(1, 5, 0.1, 200_000),
  // OpenAI: [input, cached input, output, 30-minute cache write]
  'gpt-6.2-astra': openai([8, 0.4, 40, 10], [16, 0.8, 60, 20]),
  'gpt-6.2-sol': openai([2, 0.1, 10, 2.5], [4, 0.2, 15, 5]),
  'gpt-6-astra': openai([10, 1, 50, 12.5], [20, 2, 75, 25]),
  'gpt-6.1-sol': openai([2, 0.1, 10, 2.5], [4, 0.2, 15, 5]),
  'gpt-6.1-terra': openai([1, 0.05, 5, 1.25], [2, 0.1, 7.5, 2.5]),
  'gpt-6-luna': openai([0.1, 0.01, 0.5, 0.125], [0.2, 0.02, 0.75, 0.25]),
  'gpt-6-sol': openai([2, 0.2, 10, 2.5], [4, 0.4, 15, 5]),
  'gpt-5.6-sol': openai([4, 0.4, 20, 5], [8, 0.8, 30, 10]),
  'gpt-5.6-terra': openai([2, 0.2, 12, 2.5], [4, 0.4, 18, 5]),
  'gpt-5.6-luna': openai([0.2, 0.02, 1.2, 0.25], [0.4, 0.04, 1.8, 0.5]),
  'gpt-5.5': openai([5, 0.5, 30], [10, 1, 45]),
  'gpt-5.4': openai([2.5, 0.25, 15], [5, 0.5, 22.5]),
  'gpt-5.4-mini': openai([0.75, 0.075, 4.5]),
  'gpt-5.4-nano': openai([0.2, 0.02, 1.25]),
  'gpt-5.3-codex': openai([1.75, 0.175, 14]),
  'gpt-5.2': openai([1.75, 0.175, 14]),
  'gpt-5.1': openai([1.25, 0.125, 10]),
  'gpt-5': openai([1.25, 0.125, 10]),
  'gpt-5-mini': openai([0.25, 0.025, 2]),
  'gpt-5-nano': openai([0.05, 0.005, 0.4]),
  // Google (text prices)
  'gemini-4-carbon': { ...gemini(2, 10, 0.1, null), changes: [{ from: '2026-12-01', price: { input: 4, output: 20, cacheRead: 0.2 } }] },
  'gemini-4-argon': { ...gemini(2, 10, 0.1, null), changes: [{ from: '2026-12-01', price: { input: 4, output: 20, cacheRead: 0.2 } }] },
  'gemini-4-hydrogen': gemini(1.5, 7.5, 0.075, null),
  'gemini-3.8-flash': { ...gemini(0.75, 3.75, 0.075), changes: [{ from: '2027-01-01', price: { input: 1.5, output: 7.5, cacheRead: 0.15 } }] },
  'gemini-3.6-flash': { ...gemini(0.75, 3.75, 0.075), changes: [{ from: '2027-01-01', price: { input: 1.5, output: 7.5, cacheRead: 0.15 } }] },
  'gemini-3.5-flash-lite': gemini(0.3, 2.5, 0.03),
  'gemini-3.1-flash-lite': gemini(0.25, 1.5, 0.025),
  'gemini-3.1-pro-preview': gemini(2, 12, 0.2, GEMINI_CONTEXT, { over: 200_000, card: { input: 4, output: 18, cacheRead: 0.4 } }),
  'gemini-3.1-pro-preview-customtools': gemini(2, 12, 0.2, GEMINI_CONTEXT, { over: 200_000, card: { input: 4, output: 18, cacheRead: 0.4 } }),
  'gemini-3-flash-preview': gemini(0.5, 3, 0.05),
  'gemini-2.5-pro': gemini(1.25, 10, 0.125, GEMINI_CONTEXT, { over: 200_000, card: { input: 2.5, output: 15, cacheRead: 0.25 } }),
  'gemini-2.5-flash': gemini(0.3, 2.5, 0.03),
  'gemini-2.5-flash-lite': gemini(0.1, 0.4, 0.01),
};

/** Claude's web search: $10 per 1,000 searches. */
export const CLAUDE_WEB_SEARCH_USD = 0.01;

/**
 * The model's entry: exact id only (after removing a `models/` prefix and Anthropic's date
 * suffix), so a variant with other prices (a fast or "ultrafast" model) is never priced as another.
 */
export function modelInfo(model: string | null | undefined): ModelInfo | null {
  if (typeof model !== 'string' || model.length > 100) return null;
  const id = model.trim().toLowerCase().replace(/^models\//, '').replace(/^(claude-[a-z0-9-]+?)-20\d{6}$/, '$1');
  return Object.prototype.hasOwnProperty.call(MODELS, id) ? MODELS[id]! : null;
}

/** The rates for one request: by its date (ms since epoch) and its prompt's size in tokens. */
export function priceFor(model: string | null | undefined, at: number, promptTokens: number): PriceCard | null {
  const info = modelInfo(model);
  if (!info) return null;
  let priced: PricedCard = info.price;
  const day = Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : '';
  for (const c of info.changes ?? []) if (day >= c.from) priced = c.price;
  return priced.long && promptTokens > priced.long.over ? priced.long.card : priced;
}

/** Tokens of one request (or a sum of them) by kind; `output` includes reasoning. */
export interface TokenCounts {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWriteLong: number;
  output: number;
}

/** USD for these tokens at these rates; `multiplier` is 2 for Anthropic's fast mode. */
export function costOf(card: PriceCard, t: TokenCounts, multiplier = 1): number {
  const write = card.cacheWrite ?? card.input;
  const writeLong = card.cacheWriteLong ?? write;
  return ((t.input * card.input + t.cacheRead * card.cacheRead + t.cacheWrite * write + t.cacheWriteLong * writeLong + t.output * card.output) / 1_000_000) * multiplier;
}
