// The welcome screen's guide (src/renderer/features/workspaces/WelcomeGuide.tsx).
import { describe, expect, it } from 'vitest';
import { shortcutLabel } from '../../src/renderer/features/commands/shortcuts';
import { WELCOME_TIPS } from '../../src/renderer/features/workspaces/WelcomeGuide';

describe('welcome guide', () => {
  it('covers workspaces, splits and agents, and every key it shows is a real shortcut', () => {
    expect(WELCOME_TIPS.map((t) => t.title)).toEqual(['Workspaces', 'Split panes', 'Agents']);
    for (const t of WELCOME_TIPS) {
      expect(t.keys.length).toBeGreaterThan(0);
      for (const [id] of t.keys) expect(shortcutLabel(id), `${t.title}: ${id}`).toMatch(/^Ctrl\+/);
    }
  });
});
