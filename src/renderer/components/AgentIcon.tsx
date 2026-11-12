/// <reference types="vite/client" />
// Logo of the AI agent running in a terminal, with a small state badge.
// Logos: developer-icons (MIT), see src/renderer/assets/agent-icons/README.md.
// Dark logos are drawn as a mask in the theme's text colour so they stay
// visible on the dark tabs.
import type { AgentId } from '../../shared/agents';
import type { AgentState } from '../features/terminal/agent-status';
import claudeUrl from '../assets/agent-icons/claude-ai.svg?url';
import copilotUrl from '../assets/agent-icons/github-copilot.svg?url';
import cursorUrl from '../assets/agent-icons/cursor-light.svg?url';
import geminiUrl from '../assets/agent-icons/gemini.svg?url';
import openaiUrl from '../assets/agent-icons/openai.svg?url';

const ICONS: Partial<Record<AgentId, { url: string; mono: boolean }>> = {
  claude: { url: claudeUrl, mono: false },
  codex: { url: openaiUrl, mono: true },
  gemini: { url: geminiUrl, mono: false },
  copilot: { url: copilotUrl, mono: true },
  cursor: { url: cursorUrl, mono: false },
};

export function AgentIcon({ agent, state, estimated = false, size = 16 }: { agent: AgentId | null; state: AgentState; estimated?: boolean; size?: number }) {
  const icon = agent ? ICONS[agent] : undefined;
  return (
    <span className={`agent-icon agent-icon--${state}${estimated ? ' agent-icon--estimated' : ''}`} style={{ width: size, height: size }} aria-hidden="true">
      {icon && !icon.mono && <img src={icon.url} alt="" width={size} height={size} draggable={false} />}
      {icon?.mono && <span className="agent-icon__mask" style={{ WebkitMaskImage: `url("${icon.url}")`, maskImage: `url("${icon.url}")` }} />}
      {!icon && (
        // Generic agent mark (original): a four-point sparkle.
        <svg viewBox="0 0 24 24" width={size} height={size} className="agent-icon__generic">
          <path d="M12 2.5c.6 4.6 2.9 6.9 7.5 7.5-4.6.6-6.9 2.9-7.5 7.5-.6-4.6-2.9-6.9-7.5-7.5 4.6-.6 6.9-2.9 7.5-7.5z" fill="currentColor" />
          <path d="M19 15.5c.25 1.9 1.1 2.75 3 3-1.9.25-2.75 1.1-3 3-.25-1.9-1.1-2.75-3-3 1.9-.25 2.75-1.1 3-3z" fill="currentColor" opacity="0.7" />
        </svg>
      )}
      <span className="agent-icon__badge" />
    </span>
  );
}
