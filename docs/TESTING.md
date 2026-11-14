# Test results

**Test machine:** Windows 11 Home build 26300 (x64), Intel Core i7-10700K, 64 GB RAM, AMD Radeon RX 9060 XT, Node.js 20.19.5, WSL 2.6.3 with Ubuntu-22.04 (plus Docker Desktop’s internal distributions, which are hidden). Windows PowerShell 5.1 only; **PowerShell 7 is not installed**, so the `pwsh` profile was exercised only by unit tests with simulated discovery. Date: 2026-11-02.

## Changes panel, R1: task summaries and compact rows (2026-11-14)

- **E2E:**
  - `run-tasks.mjs` 19 / 19: a new, untracked 3-line file shows `+3 −0` before any commit, with "No commits yet" and "1 change not committed yet" in the tooltip, which says what the counts are against. After a commit trimmed to one line it shows `+1 −0` and "1 commit that main doesn't have". The row has no path, branch or tag line. Summaries ran 3 times against 7 Git status checks, never more.
  - `run-tasks-wsl.mjs` 4 / 4: the WSL task row shows `+1 −0` from Linux Git.
- **Real Git** (`task-service-real.test.ts`, now 47):
  - +6 −3 for a committed edit, a deletion and a rename, plus an uncommitted edit, a new 4-line file without a final newline and a new binary file; main's own later commit is left out; ahead 1, behind 1.
  - The version is stable without changes and moves with them, and a changed new file is counted anew.
  - A new folder or a 600 KB new file makes the count approximate.
  - A repository filter gives nothing, and a missing folder says so.
- **Real WSL** (13): several Git commands in one `wsl.exe` start, with exact exit codes and NUL-separated output, including file names with spaces, quotes and `$(…)`. Summary counts from Linux Git.
- **Unit:** the queue (tasks only, only when on, requests during a run become one more run, clearing when turned off), line counts (no final newline, empty file, CRLF, binary), status entries, batch framing (missing results after a stop, a cut), and the row's counts and tooltip.
- **Found while testing:**
  - Since M6's `timeout` wrapper, a missing Git in WSL was reported by `timeout`, not `env`, so "Git not installed" wasn't recognised. Fixed.
  - Separately, a probe run from Git Bash passed a Linux path that Git Bash rewrote into a Windows one. The command then ran in this repository mounted in WSL and added one empty local commit. It was found at once, checked empty and removed before anything was pushed; the repository's settings were unchanged. Linux paths for WSL now go through Node or tests only.
- **Regressions:** unit 544 / 544; WSL 13 / 13; `run-e2e.mjs` 36 / 36. Type check and lint are clean.

## Agent tasks, M6: review fixes and on by default (2026-11-14)

- **Independent review** of the whole feature (a separate reviewer reading the code, not my notes). Its findings, each verified before fixing:
  - "nothing to merge" when the base branch is gone;
  - `heads/main` with a same-named tag (reproduced);
  - markers in staged files (reproduced: `diff --diff-filter=U` is empty after `git add`, while `diff --check` reports them);
  - Discard confirming only the commit;
  - the capped list hiding uncommitted files;
  - WSL Git surviving a timeout.

  It found no way for the page to make main act on folders or branches it didn't create.
- **Real Git** (`task-service-real.test.ts`, now 43):
  - a tag named `main`;
  - staged conflict markers refused, then committed once resolved;
  - base branch deleted: unknown, not nothing, and the unmerged branch kept on removal;
  - uncommitted work found by status, with removal refused before anything is ended;
  - a Japanese name gets `splitnest/task`;
  - a folder deleted outside, reported and removable;
  - Discard refused after a new commit, after a file written while the confirmation was open, and after a change to a listed file.
- **Unit:** the Finish plan for an unknown base and for unlisted uncommitted changes; agent tasks on by default (also for settings saved before the setting existed), off only with `false`.
- **E2E:** `run-tasks.mjs` 19 / 19 (on by default; turning the setting off hides the button and command, on brings them back); `run-tasks-wsl.mjs` 4 / 4 (no setting needed now; Git in WSL under `timeout`).
- **Regressions:** unit 532 / 532; WSL 11 / 11; `run-e2e.mjs` 36 / 36. Type check and lint are clean.

## Agent tasks, M5: repositories inside WSL (2026-11-14)

- **E2E** (`node tests/e2e/run-tasks-wsl.mjs`, 4 / 4; Ubuntu-22.04, Git 2.34.1; repository in a temporary folder under `/tmp`): the WSL workspace gets *New agent task* (it has no sidebar Git status); the dialog offers only `wsl:Ubuntu-22.04` and shows the task folder as `\\wsl.localhost\…\app.worktrees\fix-parser`; Linux Git makes the worktree (its `.git` names a Linux path) and `git status` works in the task's WSL terminal; Review lists a file written from Windows; Finish commits, says it can't check for conflicts first (Git 2.34), merges into main and deletes folder and branch.
- **Real WSL** (`tests/wsl/task-service-wsl.test.ts`, 5): create with Linux Git; review, commit all, clean merge, cleanup; a conflicting merge undone with main unchanged and no `MERGE_HEAD`; bringing in main with the conflict found through Linux `--git-path` output, markers refused, resolved and merged; remove refuses uncommitted work, discard deletes it; other distributions and `..` paths refused.
- **Unit:** WSL path mapping (`parseWslUnc`, `wslUnc`) and which shells a task offers (`taskShells`: the repository's distribution inside WSL, PowerShell for a Windows drive).
- **Regressions:** unit 525 / 525; WSL 11 / 11; `run-tasks.mjs` 19 / 19; `run-e2e.mjs` 36 / 36. Type check and lint are clean.

## Agent tasks, M4: finish (2026-11-14)

- **E2E** (`run-tasks.mjs`, now 19 / 19):
  - Finish names 3 uncommitted files and the running terminal; *Commit all* commits them with the message; the merge step then says 2 commits merge cleanly.
  - *Merge into main and clean up*: main has the work, the folder and branch are gone, the task's agent process ended, the workspace left the list, and the parent's own uncommitted file is untouched.
  - Conflicts: Finish names `README.md` and keeps Merge disabled; *Bring in latest main* leaves the conflict in the task while main is untouched; resolving and *Commit all* make the merge clean; the merged result reaches main.
  - Discard lists the uncommitted file, the unmerged commit and the branch, then deletes folder and branch; nothing reaches main.
- **Found by the E2E and fixed:** a newly created task's terminal was still marked to start automatically, so after Finish ended it, its pane started a new shell and the folder stayed in use; ending a task's terminals now clears that mark. And the result note could show before the steps were re-read; the steps are now refreshed first.
- **Real Git** (`task-service-real.test.ts`, now 37): fresh task and its ignored entries; Commit all (messages refused, new and changed files, body kept); merge with a diverged base and untracked files in the parent; refusals (uncommitted task, dirty base unchanged, base not checked out); conflicts previewed and an attempted merge undone with the base byte-for-byte as before; bring in the base with conflicts left in the task, markers refused, resolution committed, then merged; up-to-date and clean updates; a merge in progress in the parent blocks and is left alone; a refusing `pre-merge-commit` hook leaves the base unchanged; discard refused for newer commits and non-tasks, then deletes folder and unmerged branch.
- **Unit:** the Finish plan's steps and buttons for each state (`finish-plan.test.ts`, 8).
- **Regressions:** unit 517 / 517; `run-resume.mjs` 12 / 12; `run-e2e.mjs` 36 / 36. Type check and lint are clean.

## Agent tasks, M3: review (2026-11-14)

- **E2E** (`run-tasks.mjs`, now 15 / 15): Review lists a committed file and new uncommitted ones (marked), shows each diff with added lines, picks up a file made while it is open after *Refresh*, closes with Escape; a task without changes says so; the palette command is disabled outside a task.
- **Real Git** (`task-service-real.test.ts`, 27): every kind of change (edit, add, delete, rename, binary, untracked, uncommitted on top of a commit), the base branch's own later change left out, untracked file shown as added lines, paths not in the listing refused (`README.md`, `../`, `C:\`, `/etc`, `src/../a.txt`, pathspec magic, non-strings), `[ab].txt` taken literally, a 1.5 MB diff cut at 1 MB on a line boundary, a repository filter refused, and reviewing leaves the index and lock files unchanged.
- **Unit:** diff rows with line numbers, CRLF, renames, row cap (`diff-lines.test.ts`); name-status, numstat and safe paths (`git-worktree.test.ts`).
- **Regressions:** unit 499 / 499; `run-e2e.mjs` 36 / 36. Type check and lint are clean.

## Agent tasks, M2: create and run (2026-11-13)

- **E2E, dev build** (`node tests/e2e/run-tasks.mjs`, 13 / 13). Stand-in `claude.exe`/`codex.exe` (copies of cmd.exe) first on PATH, checked before each step that types an agent's name; temporary repository, profile and agent home.
  - Off by default (no command, no button); the setting turns it on.
  - The dialog shows branch, folder and base commit before anything exists, and names the parent's uncommitted changes; nothing is created on Cancel.
  - Create: worktree on `splitnest/fix-login`, uncommitted files not copied, the task listed under its workspace, Claude Code typed and detected, running in the task folder.
  - Commits show in the sidebar (*1 commit*); a second task with Codex runs at the same time; a taken name gets `-2`; a folder that isn't a repository says so and can't create.
  - Main refuses a saved task with another branch or folder (`FORBIDDEN`), and the saved task stays as created.
  - Resume: the conversation is saved in the task folder; after a restart the tasks are back under their workspace and Resume reopens it there.
  - Removing a task from the list keeps its folder and branch, and the confirmation says so.
- **Unit:** saved-task validation, list order, sidebar text (`tasks-state.test.ts`, 12).
- **Regressions:** unit 482 / 482; `run-resume.mjs` 12 / 12; `run-e2e.mjs` 36 / 36. Type check and lint are clean.

## Agent detection suite: intermittent step and leftover temp folders fixed (2026-11-12)

- **Intermittent failure** ("estimated states look different", failed 2 runs out of about 9 over two days):
  - **Cause:** the step typed a command that rings the terminal bell, then switched tabs. When the bell arrived before the switch, the tab was still on screen, and the bell counted as seen at once.
  - **Fix:** the step now switches first and writes the bell into the background tab's output, setting the stand-in agent again right before it (main's real scan can replace it).
  - **Result:** 8 / 8 runs passed afterwards.
- **Leftover temp folders:** every run left `%TEMP%	w-agents-*` with the whole test profile (36 had collected).
  - **Cause:** the suite starts real Codex (no prompt) in its workspace folder. Afterwards that folder stays held by another program for some minutes; one leftover was free about 15 minutes later. No process had it as its working folder, so it is most likely a handle kept by Codex's shared background service (not confirmed with a handle viewer). Removing the folder first made the whole cleanup fail.
  - **Fix:** cleanup now goes part by part. The profile is always removed, and the empty workspace folder is reported if it is still held.

## First notification after Windows registers SplitNest: now displayed (2026-11-12, branch feat/agent-inbox)

