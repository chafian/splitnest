// The welcome screen's short guide for people who just installed SplitNest: what a workspace is,
// splitting panes, and how agents show up (tab state and the inbox). Shortcuts come from the
// bindings, so the guide never shows a key that doesn't work.
import { Icon, type IconName } from '../../components/Icon';
import { shortcutLabel, type CommandId } from '../commands/shortcuts';

interface Tip {
  icon: IconName;
  title: string;
  text: string;
  keys: [CommandId, string][];
}

export const WELCOME_TIPS: Tip[] = [
  {
    icon: 'folder',
    title: 'Workspaces',
    text: 'One per project folder, listed in the sidebar. Switch between them while their shells keep running.',
    keys: [['nextWorkspace', 'next workspace']],
  },
  {
    icon: 'splitRight',
    title: 'Split panes',
    text: 'Put PowerShell and WSL side by side. Each pane has its own tabs; drag a tab to move it.',
    keys: [
      ['splitRight', 'right'],
      ['splitDown', 'down'],
    ],
  },
  {
    icon: 'bell',
    title: 'Agents',
    text: 'Run Claude Code, Codex or another agent in a tab. The tab shows what it is doing, and the bell lists every agent waiting for you.',
    keys: [
      ['inbox', 'inbox'],
      ['nextAgent', 'next waiting'],
    ],
  },
];

export function WelcomeGuide() {
  return (
    <ul className="welcome__tips" aria-label="How SplitNest works" data-testid="welcome-tips">
      {WELCOME_TIPS.map((t) => (
        <li key={t.title} className="welcome-tip">
          <span className="welcome-tip__head">
            <Icon name={t.icon} size={16} className="welcome-tip__icon" />
            <strong>{t.title}</strong>
          </span>
          <span className="welcome-tip__text">{t.text}</span>
          <span className="welcome-tip__keys">
            {t.keys
              .map(([id, label]) => [id, label, shortcutLabel(id)] as const)
              .filter(([, , key]) => key)
              .map(([id, label, key]) => (
                <span key={id}>
                  <kbd className="kbd">{key}</kbd> {label}
                </span>
              ))}
          </span>
        </li>
      ))}
    </ul>
  );
}
