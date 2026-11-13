// Keeps terminal controllers alive independently of React components and
// routes session events from the backend to the right controller.
import type { TaskAgent } from '../../../shared/tasks';
import type { SessionEvent } from '../../../shared/types';
import type { AgentResume } from '../../../shared/agent-resume';
import type { AgentId } from '../../../shared/agents';
import { DEFAULT_THEME_ID, themeById, type Theme } from '../appearance/themes';
import { api } from '../../api';
import { flushSave } from '../workspaces/persistence';
import { countRunningShells } from './shell-count';
import { TerminalController } from './terminal-controller';

interface EarlyBuffer {
  events: SessionEvent[];
  chars: number;
  at: number;
}

const EARLY_MAX_CHARS = 1024 * 1024;
const EARLY_TTL_MS = 10_000;

export interface AgentCounts {
  needs: number;
  maybe: number;
  working: number;
  total: number;
}

export class TerminalRegistry {
  private readonly controllers = new Map<string, TerminalController>();
  private readonly bySession = new Map<string, TerminalController>();
  private readonly early = new Map<string, EarlyBuffer>();
  private readonly ended = new Set<string>();
  private shortcutHandler: (event: KeyboardEvent) => boolean = () => false;
  private focusHandler: (paneId: string) => void = () => undefined;
  private resumeHandler: (tabId: string, resume: AgentResume | null) => void = () => undefined;
  private settings = { fontSize: 14, scrollback: 10_000, shortPrompt: true };

  constructor() {
    api.onSessionEvent((event) => this.route(event));
    api.onSessionAgent(({ sessionId, agent }) => this.bySession.get(sessionId)?.setProcessAgent(agent));
    api.onSessionResume(({ sessionId, resume }) => {
      const c = this.bySession.get(sessionId);
      if (c) this.resumeHandler(c.paneId, resume);
    });
  }

  /** The agent conversation in a terminal changed (see TerminalTab.resume). */
  setResumeHandler(handler: (tabId: string, resume: AgentResume | null) => void): void {
    this.resumeHandler = handler;
  }

  /** Agents among `tabIds`: how many need the user and how many are working. */
  /** `needs`/`working` are what agents reported; `maybe` = estimated "needs you" (e.g. a bell). */
  agentCounts(tabIds: Iterable<string>): AgentCounts {
    const counts: AgentCounts = { needs: 0, maybe: 0, working: 0, total: 0 };
    for (const id of tabIds) {
      const a = this.controllers.get(id)?.getSnapshot().agent;
      if (!a) continue;
      counts.total++;
      if (a.state === 'needs-action' && a.source === 'heuristic') counts.maybe++;
      else if (a.state === 'needs-action' || a.state === 'error') counts.needs++;
      else if (a.state === 'working') counts.working++;
    }
    return counts;
  }

  setShortcutHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.shortcutHandler = handler;
  }

  setFocusHandler(handler: (paneId: string) => void): void {
    this.focusHandler = handler;
  }

  get(paneId: string): TerminalController | undefined {
    return this.controllers.get(paneId);
  }

  /** New agent tasks: the agent to start in a tab once its terminal is created (and auto-started). */
  private readonly agentStarts = new Map<string, TaskAgent>();

  /** Before the tab is shown: its terminal starts the shell and then this agent. */
  startAgentOnCreate(tabId: string, agent: TaskAgent): void {
    this.agentStarts.set(tabId, agent);
  }

  getOrCreate(paneId: string, workspaceId: string, autoStart: boolean): TerminalController {
    const existing = this.controllers.get(paneId);
    if (existing) return existing;
    const autoAgent = autoStart ? this.agentStarts.get(paneId) : undefined;
    this.agentStarts.delete(paneId);
    const controller = new TerminalController({
      paneId,
      workspaceId,
      ...(autoAgent ? { autoAgent } : {}),
      fontSize: this.settings.fontSize,
      scrollback: this.settings.scrollback,
      theme: this.theme,
      autoStart,
      hooks: {
        onShortcut: (event) => this.shortcutHandler(event),
        // Yield first: the commit that created this pane queues its save after
        // child layout effects run, so flush only once that has happened.
        beforeStart: () => new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => flushSave()),
        onFocus: (id) => this.focusHandler(id),
        shortPrompt: () => this.settings.shortPrompt,
        bindSession: (sessionId, c) => this.bind(sessionId, c),
        forgetResume: () => this.resumeHandler(paneId, null),
        // The folder is filled in by the app (the workspace folder; the agent's own list opens there).
        wslAgent: (agent) => this.resumeHandler(paneId, agent ? { agent, sessionId: null, cwd: '', exact: false, at: Date.now() } : null),
        unbindSession: (sessionId) => this.unbind(sessionId),
      },
    });
    this.controllers.set(paneId, controller);
    if (this.testTermOptions) controller.setTestTermOptions(this.testTermOptions);
    controller.subscribe(() => this.notify());
    return controller;
  }

  // Coarse change notifications (session status only; never per output chunk).
  private readonly listeners = new Set<() => void>();
  private version = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private notify(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  dispose(paneId: string): void {
    const controller = this.controllers.get(paneId);
    if (!controller) return;
    this.controllers.delete(paneId);
    controller.dispose();
    this.notify();
  }

  /** Terminals among `tabIds` whose shell session is running (see countRunningShells). */
  runningCount(tabIds: Iterable<string>): number {
    return countRunningShells([...tabIds].map((id) => this.controllers.get(id)?.getSnapshot().status));
  }

  liveCount(paneIds?: Iterable<string>): number {
    const ids = paneIds ? [...paneIds] : [...this.controllers.keys()];
    return ids.filter((id) => this.controllers.get(id)?.isLive).length;
  }

  /** Settings › Appearance: recolours every terminal now and in the future. */
  private theme: Theme = themeById(DEFAULT_THEME_ID);
  applyTheme(theme: Theme): void {
    if (theme === this.theme) return;
    this.theme = theme;
    for (const c of this.controllers.values()) c.setTheme(theme);
  }

  applySettings(settings: { fontSize: number; scrollback: number; shortPrompt: boolean }): void {
    const fontChanged = settings.fontSize !== this.settings.fontSize;
    const scrollChanged = settings.scrollback !== this.settings.scrollback;
    this.settings = { ...settings };
    for (const c of this.controllers.values()) {
      if (fontChanged) c.setFontSize(settings.fontSize);
      if (scrollChanged) c.setScrollback(settings.scrollback);
    }
  }

  /** E2E diagnostics only (see __twTest.termOptions). */
  private testTermOptions: { reflowCursorLine?: boolean; windowsPtyBuild?: number; webgl?: boolean; resizeLog?: boolean } | null = null;
  setTestTermOptions(o: { reflowCursorLine?: boolean; windowsPtyBuild?: number; webgl?: boolean; resizeLog?: boolean }): void {
    this.testTermOptions = o;
    for (const c of this.controllers.values()) c.setTestTermOptions(o);
  }

  private bind(sessionId: string, controller: TerminalController): void {
    this.bySession.set(sessionId, controller);
    const buffered = this.early.get(sessionId);
    if (buffered) {
      this.early.delete(sessionId);
      for (const event of buffered.events) controller.handleEvent(event);
    }
  }

  private unbind(sessionId: string): void {
    this.bySession.delete(sessionId);
    this.ended.add(sessionId);
    if (this.ended.size > 500) this.ended.delete(this.ended.values().next().value as string);
  }

  /**
   * Output can arrive before createSession() resolves in the renderer; it is
   * held briefly (bounded) and replayed when the session binds.
   */
  private route(event: SessionEvent): void {
    const controller = this.bySession.get(event.sessionId);
    if (controller) {
      controller.handleEvent(event);
      return;
    }
    if (this.ended.has(event.sessionId)) return;
    const now = Date.now();
    for (const [id, buf] of this.early) if (now - buf.at > EARLY_TTL_MS) this.early.delete(id);
    const buf = this.early.get(event.sessionId) ?? { events: [], chars: 0, at: now };
    const size = event.type === 'data' ? event.data.length : 0;
    if (buf.chars + size > EARLY_MAX_CHARS) return;
    buf.events.push(event);
    buf.chars += size;
    this.early.set(event.sessionId, buf);
  }
}

export const registry = new TerminalRegistry();

// End-to-end test hook. Main adds `?e2e=1` only for unpackaged builds started
// with TW_E2E=1, so packaged builds never expose it.
if (new URLSearchParams(window.location.search).get('e2e') === '1') {
  (window as unknown as Record<string, unknown>).__twTest = {
    inspect: (paneId: string, lines?: number, raw?: boolean) => registry.get(paneId)?.inspect(lines, raw) ?? null,
    status: (paneId: string) => registry.get(paneId)?.getSnapshot().status ?? null,
    cursorRow: (tabId: string) => registry.get(tabId)?.cursorRow() ?? null,
    geometry: (tabId: string) => registry.get(tabId)?.testGeometry() ?? null,
    resizes: (tabId: string) => registry.get(tabId)?.testResizes() ?? [],
    /** Feed text to a terminal as session output (tests of the resize path with awkward output). */
    feed: (tabId: string, data: string) => registry.get(tabId)?.testFeed(data) ?? false,
    termBackground: (tabId: string) => registry.get(tabId)?.themeBackground() ?? null,
    /** Pretend process detection found (or lost) an agent, to exercise the estimated states. */
    fakeProcessAgent: (tabId: string, agent: AgentId | null) => {
      registry.get(tabId)?.setProcessAgent(agent);
      return true;
    },
    agent: (tabId: string) => registry.get(tabId)?.getSnapshot().agent ?? null,
    statusLog: (tabId: string) => registry.get(tabId)?.statusLog ?? [],
    title: (tabId: string) => registry.get(tabId)?.getSnapshot().shellTitle ?? null,
    /** Diagnostics: change resize-related xterm options on every terminal (and future ones). */
    termOptions: (o: { reflowCursorLine?: boolean; windowsPtyBuild?: number; webgl?: boolean; resizeLog?: boolean }) => registry.setTestTermOptions(o),
  };
}
