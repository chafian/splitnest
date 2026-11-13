// AI agent CLIs SplitNest recognises in a terminal, and how.
//
// Detection only ever yields an agent id; command lines stay in the main
// process and are never logged or sent to the page.

export type AgentId = 'claude' | 'codex' | 'gemini' | 'copilot' | 'cursor' | 'aider' | 'opencode' | 'qwen' | 'amp';

export interface AgentDef {
  id: AgentId;
  label: string;
  /** Matches a process image name (e.g. `claude.exe`). */
  name?: RegExp;
  /** Matches a process command line (e.g. a Node package path). */
  cmd?: RegExp;
  /** `app=` values used in OSC 7501 program-status reports. */
  apps: string[];
}

export const AGENTS: readonly AgentDef[] = [
  { id: 'claude', label: 'Claude Code', name: /^claude(\.exe)?$/i, cmd: /@anthropic-ai[\\/]claude-code/i, apps: ['claude-code', 'claude'] },
  { id: 'codex', label: 'Codex', name: /^codex(\.exe)?$/i, cmd: /@openai[\\/]codex/i, apps: ['codex', 'codex-cli'] },
  { id: 'gemini', label: 'Gemini CLI', name: /^gemini(\.exe)?$/i, cmd: /@google[\\/]gemini-cli/i, apps: ['gemini', 'gemini-cli'] },
  { id: 'copilot', label: 'GitHub Copilot CLI', name: /^copilot(\.exe)?$/i, cmd: /@github[\\/]copilot/i, apps: ['copilot', 'github-copilot'] },
  { id: 'cursor', label: 'Cursor Agent', name: /^cursor-agent(\.exe)?$/i, cmd: /cursor-agent/i, apps: ['cursor-agent', 'cursor'] },
  { id: 'aider', label: 'Aider', name: /^aider(\.exe)?$/i, cmd: /(^|[\\/\s"])aider(\.exe)?("|\s|$)/i, apps: ['aider'] },
  { id: 'opencode', label: 'OpenCode', name: /^opencode(\.exe)?$/i, cmd: /[\\/]opencode-ai[\\/]|(^|[\\/\s"])opencode(\.exe)?("|\s|$)/i, apps: ['opencode'] },
  { id: 'qwen', label: 'Qwen Code', name: /^qwen(\.exe)?$/i, cmd: /@qwen-code[\\/]/i, apps: ['qwen', 'qwen-code'] },
  { id: 'amp', label: 'Amp', name: /^amp(\.exe)?$/i, cmd: /@sourcegraph[\\/]amp/i, apps: ['amp'] },
];

export const agentById = (id: string | null | undefined): AgentDef | undefined => AGENTS.find((a) => a.id === id);

export function agentFromApp(app: string | null | undefined): AgentDef | undefined {
  if (!app) return undefined;
  const a = app.toLowerCase();
  return AGENTS.find((d) => d.apps.includes(a));
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  cmd: string;
}

/** Every process below `rootPid` (not including it), breadth-first. */
export function descendants(processes: readonly ProcessInfo[], rootPid: number): ProcessInfo[] {
  const byParent = new Map<number, ProcessInfo[]>();
  for (const p of processes) {
    if (p.pid === p.ppid) continue;
    const list = byParent.get(p.ppid) ?? [];
    list.push(p);
    byParent.set(p.ppid, list);
  }
  const out: ProcessInfo[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length && out.length < 2000) {
    for (const child of byParent.get(queue.shift()!) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

/** The agent running under a shell, from its descendant processes (nearest first). */
export function detectAgent(processes: readonly ProcessInfo[], shellPid: number): AgentId | null {
  return findAgent(processes, shellPid)?.id ?? null;
}

/** The agent and the process it was recognised by (its pid is what the agent's own records use). */
export function findAgent(processes: readonly ProcessInfo[], shellPid: number): { id: AgentId; process: ProcessInfo } | null {
  for (const p of descendants(processes, shellPid)) {
    const a = agentOfProcess(p);
    if (a) return { id: a.id, process: p };
  }
  return null;
}

/** The agent a process is, by its image name or command line. */
export function agentOfProcess(p: Pick<ProcessInfo, 'name' | 'cmd'>): AgentDef | undefined {
  return AGENTS.find((a) => (a.name && a.name.test(p.name)) || (a.cmd && a.cmd.test(p.cmd)));
}
