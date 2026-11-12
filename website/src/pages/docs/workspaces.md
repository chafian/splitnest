---
layout: ../../layouts/DocLayout.astro
title: "Workspaces and terminals"
description: "How workspaces, sidebars, terminals, tabs, split panes, short prompts and WSL panes work in SplitNest."
path: /docs/workspaces/
---

The detailed reference for workspaces, terminals and panes. For the overview, see the [features](/features/workspaces-splits-tabs/).

## Workspaces

Shown in the left sidebar, one project folder each. **New workspace from folder…** is the folder button at the top of the sidebar (**Ctrl+Shift+O**). The current workspace has a mint bar and bold name. Rename and remove workspaces with the buttons that appear on hover. **Removing a workspace never deletes files**; it only removes the entry and ends its sessions after confirmation.



## Sidebars

The workspace sidebar and the file explorer are independent.

- **Collapse / expand the workspace sidebar** to an icon rail with **Ctrl+Shift+B** or the first title-bar button. **Show / hide the explorer** with **Ctrl+Shift+E** or the second.
- **Resize** either one by dragging its right edge, or focus the edge with Tab and use ←/→ (Shift = larger steps). Widths are saved and come back after a restart or after collapsing.
- On a small window the panels are narrowed for display (explorer first) so the terminals keep at least 360 px; your saved widths are restored when the window grows.
- **Focus terminals** (**Ctrl+Shift+Enter**, the third title-bar button, or the palette) hides both sidebars. Using it again, or pressing either sidebar shortcut, restores them exactly as they were. The title-bar button stays highlighted while focus mode is on.

## Terminals

**New terminal** in the title bar (or **Ctrl+Shift+T**) opens a terminal tab **in the current pane** with the default shell; its arrow chooses another shell (PowerShell 7, Windows PowerShell, or a WSL distribution). The **+** in a pane’s tab bar does the same for that pane, using that pane’s current shell.



## Title bar

SplitNest draws its own title bar.

- **Left:** sidebar, file-explorer and focus-mode toggles, and the current workspace’s name and folder.
- **Center:** a search box that opens the command palette.
- **Right:** **New terminal ▾**, **Split left/right** and **Split top/bottom** (both act on the current pane). Every icon button has a tooltip with its shortcut.
- **Window buttons:** minimize, maximize and close are still the native Windows buttons (Electron’s title-bar overlay), so snap layouts, double-click to maximize and dragging all work as usual.

## Tabs

Every split pane has its own tab bar, so it can hold several terminals. Switch with **Ctrl+Tab** / **Ctrl+Shift+Tab** or the arrow keys on a focused tab bar. Close with the tab’s **×**, middle-click, **Delete** on a focused tab, or **Ctrl+Shift+W** (closing the last tab closes the pane). **Drag a tab** to reorder it or drop it on another pane’s tab bar to move it; its shell keeps running. Background tabs keep running too.

- A tab shows a status dot, its name, and a state label when not running (*Not started*, *Starting*, *Exited (code)*, *Failed*). The tooltip has the shell, state, starting folder (it does not follow later `cd` commands) and the title the shell last set, if any.
- **Rename a terminal** (for example *Backend*, *Tests*, *Logs*) by double-clicking its tab, pressing **F2** on a focused tab, right-click → **Rename terminal…**, or the palette’s **Rename terminal…**. Enter saves, Escape cancels, and an empty name goes back to the shell’s name. Named tabs also show the shell in smaller text. Titles set by the shell never replace a name you chose. Long names are shortened on the tab; the full name is in the tooltip.
- Right-click a tab (or **Shift+F10** on it) for rename, start/restart, split with this shell, and close.

## Panes

Each pane header has **+** (new terminal here), **Split left/right**, **Split top/bottom** and **⋯** (find, start/restart, rename, close terminal, close pane). When there are several panes, the current pane has a faint mint outline and a lighter header; while it has keyboard focus the outline is solid mint. Clicking a terminal or **Ctrl+Alt+Arrow** moves focus.



## Short prompts

Settings → *Short folder names in prompts*, on by default. Long folders no longer wrap the prompt.

- **PowerShell** shows `PS car-rental>` (or `PS ~>` at home) instead of the full path. This applies only when PowerShell's built-in prompt is active after your profile ran; a prompt from `$PROFILE`, oh-my-posh or Starship is left alone. The setup line is not added to PSReadLine's up-arrow history, but `Get-History` lists it as entry 1.
- **WSL bash** gets `PROMPT_DIRTRIM=1` (passed through `WSLENV`), so the usual `\w` prompt shows `user@host:.../car-rental$`. A `PROMPT_DIRTRIM` set in your `~/.bashrc` wins, and prompts without `\w` (zsh, custom PS1) are unaffected.
- **Only the prompt changes.** Terminal output is never rewritten or filtered. `pwd`, `Get-Location`, error messages and copied output keep full paths, and your profile files (`$PROFILE`, `~/.bashrc`) are not modified. The full path is also in the tab tooltip.
- It applies per session: changing the setting affects shells started afterwards, and turning it off gives the normal full-path prompt again.

## Maximise pane

**Ctrl+Shift+M**, the ⤢ button in a pane's header, its ⋯ menu, or the palette. The pane temporarily fills the terminal area. The other panes stay open underneath, so their shells keep running and their editors keep unsaved text. **Restore layout** (same shortcut or button) brings back the exact split sizes and selected tabs. Moving focus to another pane (Ctrl+Alt+arrows, opening a file beside it) or closing the pane also restores the layout.



## Workspace counts

The counts in the sidebar show running shells only (*1 shell running*, *6 shells running*), including background tabs. Editor tabs and shells that are not started, starting, failed or exited are not counted.



## Tab labels

A renamed terminal shows *Project B · PowerShell*, with the shell in smaller text; unnamed tabs show just the shell. In narrow panes the shell part is dropped first; the full label is in the tooltip and accessible name.



## Splits

Drag dividers to resize, or focus a divider with Tab and use the arrow keys (Shift = larger steps).



## WSL panes

WSL panes start in the Linux path that `wslpath` reports for the workspace folder (for example `/mnt/c/...`). If the folder can’t be mapped, the pane explains why and offers an explicit **Start in home directory instead** button. It never silently starts somewhere else.



