# Implementation plan and status

| # | Milestone | Status | Evidence |
|---|---|---|---|
| 1 | Isolated project, toolchain chosen (Forge 7 + Vite 5, Electron 45.2.1, node-pty 1.1.0) | Done | Own git repo in `xmux/`, branch `feat/windows-terminal-workspace` |
| 2 | Real PowerShell PTY in dev **and** packaged build | Done | `npm run verify:package` self-test: node-pty loads from `app.asar.unpacked` in the utility process, with no Node.js on PATH and outside the source tree |
| 3 | Validated IPC, session ownership and lifecycle | Done | `tests/unit/session-broker.test.ts`, `tests/pty/broker-integration.test.ts` |
| 4 | Workspaces, folder picker, split panes | Done | E2E steps 2–15 |
| 5 | WSL profiles and path mapping | Done | `tests/wsl/*` (Ubuntu-22.04), E2E WSL steps |
| 6 | Persistence and restoration | Done | `tests/unit/state-store.test.ts`, E2E runs 2–4 |
| 7 | UI polish, keyboard navigation, palette, shortcuts | Done | Screenshots from the E2E runs (`test-results/screenshots/`, not committed) |
| 8 | Tests, packaging, docs, CI | Done locally | CI workflow written but **not yet run on GitHub** (nothing has been pushed) |

## Next candidates (not started)

- Shell integration (OSC 7 / OSC 133) for live cwd and command status
- Code signing and an installer (MSIX or Squirrel) once distribution is wanted
- Upgrade to Electron Forge 8 when Node ≥ 22.13 is available, which clears the dev-tooling audit advisories
- Configurable shortcuts and themes
