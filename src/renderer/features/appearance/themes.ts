// App themes (Settings › Appearance). The five themes and their main colours come from the
// "Settings › Appearance — theme picker" design: bg, side, pane, raised, border, borderStrong,
// text, muted, primary, onPrimary, accent (focus), onAccent, green, blue, yellow, magenta.
// Everything else (hover, faint text, red, cyan, the remaining terminal colours, editor colours)
// is derived here per theme and checked for contrast in tests/unit/themes.test.ts.
// Applied by setting CSS variables on <html> (tokens.css derives tints from them), the xterm
// theme of every terminal, and the window's title bar overlay colours.
import type { ITheme } from '@xterm/xterm';
import type { DarkThemeId, ThemeMode } from '../../../shared/types';

export type ThemeId = DarkThemeId | 'light';

export interface Theme {
  id: ThemeId;
  name: string;
  desc: string;
  dark: boolean;
  ui: {
    bg: string;
    side: string;
    pane: string;
    raised: string;
    hover: string;
    paneBarActive: string;
    border: string;
    borderStrong: string;
    text: string;
    muted: string;
    faint: string;
    /** Main buttons, selected tab line, active rows ("Silver" in Graphite). */
    primary: string;
    primaryHover: string;
    onPrimary: string;
    /** Focus ring, focused pane, cursor ("Nest Blue" in Graphite). */
    focus: string;
    link: string;
    linkHover: string;
    success: string;
    warning: string;
    danger: string;
    dangerHover: string;
    onDanger: string;
    terminalBg: string;
    titlebarSymbol: string;
  };
  ansi: {
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
  };
  /** Terminal selection (rgba). */
  selection: string;
  editor: { comment: string; gutter: string; gutterActive: string; activeLine: string };
}

