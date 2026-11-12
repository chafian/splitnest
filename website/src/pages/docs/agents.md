---
layout: ../../layouts/DocLayout.astro
title: "AI agents"
description: "Reference for agent-aware tabs, notifications, the agent inbox and resuming Claude Code and Codex conversations in SplitNest."
path: /docs/agents/
---

Everything SplitNest does for AI coding agents. The sections cover the tab states, notifications, the inbox and Resume.

## Agent-aware tabs

Supported agents: Claude Code, Codex, Gemini CLI, GitHub Copilot CLI, Cursor Agent, Aider, OpenCode, Qwen Code and Amp. When one runs in a tab, the tab shows its logo instead of the status dot, its name, and what it is doing.

- **States:** *Working* (mint, pulsing badge), *Needs you* (amber badge, pill and underline, e.g. waiting for a permission or an answer), *Done*, *Error*. Idle shows no pill. The sidebar sums it up per workspace ("1 agent needs you · 2 working"), and the window title gets a count, e.g. `(1) car-rental — SplitNest`, so it shows in the taskbar.
- **Reported vs. estimated:** a state the agent reported is shown solid. A guess (for agents that don't report) is shown dashed with a "?" (*Needs you?*, *Working?*), reads "may need you" in the sidebar, isn't counted in the window title, and the tooltip says what it is based on. Once an agent has reported, nothing about it is guessed any more for that run.
- **Seeing vs. answering:** opening or typing into a tab clears its *notification* (a bell) and a *Done*/*Error* you have now seen. It never clears what the agent is waiting for: *Needs permission* stays until the agent itself reports that it continues.
- **When the agent exits** (its process ends, the shell's prompt or title comes back, or the session ends), its logo, state and session title all go, so the next program in that terminal starts clean.
- **Session title:** if the agent reports one, the tab shows it (e.g. *Fix login redirect · Claude Code*); a name you gave the tab still wins. Details (agent, state, reason, message) are in the tooltip.
- **How it knows:**
  1. **Program Status Protocol (OSC 7501).** The agent reports its own state. SplitNest answers the protocol's feature query, which Claude Code waits for before reporting; Codex reports on its own. Checked with Claude Code 2.1.316 and Codex 0.166.0 by the project.
  2. **Process detection** (PowerShell tabs only): a hidden helper looks for the agent's process under the tab's shell, every 3 s while something changes, otherwise every 12 s. Command lines never leave the main process and are not logged.
  3. **Fallbacks** for an identified agent that doesn't report (shown as estimated, see above): a terminal bell means *Needs you?*; a spinner in the title or recent output means *Working?*. Output, bells or titles alone never make a program count as an agent.
- **Limits:** WSL tabs can't use process detection (Linux processes aren't visible to Windows), so they rely on the agent's own reports or Claude Code's exact title ("✳ Claude Code"). Claude Code's first-run questions (e.g. "Claude in Chrome extension detected") are not reported by Claude, so they show as idle. No agent settings or hooks are changed. Logos come from [developer-icons](https://github.com/xandemon/developer-icons) (MIT); they are trademarks of their owners.

## Agent notifications

Settings → Notifications, on by default. When an agent *needs you* (permission, a question, sign-in, or anything else it waits for), *finishes*, or *stops with an error*.

- **Where:** nothing for the tab you are looking at. With SplitNest in front but another tab, workspace or Settings shown, a notice appears at the bottom right with a **Show** button. With SplitNest minimized or behind another program, a Windows notification appears; clicking it, also later from Notification Center, brings SplitNest back and shows that exact tab.
- **Taskbar:** for *needs you*, the taskbar button also flashes, and a small amber dot stays on it until you have seen the tab.
- **What it says:** SplitNest's own words, e.g. *Claude Code needs permission*, then the workspace and the name you gave the tab (*car-rental · Backend*), else the agent's name. The agent's session title and message can contain your prompt, so they are left out unless you turn on *Include what the agent wrote*.
- **When:** a notice goes away when the agent continues or you open the tab. *Finished* comes from the agent's own report (Claude Code and Codex both report it at the end of a turn) and is skipped if the agent starts working again within 1.5 s. Estimated states (a bell) don't notify unless you turn that on. More than three Windows notifications within 10 s become one summary. SplitNest removes its notifications from Notification Center when it quits.
- **Spoofing:** only agents SplitNest found running in the tab can raise a Windows notification (PowerShell tabs); a program that merely prints a status report naming an agent can't. WSL tabs can't be checked that way, so there the agent's report is enough.
- **Start menu:** Windows needs a Start menu entry to show an app's notifications, so the first notification adds *SplitNest* to the Start menu (it opens the copy of SplitNest that last showed a notification). Windows doesn't display the very notification that registers an app, so SplitNest shows that first one a second time 3 seconds later; you see it once, slightly late. *Send a test notification* in Settings shows whether Windows accepts them; if no banner appears, check Do Not Disturb and SplitNest's entry in Windows Settings → System → Notifications.

## Agent inbox

The bell in the title bar, **Ctrl+Shift+A**. Every agent that is waiting for you, in all workspaces. The bell shows how many (amber when one needs you).

- **Listed:** an agent that *needs you* (permission, a question, sign-in), from the moment it waits until it continues or exits; opening its tab doesn't remove it, because it is still blocked. A *finished* turn or an *error*, until you look at that tab or the agent works again.
- **Order:** agents that need you first, then errors, then finished turns; within each, the one that has waited longest comes first. Each row shows the agent, what it needs, the workspace and tab, and how long it has waited.
- **Ctrl+Shift+U** goes to the next waiting agent, also from Settings or another workspace; pressing it again walks through all of them. Clicking a row does the same for that one. Both are in the command palette too, together with one entry per waiting agent.
- **Same rules as notifications:** the kinds you turned off in Settings → Notifications are not listed, and what the agent wrote appears only with *Include what the agent wrote*. Nothing is saved: the inbox is what is waiting right now, not a history.

## Resume agent conversations

Available for Claude Code and Codex. If an agent was running in a terminal when SplitNest closed, that terminal says so after a restart and offers **Resume Claude Code** (or Codex) next to *Start PowerShell only*. The restore notice offers **Resume agents (N)**.

- **What it does:** starts a new PowerShell in the folder the agent ran in and types `claude --resume <id>` or `codex resume <id>` at the prompt, visibly. The text above the button says exactly that before you click. Nothing runs until you click.
- **Which conversation:** Claude Code's own record for the agent process in that tab, so two agents in one folder each get their own; it follows `/clear`. For Codex, the conversation started in that folder after the agent started, or the id the tab itself resumed. If SplitNest can't be sure, Resume opens the agent's own list of earlier conversations instead of guessing.
- **Saved:** the agent, the conversation id and the folder, with the tab; never conversation text. Also the conversation's title (Claude Code's own name for it, or the session title an agent reports), shown above the button. That is on by default (Settings → Workspaces → *Show conversation titles for Resume*); a title can contain words from your prompt, and turning the setting off removes the saved ones. It is kept through a quit or a crash of SplitNest and removed when the agent exits on its own, or when you start a plain shell in that terminal instead (*Start PowerShell only*, *Start all shells*, restart).
- **No setup:** no hooks or agent settings are installed or changed. If the agent doesn't start within 25 s, the terminal says so and stays usable.
- **Also:** the command palette has *Resume <agent> in this terminal* and *Resume agents in this workspace*. **Settings → Workspaces → Resume agents automatically when the app opens** (off by default) resumes them without a click, each workspace the first time it is shown. With *Start fresh shells automatically* on, a terminal where an agent was running still waits with its Resume button instead of starting a plain shell.
- **WSL tabs:** Windows can't see their processes, so SplitNest knows only that Claude Code or Codex ran there (from the agent's own status reports), not which conversation. Resume there starts the shell in the workspace folder and opens the agent's own list (`claude --resume`, `codex resume`).
- **Limits:**
  - The agents' session files are undocumented; if a future version changes them, Resume falls back to the agent's list.
  - Codex's `/new` is not followed: the saved conversation stays the one the tab started with.
  - If the agent ran in a folder outside the workspace folder, Resume is refused and the terminal offers a plain shell.