- **Fault** (found 2026-11-11, twice): the notification during which Electron registers SplitNest with Windows was accepted (in the app's notification history) but shown neither as a banner nor in Notification Center. Every later one was displayed.
- **Fix:** `showAgainOnceRegistered` in `src/main/notifications.ts`. A notification shown while the Start menu shortcut doesn't exist yet, or within 3 s after that, is shown again when the 3 s have passed (same id). Nothing is registered earlier than before, and later notifications are untouched.
- **Unit tests** (`notification-registration.test.ts`, 5): already registered → shown once; the registering one → shown again with the same id and handlers, the first withdrawn; another inside the delay → shown again at the same moment; closed before the delay → not shown again; close after the second showing closes that one.
- **Packaged check with a person at the desktop** (`out-banner`, `tests/windows/packaged-notify.mjs`; no SplitNest registration existed before; stand-in agent, no prompts):

| | Result |
|---|---|
| Before launch and after launch | no shortcut, no activator, no settings key |
| First notification ever (permission request, SplitNest minimized, "Other" shown) | delivered (run tag `kc93e7-n1`). **The person saw it and clicked it**; before the fix nothing was visible at this point |
| The click | window restored and in front with Backend selected; entry left Notification Center |
| Cleanup | shortcut, activator and settings key removed (all created by the test) |

- **Limits of this check:**
  - **One trial, one machine** (Windows 11 build 26300), with the 3 s delay; shorter delays were not tried.
  - **Banner or Notification Center:** the person reported clicking the notification 21 s after it was sent. Whether that was the banner or its Notification Center entry was not stated; either was invisible before the fix.

## Agent inbox (2026-11-12, branch feat/agent-inbox)

- **Unit tests** (`agent-inbox.test.ts`, 15):
  - **Rules:** blocked agents stay while blocked, also when seen; a changed reason restarts the wait; finished after the settle time and until seen; not listed when watched or when the agent works again; exit rules; order; the "next agent" walk; kind settings; closed tabs.
  - **Recorded runs:** Claude Code gives "needs permission", then nothing, then "finished", kept after it exits. Codex start-up gives nothing; a Codex task gives the same sequence although its `done` becomes `idle`.
  - **Labels:** the waited-time and button wording.
  - **Full unit suite:** 370 / 370.
- **E2E, dev build** (`node tests/e2e/run-inbox.mjs`, 10 / 10; two workspaces, states fed as real OSC 7501 reports, no agent run):
  - **Empty state:** no count on the bell; Ctrl+Shift+A opens "No agents are waiting"; Escape closes it.
  - **Order:** a blocked agent is listed above a finished turn that came earlier, in another workspace.
  - **Privacy:** session title and message are absent by default.
  - **Ctrl+Shift+U:** opens the blocked agent first (it stays listed), then the finished one in the other workspace (seen, so removed), then back. When the agent continues, the inbox is empty and the shortcut says so.
  - **Navigation:** a row click shows that tab; the shortcut works from Settings; the palette lists the waiting agent.
  - **Closed tab:** closing the tab removes its item.
  - **Screen:** the open list was checked in a screenshot.
- **Regressions:** `run-notify.mjs` 12 / 12; `run-resume.mjs` 11 / 11; `run-e2e.mjs` 34 / 34. Type check and lint are clean.

## Agent session resume: implementation checks (2026-11-11, branch feat/agent-resume)

- **Unit tests:**
  - `agent-sessions.test.ts` (10): the measured file shapes, validation, command-line ids, folder matching, Codex's one-match rule, two tabs in one folder, `/clear`, exit.
  - `agent-resume-state.test.ts` (8): tab state round trip, damaged record, rename, quit vs agent exit, the typed command, and main's start-folder rules (inside the workspace, PowerShell only, existing).
  - **Full unit suite:** 350 / 350.
- **E2E, dev build** (`node tests/e2e/run-resume.mjs`, 11 / 11):
  - **Setup:** stand-in `claude.exe`/`codex.exe` (copies of `cmd.exe`) first on PATH, checked before every Resume. Agent records are written into a temporary home.
  - **Steps covered:** capture, `/clear`, Codex match, both kept through a quit, "Resume agents (2)" and the explanation shown with nothing started, Resume typing `claude --resume <id>`, Resume agents typing `codex resume <id>`, the agent found again, agent exit clearing Resume, and "didn't start" with the shell still usable.
  - **Screens:** checked in screenshots.
- **Regressions:** `run-e2e.mjs` 34 / 34. Type check and lint are clean.
- **Palette, WSL, automatic resume** (`node tests/e2e/run-resume-more.mjs`, 6 / 6):
  - **Palette:** *Resume Claude Code in this terminal* resumes the active terminal.
  - **WSL tab:**
    - **Kept for Resume:** an agent's report in the tab is saved as a resume record: no id, the workspace folder as the folder. It is kept through a quit.
    - **Resume:** explains first that it will open the agent's list, then types `claude --resume` in WSL. The script checked first that WSL has no `claude`, so nothing real started. The "didn't start" note followed.
  - **Resume agents automatically:** the agent terminal resumes on start-up without a click, and the other terminal is left idle.
  - **Regressions:** unit 354 / 354; `run-resume.mjs` 11 / 11; `run-e2e.mjs` 34 / 34.
- **Review after the plan was complete (2026-11-12): two faults found by reading the code, confirmed by failing E2E steps, then fixed** (`run-resume-more.mjs` now 8 / 8):
  - **Stale Resume:** starting a plain shell in a restored agent terminal left the saved conversation on the tab, so the next restart offered Resume for an agent that had not been running. A plain start (button, *Start all shells*, restart, automatic start) now forgets it; a start that joins an in-flight Resume doesn't.
  - **Lost Resume:** with *Start fresh shells automatically* on (and automatic resume off), agent terminals started plain shells and never offered Resume. They now wait with the Resume button; the other terminals still start by themselves.
  - **Regressions after the fixes:** unit 355 / 355; `run-resume.mjs` 11 / 11; `run-notify.mjs` 12 / 12; `run-e2e.mjs` 34 / 34.
  - **Known and not changed:** Codex's `/new` is not followed. A folder outside the workspace is refused by main, and the terminal then offers only a plain shell.
- **Found while writing it:** WSL sees the Windows `codex` through PATH interop (here `/mnt/c/.../npm/codex`). So in a WSL tab that reported Codex, Resume would start Windows Codex. That is the same program, but it runs against Windows' conversation store.
- **Packaged build, real agents** (`out-resume`; Claude Code 2.1.322, Codex 0.166.0; one approved prompt each; fresh profile, clean environment, temporary workspace "Resume Test"):

| Check | Result |
|---|---|
| Claude Code answered its prompt in tab "Claude" | its conversation saved with the tab, `exact` |
| Codex answered its prompt in tab "Codex" | its conversation saved with the tab (folder/time match) |
| SplitNest force-closed (a crash, no quit flow) | both conversations still in the state file |
| Relaunched | "Resume agents (2)"; no agent started before the click |
| Resume agents | Claude Code: the new process ran `claude --resume <id>`, and Claude's own live record for it holds that same conversation id. Codex: `codex resume <id>` ran and kept running. No "didn't start" note after 28 s; both tabs show their agent again |

- **Harness fault in the first run:** after the relaunch, a process command line with a control character broke the script's own JSON parsing, and its cleanup deleted the test profile. The resume half was then rerun with no new prompts:
  - **IDs:** the two conversation IDs were recovered for the test folder only. Claude's came from its project-folder name for that folder; Codex's from the first line of rollouts whose folder was the test folder.
  - **State file:** rebuilt in the same shape the first half had saved.
- **Evidence limit:** whether each agent *showed* the earlier conversation was not read from the screen. The evidence is the agents' own records and processes.


## Agent session resume, phase 1: evidence before building (2026-11-11, branch feat/agent-resume)

**Setup:** a real PowerShell in a ConPTY (node-pty) with a clean environment, in a temporary folder. Real agents, approved prompts only: 2 for Claude Code, 2 for Codex. Each first prompt gave a code word; each second prompt, in the resumed session, asked for it back. Only this probe's own session files were read: Claude's by the process ID of the probe's own `claude.exe`, Codex's by creation time and the temporary folder. Conversation text was not read; only the code word was searched for in the probe's own terminal.

| | Claude Code 2.1.322 | Codex CLI 0.166.0 |
|---|---|---|
| Where the session ID is | `~/.claude/sessions/<pid>.json` while the process runs: `sessionId`, `cwd`, `status` (busy/idle), `kind: interactive` | `~/.codex/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`, first line `session_meta`: `id`, `cwd`, `timestamp`. Written by the shared Codex app-server (`cli_version` 0.167.1, `source` "vscode" here), **not** by a process under the tab |
| Exact link to the tab's process | **Yes:** the file is named after the agent's process ID, which process detection already finds under the tab's shell | **No** process link: only "created after this agent started, same folder" |
| Starting a new conversation | `/clear` gives a **new session ID**, and the live file follows it immediately | `/new` creates no file until the first message is sent |
| On exit | the live file is deleted | rollout stays. Codex's exit hint names the **current** conversation (here the empty `/new` one, which can't be resumed), not the last one with content |
| Resume command | `claude --resume <id> [prompt]`: answered the code word | `codex resume <id> [prompt]`: answered the code word; appends to the same rollout file (no new file) |
| Resumed process | writes a new live file (new pid) with the **same** session ID | no new file; the ID is in the command line (`codex resume <id>`) |

**Consequences for the design:**
- **Claude Code:** read the session ID from the live file of the detected process, keep re-reading it while the agent runs (because of `/clear`), and save the last value. That gives the exact session even with several agents in one folder.
- **Codex:** take the ID from the command line when the tab started `codex resume <id>`. Otherwise match rollouts created after the agent process started, with the same folder. Exactly one match: offer Resume. Several or none: offer Codex's own picker (`codex resume`, which filters by folder). Never use the exit hint.
- **Both:** the file formats are undocumented, so every field is validated (UUID shape, absolute folder) and a missing or changed format falls back to the picker. No hooks or agent settings are needed.

**Side effects:**
- **Agents' own history:** the two probe conversations remain in Claude Code's and Codex's history. They are the agents' data, so they were left alone.
- **Temp folder:** Codex's shared app-server, which belongs to the Codex desktop app, started MCP helpers in the probe folder during the resume. They are not SplitNest's to end, so the empty folder `%TEMP%	w-resume-probe-0H5osD` remains until they exit.
- **Approval prompts:** none appeared. Neither agent asked for folder trust or permission.

## Agent notifications: scoped diagnostics, and the banner, taskbar and privacy checks with a person at the desktop (2026-11-11, after 666e778)

**Why:** in the earlier packaged round, one diagnostic command matched Notification Center content too loosely and printed another app's notification into the session. Nothing was stored, but the lookup itself was wrong.

**Fix (test tooling, plus one switch in main):**
- **Run tag:** `--tw-notify-id=<token>` (`[a-z0-9]{4,8}`, anything else ignored) prefixes every Windows notification id (the toast tag) with that token, e.g. `kac035-n1`. Without it, ids are `n1`, `n2`, … as before.
- **`tests/windows/notifications.ps1`:**
  - **Lookup:** asks Windows' history for SplitNest's app id only, then picks entries by tag prefix and group *before* reading any text.
  - **Output:** only the id, delivery status, and pass/fail of text checks.
  - **Cleanup:** removes by exact tag, group and app id.
  - **No UI Automation of Notification Center:** element names can't be scoped to one app before they are read, so banners and entries are clicked by the person running the check.
- **Regression test:** `tests/unit/windows-notifications-scope.test.ts` (4) runs the helper's real functions on a synthetic history: another app's entry, an ordinary SplitNest one, another run's, and two lookalikes. Their text accessor is never called, and they are never reported or removed. Reading text before filtering makes all 4 fail (checked).
- **`tests/windows/packaged-notify.mjs`:** the interactive harness.
  - **Launch:** fresh profile and a clean environment; it checks the process's path.
  - **Commands:** it waits for one command per check.
  - **Registrations:** it snapshots SplitNest's Windows registrations first and finally undoes only what points at the test build.

**Build:** `out-notify-check\SplitNest-win32-x64\splitnest.exe` from 666e778 plus this change. The process path was checked on every launch. Each check started with SplitNest minimized, "Other" shown, and a permission request from "Backend" (workspace "Notification Test"); the agent was a renamed `PING.EXE`, as before.

| Check | Person at the desktop | Automation (scoped) |
|---|---|---|
| Banner click | Banner "Claude Code needs permission" / "Notification Test · Backend" from SplitNest; clicking it opened the Backend terminal | delivered; window restored and in front with Backend selected; entry left Notification Center |
| Taskbar and sound | Sound; taskbar flash stopped when the window was opened; amber dot stayed on "Other" and cleared on visiting Backend | delivered; window opened with Other selected, Backend 6.7 s later; entry left Notification Center |
| Privacy defaults ("Include what the agent wrote" off, message "Notification Test message: violet-heron-417") | Banner showed title and "Notification Test · Backend", no message; click opened Backend | title ✓, second line ✓, message absent ✓ |