export const THEMES: Theme[] = [
  {
    id: 'graphite',
    name: 'Graphite',
    desc: 'Default · dark, silver accents',
    dark: true,
    ui: {
      bg: '#0c0c0e', side: '#111113', pane: '#151517', raised: '#1d1d21', hover: '#232328', paneBarActive: '#19191c',
      border: '#26262b', borderStrong: '#36363d', text: '#ededf2', muted: '#8e8e99', faint: '#85858f',
      primary: '#dbddf0', primaryHover: '#ffffff', onPrimary: '#0c0c0e', focus: '#2f6bff', link: '#7fa6ff', linkHover: '#a8c3ff',
      success: '#5ee0a0', warning: '#f5d06b', danger: '#ff7a85', dangerHover: '#ff9aa2', onDanger: '#0c0c0e',
      terminalBg: '#0c0c0e', titlebarSymbol: '#b4b4be',
    },
    ansi: {
      black: '#1d1d21', red: '#ff7a85', green: '#5ee0a0', yellow: '#f5d06b', blue: '#6ea0ff', magenta: '#b49cff', cyan: '#5cd5f5', white: '#ededf2',
      brightBlack: '#4e4e58', brightRed: '#ff9ea6', brightGreen: '#8aebbb', brightYellow: '#f9df96', brightBlue: '#98bbff', brightMagenta: '#ccbdff', brightCyan: '#8ae2f8', brightWhite: '#ffffff',
    },
    selection: 'rgba(219, 221, 240, 0.22)',
    editor: { comment: '#6e6e7a', gutter: '#5e5e69', gutterActive: '#b4b4be', activeLine: '#111113' },
  },
  {
    id: 'light',
    name: 'Silver Light',
    desc: 'Bright, for daytime',
    dark: false,
    ui: {
      bg: '#f3f4f8', side: '#eceef4', pane: '#ffffff', raised: '#e2e6f0', hover: '#e7eaf1', paneBarActive: '#f7f8fb',
      border: '#dde1ea', borderStrong: '#c9ced9', text: '#14161c', muted: '#5e6475', faint: '#5b6172',
      primary: '#1b1e26', primaryHover: '#2e3340', onPrimary: '#ffffff', focus: '#2f6bff', link: '#2456d6', linkHover: '#1a43b0',
      success: '#0f8a55', warning: '#9a6b00', danger: '#c62f3f', dangerHover: '#a82534', onDanger: '#ffffff',
      terminalBg: '#ffffff', titlebarSymbol: '#3a3f4d',
    },
    ansi: {
      // Terminal green a step darker than the UI's #0f8a55, to reach 4.5:1 on the white terminal.
      black: '#14161c', red: '#c62f3f', green: '#0d7f4e', yellow: '#9a6b00', blue: '#2456d6', magenta: '#7c4ddb', cyan: '#0e7c8c', white: '#5e6475',
      brightBlack: '#7a8093', brightRed: '#d93f50', brightGreen: '#13a066', brightYellow: '#a87600', brightBlue: '#3d6ff0', brightMagenta: '#9466ea', brightCyan: '#128fa1', brightWhite: '#3a3f4d',
    },
    selection: 'rgba(47, 107, 255, 0.18)',
    editor: { comment: '#6b7183', gutter: '#8a90a2', gutterActive: '#14161c', activeLine: '#f5f6fa' },
  },
  {
    id: 'midnight',
    name: 'Midnight Blue',
    desc: 'Logo blue, front and center',
    dark: true,
    ui: {
      bg: '#070b14', side: '#0a0f1d', pane: '#0b1120', raised: '#121c35', hover: '#18223d', paneBarActive: '#0e162a',
      border: '#1c2742', borderStrong: '#2a3a62', text: '#e8ebf7', muted: '#8390b3', faint: '#7a87ab',
      primary: '#2f6bff', primaryHover: '#4c80ff', onPrimary: '#ffffff', focus: '#7fa6ff', link: '#9dbbff', linkHover: '#c0d3ff',
      success: '#5ee0a0', warning: '#f5d06b', danger: '#ff7a85', dangerHover: '#ff9aa2', onDanger: '#070b14',
      terminalBg: '#070b14', titlebarSymbol: '#b3bcd6',
    },
    ansi: {
      black: '#121c35', red: '#ff7a85', green: '#5ee0a0', yellow: '#f5d06b', blue: '#6ea0ff', magenta: '#b49cff', cyan: '#5cd5f5', white: '#e8ebf7',
      brightBlack: '#4a5577', brightRed: '#ff9ea6', brightGreen: '#8aebbb', brightYellow: '#f9df96', brightBlue: '#98bbff', brightMagenta: '#ccbdff', brightCyan: '#8ae2f8', brightWhite: '#ffffff',
    },
    selection: 'rgba(47, 107, 255, 0.32)',
    editor: { comment: '#66739a', gutter: '#4f5b7e', gutterActive: '#b3bcd6', activeLine: '#0a0f1d' },
  },
  {
    id: 'ember',
    name: 'Ember',
    desc: 'Warm dark, amber glow',
    dark: true,
    ui: {
      bg: '#100c0a', side: '#15100d', pane: '#1a1411', raised: '#261d18', hover: '#2c221c', paneBarActive: '#201914',
      border: '#30251f', borderStrong: '#45362d', text: '#f3ece6', muted: '#a3958a', faint: '#9a8c81',
      primary: '#f2a65a', primaryHover: '#f5b97a', onPrimary: '#1a1411', focus: '#f2a65a', link: '#86b9e6', linkHover: '#aacfef',
      success: '#a6da86', warning: '#f2c46a', danger: '#f28b82', dangerHover: '#f5a59e', onDanger: '#1a1411',
      terminalBg: '#100c0a', titlebarSymbol: '#cdbfb4',
    },
    ansi: {
      black: '#261d18', red: '#f28b82', green: '#a6da86', yellow: '#f2c46a', blue: '#86b9e6', magenta: '#e7a1c8', cyan: '#8fd3c8', white: '#f3ece6',
      brightBlack: '#5e4e44', brightRed: '#f6a8a1', brightGreen: '#bfe6a6', brightYellow: '#f6d590', brightBlue: '#a9cdee', brightMagenta: '#efbdd9', brightCyan: '#ade0d8', brightWhite: '#fffaf5',
    },
    selection: 'rgba(242, 166, 90, 0.26)',
    editor: { comment: '#7d6d62', gutter: '#6a5a4f', gutterActive: '#cdbfb4', activeLine: '#15100d' },
  },
  {
    id: 'lagoon',
    name: 'Lagoon',
    desc: 'Cool dark, teal accents',
    dark: true,
    ui: {
      bg: '#091214', side: '#0d171a', pane: '#101d20', raised: '#17292d', hover: '#1c3034', paneBarActive: '#132326',
      border: '#203538', borderStrong: '#2e4a4e', text: '#e6f1f1', muted: '#8ba6a9', faint: '#819c9f',
      primary: '#5eead4', primaryHover: '#86f0df', onPrimary: '#091214', focus: '#5eead4', link: '#7cc4ff', linkHover: '#a6d7ff',
      success: '#7ee0a0', warning: '#f2d06b', danger: '#ff8a8a', dangerHover: '#ffa3a3', onDanger: '#091214',
      terminalBg: '#091214', titlebarSymbol: '#b5cbcd',
    },
    ansi: {
      black: '#17292d', red: '#ff8a8a', green: '#7ee0a0', yellow: '#f2d06b', blue: '#7cc4ff', magenta: '#c3a6ff', cyan: '#5eead4', white: '#e6f1f1',
      brightBlack: '#46605f', brightRed: '#ffa8a8', brightGreen: '#a1eabb', brightYellow: '#f6dd90', brightBlue: '#a2d5ff', brightMagenta: '#d6c2ff', brightCyan: '#8cf0e0', brightWhite: '#ffffff',
    },
    selection: 'rgba(94, 234, 212, 0.22)',
    editor: { comment: '#5f7a7d', gutter: '#4b6467', gutterActive: '#b5cbcd', activeLine: '#0d171a' },
  },
];

