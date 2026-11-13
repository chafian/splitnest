# Changelog

All notable changes to SplitNest. Release notes on GitHub are taken from the section for each version.

## Unreleased

- **Feedback links**: Settings → About → Feedback, and the command palette (*Report a bug*, *Suggest a feature*, *Questions and ideas*), open the GitHub issue forms and Discussions in your browser. The bug form arrives with your SplitNest version filled in; nothing is sent until you submit it.

## 0.2.0 (2026-11-12)

First public release with an installer.

- **Windows installer** (`SplitNest-win32-x64-Setup.exe`): installs for your Windows user without administrator rights, adds SplitNest to the Start menu and to Windows' installed apps, and uninstalls from Settings → Apps. Your settings and workspaces are kept on uninstall. A portable ZIP is still available.
- **Automatic updates**: SplitNest checks this project's GitHub Releases for new versions, downloads them in the background and installs them when it restarts. It explains this the first time it starts, before any request, and can be turned off in Settings → About. See the [privacy policy](https://splitnest.dev/privacy/).
- **Agent inbox**: the bell in the title bar lists every agent waiting for you (Ctrl+Shift+A); Ctrl+Shift+U goes to the next one.
- **Resume agent conversations**: after a restart, terminals where Claude Code or Codex was running offer to reopen that conversation.
- **Agent notifications**: in-app notices, Windows notifications and taskbar signals when an agent needs you, finishes or fails.
- Consistent "SplitNest" product and company information on every program file.