**Found on the way:**
- **No banner for the first notification after Windows registers SplitNest.** Electron creates the Start menu shortcut and the activator while showing the first notification. Windows accepted that notification (it was in Windows' history) but showed no banner and nothing visible in Notification Center, twice. The next notification had a banner. This affects a user's very first SplitNest notification. Not fixed here; fixed on 2026-11-12 (see "First notification after Windows registers SplitNest").
- **Do Not Disturb** suppressed one attempt and switched itself back on once, through Windows' automatic rules. Notifications go into history without a banner then.
- **Harness faults, fixed:**
  - "working" and "blocked" printed in one write were one state change to SplitNest, so a repeat request raised nothing. That was correct behavior; the harness now waits 2 s between them.
  - The stand-in agent ran for one hour (`ping -n 3600`), so a check started hours later had no detected agent, and SplitNest correctly showed no Windows notification for an unconfirmed report. It now runs until the end.
  - A locked temp folder no longer aborts cleanup.
- **An early test window closed** 10 minutes after launch, before any check, through the normal shutdown path. The cause is unknown.

## Agent notifications: implementation checks (2026-11-11, branch feat/agent-notifications)

**Unit tests** (all real logic, timers and clocks controlled):
- `agent-notifier.test.ts` (17): the recorded Claude Code and Codex runs replayed through the real parser, records and view logic into the notifier, plus each rule on its own.
  - **Claude Code run:** "needs permission" at 19.9 s → withdrawn at 21.1 s → "finished" at 24.4 s, even though Claude exits 1.0 s after `done` (that case was a bug the recording caught).
  - **Codex run:** "finished" at 13.0 s although its `done` is replaced by `idle` 0.8 s later.
  - **Codex start-up:** `working → idle` gives nothing.
  - **Other rules:** repeats, reasons, the settle time, looking vs in-app vs Windows, confirmation (spoof, wait, WSL), and settings.
- `notification-service.test.ts` (13): main writes the text; refusals; focused → in-app; click restores the window and targets the tab; one per tab; summary only with others up; flash, badge and sound; failure; quit closes all; test notification.
- `notifications-text.test.ts` (7): wording, privacy of the second line, plain-text cleaning, settings and IPC validation.
- **Full Vitest:** 349 / 349 (30 files).

**E2E, dev build** (`node tests/e2e/run-notify.mjs`, 12 / 12):
- **Setup:** real OSC 7501 reports are written into a tab's output; process detection is stood in for. Main records notifications instead of showing them (E2E builds only).
- **Steps covered:** in-app notice with Show; looking → nothing; withdrawal; minimized → Windows notification with main's text; click from Settings → that tab; Codex-style finish; spoofed report → nothing until confirmed; details on/off; kind off; test notification.

**Bugs found by these checks and fixed:**
- **Unreliable page focus.** The page's `document.hasFocus()` and `visibilityState` stay true/"visible" while the window is minimized (Electron 45, measured), so a minimized SplitNest would have shown in-app notices. Main now sends the window state; the page uses only that.
- **Stale details setting.** Main's copy of settings lags the page by the 250 ms save delay, so "Include what the agent wrote" could still apply for a moment after being turned off. The page now sends its current choice, and main requires both.
- **"1 agent notifications".** A rate-limited notification became a summary even with nothing else up. Now a summary only combines notifications that are still up.

**Packaged build, real Windows notifications** (`out-agent-notify3`, built from this source; scratch script, 19 / 19):
- **Setup:** temporary profile; process path checked; a workspace with a unique name. Every read from Windows was filtered to that name: Notification Center history and UI Automation.
- **The "agent":** a copy of `PING.EXE` named `claude.exe`, started by the tab's shell, so the *real* process detection confirmed "Claude Code". Its states were real OSC 7501 reports printed by PowerShell when the script dropped a trigger file. No real agent ran and no prompt was sent.

| Situation | Result |
|---|---|
| Minimized, other tab shown, `blocked kind=permission` (with a `msg`) | Windows notification in Notification Center (app id `electron.app.SplitNest`): "Claude Code needs permission" / "notify-pkg-… · Backend"; the message was not included; no in-app notice |
| Its entry in Notification Center (group "Notifications from SplitNest"), real mouse click | window restored from minimized and in front; **the Backend tab selected**; the entry left Notification Center |
| Focused, other tab shown, `done` | in-app notice "Claude Code finished" with Show, no Windows notification; Show selected Backend and removed the notice |
| Minimized **with the agent's own tab selected**, `blocked kind=question` | Windows notification "Claude Code has a question" |
| Then `done` | "Claude Code finished" replaced the question (one per tab) |
| Agent and shells exited | "finished" stayed in Notification Center |
| Window closed → SplitNest quit (exit 0) | its notification was removed from Notification Center |

- **Harness corrections during this round:**
  - The first window helper picked one of Electron's hidden windows. Its "minimize" had minimized nothing, and the run's failures came from that, not from SplitNest.
  - PowerShell's console encoding turned "·" into "�" until UTF-8 output was forced.
- **Afterwards:** the Start menu shortcut, the COM activator registration and the notification settings key the runs created were removed, so Windows is as it was.

**Manual checks still needed** (not verifiable here without a screen capture, which would include other content):
- the banner appearing on screen, and clicking the banner itself (the Notification Center entry was clicked);
- the sound;
- the taskbar flash and the amber taskbar dot (both unit-tested only);
- what Windows shows on the lock screen.

**Other suites this round:**
- `run-e2e.mjs` 34 / 34.
- `run-git.mjs` 13 / 13.
- `run-agents.mjs`: 6 / 6 twice. One earlier run failed "estimated states look different" once: the faked agent was shown without its bell. That is a step whose code path this work doesn't touch, so it's counted as intermittent, 1 of 3 runs.
- Type check and lint clean.

## Agent notifications, phase 1: observations before building (2026-11-11, branch feat/agent-notifications)

**What the agents report** (recordings from earlier real runs in SplitNest, now `tests/fixtures/agent-status-recordings.json`; the user and temp-folder names inside Claude's base64 message are redacted):

| Agent | Run | Reports, in order |
|---|---|---|
| Claude Code 2.1.316 | task, asking permission mode | `?` → idle → working → blocked `kind=permission` (with `msg`) → working → **done** → clear (1.0 s after done; the script then exits it) |
| Codex 0.166.0 | task, on-request approvals | idle → working → idle → working → blocked `kind=permission` → working → **done** → idle (0.8 s later) → clear |
| Codex 0.166.0 | start-up, no prompt | idle → working → idle |

- **Turn end:** both report `done`. Codex's start-up shows `working → idle` without any turn, so `working → idle` is not treated as "finished" for either agent.
- **Codex's `done`:** it is replaced by `idle` within a second, so the event is latched when `done` arrives, not read later.
- **Not observed yet:** `kind=question` or `kind=auth` from either agent, and what Claude Code reports for a plan approval. These need live prompts (not sent; see the report). They are handled generically: any `blocked` notifies, with the reason's wording when one is given.

**Windows notification probe** (packaged build of `c64aa93` plus a temporary trigger in `main.ts`, built into a throwaway folder and never committed):
- **Launch:** temporary profile, process path checked. The probe minimized its window and showed one notification ("Claude Code needs permission", second line "probe-A · notify-probe workspace").
- **Observation:** UI Automation, reading only the probe's own element and its ancestors. A real mouse click on the Notification Center entry (opened with Win+N), with the cursor put back afterwards.

| Check | Result |
|---|---|
| Electron | `Notification.isSupported()` true; events `show`, then `close` with reason `timedOut` about 6.7 s later |
| Delivered to Notification Center | **Yes**: Windows' own history (`ToastNotificationManager.History`) listed it for app id `electron.app.SplitNest`, and UI Automation found it in Notification Center |
| App name shown | **"SplitNest"**: group "Notifications from SplitNest", header "SplitNest" |
| Click from Notification Center | **Landed in the running process**: `Notification.handleActivation` with `{type: "click", arguments: ""}`, then the notification's own `click` event. No second process was started. The window went from minimized to restored, visible and focused. The entry left Notification Center. |
| Banner on screen | **Not verified: needs a manual check.** No banner window was visible to UI Automation, and Windows' Do Not Disturb or full-screen rules could suppress it. A screenshot was not taken, because it would capture other content. |

**Side effects of showing a notification** (registry and Start menu diffed before and after):
- Electron 45 creates a Start menu shortcut `SplitNest.lnk` with app id `electron.app.SplitNest`.
- It also registers a per-user COM activator (`HKCU\Software\Classes\CLSID\{…}\LocalServer32` → the exe).
- Windows adds `…\Notifications\Settings\electron.app.SplitNest`.
- Every build that shows a notification points the shortcut and the activator at **its own exe**. The activator CLSID is fixed by the first shortcut: a later `app.setToastActivatorCLSID` was not applied, so the product doesn't set one.
- All of these were removed after the probes, together with the probe builds and their Notification Center entries.

**Consequences for the design:**
- Clicks are routed by each notification's `click` event and an in-memory notification → tab map. Activation arguments are empty, so they can't carry the tab.
- SplitNest closes its notifications when it quits. A click on a leftover Notification Center entry would otherwise start whichever build last showed a notification, without its profile argument.

## Git status: saves during a check, SHA-256 repositories (2026-11-11, after 305b89f)

Both bugs were reproduced with their regression tests on 305b89f before the fix. Git 2.39.0.windows.2.

| Bug | Before | After |
|---|---|---|
| **1. Save during a running check.** Check starts at 0 ms, saves at 200 and 300 ms, check ends at 350 ms (controlled clock, the check held open). | The second check started at **350 ms**, as soon as the first ended: the one-second limit was skipped. | One follow-up check at **1000 ms** (one second after the first check *started*), reading the latest state; nothing else runs afterwards. |
| Same, first check ending at 1200 ms. | second check at 1200 ms | second check at 1200 ms, never two at once (at most one active check measured). |
| **2. Totals before the first commit, SHA-256 repository.** One-line file staged, then replaced; and the staged file deleted. | totals unknown (`null`, shown as a dot): the SHA-1 empty-tree id is not an object in a SHA-256 repository, so `git diff` failed | `+1 −0` and `0 / 0` |
| Same, SHA-1 repository | `+1 −0` and `0 / 0` | `+1 −0` and `0 / 0` |

- **Fix 1:** a request during a check (`again`) now goes through `request()` when the check ends, so it uses the same one-second scheduling. Output during a check re-arms the output timer instead (its 3 s gap still counts from the start of that check).
- **Fix 2:** before the first commit the empty tree's id comes from `git hash-object -t tree --stdin` with empty input and stdin closed, no `-w`. `runFile` gained an `input` option for that; without it, stdin stays open as before.
- **Real-Git tests**, run once per object format (`--object-format=sha1`, `--object-format=sha256`): the repository's object format is checked; untracked files are present (a 3-line file and a folder) and not counted; every file in `.git` (size, time, hash) is unchanged after reading the totals.

**Packaged build** (`out-git-status4`, built from the fixed source)
- **Setup:** launched with a temporary profile; process path checked as `out-git-status4\SplitNest-win32-x64\splitnest.exe`. Workspace: a SHA-256 repository without commits, one terminal tab not started. Read over CDP: the row's branch, totals, dot, `title`, and the row button's `aria-description`.
- **States 1–5** were made from outside and picked up with a window-focus event:

| State | Row | Tooltip (abridged) | Accessible text |
|---|---|---|---|
| empty repository | `main` | Branch: main (no commits yet) / No changes | Git branch main |
| one-line file staged | `main +1 −0` | 1 changed file: 1 lines added, 0 removed | Git branch main, 1 lines added, 0 removed |
| contents replaced | `main +1 −0` | same | same |
| staged file deleted | `main •` | 1 changed file, no lines added or removed (…) | Git branch main, 1 changed file |
| file back + untracked 3-line file | `main +1 −0` | … / Untracked files present (their lines are not counted) | …, untracked files present |
| two editor saves (Ctrl+S) | `main +2 −0`, then `main +3 −0` | 1 changed file: 3 lines added, 0 removed / Untracked files present … | Git branch main, 3 lines added, 0 removed, untracked files present |

- **The two editor saves:** the first save was checked at once and shown 117 ms later. The second save came 151 ms after the first, inside that check's second. The final `+3 −0` appeared 929 ms after the second save (1081 ms after the first), with no window-focus event and no shell running. The exact timing is proven by the controlled-clock test above.
- **Harness note:** a first version of the packaged script hung once without output and was stopped. Its own processes were closed and its temp folder removed. Rerun with timeouts and a watchdog, it completed in about 10 s. The cause was not identified.

**Checks run after the fix:**
- Typecheck and lint.
- Vitest 312 / 312, of which 57 focused Git tests.
- Git sidebar E2E `run-git.mjs` 13 / 13.
- Packaged sidebar check: 6 / 6 states.

## Git status review fixes (2026-11-11, after c1ac366 and 691c9d9)

Each issue was reproduced with its regression test on the code before the fix; the same tests pass after it.

| Issue | Before | After |
|---|---|---|
| **1. Totals before the first commit.** One-line file staged, then the line replaced in the working copy. | `+2 −1`: the staged diff (index vs empty tree) and the unstaged diff (worktree vs index) were added together. | `+1 −0`: one diff, working copy of tracked files against the empty tree. |
| Same, staged file deleted from the working copy. | `+3 −3` (3-line file). | `0 / 0`. |
| Untracked content in both cases (a 3-line file and a folder). | not counted | not counted (both tests include untracked files). |
| **2. Untracked wording.** A folder holding three new files. | Git reports one entry; the tooltip said "1 new file not tracked by Git yet", the accessible description "1 new file". | Dot; tooltip "Untracked files present (their lines are not counted)"; accessible description "Git branch feature/login, untracked files present"; no count anywhere. |
| Same folder plus a tracked edit. | line totals; the untracked note was in the tooltip (with a count) but not in the accessible description | `+1 −0`; tooltip has the line totals and "Untracked files present"; accessible description "…, 1 lines added, 0 removed, untracked files present". |
| **3. Save inside the one-second limit.** Check done at 0 ms, saves at 200 ms and 500 ms, nothing more. | Both saves were dropped: no check until some later event. | Exactly one check at 1000 ms, publishing the state changed at 500 ms; none after. Turning the setting off or removing the workspace before then cancels it. |

- **Issue 1:** `git diff HEAD` already compares the working copy with the last commit in one step. Before the first commit it was two diffs summed. A line staged and then changed was counted in both; a staged file deleted again counted as added and removed.
- **Issue 2:** `--untracked-files=normal` stays (fast). The number of entries is never shown or announced. Real-Git test: a folder of three files is one entry.
- **Issue 3:** one timer per workspace; requests in between join it; a check that starts meanwhile (e.g. after terminal output) makes it unnecessary and cancels it. The earlier test "not twice within a second" now expects the follow-up check.

**Checks run:**
- Typecheck and lint.
- Vitest: unit, real PTY and real Git. Focused: 53 / 53 (`git-status`, `git-label`, `git-status-real`).
- Git sidebar E2E `tests/e2e/run-git.mjs` on the dev build: 13 / 13, including the two new untracked steps, which read the row's real `title` and `aria-description`.

The read-only protections are unchanged:
- `--no-optional-locks`;
- no fsmonitor, external diff or textconv;
- the repository filter check;
- `--ignore-submodules=all`;
- the home/drive-root ceiling.

The real-Git tests for them pass.

## Git status in the sidebar (2026-11-11, branch feat/git-status)

**What it shows.** Each workspace folder in a Git repository gets a third line in its sidebar row.
- **Clean:** the branch only.
- **`+added −removed`:** only when lines changed (staged and unstaged against the last commit, tracked files).
- **A small dot:** for changes without changed lines (a rename, a mode or binary change, untracked files), explained in the tooltip.
- **Detached HEAD:** shows *detached at 1a2b3c4*.

**When it updates** (`src/main/git-status.ts`):
- **Right away:** selecting a workspace, the window getting focus, or saving a file. Not twice within 1 s.
- **After terminal output:** 0.8 s after it goes quiet, at least 3 s after the previous check.
- **Continuous output:** at most once every 30 s, plus once when it stops.
- **Scope:** output comes from the session broker, so WSL terminals in a `C:\` workspace count too. Folders inside WSL (`\\wsl$\…`, `\\wsl.localhost\…`) are skipped.

**Found while building it:**
- **The home folder on this machine is a Git repository** (`C:\Users\<user>`). Git looks upwards for a repository, so without a limit every non-repository project folder under it would show that repository, and every check would scan the user folder for untracked files. That would produce numbers like `+8538393 −6`. Git is now not allowed to go up into the home folder or a drive root (`GIT_CEILING_DIRECTORIES`). Real-Git test with a fake home repository: the project below it shows nothing; the home folder itself as a workspace shows its repository; without the limit Git would have found it.
- **Automated security review:** a repository's own `.git/config` can name a clean filter program, and `git diff` starts it to compare working-tree files (`--no-textconv` does not prevent that). Such a configuration, directly or through an included file, is now detected first. Then only the branch is read and the tooltip says changes were not checked. The real-Git test confirms the filter does not run through SplitNest. As a control, the same `git diff` without the check does run it. Filters from the user's global or system configuration (Git LFS here) are not affected.
- **Second review finding, also confirmed:** `git status` checks each submodule with the submodule's own configuration. With a filter set only there and an edit of the same byte size, a plain `git status` in the outer repository started it (reproduced by hand and in the real-Git test's control). `status` and `diff` now run with `--ignore-submodules=all`; the same test shows the filter is not started through SplitNest. Trade-off: changes inside submodules are not counted.

**Tests:**
- **Unit** (`tests/unit/git-status.test.ts`, `git-label.test.ts`): status and shortstat parsing; WSL roots; Git environment and ceiling; the commands and their options; the filter check; scheduling with fake timers (select, focus within a second, a burst, the minimum gap, three minutes of continuous output, one check at a time, setting off, no Git, WSL roots never given to Git); label rules (quiet when clean, dot cases, large numbers, tooltips).
- **Real Git** (`tests/unit/git-status-real.test.ts`, skipped without git.exe):
  - clean, edited (staged + unstaged), renamed, untracked, branch switch, detached, no commits yet;
  - nothing in `.git` changes during checks (every file's size, time and hash);
  - fsmonitor, external diff, textconv and repository clean filters (direct and included) are never started;
  - home-folder ceiling.
- **End to end** (`tests/e2e/run-git.mjs`, dev build, temp folders): 12 / 12.

| Step | Result |
|---|---|
| Clean repository | branch only, no numbers, no dot |
| `git switch -c feature/login` typed in the terminal | shown 1.3 s after Enter |
| Two lines changed | `+2 −1` (3 s: within the 3 s gap after the previous check) |
| `git mv` (rename) | dot, tooltip "1 changed file, no lines added or removed …" |
| Untracked file | dot, tooltip "1 new file not tracked by Git yet …" |
| File changed outside SplitNest, window focus | shown about 0.1-0.2 s after focus |
| Commit made while another workspace was shown, then selected | shown 0.1 s after selecting |
| Folder that is not a repository, under the Git home folder | no Git line |
| Log printing 20 lines/s for 50 s | 1 check while printing, 1 after it stopped |
| WSL terminal in a `C:\` workspace appends a line | `+1` shown 1.0-1.1 s after Enter |
| Workspace `\\wsl.localhost\Ubuntu-22.04\tmp` | no Git line, 0 Git checks |
| Setting off / on | line hidden / shown again; the WSL limitation is in the setting's text |

**Other runs:**
- Vitest 300 / 300 (unit and real PTY).
- E2E suite 34 / 34.
- Resize scenarios A and S 47 / 47 (the broker's output path changed).
- Packaged build (`out-git-status`): the row shows `release +2 −0` for a temporary repository (attached over CDP, temporary profile); fuses unchanged.
- The agents suite failed its "estimated states" step once: the same intermittent step as on 27137e3, unrelated.

**Not covered / limits:**
- Changes made by other programs while SplitNest stays in front (no file watching) show on the next select, focus, save or terminal output.
- Line totals do not include untracked files, nor changes inside submodules.
- Very large repositories: status times out after 10 s and diff after 15 s; on timeout the totals are shown as unknown (a dot).
- PowerShell 7 and Git versions other than 2.39 were not tested.

## Review round: redraw reader, cut lines (2026-11-10, after 27137e3)

**Three review findings, each reproduced on 27137e3 first** (same tests and harness before and after; the "before" build was 27137e3 plus the test-only `feed` hook).

| Finding | Before (27137e3) | After |
|---|---|---|
| `parseRedrawTop('\x1b[H\x1b[9999999999C', 23)` | `RangeError: Invalid string length` (`' '.repeat(count)` with a count taken from the output) | that parser is gone; the cursor stops at the last column and the next chunk is read as usual (unit test) |
| the same, in the app (scenario H: that sequence fed as session output every 3 ms during two divider drags) | 84 and 114 console errors in two runs (of 339 and 311 chunks); output was delayed, not lost | 0 errors; screen, cursor and typed command as on the console |
| `éabcZ` at 4 columns | rows `éab`, `cZ` (string length counted as cells) | `éabc`, `Z`, equal to xterm's rows |
| Arabic with a combining mark; a double-width character at the wrap boundary | wrong rows in both | equal to xterm's rows |
| the cut line's part (`hij end`) after it has scrolled off (scenario M) | still in scrollback: 151 "hij end" lines for 150 real ones (`tail3`), the 30-character part still there (`tail2`) | gone; all 150 numbered lines and all 150 real `hij end` lines once, in order |

**1 and 2: the redraw is laid out by xterm (`redraw-reader.ts`).** The hand-written parser is removed. An xterm that is never opened, with the terminal's size and Unicode version, parses the output after cursor-home; the first rows are read from its buffer. So widths, wrapping and cursor moves are xterm's by construction, and no number from the output is used by SplitNest.
- It reports when the cursor is below the rows it needs, when the console shows the cursor again, or after 30 ms without output (rows above the cursor only). It gives up after 256 K characters or if its first row is trimmed.
- Constructing it takes about 0.45 ms (measured, 120x50).
- `tests/unit/redraw-reader.test.ts` runs it on a real xterm in Node (`tests/unit/xterm-node.ts`) and compares each layout case with a separately configured xterm.
- A smaller count (`\x1b[400000000C`) threw nothing before but allocated a 400 MB string; covered by a test.
- Reachability: through the system ConPTY a program's own cursor-forward does not reach the terminal as written (conhost interprets it; checked with PowerShell writing `ESC[9999999999C`: no such sequence in the stream). The failure was reproduced through the test feed. The parser is replaced regardless.

**3: the duplicated part of a cut line.** Rechecked with the 150-line reproduction and pane heights that put the top row on the third row of a numbered line (`tail3`), on its second row (`tail2`) and on a real line with the same text (`legit`). In scenario M every numbered line is followed by a line the program really prints whose text equals the numbered line's last row.
- **The `splitMidRow` decision stays.** The console has only the rest of the line and draws it at column 0 of its top row. Writing that into the middle of xterm's re-wrapped line would destroy the line's beginning, and xterm cannot keep a line split at that point as one wrapped line (it treats every wrapped row but the last as full). So the complete line stays in scrollback and the console's part is on the top row, as on the console.
- **The two cases can be told apart reliably, by origin instead of text.** When a resize cuts a line this way the controller puts a marker on the row that becomes the top of the screen, and after the redraw has been written records it if it is the end of the line above (`cut-line.ts`). A real line is never marked.
- **Removal.** Once output has scrolled the part off the screen it is deleted from scrollback with public xterm operations: grow the terminal by the distance so the rows return from scrollback, delete the lines at the top, shrink back. `tests/unit/cut-line.test.ts` checks on a real xterm that exactly those rows go and that everything else, the cursor and the size stay. It also checks that nothing is touched when a check fails: part still on screen, cursor not on the last row, view scrolled up, selection, text changed, too far away, alternate screen, a row that is not a part.
- **One output queue.** To do this at the right moment, with nothing else writing to xterm meanwhile, all output goes through `TerminalController.out`: line by line while a part is on the screen, held while a part is removed or a resize is applied. A fit no longer starts while a confirmed resize is still being applied to xterm; before, a redraw for the next size could be laid out at the previous one.
- **Found by the stricter end checks (150 % run):** the console pads a redrawn row with spaces, which xterm keeps as text, so the part was not recognised as the end of the line above. Trailing spaces are ignored now (unit test).

**Results, final build** (`tests/e2e/run-resize.mjs`, scenarios A-F, S, M, H, W; 155 checks per run):

| Run | Checks passed | Blank frames (4 recordings) | Reported: part on the console's top row |
|---|---|---|---|
| WebGL 1 | 155 / 155 | 0 | 6 |
| WebGL 2 | 155 / 155 | 0 | 6 |
| DOM | 155 / 155 | 0 | 6 |
| simulated 150 % | 155 / 155 | 0 | 1 |

- Every run compares screen and cursor with the console after each step, counts every numbered and KEEP line, and types a command at the end of each scenario. The recordings are three divider drags and the output that scrolls a part off and triggers its removal.
- S and E now end by scrolling the screen off and then allow no part anywhere.
- "Reported" is the "no partial duplicates" check while the part is the console's own top row: listed, not failed. Scrolled up, a user sees it there under the complete line until output scrolls it off.
- Harness correction (test, not app): after a character in the last column the cursor waits there to wrap; xterm reports that as column = cols, the console API as the last column. The cursor check treats exactly that pair as equal and marks it (`cursorWaitsToWrap`). It appeared once, in a 17-column pane with the 17-character prompt.
- Vitest 255 / 255 (unit and real PTY). E2E suite 34 / 34.
- Packaged build: closing one of two terminals ends its shell, `ping` and console host, the other keeps running, no second instance; fuses unchanged.

**Still open:**
- **A part can stay in scrollback** if, when it leaves the screen, the cursor is not on the last row, the view is scrolled up, text is selected, or it is already more than one screen height above the screen. It is tried again with every line of output until then.
- **A part is not recorded at all** if what the console draws is not the end of the line above as xterm has it, for example a part of several rows that the console sends without their wrap.
- **Bulk output is slower while a part is on the screen**: it is written to xterm line by line until the part has scrolled off.
- **`tests/e2e/run-agents.mjs` is intermittent, before and after this round:** 3 of 6 runs failed on 27137e3 and 3 of 7 with these changes, in the same two steps (`opening the tab changed the agent state: null`, `estimated states`), which follow the real Codex CLI in the same terminal. Since today Codex first asks to update; the suite answers with Esc (skip once; nothing installed, no setting changed). Not investigated further.
- **Not re-measured in this round:** WSL throughput and the PSReadLine case. Their code paths are unchanged apart from the output queue's direct path.

## Scrollback kept across resizes; fork-guard review; PSReadLine and WSL trade-offs (2026-11-10)

**Reproduction (scenario S in `tests/e2e/run-resize.mjs`, same before and after):** pane 2 dragged to ~23 columns, 150 numbered lines of 50 characters printed (3 rows each), then widened to ~55, maximised, restored, narrowed to ~23, widened again; after each step every numbered line must be present exactly once and in order (150 × 3 rows is far below the 10,000-row scrollback), screen and cursor must equal the console's (probe), and a typed command must print once. A separate check fails if a line of its own repeats the *end* of a numbered line ("partial duplicate"), so such leftovers are never hidden by the exact-line counts.

**Before (commit 33be31d):** after widening, lines 116–136 were missing and 137–143 duplicated, on every run; screen and cursor still agreed with the console, so only scrollback was damaged.

**Confirmed causes and fixes:**
1. **Boundary moved by xterm's reflow.** The console keeps the text of its top row at the top after re-wrapping; xterm keeps the cursor's row in place, so widening pulled scrollback rows onto the screen and narrowing pushed screen rows into scrollback (xterm 6.0.0 `Buffer._reflowLargerAdjustViewport` / `_reflowSmaller`, both with `windowsPty`). The console's redraw then overwrote or repeated them. Fix: after re-wrapping, the controller makes the console's top row the top of xterm's screen before the redraw is written (ARCHITECTURE "Scrollback boundary").
2. **Where the console's screen starts cannot be derived reliably from xterm's buffer.** Measured differences: the console trims trailing spaces its own redraw writes (up to three before CR LF), but keeps spaces an application wrote (PowerShell pads table rows to the width), and it sends some wrapped rows without their wrap (CR LF or a cursor move between them). Each made the boundary wrong by up to 21 rows in one layout or another. Fix: the top row is read from the console's redraw itself (its first rows after the cursor-home sequence, matched in xterm's buffer); an estimate is used only when they cannot be matched. Output is held for this (at most 200 ms waiting for the redraw, never more than 1 s in total).
3. **xterm's cursor after re-wrapping can be a row low**: a cursor row padded with spaces splits off a row of spaces and xterm (6.0.0, `reflowCursorLine`) moves the cursor onto it. The boundary is therefore moved with resizes that do not depend on xterm's cursor row.
4. **A redraw parsed at the wrong width during drags.** The next resize could reach the console before the redraw for the previous one had been read, so that redraw arrived after xterm had taken the newer width (seen as a garbled row at the boundary). The host now holds the next resize until the redraw has arrived and gone quiet. A first version compared timestamps and missed redraws arriving within the same millisecond, holding every step for the full 250 ms; it uses a flag now (PTY test: second resize applied in < 200 ms).

**After** (final build; all scenarios A–F, S, W; WebGL twice, DOM, simulated 150 %; 100 checks per run):

| Run | Failed checks | What failed |
|---|---|---|
| WebGL 1 | 6 | S: partial duplicate `hij end` (one line, present from the first widening on, so counted at 6 steps) |
| WebGL 2 | 6 | same |
| DOM | 7 | same, plus one in E (`size check`) |
| simulated 150 % | 1 | one in E (`e for the resize check`) |

Every exact-line check (each numbered or KEEP line once and in order, at every step of A, B, E, S), every screen/cursor comparison with the console, every typed command and every size check passed in all four runs. Flicker: 0 blank frames in all recorded drags (WebGL and DOM). Scenario S alone (43-row pane): 28 of 28 passed, twice. Full E2E suite 34/34, agents suite 6/6, Vitest 228/228 (unit + real PTY).

Harness fixes found on the way (test bugs, not app bugs): S's drag picked the wrong divider once E had split a pane (now chosen by position); W left a WSL tab active in pane 2 (now closed); two "output on its own line" waits did not allow trailing spaces.

**Not fixed at that time (the section above describes what changed since):** when the console's top row is the middle of a wrapped line and the new width splits that line at a different point, the console redraws only the part it still has, as a line of its own. The full line is kept in scrollback; the console's part appears once more above the newest output (the "partial duplicate" check fails with e.g. `hij end`). Smallest case: scenario S in a pane whose height makes the top row the second or third row of a numbered line. The console has no record of the line's beginning, so neither side can avoid this without changing ConPTY.

**Fork guard (`src/pty-host/fork-guard.ts`), reviewed:** it now intercepts only `…/node-pty/lib/conpty_console_list_agent(.js)` (also from `app.asar.unpacked`); look-alike paths and non-string paths are refused with an error and logged; a non-numeric PID argument gets an empty list (node-pty then still closes the pseudoconsole). Unit tests cover each case and pin node-pty 1.1.0's fork and kill lines. Packaged build, `tests/e2e/verify-packaged-close-one.mjs` (Playwright attached through `--remote-debugging-port`, temporary profile), 2 runs: closing one of two terminals ended its shell, its `ping` and its console host (2 → 1); the other shell and its pane stayed; the fork guard answered once; no second SplitNest; quitting afterwards left nothing behind. `tests/e2e/verify-packaged-close.ps1` (5 terminals, quit): 2 runs, no leftovers, no second instance, 5 of 5 guard answers. Fuses unchanged (RunAsNode, NODE_OPTIONS, inspect off; ASAR integrity and only-load-from-ASAR on).

**PSReadLine 2.0 (scenario P, opt-in):** prompt wrapped in a ~12-column pane, half a command typed, pane widened to ~55, rest typed. Reproduced on both runs: the line is drawn as `PS rWrite-Output ("PR" + "-DONE")R" +` (input redrawn from column 4 over the prompt). The console's own screen shows the same (probe and xterm agree on every row and on the cursor), the command runs with the full text (output once) and the earlier numbered lines are intact. This is PSReadLine's redraw, separate from scrollback; it is not changed here.

**WSL throughput in the packaged app** (`tests/perf/measure-packaged-wsl.mjs`, same machine, same 16.2 MB file, same 774×740 px terminal, variants alternated, 3 runs each; bash `time` for `cat`, which with SplitNest's flow control ends only when the terminal is at most 512 K characters behind):

| ConPTY | bash `time` (runs) | median | wall time to marker |
|---|---|---|---|
| system (default) | 1.151, 1.132, 1.155 s | **1.15 s** (≈14 MB/s) | 1.22 s |
| bundled (`TW_DIAG_CONPTY=bundled`) | 0.497, 0.458, 0.483 s | **0.48 s** (≈34 MB/s) | 0.62 s |

(An earlier series on the previous build gave 1.12 s and 0.43 s.) So a SplitNest user sees bulk WSL output about 2.4× slower with the system ConPTY, ≈0.7 s more per 16 MB. The default was not changed again.

## Resize flicker and PowerShell output corruption (branch fix/terminal-resize, 2026-11-03)

**Harness:** `tests/e2e/run-resize.mjs` (dev build, separate temp workspace and user-data folder each run). A pane's console screen is read by `tests/e2e/console-probe.ps1`, which attaches to the shell's console (`AttachConsole` + `ReadConsoleOutputCharacter`) and never types into the shell. xterm's viewport, size and cursor are compared row by row with it after every step. Other checks:
- **Scrollback:** 30 marker lines must each be present exactly once and in order.
- **Typed commands:** a new command's output must appear once, on its own line.
- **Flicker:** CDP screencast frames are scored for "blank" frames by `tests/e2e/frame-ink.ps1`.

**Scenarios:**
- A: `dir` narrowed and widened.
- B: a pane made shorter than the cursor row.
- C: resizing while output streams.
- D: a long, partially typed command.
- E: nested split drag, maximise/restore, sidebar collapse, and the window made smaller and larger.
- F: a shell started very narrow.
- W: WSL.
- final: typing in every pane.

`--renderer dom`, `--scale 1.5` and `TW_DIAG_CONPTY=bundled` select the variants. Exit code 1 on any failure; there are no "known" exceptions.

**Confirmed causes:**
1. **Flicker.** The pane was refitted inside a `requestAnimationFrame` callback. xterm's WebGL renderer resizes its canvas synchronously, which clears it, and repaints in the *next* animation frame, so one blank frame reached the screen per resize. The DOM renderer showed none.
   - Before: 22, 24 and 96 blank frames in the three recorded drags (WebGL).
   - Now: 0 / 0 / 0, the same as DOM.
   - Fix: refit from a timer task (`terminal-controller.ts`, `scheduleFit`), never from rAF.
2. **Output processed at the wrong width.** xterm was resized before the PTY applied the new size, so output ConPTY had already formatted for the old width was laid out at the new one. Fix: the PTY host now acknowledges each resize after `pty.resize()` returns (`resized` event). xterm resizes only on that acknowledgement, and only after the output received before it has been parsed. There is one request in flight at a time, at most one every 50 ms while dragging. The final size is always sent, including after a cancelled drag. Hidden or exited tabs resize xterm only.
3. **The bundled ConPTY never repaints after a resize, and expects the terminal to re-wrap exactly as conhost does. xterm.js doesn't.**
   - Seen in probe dumps: PowerShell pads table rows with real spaces that xterm keeps when re-wrapping but conhost trims.
   - xterm clamps the cursor column on shrink (xterm 14,0 vs console 17,0).
   - Neither terminal options nor ordering fix this: 35 of 64 checks still failed with causes 1–2 fixed.
   - The **system ConPTY** repaints the screen after each resize, so the screens agree again. SplitNest now uses it (`useConptyDll: false`).

**Results** (checks failed / total):

| Build | WebGL | DOM |
|---|---|---|
| Before (bundled ConPTY, rAF refit) | 34 / 64 | 36 / 64 |
| Ordered resize, bundled ConPTY | 33–35 / 64 | — |
| Ordered resize, system ConPTY (now) | **1 / 75** (repeated 3×; 2 of 75 once at simulated 150 %) | 1 / 64 |

**System ConPTY and process cleanup** (why the bundled one had been used):
- node-pty 1.1.0's `kill()` in system mode forks `conpty_console_list_agent`. In the packaged app (RunAsNode fuse disabled) that fork would start a second SplitNest.
- `src/pty-host/fork-guard.ts` answers that one request in-process with the shell's PID and refuses any other fork. That PID list is what node-pty itself falls back to.
- node-pty then kills the shell and closes the pseudoconsole as usual.
- Not killing at all is not an option: without `kill()` conhost stays alive, since `ClosePseudoConsole` is only reached through it.
- Nothing in `node_modules` is changed. `tests/unit/fork-guard.test.ts` fails if node-pty's kill path changes.

**Verified:**
- **Real-PTY test:** 5 sessions each running `ping` are closed, then every shell, child and console host is gone and no fork happened.
- **Packaged build** (`tests/e2e/verify-packaged-close.ps1`), run 5 times. Each run starts 5 terminals with a foreground `ping`, closes the window and presses "End sessions and quit" in the native dialog through UI Automation. Every run showed:
  - no leftover powershell/ping/conhost;
  - no second SplitNest main process (sampled every 100 ms until exit);
  - 5 of 5 fork-guard answers in the app log.
- **Fuses unchanged:** RunAsNode off, NODE_OPTIONS off, inspect off, ASAR integrity on, only-load-from-ASAR on.

**Cost of the system ConPTY:** WSL `cat` of 16 MB takes 1.40 s through raw system ConPTY vs 0.51 s through the bundled one. `cmd type` is about the same: 11.99 s vs 10.95 s. Bulk output from WSL is therefore slower.

**Not fixed (upstream):**
- **Scrollback lines lost or duplicated after a pane narrow enough to wrap them is widened** (scenario E, maximise after a 23-column pane: KEEP-23…30 overwritten). Cause, confirmed in xterm 6.0.0's `Buffer._reflowLargerAdjustViewport`:
  - Rejoining wrapped lines moves `ybase` up, pulling scrollback rows into the viewport, even with `windowsPty`.
  - Conhost has no scrollback and repaints its viewport from the top, over those rows.
  - Fixing it needs a change in xterm.js, or a ConPTY mode (resize quirk) that node-pty doesn't expose. The on-screen rows and the cursor do agree after the repaint; only scrollback above it is affected.
- PSReadLine 2.0's input-column issue in very narrow panes (below) is unchanged.

**Not tested:**
- **Real Windows display scaling:** only Chromium's `--force-device-scale-factor=1.5` was used, and that does not scale native title-bar buttons.
- **PowerShell 7:** not installed.
- WSL was covered on Ubuntu-22.04 only.

**diag-reflow.mjs audit:** it measures by typing a `$Host.UI.RawUI` command into the shell, which scrolls the screen and prints a prompt before comparing, so its result is weaker evidence. It now reports all 16 cases in agreement, and its two KNOWN exceptions were removed. Its success message names only what it checked.

## Output written over earlier output after resizing; slow ↑/↓ history

**Overlapping output (user screenshot: a second `ls` drawn over the first one, exactly 5 rows too high).**
- **Real check** (`tests/e2e/diag-reflow.mjs`): after each resize, PowerShell reads back its console's own screen (`$Host.UI.RawUI.GetBufferContents`) and the test compares it row by row with xterm's screen, at the same moment. ConPTY places output at absolute positions on its own screen, so any difference means new output lands on the wrong rows. 16 resize cases: window and split, shorter, taller, both, drags, shorter than the cursor row, an `ls` narrowed and widened, and a full screen.
- **Cause:** inside ConPTY the window is the whole buffer, with no scrollback. When a pane gets taller it adds blank rows at the bottom, whereas xterm (in its Linux behaviour) pulls lines back down from its scrollback. The bundled conpty.dll sends nothing after a resize, so nothing brings the two screens back together.

| | screens that differ |
|---|---|
| bundled ConPTY, before | **6 of 16** (every "taller" case, incl. the screenshot's) |
| bundled + xterm `windowsPty` (**now**) | **2 of 16** |
| system ConPTY (repaints after a resize) | 0 of 16 |

- **Fix:** xterm `windowsPty: { backend: 'conpty', buildNumber }`, with the real build from the preload. It is needed for reflow to stay enabled on builds ≥ 21376.
- **Remaining 2 cases:** a long *typed command* that wrapped over several rows, then a window resize that changes the width too. xterm and ConPTY re-wrap it differently. The system ConPTY would avoid this by repainting, but its kill path forks node-pty's helper, which in the packaged app would start a second copy of SplitNest (see ARCHITECTURE). So it is not used.
- Measurement pitfalls found on the way and fixed in the script: (1) the cursor-row probe was tautological (see the correction above); (2) the probe's own long command line scrolls a short screen, so both screens are now captured at the same moment and compared above that line.

**↑/↓ history about 1 s per keypress.** Measured straight through ConPTY, without SplitNest:
- ↑/↓ take 1,008–1,029 ms. Typing, ←/→, Home and Backspace take 0–16 ms.
- Without PSReadLine, ↑ takes 15 ms. With a separate history file, 17 ms. With history saving off, 16 ms.
- All key encodings and both ConPTYs are equally affected.
- PSReadLine's history lock was held by another process: a 3 s attempt to take it timed out. Windows (NtQueryMutant) reported the owner as an idle PowerShell in the user's running SplitNest.
- Every ↑/↓ in every PowerShell on the machine waits out PSReadLine's 1 s timeout. History saving also stopped: the history file had not changed since 02:25.
- Why that shell keeps the lock is not established, and no matching PSReadLine 2.0 issue was found. Possibly related: until now, automated test runs used the user's real history file and killed shells at the end.
- **Fixed on our side:** test-run shells (E2E mode only, never packaged builds) and the PTY test harness use `Set-PSReadLineOption -HistorySaveStyle SaveNothing`. Verified: the history file was unchanged (line count and time) after a full Vitest, E2E and live-agent run.

## Review follow-up: resize, inherited environment, real agent tasks, state semantics

**1. Fragmented prompts after resizing (screenshots 19/20).**
- Reproduced deterministically with `tests/e2e/diag-reflow.mjs`: a shell started about 10 columns wide and then widened kept its current prompt broken at the old width (2–3 rows as displayed). Earlier lines rejoined correctly.
- Cause, found by driving ConPTY directly (scratch probe, not kept): the bundled conpty.dll sends nothing after a resize. The system ConPTY, by contrast, repaints. xterm.js skips the cursor's line when reflowing, by design, because Linux shells redraw it on SIGWINCH. Nothing redraws it here.
- Fix: `reflowCursorLine: true`. Diagnostic: 0 broken rows. A control run with the old default still shows the broken rows.
- **Correction (next round):** the "cursor row in sync" check reported here proved nothing. ConPTY draws the probe's answer on the row the shell names, so it always "matched". Based on it I wrongly ruled out `windowsPty`. See "Output written over earlier output after resizing" below for the real check and the fix.
- **Not fixed, and not ours:** after widening, ConPTY draws typed input at row 1, column 5 with PSReadLine 2.0.0, and at column 25 without PSReadLine (correct). PSReadLine keeps the input's start column from before the resize, so text typed next can overwrite a prompt that had wrapped. It only happens when the prompt itself wrapped; the next prompt is clean. PowerShell 7 is not installed here, so newer PSReadLine versions are untested.

**2. "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker".**
- The cause was the launch, not normal startup. SplitNest passes its own environment to shells, and test runs (and the copy opened with "open the new build") were started from inside a Claude Code session. That environment holds `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN`, `CLAUDE_PID` and `AI_AGENT`.
- Fix: `buildShellEnv` drops an exact list of such parent-session markers (Claude Code, Codex sandbox, generic agent markers, other terminals' identity, VS Code git/IPC hooks) and `TW_E2E*`. It keeps the user's own variables, including `CLAUDE_CODE_*` settings and API keys.
- Tests: unit (`tests/unit/shell-env.test.ts`). Live: 7 of these variables were present in the launcher, none were visible inside a SplitNest shell (names checked, never values), and Claude Code no longer shows the warning.

**3. Real agent tasks** (`tests/e2e/run-agent-tasks.mjs`; sends a small prompt, so it is not part of routine runs). In a temp folder, each agent was asked to create `hello.txt` in an asking mode: `claude --permission-mode default`, `codex --sandbox read-only --ask-for-approval on-request`. Permission was granted once.
- **Claude Code 2.1.316:** idle → working → *Needs permission* (msg "approve Write: …\hello.txt"); still pending after the tab was focused; → working → done; file contains "hi"; after exit, logo, state and title are gone. Every state from the first report to exit came from the agent (0 estimates in the final run).
- **Codex 0.166.0:** the same cycle (blocked `kind=permission`, no msg). The first attempt never submitted: Codex treats fast typing followed at once by Enter as a paste, so the script now pauses before Enter.
- **Bug found and fixed with real agents:** on exit, both send `state=clear`, and the shell title comes back before the 3 s process scan notices. That briefly showed *estimated* idle/working. Now a root `clear` keeps the agent counted as reporting, and an exit signal marks the last scan result stale. The final Claude run is clean. Codex was not re-run after this last fix: its weekly usage limit was below 10%, and the fix is the same code path.

**4. State semantics.**
- A bell is a notification (`attention`) on top of a reported state and never replaces it.
- Looking at a tab clears the notification and a seen done/error; *Needs permission* stays until the agent reports otherwise.
- Estimated states are dashed with "?" ("Needs you?"), say "may need you" in the sidebar, are not counted in the window title, and the tooltip names the evidence (screenshot 34).
- Identity comes only from a report, a process, or (WSL only) Claude Code's exact "✳ Claude Code" title. In a PowerShell tab, a stale "✳ Claude Code" title plus a bell shows nothing.
- An agent's exit clears identity, state, session title, bell and protocol use. The next program inherits nothing (live checks in `run-agents.mjs`).

## AI agent detection in terminal tabs (added later)

- **Observation before building** (real ConPTY, PowerShell, a temp folder, no prompt sent; each agent closed with Ctrl+C):
  - **Codex 0.166.0** sent `OSC 7501 ; state=idle:app=codex`, `state=working:app=codex` (with a spinner in the title) and `state=clear` on exit. Its processes: `node.exe … @openai/codex/bin/codex.js` → `codex.exe`.
  - **Claude Code 2.1.316** set the title to `✳ Claude Code` and sent `OSC 7501 ; ?` (the protocol's feature query); no report followed while unanswered. Its process: `claude.exe`. Neither agent rang the terminal bell.
- **Unit tests** (`tests/unit/agents.test.ts`, 16):
  - The recorded Codex sequences and the Claude query parse correctly, and the reply bytes match the spec. base64 `title`/`msg`, kinds and progress are handled.
  - Hostile or malformed reports are discarded whole: control characters, invalid base64, oversize title/app/id/sequence. Direction overrides are neutralised.
  - Records: replacement, subtree clear, priority (blocked > error > working > done > idle), app inheritance, prompt/exit lifecycle, done/error until seen, the 64-record cap.
  - Heuristic fallbacks and session-title rules. Tab label priority (your name > session title > agent > shell).
  - Process detection on recorded tree shapes, and the monitor reporting only changes while skipping WSL sessions.
- **Live check with the real CLIs** (`node tests/e2e/run-agents.mjs`, built app, temp folder, no prompts):
  - Claude Code was detected via its process, and after SplitNest answered its query it reported `state=idle:app=claude-code` (`source: protocol`). It stayed detected for the 12 s timeline and disappeared after it exited.
  - Codex was detected and reported `idle` over OSC 7501.
  - Simulated with real OSC 7501 sequences printed by PowerShell: *working* with a base64 session title → *Needs you* (`kind=permission`). Checked: pill "Needs you", tooltip "Needs permission" and "Session: Fix login redirect", sidebar "1 agent needs you", window title `(1) …`. Then *done* and `clear` (agent badge gone).
  - Screenshots 31–33.
- **Bug found and fixed during the live check:** a process query that timed out (slow first WMI call) could deliver its late answer to the next query, so a stale snapshot briefly reported "no agent". Answers are now matched to their query id.
- **Not covered:** working/needs-you transitions that need a prompt (not sent, by agreement); Gemini, Copilot, Cursor, Aider, OpenCode, Qwen and Amp (not installed here; their detection patterns are untested against real installs); WSL agents in practice; Claude Code's first-run dialogs, which Claude does not report.

## Follow-up: file watching, save-before-quit, compact folders on load, deterministic resize tests, scaling (added later)

Automated tests (all on this machine: Windows 11 build 26300, Node 20.19.5, WSL Ubuntu-22.04; Windows display scaling **100 %**):
- **176 Vitest tests** passing: unit, real PowerShell PTY and real WSL. New:
  - `file-watch.test.ts` (6, real files):
    - Ordinary writes (a 5-write burst becomes one event), atomic replace (temp + rename), delete and re-create.
    - Other files in the folder are ignored; unwatch, owner cleanup and the watch limit work.
    - A change with the **timestamp restored** is still a conflict (hash, not mtime). SplitNest's own save hash equals the disk hash.
  - `quit-flow.test.ts` (6):
    - *Save all* waits for 3 saves, then quits. A write failure or a conflict keeps the app open with edits intact.
    - Discard writes nothing; Cancel changes nothing. Three close requests while the dialog is open produce **one** dialog.
    - No dialog when nothing is pending. Button sets with and without running shells.
  - `usability.test.ts` additions:
    - Compact chains: which folders are inspected (bounded at 48, skips links and cached), chain continuation, a collapsed chain shown on initial load, a chain broken by a file or a second folder, an unreadable folder ending a chain.
    - No duplicate shortcut combinations; Ctrl+Shift+M maps only to Maximise while Ctrl+M / Ctrl+Alt+M / Alt+Shift+M do not; the status bar never says "Saved" while the file is deleted or changed on disk.
- **E2E: 34/34 steps** on the final build (`npm run test:e2e`):
  - **Editor watching:** after Ctrl+S, no "external change" appears within 700 ms. A command typed into SplitNest's PowerShell terminal (`[IO.File]::WriteAllText`) reloads the clean buffer while `document.hasFocus()` stays true.
    - An atomic replace from the terminal (`Move-Item -Force` over the file) reports a conflict immediately, keeps the edits, and Ctrl+S is refused (disk unchanged).
    - `Remove-Item` reports *Deleted on disk* with the buffer kept; re-creating it with the same content clears the notice.
  - **Quit runs:** one dialog for three close requests, with prompt `{liveSessions: 1, unsavedFiles: 2}`.
    - Cancel: terminal still running and both tabs still dirty.
    - Save all with one file read-only: the other file is written, the app stays open, and a toast names the problem.
    - Save all with an unresolved external change: disk untouched, the app stays open.
    - After resolving: both writes land and the process exits.
    - `app.quit()` with Discard: nothing written.
    - The native dialog itself is answered by a test hook (`globalThis.__twQuitAsk` in main, active only in unpackaged builds with `TW_E2E=1`), so its button rendering is not automated.
  - **Compact folders:** `java-app/src/main/java/com/example` and `tests/unit` are compact and collapsed straight after load, with no folder expanded first. Arrow keys reach and expand `tests/unit`. A new `NOTES.md` breaks the chain at `java-app/src/main` after Refresh; a new `java-app/docs` folder breaks it at `java-app`.
  - **Resize waits** are now conditions instead of sleeps: `settledCols()` waits for equal column counts 150 ms apart that satisfy the expectation, and a timeout reports the column history and pane widths.
    - After maximise and after restore, `assertPtyCols()` asks the shell itself (`$Host.UI.RawUI.WindowSize.Width` / `tput cols`) and must see the same width as xterm.
    - Covered: divider drag, sidebar keyboard resize + focus mode, terminal maximise/restore, and sidebar collapse + focus mode while an editor has unsaved text (its line, column and dirty state unchanged).
  - **E2E history this round, reported as-is:**
    - Run 1 failed once on "compact row should start collapsed". It did not recur in 5 later full runs or in a targeted diagnostic that replayed the explorer interactions; the cause was not found.
    - Run 2 failed because the command palette reopened with the previous query. The palette now always resets and syncs its `<dialog>` on open; the underlying trigger was not identified.
    - Run 3: my PTY width regex was too strict (ConPTY left stale characters after the number).
    - Run 4: ConPTY's repaint after a resize overwrote part of a line that was still on its screen. The test now checks scrollback before typing again. This ConPTY behaviour is a real, user-visible limitation.
    - The last three full runs passed.
- **Scaling** (`node tests/e2e/run-scaling.mjs`): 6 configurations × {layout, keyboard focus, Save/Discard/Cancel dialog, conflict banner}; all pass. Screenshots are in `docs/screenshots/scaling/`.
  - **100 %** is the real Windows setting. **125 % and 150 % are simulated** with Chromium's `--force-device-scale-factor` (`devicePixelRatio` verified). That scales the page like Windows DPI scaling, but not the native caption buttons or other OS chrome; real Windows 125/150 % was **not** tested because changing display settings was out of scope.
  - At 150 % the 1600×1000 window was limited to 1600×928 by the monitor's work area.
  - Checks: no horizontal page scroll; title-bar buttons ≥ 24 px and clear of the window buttons; pane buttons inside their pane and the ⋯ menu always reachable; UI text ≥ 12 px; dialog and conflict buttons on screen; no sideways dialog scroll; ellipsis on long workspace names; focus ring ≥ 2 device px.
  - Viewing the screenshots myself found two problems the first checks missed, both fixed and now checked: a long file name made the Save dialog scroll sideways, and long workspace names were cut off without an ellipsis.

## Usability pass: compact folders, maximise, save states, labels, counts, prompts (added later)

- `tests/unit/usability.test.ts` (8 tests):
  - Compact-folder rows resolve to the real deepest path. Every segment keeps its own real path, and a file has the same path with the setting on or off.
  - Chains stop at files, links/junctions, truncated or unloaded folders.
  - Maximise applies only while the pane exists, has focus and has siblings, without touching the split tree.
  - Shell counts include only `running`. Save-state wording says "Saved" only after a write and "Read-only" for read-only files. "Name · Shell" labels.
- Real shells:
  - PowerShell with the short prompt (`tests/pty/short-prompt.test.ts`): `(Get-Location).Path`, `Get-Location` table output and a `Get-Item` error all show the **full** path.
  - WSL Ubuntu-22.04 (`tests/wsl`): `$(pwd)` and `ls -d` output keep the full Linux path while the prompt shows `.../car-rental`.
  - Code review: PTY data is written to xterm unmodified; only the prompt function / `PROMPT_DIRTRIM` change.
- E2E (29/29):
  - **Compact folders:** `java-app/src/main/java/com/example` is one row with its files below. A 66-character Java name is truncated, with the full path in the tooltip. Right-clicking the `main` segment copies `java-app\src\main`. Arrow keys collapse, expand and move.
  - **Editor maximise:** fills the layout, the other panes are hidden but the terminal keeps running, and restore gives identical split widths with unsaved text intact.
  - **Terminal maximise** (via the ⋯ menu): columns grow and shrink back, and scrollback is kept. All 5 shells kept running, and the sidebar read "5 shells running", matching the live count.
  - **Save states:** "Saved" only after Ctrl+S.
    - A save failure (file made read-only on disk) shows *Save failed · edits kept*. *Save and close* then closes nothing, and the text is intact. After the attribute is restored, Ctrl+S succeeds.
    - Closing a dirty tab: *Cancel* keeps the tab and edits; *Discard* leaves the disk file unchanged.
  - **Conflicts:** *Keep my edits* leaves both versions alone. A later save asks again, and *Overwrite file…* needs a second confirmation before writing.
  - **Tab labels:** `Backend API… · PowerShell` with a separator, and accessible name/tooltip containing both parts. No separator on unnamed tabs.
- Totals: **159 automated tests**, **29 E2E steps**, all passing on the final run. One run failed the focus-mode refit check because the test measured columns before the terminal had refitted after a sidebar resize; the test now waits, and the next two runs passed.
- Not checked: Windows high-contrast mode, screen readers, display scaling other than 100 %, PowerShell 7, and the native quit dialog with unsaved files (not automatable here).

## File editor (added later)

- Library choice: **CodeMirror 6** (MIT). Monaco (MIT) was considered but is several MB, needs web workers (the CSP has `worker-src 'none'`) and extra Vite setup. A home-made editor would lack undo, IME, selection and highlighting quality. The language packages are loaded on demand. `npm audit --omit=dev`: 0 vulnerabilities.
- `tests/unit/file-editor.test.ts` (14 tests, real files in a temp folder):
  - UTF-8 / BOM / UTF-16 LE are read and kept on save; undecodable text opens read-only.
  - Binary, oversized, missing, folder, `..`, absolute, UNC and stream paths are refused.
  - A file behind a **junction** to outside the workspace opens read-only and **cannot be written**; the outside file was unchanged.
  - A change on disk after opening gives `CONFLICT` and the disk file is not touched. *Overwrite* writes, and the returned version matches `stat`. New files are never created.
  - Line-ending and indentation detection, and language detection.
  - File tabs in the reducer: they open in a new pane beside the terminal, later files join that pane, and terminal-only actions ignore them. Schema 3 round-trips; unsafe saved paths are rejected; schema 2 still loads.
- E2E step "file editor…" (real app):
  - Clicking README.md in the explorer opens it in a new pane with the editor focused. Typing marks the tab unsaved, Ctrl+S writes exactly the new text to disk, and clicking the file again does not open a second tab.
  - An external change while clean is reloaded when the window regains focus.
  - An external change while dirty makes Ctrl+S show the conflict banner without overwriting the disk file; *Overwrite with my version* then saves.
  - A second file (App.tsx) joins the same pane with TypeScript JSX highlighting.
  - Ctrl+Shift+W on an unsaved tab asks; *Discard* leaves the disk file untouched. Closing the last file closes the editor pane, and the terminal keeps running.
  - A file left open in the second workspace is **restored after relaunch**, with its content re-read from disk.
- Totals: **151 automated tests**, **28 E2E steps**, all passing.
- Not checked: the quit dialog wording with unsaved files (native dialog, not automated), very large files near the 5 MB limit for typing latency, IME input (e.g. Chinese/Japanese), and screen-reader use of the editor.

## Short prompt paths (added later)

- Unit: launch arguments and env for both shells, with the option on and off. The PowerShell setup command is a constant with no user data. `WSLENV` is appended to, not replaced (case-insensitive key). The setting defaults to on, and the request flag is validated.
- Real PowerShell (`tests/pty/short-prompt.test.ts`): in a deeply nested folder the prompt is `PS car-rental>`; `cd ..` gives `PS nested folder>` and `cd ~` gives `PS ~>`. A custom prompt defined first stays (`MINE>`). With the option off the full path is shown.
  - The setup line is entry 1 of `Get-History`. It was **not** written to the PSReadLine history file: I checked the file before and after the test for the setup text, without reading its other contents.
- Real WSL Ubuntu-22.04: `$PROMPT_DIRTRIM` is `1` inside bash and the default prompt ends in `.../car-rental$ `.
- E2E (26/26) now expects `PS alpha-service> `; screenshot 02 shows both short prompts. Totals: **138 automated tests** passing.
- Not tested: PowerShell 7 (not installed), and prompts customised by oh-my-posh/Starship (the check only looks for the built-in prompt text, so those are skipped by design).

## Workspace polish: restore notice, tab names, sidebars, focus mode (added later)

- `tests/unit/workspace-polish.test.ts` (16 tests) covers:
  - **No duplicate sessions:** a double click, two overlapping "Start all" runs and a Ctrl+Shift+R on the same terminals each create exactly one session per terminal. Running terminals are skipped later. This uses a fake terminal built on the real `StartGate`/`startAll`; the xterm-backed `TerminalController` itself is covered by the E2E run below.
  - **Partial failures:** successes keep running, failures are reported per terminal, a rejected start counts as a failure, and retrying one terminal starts only that one. A second "Start all" for the same workspace is ignored while one runs.
  - The restore-notice summary (pending / starting / failed / hidden).
  - **Tab names:** trim, length limit, control characters removed, and blank resets. Names persist through save/load, tab moves and shell changes. A bad saved name is dropped without rejecting the file. Shell titles never replace a custom name, and the shell name is not shown twice.
  - **Focus mode** hides both panels and restores the exact previous visibility and widths (expanded, rail, and hidden-explorer cases). Sidebar/explorer toggles leave focus mode.
  - Width clamping on small windows is display-only; saved widths come back when the window grows.
  - A **schema-2 file without the new fields** loads with defaults, and out-of-range widths are clamped. The packaged smoke test also still starts from a **schema-1** file.
- New E2E steps (real app, real PowerShell and WSL Ubuntu-22.04):
  - Renaming with F2 and with the context menu; Escape cancels; blank resets (WSL tab). A PowerShell `WindowTitle` change leaves the name. A 42-character name is truncated on the tab with the full name and shell in the tooltip. Names are restored after relaunch.
  - **Restored layout:** every terminal is `idle`, there is one notice with “Start all shells (3)”, the panes show “Ready to start”, and the old per-pane paragraph is gone.
  - **Racing starts:** the pane’s own Start, “Start all” twice and Start again are clicked in the same task. Three terminals, one of them a background tab, all reach `running`. The main-process log shows **exactly 3** new `session started` lines, and the notice disappears.
  - **Focus mode** via Ctrl+Shift+Enter: the sidebar and explorer are hidden and the terminal refits from 27 to 49 columns. The title-bar button restores the sidebar (276 px after a keyboard resize) and explorer (260 px) widths, and the columns return to 27. Ctrl+Shift+B collapses and restores the sidebar. The width was still 276 px after relaunch.
  - **Four panes:** the pane with focus has the mint outline. Ctrl+Alt+← moves both the `pane--active` marker and DOM focus. Screenshots at 1920×1080 and 1280×800, plus a keyboard focus ring on a title-bar button.
  - Dismissing the notice leaves all terminals idle and the tab list unchanged.
  - **Missing folder:** “Start all shells” lists the terminal with its error, **Retry** and **Show**. Retry fails again as expected, and “Start in home directory instead” recovers, after which the notice disappears.
- A narrow-pane bug found by the E2E run was fixed: a background tab's hover close button could cover the tab's centre, so a click closed it. Tabs now keep a minimum width; in narrow panes the state pill and shell label give way to the name.
- Totals after this change: **131 automated tests** (unit + real PTY + WSL) and **26 E2E steps**, all passing on the final runs. `verify:package` and `smoke:packaged` passed: window in ~0.3 s, 0 shells and 0 app processes left after a forced kill.
- One E2E run failed the focus-mode refit check right after the panel came back. The terminal refits on a ResizeObserver frame, so the check now polls for up to 2 s. Every later run passed.
- **Not checked:** display scaling other than 100 %, a high-contrast theme, and a screen reader. Contrast of the raised secondary text colour (#8a929e on #16181c–#1a1d22) is about 5.4:1 by calculation, not measured with a tool.

## Terminal tabs and the SplitNest rename (added later)

- `tests/unit/tabs.test.ts` (8 tests) covers:
  - Adding, removing, reordering and activating tabs.
  - Moving a tab to another pane, with the emptied pane removed.
  - The per-pane tab cap.
  - Migrating schema-1 files (one terminal per pane) to schema 2.
  - Rejecting empty, duplicate or invalid tabs and future schema versions.
- The E2E step “terminal tabs…” checks, with real shells:
  - Ctrl+Shift+T opens a running PowerShell tab, and the palette's “New tab: WSL” adds a WSL tab.
  - Ctrl+Tab / Ctrl+Shift+Tab switch tabs; the first tab's earlier output and session are intact.
  - **Dragging the running WSL tab into the other pane keeps its session alive** (`echo MOVED-21` works afterwards).
  - Closing a live tab asks first; the close button works.
- Totals after this feature: **115 automated tests** (unit + real PTY + WSL) and **22 E2E steps**, all passing. One earlier E2E run failed at the last check of the tabs step (the pane still showed two tabs after a close); the next three full runs passed and I did not find the cause, so treat that check as possibly flaky.
- Memory in the E2E run rose to ~860 MB working set (from ~630 MB) after creating and closing several extra tabs. Closed terminals are disposed, but I did not verify whether this is garbage-collection lag or retained memory. **Open item.**

## File explorer (added later)

- `tests/unit/explorer.test.ts` (21 tests) covers:
  - Confining paths to the workspace: rejects `..`, `.`, drive letters, UNC paths, leading separators, `:` streams, control characters, oversized input and non-strings.
  - Real directory listings with a junction and a special-character folder name.
  - Natural sort with folders first.
  - The icon mapping, and that every mapped icon is bundled.
  - PowerShell and POSIX quoting.
- The E2E step “file explorer lists the workspace…” checks, against the real UI:
  - Folders are listed first, with distinct icons.
  - Expanding by mouse and by keyboard works.
  - **Enter** on `it's & ünï ⚡.ts` inserts `'…\src\it''s & ünï ⚡.ts'`, and `Test-Path -LiteralPath` on the inserted text prints `True`.
- Totals after this feature: **107 automated tests** and **21 E2E steps**, all passing.

## Automated tests (`npm test`): 86 passed, 0 skipped (before the file explorer)

| Suite | Tests | What is real |
|---|---|---|
| `unit` (6 files) | 71 | Layout split/close/flatten/restore, depth limit, neighbour focus; state-file validation, clamping, atomic/debounced writes, corrupt and future-version recovery; IPC request validation and URL allowlist; session ownership, stale IDs, duplicate-pane guard, host crash; WSL output decoding (UTF-16LE/UTF-8) and list parsing; shell selection and PowerShell 7 → Windows PowerShell fallback; WSL launch arguments and paths with spaces, Unicode, apostrophes and `$;&\`()!%^` metacharacters; shortcut table (no plain Ctrl+letter captured). Pure logic with fake runners where noted. |
| `pty` (2 files) | 10 | **Real Windows PowerShell through real node-pty/ConPTY**: input/output and exit code 7; resize to 132×41 seen by `$Host.UI.RawUI`; Ctrl+C stops `ping` and leaves the shell alive; start in a folder named `dir with space 'quote' $HOME;&\`echo x\`(1)!%PATH%^ ünï⚡`; Unicode + ANSI colour; kill ends the shell **and its child process**; closing one session leaves another running; 10 create/close cycles leave no sessions or processes; flow control pauses at the 512 K watermark and then delivers all 30,000 lines with none missing; main-process broker + real host rejects an intruder’s input/close. |
| `wsl` (1 file) | 5 | **Real Ubuntu-22.04**: discovery; `wslpath` mapping of the special-character folder; unmapped `Z:\` reported (no silent fallback); interactive pane starts in the mapped Linux path; Ctrl+C interrupts `sleep 30`; killing one WSL pane leaves another pane and the distribution running. Skips with a console notice when no distribution exists (as on hosted CI). |

## End-to-end UI test (`npm run test:e2e`): 20/20 steps passed

Drives the built app (`.vite` production bundles, unpackaged Electron, isolated user data) with Playwright, real shells and real WSL:

1. Welcome/empty state → **Open folder…** creates a workspace and a running PowerShell pane
2. Typing, multi-line output, Unicode (`ünïcödé ⚡ 中文`) and ANSI colours
3. **Ctrl+C** interrupts `ping` (prompt back after ~110 ms)
4. **Ctrl+V** paste; mouse selection + **Ctrl+C** copies **without** interrupting the shell
5. WSL pane beside PowerShell, started in `/mnt/c/.../alpha-service`
6. Full-screen `top` in WSL, quit with `q`
7. Split down, drag divider: PowerShell pane 65 → 42 columns, and `$Host.UI.RawUI.WindowSize.Width` agrees; keyboard divider resize
8. 100,000-line output stream: finished in ~16 s; requestAnimationFrame gaps p50 16.7 ms, p95 16.8 ms, **max 17 ms** (no UI lock-up)
9. Find in terminal
10. Second workspace in `beta 'café' & co ⚡`; PowerShell reports exactly that path; a command in the first workspace keeps printing while it is hidden
11. Command palette, settings and shortcut reference
12. Closing a pane with a live `sleep 600` asks for confirmation, then the other two panes keep running
13. Memory with 3 live panes: ~625 MB total working set across 5 app processes, excluding the shells (unpackaged run)
14. `exit` in every pane is detected (status *Exited (0)*), app closes without prompts
15. Relaunch: 2 workspaces, 3 panes restored as *Not started* placeholders with **no process started**; split proportions preserved (413:689 → 377:629 px, both 0.375)
16. Explicit **Start** on a restored pane works
17. A saved pane whose profile is `wsl:Not-Installed-Distro` shows “(not available)”; switching it to Windows PowerShell starts it
18. A renamed (missing) workspace folder shows a banner and a pane error with **Start in home directory instead**, which works
19. A truncated state file is preserved as `workspace-state.corrupt-<time>.json` and the app starts empty with a notice

## Packaged application (`npm run verify:package`, `npm run smoke:packaged`)

| Check | Result |
|---|---|
| Native files unpacked (`conpty.node`, `pty.node`, `conpty.dll`, `OpenConsole.exe`, worker script) | Present |
| Headless self-test from a copy **outside the source tree** with **no Node.js on PATH** | PowerShell output read; kill completed in ~1.1 s |
| Packaged GUI with “start shells on restore”: 2 panes started | Yes (`test-results/screenshots/15-packaged.png`, not committed) |
| Window shown after process start (app log) | 408–666 ms over 4 runs (warm disk cache) |
| Packaged app working set, 2 idle PowerShell panes | 441–476 MB (app processes only) |
| Forced termination of the app (Stop-Process) | 0 shells and 0 app processes left after 4 s |
| ZIP | `out/make/zip/win32/x64/SplitNest-win32-x64-0.1.0.zip`: 152 MB (360 MB extracted) |

Timings are from the machine above with warm caches; a first launch after reboot will be slower.

## Manual checks

Covered by the E2E run and screenshots instead of hand-testing: typing, multi-line output, Unicode/ANSI, copy/paste, Ctrl+C, full-screen program, pane resize, switching workspaces while commands run, closing one pane, restart and restore, missing folder, missing shell, large output, and packaged launch. I also visually reviewed screenshots 01, 02, 11, 13 and 15.

**Not performed by hand:** Windows display scaling at 125/150/175 % (the UI uses CSS pixels and relative layout, but this was not checked), screen readers, keyboard-only navigation across the whole app, and a long daily-use session.

## Known limitations and remaining verification

- **PowerShell 7** was not available on the test machine, so `pwsh` launch is untested in practice.
- **Other WSL distributions** and **WSL 1** are untested. Distribution names with characters outside `[A-Za-z0-9._-]` are rejected.
- **Display scaling** and **Windows 10** are untested.
- **Full-screen programs**: ConPTY repaints them itself and does not forward the alternate-screen switch (`alternateBufferSeen: false` in E2E), so frames from `top`/`vim` can remain in the scrollback.
- **Detached processes** (`Start-Process`, `nohup`, `setsid`, services) are not ended when a pane closes. Background jobs in a WSL shell that ignore SIGHUP may survive; this was not asserted.
- **Quit confirmation** uses a native dialog; it was verified in code paths but not clicked through by automation (E2E exits shells first).
- **CI** (`.github/workflows/ci.yml`) has not run yet because nothing has been pushed. The PTY and E2E jobs depend on the hosted runner allowing ConPTY and a desktop session; the WSL job will report skips.
- **Dev tooling** has npm-audit advisories (Electron Forge 7 dependencies, Vitest’s tinypool); **runtime dependencies have none** (`npm audit --omit=dev`).
- The build is **unsigned** and there is no installer or auto-update.
