---
layout: ../../layouts/DocLayout.astro
title: "File explorer, editor and Git status"
description: "Reference for the SplitNest file explorer, the built-in CodeMirror editor, per-workspace Git status and terminal links."
path: /docs/tools/
---

The tools beside the terminals.

## File explorer

Left of the terminals, **Ctrl+Shift+E** or the toolbar button. A tree of the workspace folder with [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) file icons (MIT).

- **Compact folders** (Settings → File explorer, on by default): a folder whose only entry is another folder is shown together with it as one row, such as `src/main/java/com/example`, as soon as the tree loads. Expanding it opens the whole chain.
  - To know this, SplitNest lists the folders inside each folder you can see, one level at a time: at most 48 per listing, never through links or junctions, never a recursive scan.
  - Results are cached and re-checked on refresh or when the window regains focus, so a new file or folder breaks a chain then. A folder that can't be read just ends the chain. Only the display changes: nothing on disk is renamed or moved. Right-click a single part (e.g. `main`) to copy, reveal or insert *that* folder's path. Long names are cut off with `…`; hover for the full path.
- Arrow keys navigate. **Click a file or press Enter** to open it in the editor.
- **Ctrl+Enter** inserts the file’s quoted path at the terminal prompt without running it.
- Right-click (or Shift+F10) offers *Open in editor*, *Insert path into terminal*, *Copy path*, *Copy relative path* and *Reveal in File Explorer*.
- The tree never runs, renames, moves or deletes files. There is no file watcher; open folders refresh when the window regains focus or via the refresh button. Drag its right edge to resize.

## File editor

Built on [CodeMirror 6](https://codemirror.net/) (MIT). A file opens as a tab in a pane beside your terminals, splitting the largest pane. More files join that pane's tabs, and opening a file that's already open just shows its tab. Editor tabs can be dragged between panes like terminals.

- Syntax highlighting for TypeScript/JavaScript, JSON, CSS, HTML, Markdown, Python, Java, XML, YAML, SQL, shell, PowerShell, Dockerfile, properties/INI/.env, TOML, Groovy/Gradle, Kotlin, C/C++/C#, Go, Rust, Ruby and Lua. Other files open as plain text.
- Line numbers, folding, bracket matching and auto-closing, multiple cursors, word completion, and find/replace (**Ctrl+F**, or **Ctrl+Shift+F** / the ⋯ menu).
- **Saving is always explicit: Ctrl+S** (only inside the editor; terminals still receive Ctrl+S). There is no auto-save.
- Unsaved tabs show a dot. The status bar says *Unsaved*, *Saving…*, *Saved* (only right after a successful write) or *Save failed · edits kept*. Read-only files say *Read-only* and offer no saving.
- Closing an unsaved tab offers **Save and close / Discard / Cancel**; closing its pane or workspace offers to save all of them first. If a save fails, nothing closes and your text stays in the editor.
- **Quitting** (closing the window, Alt+F4, or the app being asked to quit) with unsaved files offers **Save all and quit / Discard and quit / Cancel**. Running shells are mentioned in the same dialog.
  - Save all waits for every write. If any file can't be written, or changed on disk and is still unresolved, SplitNest stays open, shows which file, and keeps all edits.
  - Cancel leaves editors and shells as they were. Repeated close requests while the dialog is open don't open a second one.
  - This does not protect against the process being killed (Task Manager, a crash) or Windows shutting down without asking apps.
- The file's encoding (UTF-8, UTF-8 with BOM, UTF-16 LE) and line endings (LF/CRLF) are kept. A file with mixed line endings is saved with the one it uses most. The status bar shows the line/column, language, encoding and line ending.
- **Changes on disk** are noticed while you work: git, formatters, other editors, and commands run in SplitNest's own terminals.
  - Open files are watched (their folder, so atomic "write a temp file and rename it" saves and delete/re-create are caught), and re-checked when the window regains focus.
  - An unmodified tab reloads quietly and keeps its cursor and scroll position. A deleted file is reported and its text kept. SplitNest's own saves are not reported as changes.
- With unsaved edits you choose: **Keep my edits** (nothing on disk changes), **Reload from disk…** (asks before discarding your edits) or **Overwrite file…** (asks before replacing the other version).
- **Every save first checks the file's current content** (a SHA-256 of its bytes, not just its timestamp) against the version you started from. If it changed, the save is refused until you choose; *Keep my edits* does not turn that check off. A program writing to the file in the few milliseconds between this check and the write can still be overwritten: Windows offers no compare-and-swap for in-place writes.
- **Limits and safety:** only existing files inside the workspace folder can be opened (up to 5 MB), and new files are never created. Binary files are refused. Files that aren't valid UTF-8/UTF-16, read-only files, and files reached through a link or junction to outside the workspace open **read-only**. File contents are never logged or stored in the app's state; only the open file paths are saved, and the files are re-read from disk after a restart.

## Git status

Shown in the sidebar (Settings → Workspaces, on by default). Each workspace folder that is in a Git repository shows its branch (or *detached at 1a2b3c4*). A clean workspace shows only that.

- **+added −removed** appears only when lines were added or removed since the last commit (staged and unstaged together, tracked files). Large numbers are shortened (*+8.5M*); the tooltip has every number, the upstream branch and how far ahead or behind it is.
- A **small dot** means files changed without changed lines: a rename, a mode change, a binary file, or untracked files (the tooltip then says *Untracked files present*; their lines are not counted). The tooltip says which.
- **When it updates:** when you select a workspace, come back to SplitNest from another program, or save a file in the editor (several within a second give one check right after that second); and after terminal output in that workspace has settled (a `git switch` shows within about a second). Output that never stops, like a development server's log, causes a check at most every 30 seconds, plus one when it stops. Changes made elsewhere while you stay in SplitNest show on the next of these.
- **Read-only:** SplitNest never changes the repository (no index refresh, no locks). Git's file-system monitor, external diff and text-conversion programs are switched off for these checks. If the repository's own Git configuration names a filter program (which Git would start to compare files), only the branch is shown and the tooltip says that changes were not checked; filters you set up yourself (e.g. Git LFS) work as usual. Submodules are not looked into (Git would check them with their own configuration), so changes inside a submodule are not counted. Git otherwise uses your configuration, and repositories owned by another user are refused unless you allowed them (`safe.directory`).
- **Which repository:** Git looks in the workspace folder and upwards, but not into your user folder or a drive root. A project folder that is not a repository therefore shows nothing even if your user folder is one (some people keep dotfiles there); the user folder itself, as a workspace, shows its repository.
- **WSL:** what counts is the workspace folder, not the terminal. A folder on a Windows drive (`C:\…`) shows Git status also when its terminals run WSL. Workspaces whose folder is inside WSL (`\\wsl$\…` or `\\wsl.localhost\…`) show none in this version.
- Needs Git for Windows (`git.exe` on PATH); without it nothing is shown.

## Links

Links in terminal output open in your browser only on **Ctrl+click**, and only for `http`/`https`.



