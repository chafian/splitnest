---
layout: ../../layouts/DocLayout.astro
title: "Getting started"
description: "Requirements, installing SplitNest on Windows 11, handling the SmartScreen prompt, and opening your first workspace."
path: /docs/getting-started/
---

## Requirements

| | |
|---|---|
| OS | Windows 11 x64 (tested on build 26300). Windows 10 1809+ is likely to work but untested. |
| Shells | Windows PowerShell 5.1 (built in). PowerShell 7 (`pwsh.exe`) is used automatically when installed. |
| Git (optional) | Git for Windows (`git.exe` on PATH) for the sidebar's Git status. Without it the rest works and no Git status is shown. |
| WSL (optional) | An installed WSL distribution. The app never installs or configures WSL. To add it yourself, follow Microsoft's WSL documentation (for example `wsl --install` in an administrator terminal), then use **Settings → Refresh shell list**. |

## Install

Get the installer or the portable ZIP from the [download page](/download/). To run the portable ZIP, extract it anywhere and run `splitnest.exe`. Node.js is not needed to run SplitNest.

The build is not code-signed, so Windows SmartScreen may show an "unrecognized app" prompt. Choose **More info → Run anyway** only if you built it yourself or trust where it came from. Do not turn off Windows security features to run it. You can [verify the SHA-256 checksum](/download/#verify-the-sha-256-checksum) of your download first.

## Your first workspace

1. Click **Open folder…** and choose a project folder. A PowerShell terminal starts there.
2. Split the pane with **Ctrl+Shift+D** (left/right) or **Ctrl+Shift+S** (top/bottom), or open another terminal with **Ctrl+Shift+T**.
3. Run an AI coding agent such as Claude Code or Codex in a tab. The tab shows its logo and what it is doing, and SplitNest tells you when it needs you.
4. Press **Ctrl+Shift+P** to open the command palette, or **Ctrl+Shift+/** for the shortcut list.

Layouts and folders come back after a restart. See [saved state](/docs/saved-state/) for what that means.

## Updating

Before version 0.2.0 SplitNest does not check for updates. Starting with version 0.2.0 it checks automatically by default, and this can be turned off in Settings → About. The [privacy page](/privacy/) lists exactly what the check sends.

## Previously called "Terminal Workspace"

The app was previously called "Terminal Workspace"; on first start SplitNest copies saved workspaces from `%APPDATA%\Terminal Workspace\` (the old file is left untouched).

## Build from source

The source is on [GitHub](https://github.com/chafian/splitnest). It needs Node.js 20.19+ and npm:

```powershell
npm ci          # install the pinned dependencies
npm start       # run in development
npm run make    # build a ZIP under out/make/zip/win32/x64/
```
