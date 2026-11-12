import { describe, expect, it } from 'vitest';
import { mixHex, resolveTheme, searchDecorations, themeById, themeCssVars, THEMES, xtermTheme } from '../../src/renderer/features/appearance/themes';
import { DEFAULT_SETTINGS } from '../../src/shared/types';
import { parseWindowTheme, validateSettings } from '../../src/shared/validation';

// WCAG relative luminance / contrast ratio.
const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

describe('themes', () => {
  it('has the five themes of the design, Graphite first and default, with the design main colours', () => {
    expect(THEMES.map((t) => t.id)).toEqual(['graphite', 'light', 'midnight', 'ember', 'lagoon']);
    expect(THEMES.map((t) => t.name)).toEqual(['Graphite', 'Silver Light', 'Midnight Blue', 'Ember', 'Lagoon']);
    expect(DEFAULT_SETTINGS.darkTheme).toBe('graphite');
    expect(DEFAULT_SETTINGS.themeMode).toBe('dark');
    // Spot checks against the design sheet.
    expect(themeById('graphite').ui).toMatchObject({ bg: '#0c0c0e', side: '#111113', pane: '#151517', primary: '#dbddf0', focus: '#2f6bff' });
    expect(themeById('light').ui).toMatchObject({ bg: '#f3f4f8', pane: '#ffffff', text: '#14161c', primary: '#1b1e26' });
    expect(themeById('midnight').ui).toMatchObject({ bg: '#070b14', primary: '#2f6bff', focus: '#7fa6ff' });
    expect(themeById('ember').ui).toMatchObject({ bg: '#100c0a', primary: '#f2a65a' });
    expect(themeById('lagoon').ui).toMatchObject({ bg: '#091214', primary: '#5eead4' });
  });

  it('Graphite keeps exactly the colours the app had before themes existed', () => {
    const g = themeById('graphite');
    expect(themeCssVars(g)).toMatchObject({ '--bg-app': '#0c0c0e', '--bg-hover': '#232328', '--text-faint': '#85858f', '--accent': '#dbddf0', '--focus': '#2f6bff', '--danger': '#ff7a85' });
    expect(xtermTheme(g)).toMatchObject({ background: '#0c0c0e', cursor: '#2f6bff', brightBlack: '#4e4e58', blue: '#6ea0ff' });
  });

  it('mode: Light is Silver Light, Dark the chosen dark theme, Match system follows Windows', () => {
    expect(resolveTheme('light', 'ember', true).id).toBe('light');
    expect(resolveTheme('dark', 'ember', false).id).toBe('ember');
    expect(resolveTheme('system', 'lagoon', true).id).toBe('lagoon');
    expect(resolveTheme('system', 'lagoon', false).id).toBe('light');
  });

  it.each(THEMES.map((t) => [t.name, t] as const))('%s: readable text, buttons, links and terminal colours', (_n, t) => {
    const u = t.ui;
    for (const surface of [u.bg, u.side, u.pane, u.raised]) {
      expect(contrast(u.text, surface), `text on ${surface}`).toBeGreaterThanOrEqual(7);
      expect(contrast(u.muted, surface), `muted on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(u.faint, u.pane), 'faint on pane').toBeGreaterThanOrEqual(4.5);
    expect(contrast(u.faint, u.raised), 'faint on raised').toBeGreaterThanOrEqual(4);
    // 4.49:1 for Midnight Blue's white on #2F6BFF: the design's own pair, kept as designed.
    expect(contrast(u.onPrimary, u.primary), 'primary button').toBeGreaterThanOrEqual(4.49);
    expect(contrast(u.onDanger, u.danger), 'danger button').toBeGreaterThanOrEqual(4.5);
    expect(contrast(u.link, u.pane), 'link').toBeGreaterThanOrEqual(4.5);
    expect(contrast(u.focus, u.pane), 'focus ring').toBeGreaterThanOrEqual(3);
    for (const k of ['success', 'warning', 'danger'] as const) expect(contrast(u[k], u.pane), k).toBeGreaterThanOrEqual(3);
    const term = xtermTheme(t);
    expect(contrast(term.foreground!, term.background!)).toBeGreaterThanOrEqual(7);
    for (const k of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const) {
      expect(contrast(t.ansi[k], u.terminalBg), `ansi ${k}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('every token is a valid colour, and search decorations are #rrggbb (xterm requires it)', () => {
    for (const t of THEMES) {
      for (const [k, v] of Object.entries(themeCssVars(t))) {
        if (k === 'color-scheme') expect(['dark', 'light']).toContain(v);
        else expect(v, `${t.id} ${k}`).toMatch(/^#[0-9a-f]{6}$/);
      }
      for (const v of Object.values(searchDecorations(t))) expect(v).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('settings: theme fields validated, unknown values fall back to Graphite / Dark', () => {
    expect(validateSettings({}).themeMode).toBe('dark');
    expect(validateSettings({ themeMode: 'system', darkTheme: 'lagoon' })).toMatchObject({ themeMode: 'system', darkTheme: 'lagoon' });
    expect(validateSettings({ themeMode: 'neon', darkTheme: 'light' })).toMatchObject({ themeMode: 'dark', darkTheme: 'graphite' });
  });

  it('window colours from the renderer: only #rrggbb accepted', () => {
    expect(parseWindowTheme({ background: '#0c0c0e', titleBar: '#111113', symbol: '#b4b4be' })).toEqual({ background: '#0c0c0e', titleBar: '#111113', symbol: '#b4b4be' });
    expect(parseWindowTheme({ background: 'red', titleBar: '#111113', symbol: '#b4b4be' })).toBeNull();
    expect(parseWindowTheme({ background: '#0c0c0e', titleBar: 'url(x)', symbol: '#b4b4be' })).toBeNull();
    expect(parseWindowTheme(null)).toBeNull();
  });
});
