// Agent notifications: what an event is called and how its text is built. Shared so the in-app
// notice and the Windows notification read the same, and so main can build the Windows text
// itself from ids and names it already has (the page never supplies notification text).
import { agentById, type AgentId } from './agents';
import type { AppSettings } from './types';

/**
 * - `permission` / `question` / `auth` / `needs-you`: the agent reported it is blocked (with that
 *   reason, or none);
 * - `maybe`: estimated "may need you" (a bell from an agent that does not report);
 * - `done`: the agent reported it finished; `error`: it reported an error.
 */
export const NOTICE_KINDS = ['permission', 'question', 'auth', 'needs-you', 'maybe', 'done', 'error'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** What the page sends main for a Windows notification. */
export interface AgentNotice {
  workspaceId: string;
  tabId: string;
  kind: NoticeKind;
  /** A known agent, or null for a program SplitNest doesn't know (then `app` names it). */
  agent: AgentId | null;
  /** The program's own `app=` name from its status report (validated: letters, digits, `_.+-`). */
  app: string | null;
  /**
   * The page's current "Include what the agent wrote" choice. Main uses details only when this and
   * its own saved setting are both on, so turning it off applies at once (the saved state lags a
   * moment behind the page). With it off the page sends no session title or message at all.
   */
  details: boolean;
  /** The agent's session title and message: only shown when the user allows details. */
  session: string | null;
  message: string | null;
}

/** `shown`: a Windows notification is up; `in-app`: show the page's notice instead; `off`: settings say no. */
export type NoticeDelivery = 'shown' | 'in-app' | 'off' | 'invalid';

/** Where a click on a notification leads. */
export type NoticeTarget = { workspaceId: string; tabId: string } | { settings: 'notifications' };

export const NOTICE_LIMITS = { workspace: 64, tab: 64, session: 120, message: 300 } as const;

const APP_NAME = /^[A-Za-z0-9_.+-]{1,32}$/;

export const isNeedsKind = (kind: NoticeKind): boolean => kind !== 'done' && kind !== 'error';

/** The settings that decide whether this kind of event notifies at all. */
export function kindEnabled(kind: NoticeKind, s: Pick<AppSettings, 'notifyNeedsYou' | 'notifyFinished' | 'notifyErrors' | 'notifyEstimated'>): boolean {
  if (kind === 'done') return s.notifyFinished;
  if (kind === 'error') return s.notifyErrors;
  if (kind === 'maybe') return s.notifyNeedsYou && s.notifyEstimated;
  return s.notifyNeedsYou;
}

export function noticeAgentLabel(agent: AgentId | null, app: string | null): string {
  return agentById(agent)?.label ?? (app && APP_NAME.test(app) ? app : 'An agent');
}

/** SplitNest's own wording; nothing the agent wrote appears in the title. */
export function noticeTitle(kind: NoticeKind, label: string): string {
  switch (kind) {
    case 'permission':
      return `${label} needs permission`;
    case 'question':
      return `${label} has a question`;
    case 'auth':
      return `${label} needs sign-in`;
    case 'needs-you':
      return `${label} needs you`;
    case 'maybe':
      return `${label} may need you`;
    case 'done':
      return `${label} finished`;
    case 'error':
      return `${label} stopped with an error`;
  }
}

/** One line of plain text: no control or direction-changing characters, single spaces, capped. */
export function plainText(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  const t = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  const chars = [...t];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : t;
}

/**
 * The second line: the workspace, then the tab's own name (one the user gave it). Without one:
 * the agent's session title when details are allowed (it can contain prompt text), else the
 * agent's name. With details allowed, the agent's message follows on its own line.
 */
export function noticeBody(o: {
  workspace: string | null;
  tabName: string | null;
  label: string;
  details: boolean;
  session: string | null;
  message: string | null;
}): string {
  const workspace = plainText(o.workspace, NOTICE_LIMITS.workspace);
  const tab = plainText(o.tabName, NOTICE_LIMITS.tab);
  const session = o.details ? plainText(o.session, NOTICE_LIMITS.session) : null;
  const message = o.details ? plainText(o.message, NOTICE_LIMITS.message) : null;
  const line = [workspace, tab ?? session ?? o.label].filter(Boolean).join(' · ');
  return message ? `${line}\n${message}` : line;
}

/** Validates an AgentNotice from the page; null for anything malformed. */
export function parseAgentNotice(value: unknown, isId: (v: unknown) => v is string): AgentNotice | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!isId(v.workspaceId) || !isId(v.tabId)) return null;
  if (!(NOTICE_KINDS as readonly unknown[]).includes(v.kind)) return null;
  const agent = v.agent === null || v.agent === undefined ? null : agentById(v.agent as string)?.id;
  if (agent === undefined) return null;
  const app = v.app === null || v.app === undefined ? null : typeof v.app === 'string' && APP_NAME.test(v.app) ? v.app : undefined;
  if (app === undefined) return null;
  const text = (x: unknown, max: number) => (x === null || x === undefined ? null : typeof x === 'string' && x.length <= max * 4 ? x : undefined);
  const session = text(v.session, NOTICE_LIMITS.session);
  const message = text(v.message, NOTICE_LIMITS.message);
  if (session === undefined || message === undefined) return null;
  return { workspaceId: v.workspaceId, tabId: v.tabId, kind: v.kind as NoticeKind, agent, app, details: v.details === true, session, message };
}
