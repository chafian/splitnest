---
layout: ../../layouts/DocLayout.astro
title: "Keyboard shortcuts"
description: "Every SplitNest keyboard shortcut: command palette, splits, tabs, focus, agent inbox, copy and paste."
path: /docs/shortcuts/
---

Also listed in the app (**Ctrl+Shift+/**). Plain Ctrl+letter keys always go to the shell.

| Action | Keys |
|---|---|
| Command palette | Ctrl+Shift+P |
| New workspace from folder | Ctrl+Shift+O |
| New terminal in the current pane | Ctrl+Shift+T |
| Next / previous terminal in the pane | Ctrl+Tab / Ctrl+Shift+Tab |
| Split left/right / split top/bottom | Ctrl+Shift+D / Ctrl+Shift+S |
| Close terminal (last one closes the pane) | Ctrl+Shift+W |
| Rename terminal (on a focused tab) | F2 |
| Find in terminal | Ctrl+Shift+F (Enter / Shift+Enter: next / previous, Esc: close) |
| Start / restart shell | Ctrl+Shift+R |
| Move focus between panes | Ctrl+Alt+Arrow keys |
| Next / previous workspace | Ctrl+Shift+PgDn / Ctrl+Shift+PgUp |
| Collapse / expand workspace sidebar | Ctrl+Shift+B |
| Show / hide file explorer | Ctrl+Shift+E |
| Focus terminals (hide / restore both sidebars) | Ctrl+Shift+Enter |
| Maximise pane / restore layout | Ctrl+Shift+M |
| Font size bigger / smaller / reset | Ctrl+= / Ctrl+− / Ctrl+0 |
| Agent inbox / next waiting agent | Ctrl+Shift+A / Ctrl+Shift+U |
| Settings | Ctrl+, |
| Keyboard shortcut list | Ctrl+Shift+/ |
| Copy | Ctrl+C **when text is selected** (otherwise Ctrl+C interrupts), or Ctrl+Shift+C |
| Paste | Ctrl+V or Ctrl+Shift+V; right-click pastes when nothing is selected, copies otherwise |

## Shortcut scope

App shortcuts are a fixed table; there is no user configuration yet. They work everywhere in the window, including inside terminals and the editor, so the app takes them before the shell or the editor sees them.
- **Ctrl+Shift+M** (maximise): none of SplitNest's other shortcuts or the editor's key bindings use it (CodeMirror's only Ctrl+Shift+M is its lint panel, which SplitNest doesn't load). In xterm.js a shell would receive it as plain Ctrl+M (Enter) anyway.
- **Could still clash:** it is Windows Terminal's default *mark mode* key, and a custom binding in a TUI or shell profile could expect it. This was checked against SplitNest's own tables, not against every possible user binding.
- Ctrl+M, Ctrl+Alt+M and Alt+Shift+M still go to the shell.
