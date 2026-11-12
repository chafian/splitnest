---
layout: ../../layouts/DocLayout.astro
title: "Saved state and session cleanup"
description: "What SplitNest saves and restores after a restart, what it never saves, and how it ends sessions when you close a pane or quit."
path: /docs/saved-state/
---

## Saved state and restoration

- State file: `%APPDATA%\SplitNest\workspace-state.json` (see **Settings → About**, which can also open it in Explorer). Log file: `%APPDATA%\SplitNest\logs\splitnest.log`.
- **Saved:** a schema version, workspace IDs, names and folders, the pane layout and split proportions, each terminal’s shell profile and optional custom name, the agent conversation running in it (agent, conversation id, folder, and its title unless turned off; for Resume), the active workspace and pane, and appearance settings (font size, scrollback, sidebar collapsed/width, explorer visibility/width, focus mode, default shell, restore behaviour). Files written before custom names and sidebar widths existed load unchanged with defaults.
- **Never saved:** terminal output, command history, environment variables, credentials, or the contents of files open in the editor (only their workspace-relative paths). The log records lifecycle events and errors only, never terminal input or output.
- Writes are debounced and atomic (temp file + rename). If the file is malformed or from an unsupported version, it is **kept** next to the original as `workspace-state.corrupt-<time>.json` (or `.unsupported-<time>.json`) and the app starts empty with a notice.
- **Restoring:** by default the layout comes back with nothing running. One notice per restored workspace says *“Layout restored. Start new shells to continue.”*, and each unstarted terminal shows **Ready to start** with a shell selector and a **Start ‹shell›** button.
  - **Start all shells** starts a *new* shell, with each terminal’s selected shell in its saved folder, for every unstarted terminal of that workspace, background tabs included. Running terminals are left alone. Repeated clicks or an individual Start at the same time never create a second session.
  - A terminal that fails is listed in the notice with **Retry** and **Show**; the others keep running. The notice disappears when nothing is left to start. **Dismissing** it starts and closes nothing.
  - Optionally, **Settings → Start fresh shells automatically** starts a new shell in each restored terminal.
  - Starting a shell runs its normal profile scripts (for example `$PROFILE` or `~/.bashrc`). Previous processes are never resumed and commands are never replayed.

## Session cleanup policy

- **Closing a pane** with a running session asks first, then ends that pane’s shell. On Windows this closes its pseudoconsole, which ends the shell and the processes attached to that console. Other panes are not affected.
- **Quitting** with running sessions asks first (the app cannot tell whether a shell is idle), then ends all sessions, waiting up to 3 seconds.
- **WSL**: closing a pane ends only that pane’s `wsl.exe` session. The app never runs `wsl --shutdown` or terminates a distribution.
- **Not covered:** processes intentionally detached from the console (for example `Start-Process`, `nohup … &`, `setsid`, Windows services, or daemons started by a WSL shell) may keep running after their pane closes. That is by design of those tools.
