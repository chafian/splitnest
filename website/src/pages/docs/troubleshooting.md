---
layout: ../../layouts/DocLayout.astro
title: "Troubleshooting and known limitations"
description: "Fixes for common SplitNest problems with WSL and missing folders, and the full list of known limitations of this MVP prototype."
path: /docs/troubleshooting/
---

## Troubleshooting

- **“The terminal backend is unavailable” / panes fail with a node-pty error:** the log file (`%APPDATA%\SplitNest\logs\splitnest.log`) records the load error. If you see this with a downloaded build, please [open an issue on GitHub](https://github.com/chafian/splitnest/issues).
- **WSL is listed as unavailable:** run `wsl --list --verbose` yourself. If it reports no distributions or that the feature is not enabled, install or enable WSL using Microsoft’s documentation, then use **Refresh shell list**. Docker Desktop’s internal `docker-desktop*` distributions are intentionally hidden.
- **A WSL pane is slow to start:** the first start boots the distribution’s VM (a few seconds). Mapping the folder times out after 25 s with an option to start in the home directory.
- **A WSL pane says the folder can’t be mapped:** this happens with network shares or drives that aren’t mounted inside the distribution, or a customised `[automount]` in `/etc/wsl.conf`. Use **Start in home directory instead**, or mount the drive in WSL.
- **Missing project folder:** a banner offers **Choose folder…** (relink) or **Remove workspace**. Panes offer to start in your home directory instead.

## Known limitations

See [TESTING.md](https://github.com/chafian/splitnest/blob/main/docs/TESTING.md#known-limitations-and-remaining-verification) for the full list. Highlights:

- Windows 11 x64 only; unsigned; no installer or auto-update (ZIP only).
- The displayed directory is where the shell **started**; there is no shell integration that tracks `cd`.
- Full-screen programs work, but ConPTY repaints them itself, so their screens can leave frames in the scrollback.
- **Resizing:** dividers and window resizes do not flash; the console's screen, the cursor and xterm's agree after every resize, and output above the screen (scrollback) is kept when a pane is narrowed, widened or maximised. One thing you can still see: when the top row of the screen is the middle of a long wrapped line and the width changes, the console only has the rest of that line and draws it as a line of its own, so it shows on the top row, under the complete line in the history. It is removed from the history as soon as output scrolls it off the screen. It stays if, at that moment, you are scrolled up or have text selected and more than a screenful of output passes. WSL output is slower than with the ConPTY bundled with node-pty (about 1.15 s instead of 0.48 s for 16 MB of text in the packaged app; see TESTING.md).
- **Slow ↑/↓ in PowerShell (about 1 s):** this happens when another PowerShell process keeps PSReadLine's history lock (it affects every PowerShell window, not only SplitNest, and new commands stop being saved). Closing that PowerShell fixes it. SplitNest's own automated tests no longer use your history file.
- **Windows PowerShell 5.1 in very narrow panes:** if the prompt itself wrapped (pane narrower than the prompt) and the pane is then resized before you press Enter, what you type next can be drawn over the prompt. The cause is PSReadLine 2.0 (bundled with Windows PowerShell 5.1), which keeps the input's start column from before the resize; the same happens in other terminals, and the next prompt is clean. The terminal side is fixed: wrapped lines, including the current prompt, now rejoin correctly when a pane widens. Newer PSReadLine versions (PowerShell 7) may behave better; not tested here.
- Shells get a clean environment: when SplitNest is started from inside another terminal or an AI agent CLI, that session's markers and IPC variables (e.g. `CLAUDE_CODE_CHILD_SESSION`, `CLAUDECODE`, VS Code's git askpass hooks) are not passed on to its shells. Your own variables, including `CLAUDE_CODE_*` settings and API keys, are kept.
- Linux-only projects opened via `\\wsl.localhost\...` are not specially supported (PowerShell can start there; WSL mapping depends on `wslpath`).
- Scrollback is per pane and lives only in memory.

