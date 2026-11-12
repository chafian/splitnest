// What an AI agent CLI in a terminal is doing. Pure logic (no DOM).
//
// Primary source: the Program Status Protocol (OSC 7501), where a program
// reports its own state (idle / working / done / blocked / error). Codex sends
// it on its own; Claude Code sends it once the terminal answers its `?` query.
// Spec: https://control-codes.page/proposals/osc-7501/
//
// Fallback when an agent does not report: terminal bell = needs action, a
// spinner in the title or recent output = working, otherwise idle. These are
// guesses and are labelled as such.
import { agentFromApp, agentById, type AgentId } from '../../../shared/agents';

export type ProgramState = 'idle' | 'working' | 'blocked' | 'done' | 'error';
export type BlockKind = 'permission' | 'question' | 'auth';

export interface StatusRecord {
  id: string;
  state: ProgramState;
  kind: BlockKind | null;
  progress: number | null;
  app: string | null;
  title: string | null;
  msg: string | null;
  updated: number;
}

export type StatusCommand =
  | { type: 'query' }
  | { type: 'clear'; id: string }
  | { type: 'report'; record: Omit<StatusRecord, 'updated'> };

/** Answer to `OSC 7501 ; ?` (feature detection), as the spec defines it. */
export const PROGRAM_STATUS_REPLY = '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\';

const STATES = new Set(['idle', 'working', 'blocked', 'done', 'error']);
const KINDS = new Set(['permission', 'question', 'auth']);
const MAX_RECORDS = 64;

