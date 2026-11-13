// Resuming an agent conversation after a restart (Claude Code, Codex and Gemini CLI; see
// src/main/agent-sessions.ts for how the session is found).

export type ResumableAgent = 'claude' | 'codex' | 'gemini';
export const RESUMABLE_AGENTS: readonly ResumableAgent[] = ['claude', 'codex', 'gemini'];
export const isResumableAgent = (v: unknown): v is ResumableAgent => (RESUMABLE_AGENTS as readonly unknown[]).includes(v);

/** Saved with a terminal tab while its agent runs; what "Resume" will reopen. */
export interface AgentResume {
  agent: ResumableAgent;
  /** The conversation to reopen; null = not known for sure, so the agent's own picker is offered. */
  sessionId: string | null;
  /** The folder the agent ran in (the shell starts there to resume). */
  cwd: string;
  /** True when the id comes from the agent's own record for this process (not a folder/time match). */
  exact: boolean;
  /** When this was last confirmed (ms since epoch). */
  at: number;
  /** The conversation's title (setting `resumeTitles`); plain text, at most TITLE_MAX characters. */
  title?: string;
}

export const TITLE_MAX = 120;

/** A title as plain text: no control or direction characters, spaces collapsed, length capped. */
export function cleanTitle(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Session ids are UUIDs for all three agents; nothing else is ever put on a command line. */
export const isResumeId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** Validates a value from the page or the state file. */
export function parseAgentResume(v: unknown): AgentResume | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (!isResumableAgent(r.agent)) return null;
  if (r.sessionId !== null && !isResumeId(r.sessionId)) return null;
  if (typeof r.cwd !== 'string' || r.cwd.length < 3 || r.cwd.length > 4096 || /[\0\r\n]/.test(r.cwd) || !/^([a-zA-Z]:[\\/]|\\\\)/.test(r.cwd)) return null;
  if (typeof r.exact !== 'boolean' || typeof r.at !== 'number' || !Number.isFinite(r.at)) return null;
  const title = cleanTitle(r.title);
  return { agent: r.agent, sessionId: r.sessionId, cwd: r.cwd, exact: r.exact && r.sessionId !== null, at: r.at, ...(title ? { title } : {}) };
}

export const RESUME_LABEL: Record<ResumableAgent, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' };

/**
 * The command typed into a new PowerShell to reopen the conversation. Built only from the agent
 * id and a validated UUID. Without an id, Claude Code and Codex open their own list of earlier
 * conversations of the current folder; Gemini CLI has no such list on its command line, so
 * `gemini --resume` reopens its most recent conversation in the folder (`/resume` there picks another).
 */
export function resumeCommand(r: Pick<AgentResume, 'agent' | 'sessionId'>): string {
  const id = r.sessionId !== null && isResumeId(r.sessionId) ? r.sessionId : null;
  if (r.agent === 'claude') return id ? `claude --resume ${id}` : 'claude --resume';
  if (r.agent === 'gemini') return id ? `gemini --resume ${id}` : 'gemini --resume';
  return id ? `codex resume ${id}` : 'codex resume';
}

/** What Resume does when the exact conversation isn't known (shown in the pane). */
export function resumeFallbackText(agent: ResumableAgent, cwd: string): string {
  return agent === 'gemini'
    ? `The exact conversation isn't known, so Resume opens Gemini CLI's most recent conversation in ${cwd} (type /resume there to pick another).`
    : `The exact conversation isn't known, so Resume opens ${RESUME_LABEL[agent]}'s list of earlier conversations in ${cwd}.`;
}