export const DEFAULT_THEME_ID: ThemeId = 'graphite';

export function themeById(id: ThemeId): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}

/**
 * Which theme is on screen: Light mode is Silver Light; Dark mode is the chosen dark theme;
 * Match system follows Windows (light app mode → Silver Light, dark → the chosen dark theme).
 */
export function resolveTheme(mode: ThemeMode, darkTheme: DarkThemeId, systemDark: boolean): Theme {
  if (mode === 'light' || (mode === 'system' && !systemDark)) return themeById('light');
  return themeById(darkTheme);
}

/** Mixes two #rrggbb colours (w = share of b). */
export function mixHex(a: string, b: string, w: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number) => Math.round(((pa >> shift) & 255) * (1 - w) + ((pb >> shift) & 255) * w);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

/** CSS variables for the app's tokens (tokens.css derives tints and outlines from these). */
export function themeCssVars(t: Theme): Record<string, string> {
  const u = t.ui;
  const a = t.ansi;
  return {
    '--bg-app': u.bg,
    '--bg-sidebar': u.side,
    '--bg-titlebar': u.side,
    '--bg-surface': u.pane,
    '--bg-elevated': u.raised,
    '--bg-hover': u.hover,
    '--bg-active': u.raised,
    '--bg-terminal': u.terminalBg,
    '--bg-pane-bar-active': u.paneBarActive,
    '--border': u.border,
    '--border-strong': u.borderStrong,
    '--text': u.text,
    '--text-muted': u.muted,
    '--text-faint': u.faint,
    '--text-on-accent': u.onPrimary,
    '--text-on-danger': u.onDanger,
    '--accent': u.primary,
    '--accent-strong': u.primaryHover,
    '--focus': u.focus,
    '--link': u.link,
    '--link-hover': u.linkHover,
    '--success': u.success,
    '--warning': u.warning,
    '--danger': u.danger,
    '--danger-hover': u.dangerHover,
    // Editor (CodeMirror reads these too).
    '--ed-comment': t.editor.comment,
    '--ed-gutter': t.editor.gutter,
    '--ed-gutter-active': t.editor.gutterActive,
    '--ed-active-line': t.editor.activeLine,
    '--syn-keyword': a.magenta,
    '--syn-string': a.green,
    '--syn-number': a.brightRed,
    '--syn-function': a.blue,
    '--syn-type': a.yellow,
    '--syn-property': a.cyan,
    '--syn-tag': a.red,
    '--syn-operator': a.brightCyan,
    'color-scheme': t.dark ? 'dark' : 'light',
  };
}

export function xtermTheme(t: Theme): ITheme {
  return {
    background: t.ui.terminalBg,
    foreground: t.ui.text,
    cursor: t.ui.focus,
    cursorAccent: t.ui.terminalBg,
    selectionBackground: t.selection,
    selectionInactiveBackground: t.dark ? 'rgba(160, 165, 180, 0.14)' : 'rgba(20, 22, 28, 0.08)',
    ...t.ansi,
  };
}

/** xterm search decorations (it needs #rrggbb): primary tint for matches, focus tone for the current one. */
export function searchDecorations(t: Theme) {
  const bg = t.ui.terminalBg;
  return {
    matchBackground: mixHex(bg, t.ui.primary, t.dark ? 0.18 : 0.12),
    matchBorder: mixHex(bg, t.ui.primary, 0.45),
    matchOverviewRuler: t.ui.primary,
    activeMatchBackground: mixHex(bg, t.ui.focus, t.dark ? 0.5 : 0.28),
    activeMatchBorder: t.ui.focus,
    activeMatchColorOverviewRuler: t.ui.focus,
  };
}

/** Applies a theme to the page (CSS variables). Terminals and the window frame are updated by the caller. */
export function applyThemeVars(t: Theme, root: HTMLElement = document.documentElement): void {
  for (const [k, v] of Object.entries(themeCssVars(t))) root.style.setProperty(k, v);
  root.dataset.theme = t.id;
}