function decodeBase64Text(value: string, maxEncoded: number, maxDecoded: number): string | null | undefined {
  if (value.length > maxEncoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return undefined;
  let text: string;
  try {
    const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  if ([...text].length > maxDecoded) return undefined;
  // Control characters are refused; direction overrides and invisible formatting are neutralised.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) return undefined;
  return text.replace(/[​-‏‪-‮⁦-⁩﻿]/g, '').trim() || null;
}

/**
 * Parses the body of an OSC 7501 sequence (what follows `7501;`). Returns
 * null for anything malformed; the whole report is then ignored.
 */
export function parseProgramStatus(body: string): StatusCommand | null {
  if (body.length > 4096) return null;
  if (body === '?' || body.startsWith('?:')) return { type: 'query' };
  const pairs = new Map<string, string>();
  for (const part of body.split(':')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue; // malformed pair: skipped
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key.length > 16 || !/^[a-z]+$/.test(key) || !/^[A-Za-z0-9_.,+/=-]*$/.test(value)) continue;
    pairs.set(key, value); // last one wins
  }
  const state = pairs.get('state');
  let id = pairs.get('id') ?? '';
  if (id) {
    const segs = id.split('/');
    if (id.length > 128 || segs.length > 8 || segs.some((s) => !s || s.length > 32)) return null;
    id = segs.join('/');
  }
  if (state === 'clear') return { type: 'clear', id };
  if (!state || !STATES.has(state)) return null;
  const kindRaw = pairs.get('kind');
  const kind = state === 'blocked' && kindRaw && KINDS.has(kindRaw) ? (kindRaw as BlockKind) : null;
  const progressRaw = pairs.get('progress');
  const progressNum = progressRaw !== undefined && /^\d{1,3}$/.test(progressRaw) ? Number(progressRaw) : NaN;
  const progress = (state === 'working' || state === 'blocked') && progressNum >= 0 && progressNum <= 100 ? progressNum : null;
  const appRaw = pairs.get('app');
  if (appRaw !== undefined && (appRaw.length > 32 || !/^[A-Za-z0-9_.+-]*$/.test(appRaw))) return null;
  const title = pairs.has('title') ? decodeBase64Text(pairs.get('title')!, 256, 192) : null;
  const msg = pairs.has('msg') ? decodeBase64Text(pairs.get('msg')!, 2732, 2048) : null;
  if (title === undefined || msg === undefined) return null; // invalid base64 or control characters: discard whole report
  return { type: 'report', record: { id, state: state as ProgramState, kind, progress, app: appRaw || null, title, msg } };
}

const PRIORITY: Record<ProgramState, number> = { blocked: 5, error: 4, working: 3, done: 2, idle: 1 };

/** The program-status records of one terminal. */
export class StatusRecords {
  private readonly records = new Map<string, StatusRecord>();
  private seq = 0;

  get size(): number {
    return this.records.size;
  }

  /** Applies a report or clear; returns true if anything changed. */
  apply(command: StatusCommand): boolean {
    if (command.type === 'query') return false;
    if (command.type === 'clear') {
      if (!command.id) {
        const had = this.records.size > 0;
        this.records.clear();
        return had;
      }
      let changed = false;
      for (const key of [...this.records.keys()]) {
        if (key === command.id || key.startsWith(`${command.id}/`)) changed = this.records.delete(key) || changed;
      }
      return changed;
    }
    // Each report replaces its record completely.
    this.records.delete(command.record.id);
    this.records.set(command.record.id, { ...command.record, updated: ++this.seq });
    while (this.records.size > MAX_RECORDS) {
      let oldest: StatusRecord | null = null;
      for (const r of this.records.values()) if (!oldest || r.updated < oldest.updated) oldest = r;
      if (oldest) this.records.delete(oldest.id);
    }
    return true;
  }

  /** New shell prompt or the program exited: working and blocked (and idle) records go; done/error stay. */
  dropTransient(): boolean {
    let changed = false;
    for (const [key, r] of [...this.records]) {
      if (r.state === 'working' || r.state === 'blocked' || r.state === 'idle') changed = this.records.delete(key) || changed;
    }
    return changed;
  }

  clearAll(): boolean {
    const had = this.records.size > 0;
    this.records.clear();
    return had;
  }

  /** `done`/`error` the user has now seen: drop them. */
  acknowledge(): boolean {
    let changed = false;
    for (const [key, r] of [...this.records]) if (r.state === 'done' || r.state === 'error') changed = this.records.delete(key) || changed;
    return changed;
  }

  /** The most important record (blocked > error > working > done > idle), with `app` inherited from ancestors. */
  summary(): (StatusRecord & { app: string | null }) | null {
    let best: StatusRecord | null = null;
    for (const r of this.records.values()) {
      if (!best || PRIORITY[r.state] > PRIORITY[best.state] || (PRIORITY[r.state] === PRIORITY[best.state] && r.updated > best.updated)) best = r;
    }
    if (!best) return null;
    let app = best.app;
    for (let id = best.id; !app && id; ) {
      id = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '';
      app = this.records.get(id)?.app ?? null;
    }
    const title = best.title ?? this.records.get('')?.title ?? null;
    return { ...best, app, title };
  }
}

// ---------------------------------------------------------------- titles

/** Spinner / status glyphs agents put in front of their title. */
const TITLE_STATUS = /^[⠀-⣿◐-◓✢-✽·*]+\s*/;
const SPINNER = /^[⠀-⣿◐-◓]/;

export function stripTitleStatus(title: string): string {
  return title.replace(TITLE_STATUS, '').trim();
}

/** The title says a program finished (shell reset it to its own path, or cleared it). */
export function titleLooksLikeShell(title: string | null): boolean {
  if (title === null) return false;
  const t = title.trim();
  return t === '' || /\\(powershell|pwsh|cmd|wsl|bash)\.exe$/i.test(t);
}

/** The title starts with an agent's status glyph (spinner, ✳ …). Shell titles never do. */
export function hasTitleStatus(title: string | null): boolean {
  return !!title && TITLE_STATUS.test(title);
}

/**
 * WSL fallback (no process detection there): Claude Code's own idle/working title, exactly
 * "<status glyph> Claude Code". Any other title mentioning it (a folder name in a bash title,
 * an echo) does not count.
 */
export function agentFromTitle(title: string | null): AgentId | null {
  if (!title || !hasTitleStatus(title)) return null;
  return /^claude code$/i.test(stripTitleStatus(title)) ? 'claude' : null;
}

// ---------------------------------------------------------------- view

export type AgentState = 'working' | 'idle' | 'needs-action' | 'done' | 'error';

export interface AgentView {
  id: AgentId | null;
  /** "Claude Code", or the program's own `app` name for programs SplitNest doesn't know. */
  label: string;
  state: AgentState;
  kind: BlockKind | null;
  /** Session title (from the status report, or Claude Code's terminal title). */
  title: string | null;
  message: string | null;
  progress: number | null;
  /** `protocol`: the agent reported it; `heuristic`: guessed from bell / title / output. */
  source: 'protocol' | 'heuristic';
  /**
   * An unseen notification (terminal bell) — separate from `state`. Looking at the tab clears it;
   * it never changes or clears what the agent reported (a pending permission stays pending).
   */
  attention: boolean;
  /**
   * The agent's identity is backed by more than its own claim: process detection found that
   * agent in this terminal (PowerShell tabs), or process detection isn't available (WSL tabs,
   * where the report is all there is). Windows notifications require it, so a program that only
   * prints a status report naming another agent can't raise one.
   */
  confirmed: boolean;
}

export interface AgentInputs {
  summary: ReturnType<StatusRecords['summary']>;
  /** Found in the shell's process tree (PowerShell tabs). */
  processAgent: AgentId | null;
  /** Process detection runs for this terminal (false for WSL, where Linux processes aren't visible). */
  processDetection: boolean;
  /** Recognised from the terminal title (WSL tabs only, where processes aren't visible). */
  titleAgent: AgentId | null;
  shellTitle: string | null;
  /** A bell arrived and the user has not looked at the tab since. */
  bellPending: boolean;
  /** Output arrived in the last couple of seconds (only used for an identified agent). */
  recentOutput: boolean;
  /** The running agent has sent status reports: its state is never guessed from bell/output. */
  reportedThisRun: boolean;
}

export function deriveAgentView(i: AgentInputs): AgentView | null {
  const s = i.summary;
  const fromApp = agentFromApp(s?.app);
  // Identity only from explicit evidence: the agent's own report, its process, or its exact title.
  // Output, bells and spinners never make a program an agent.
  const id: AgentId | null = fromApp?.id ?? i.processAgent ?? i.titleAgent;
  if (!s && !id) return null;
  const def = agentById(id);
  const label = def?.label ?? s?.app ?? 'Program';
  const stripped = i.shellTitle ? stripTitleStatus(i.shellTitle) : '';
  // Claude Code names its terminal after the conversation; other agents' titles aren't session names.
  const titleFromTerminal = id === 'claude' && stripped && !/^claude( code)?$/i.test(stripped) && !titleLooksLikeShell(stripped) ? stripped : null;
  const title = s?.title ?? titleFromTerminal;
  const confirmed = !i.processDetection || (id !== null && i.processAgent === id);
  if (s) {
    // Exactly what the agent reported. A bell is only a notification on top of it.
    const state: AgentState = s.state === 'blocked' ? 'needs-action' : s.state;
    return { id, label, state, kind: s.kind, title, message: s.msg, progress: s.progress, source: 'protocol', attention: i.bellPending, confirmed };
  }
  if (i.reportedThisRun) {
    // A reporting agent with no current record (its "done" was seen): idle, not a guess.
    return { id, label, state: 'idle', kind: null, title, message: null, progress: null, source: 'protocol', attention: i.bellPending, confirmed };
  }
  const working = (i.shellTitle !== null && SPINNER.test(i.shellTitle)) || i.recentOutput;
  const state: AgentState = i.bellPending ? 'needs-action' : working ? 'working' : 'idle';
  return { id, label, state, kind: null, title, message: null, progress: null, source: 'heuristic', attention: i.bellPending, confirmed };
}

export const AGENT_STATE_TEXT: Record<AgentState, string> = {
  working: 'Working',
  idle: 'Idle',
  'needs-action': 'Needs you',
  done: 'Done',
  error: 'Error',
};

export function agentStateText(v: AgentView): string {
  if (v.state === 'needs-action' && v.kind === 'permission') return 'Needs permission';
  if (v.state === 'needs-action' && v.kind === 'question') return 'Has a question';
  if (v.state === 'needs-action' && v.kind === 'auth') return 'Needs sign-in';
  if (v.state === 'working' && v.progress !== null) return `Working ${v.progress}%`;
  return AGENT_STATE_TEXT[v.state];
}
