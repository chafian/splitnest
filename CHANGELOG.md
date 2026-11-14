# Changelog

All notable changes to SplitNest. Release notes on GitHub are taken from the section for each version.

## 0.3.0 (2026-11-14)

Agent tasks: run several agents on one repository at once, each in its own Git worktree, and review and merge their work from SplitNest.

- **New agent task** (the branch button on a repository's row, or the command palette) creates a Git worktree next to the repository on a new branch `splitnest/<name>`, opens it as a workspace under the one it came from, and starts Claude Code, Codex or Gemini CLI there. Each agent works in its own folder and branch, so agents don't change each other's files, and your own folder, branch and uncommitted changes are left alone.
- **Changes panel** (**Ctrl+Shift+G**): docked next to the task's terminals, it lists the files the task changed compared with where it left its branch (committed or not, new files included) and updates by itself while the agent works. Each file's changes open as a **diff tab** beside the terminal.
- **In the sidebar**, each task is one line with its `+added −removed`; the tooltip has its branch, commits and what isn't committed yet.
- **Finish** commits what is left, merges the task into the branch it came from (checked for conflicts first, and undone at once if a merge stops) and deletes its folder and branch. Conflicts are resolved inside the task with *Bring in latest <branch>*. *Discard* deletes a task after listing exactly what is lost.
- **WSL**: for a repository stored inside WSL, tasks use that distribution's own Git and run in WSL. Tasks of a repository on a Windows drive run in PowerShell.
- Agent tasks are on by default; *Settings → Workspaces → Agent tasks* turns them off.
- **Look and feel**: dropdowns in SplitNest's own style (keyboard as before), text fields show focus with a quiet 1 px gray border instead of a blue ring, and the title bar's bottom border now runs under the window buttons.

## 0.2.2 (2026-11-13)

Exact Resume in WSL tabs, a welcome guide on the first screen, and release notes before you restart for an update.

- **Exact Resume in WSL tabs**: SplitNest now finds which Claude Code, Codex or Gemini CLI conversation runs in a WSL terminal (from the agent's files in your Linux home, read through `\\wsl.localhost`; Claude Code by its Linux process), so after a restart Resume starts WSL in the agent's folder and reopens that conversation, instead of opening the agent's list. Nothing is written in the distribution.
- **Welcome guide**: the first screen now explains workspaces, split panes and agents (tab state and the inbox) in three short cards, with their shortcuts.
- **Release notes before you restart**: the *Update ready* notice has a *Release notes* button that opens the latest release on GitHub in your browser, so you can see what changed before restarting.

## 0.2.1 (2026-11-13)

Feedback links, a What's new notice after updates, Resume for Gemini CLI, and agent detection in WSL tabs.

- **Feedback links**: Settings → About → Feedback, and the command palette (*Report a bug*, *Suggest a feature*, *Questions and ideas*), open the GitHub issue forms and Discussions in your browser. The bug form arrives with your SplitNest version filled in; nothing is sent until you submit it.
- **What's new after an update**: the first time a newer version starts, a notice names it and offers its release notes on GitHub (opened in your browser only if you click). It appears once per version and never on a first install. Settings → About also links to the current version's release notes.
- **Resume Gemini CLI conversations**: after a restart, a terminal where Gemini CLI was running offers *Resume Gemini CLI*, which types `gemini --resume <id>` in that folder, like Claude Code and Codex. SplitNest reads only the first line of Gemini CLI's session file and its project list, never conversation text. When the exact conversation isn't known, Resume runs `gemini --resume` (its most recent conversation in that folder).
- **Agents in WSL tabs are found like in PowerShell tabs**: SplitNest now sees the Linux processes started in its WSL terminals, so agents that don't report their state themselves get their logo and state there too, and their end is noticed. It works with a marker variable each WSL terminal passes in and one small helper per distribution in use that reads only `/proc`; nothing is installed or written in the distribution.

## 0.2.0 (2026-11-12)

First public release with an installer.

- **Windows installer** (`SplitNest-win32-x64-Setup.exe`): installs for your Windows user without administrator rights, adds SplitNest to the Start menu and to Windows' installed apps, and uninstalls from Settings → Apps. Your settings and workspaces are kept on uninstall. A portable ZIP is still available.
- **Automatic updates**: SplitNest checks this project's GitHub Releases for new versions, downloads them in the background and installs them when it restarts. It explains this the first time it starts, before any request, and can be turned off in Settings → About. See the [privacy policy](https://splitnest.dev/privacy/).
- **Agent inbox**: the bell in the title bar lists every agent waiting for you (Ctrl+Shift+A); Ctrl+Shift+U goes to the next one.
- **Resume agent conversations**: after a restart, terminals where Claude Code or Codex was running offer to reopen that conversation.
- **Agent notifications**: in-app notices, Windows notifications and taskbar signals when an agent needs you, finishes or fails.
- Consistent "SplitNest" product and company information on every program file.
