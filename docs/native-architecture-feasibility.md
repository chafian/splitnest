# Native architecture feasibility: Electron vs. a shared Rust, GPU-rendered architecture

**Status:** research only. No migration, no dependency changes. Checked **2026-11-03**.
**Question:** can SplitNest move from Electron to one Rust codebase for Windows and macOS, with a GPU-rendered UI (no Electron, no WebView for the workspace and terminal), the same architectural approach as Warp, while keeping PowerShell/WSL reliability and SplitNest's features?

**Short answer:** technically yes. The building blocks exist under usable licences and are proven in shipping products (Zed, Warp). But no candidate is a drop-in replacement for what xterm.js, CodeMirror and Chromium give SplitNest today. The terminal widget, accessibility, IME and the test harness would have to be built or rebuilt.

The terminal corruption that prompted the question is **not caused by Electron**. Any terminal that sits on ConPTY has the same problem. A native stack would only give more direct control over ConPTY, and that control can also be had inside Electron.

**Recommendation: a staged path (option C).**
1. Keep the Electron app as the product.
2. Replace the Node PTY host with a small Rust process that keeps the current message protocol. That is useful in both worlds.
3. Build the native feasibility prototype in §6, time-boxed, before committing to a full migration.

Sections: [1. The current application](#1-the-current-application) · [2. Native candidates](#2-native-candidates) · [3. SplitNest's difficult requirements](#3-splitnests-difficult-requirements) · [4. Measurements of the current build](#4-measurements-of-the-current-electron-build) · [5. Options](#5-migration-options) · [6. Prototype](#6-feasibility-prototype) · [7. Open questions](#7-unresolved-questions-and-unavailable-environments)

---

## 1. The current application

### 1.1 Architecture as built

| Layer | Implementation (files) | Notes |
|---|---|---|
| Process model | Electron 45.2.1: main process, sandboxed renderer, **PTY host as an Electron utility process** (`src/pty-host/`), plus one hidden PowerShell helper for agent detection (`src/main/agent-monitor.ts`). | Fuses: no RunAsNode, no Node CLI inspect, ASAR integrity, app only from ASAR (`forge.config.ts`). |
| IPC | 30 typed channels (`src/shared/ipc.ts`), every payload validated (`src/shared/validation.ts`). Ownership checks per window in `src/main/session-broker.ts`. Sandboxed preload with a small typed API (`src/preload/preload.ts`). | Main ↔ PTY host protocol: `src/shared/pty-protocol.ts` (35 lines, message based, with flow-control acks). |
| PTY | `node-pty` 1.1.0, ConPTY with the **bundled conpty.dll / OpenConsole.exe** (`useConptyDll: true`, `src/pty-host/session-manager.ts`), because node-pty's system-ConPTY kill path calls `child_process.fork()` (a second app copy with RunAsNode disabled). Environment cleaned of the launching session's markers (`buildShellEnv`). | Flags: none (node-pty passes 0; no RESIZE_QUIRK / passthrough). |
| Shells | Discovery and launch: `src/main/shells.ts`, WSL discovery and path mapping: `src/main/wsl.ts`, launch resolution: `src/main/launch-resolver.ts`. | PowerShell 5.1/7, WSL distributions; short prompts; history isolation for test runs. |
| Terminal | xterm.js 6.0 (+ fit, search, unicode11, web-links, WebGL addons), one controller per tab outside React (`terminal-controller.ts`, `terminal-registry.ts`). `windowsPty` + `reflowCursorLine` for ConPTY. | OSC 7501, OSC 133 and title handling via xterm's parser hooks. Screen-reader mode is off today. |
| Layout | Pure split-tree operations (`src/shared/layout.ts`) and a reducer (`workspace-state.ts`). React renders the splits (`SplitView.tsx`), panes and tabs (`TerminalPane.tsx`), maximise (`maximize.ts`), sidebars (`chrome.ts`), restore and bulk start (`RestoreNotice.tsx`, `bulk-start.ts`). | Tabs drag between panes. Layout restored with placeholders (no processes started unless enabled). |
| Editor | CodeMirror 6 (`editor-controller.ts`, about 25 languages via `@codemirror/lang-*` and legacy modes, `editor-languages.ts`). | Find/replace, multiple cursors, folding, completion. |
| Files | Read-only explorer listing (`src/main/file-explorer.ts`, `explorer-tree.ts` with compact folders). Text read/write with **SHA-256 expected-version check** (`src/main/file-editor.ts`). Open-file watcher (`src/main/file-watch.ts`). | Save-before-quit and conflict handling: `src/main/quit-flow.ts`, `save-all.ts`. |
| Agents | Detection: protocol (OSC 7501, `agent-status.ts`), process tree (`agent-monitor.ts`, PowerShell/CIM, adaptive 3/12 s), exact titles for WSL. State model: reported vs. estimated, notification vs. state. | Recognised CLIs: `src/shared/agents.ts`. |
| Settings/themes | Settings page (`SettingsView.tsx`), five themes from one source (`appearance/themes.ts`) driving CSS tokens, xterm, CodeMirror (CSS variables) and the window overlay. | Persistence: versioned JSON, atomic debounced writes, corrupt-file recovery (`src/main/state-store.ts`). |
| Packaging | Electron Forge 7, ZIP for Windows x64. No macOS build exists. | |
| Tests | Vitest unit tests (16 files), real-PTY tests (`tests/pty`), WSL tests, a Playwright E2E suite with 34 scenarios (`tests/e2e/run-e2e.mjs`), plus live agent, task, resize and scaling scripts. | E2E drives the DOM through Playwright and test hooks (`window.__twTest`). |

### 1.2 What is reusable in a Rust/GPU rewrite

| Category | What | How it carries over |
|---|---|---|
| **Reusable as is** | Bundled `conpty.dll`/`OpenConsole.exe` (Microsoft, MIT); app icons; theme colour values; Tabler icon geometry (MIT); Material file-icon SVGs (MIT); agent logos (MIT); the state file format. | Data and assets, not code. |
| **Specification to port (logic is clear and tested, code is TypeScript)** | Split-tree ops (`layout.ts`), workspace reducer, state validation and recovery, session ownership rules, shell discovery and launch rules, WSL path mapping, environment cleaning, quit and save-all flow, explorer tree and compact folders, OSC 7501 parser and agent state model, tab labels, themes and derivations. | Rewrite in Rust, translating the **unit tests as acceptance tests**. These modules are pure or nearly pure, so the port is mechanical but still a rewrite. |
| **Test scenarios to keep (harness must be replaced)** | 34 E2E scenarios, PTY tests, the resize/screen-sync diagnostic, live agent checks, scaling checks. | The scenarios are the contract. Playwright cannot drive a GPU UI, so a new harness is needed (in-process test API plus OS automation). |
| **Must be replaced** | React UI (all components), xterm.js (engine **and** renderer), CodeMirror, Electron window, title-bar overlay, dialogs, IPC/preload (becomes in-process calls), node-pty, Forge packaging, Playwright E2E. | This is the bulk of the work. |

---

## 2. Native candidates

All facts below were checked on 2026-11-03 against the linked sources. "Not verified" means no primary source was found.

### 2.1 UI framework (window, layout, text, input)

| Candidate | Windows | macOS | Licence | Embedding as a library | IME | Accessibility | Maturity |
|---|---|---|---|---|---|---|---|
| **GPUI** (Zed) | Production in Zed since 2025-10 (DX11 + DirectWrite) | Production (Metal) | Apache-2.0 | crates.io `gpui` 0.2.2 (2025-10-22). Site: *"For the near future, GPUI is tied to Zed"*. README: pre-1.0, frequent breaking changes. | Works in Zed. Zed's Windows launch asked for IME feedback. | AccessKit plumbing merged 2026-05, early (caused panics; opt-out added) | High inside Zed, low as a library |
| **warpui** (Warp) | Production in Warp (Windows GA 2025-02) | Production | **MIT** (`warpui_core`, `warpui`); rest of Warp AGPL-3.0 | In the open Warp repo; no crates.io release or embedding docs | Not verified | Not verified | Internal to Warp |
| Slint | Production | Production | GPL-3 / royalty-free / commercial | Yes, documented, 1.x | Desktop OK, macOS gaps | Roles exist; open NVDA issue | Stable, but a form-oriented DSL |
| egui/eframe | Yes | Yes | MIT/Apache | Yes | Regression history | AccessKit | Good for tools |
| Iced | Yes | Yes | MIT | Yes | Since 0.14 | **None** | "Experimental" |
| Floem, Xilem, Freya, Makepad, Vizia | Mixed | Mixed | MIT/Apache | Yes | Mostly not verified | Mostly not verified | Pre-1.0 / experimental |

Third-party evidence for GPUI outside Zed: **gpui-component / GPUI Kit** (Longbridge, Apache-2.0, 0.9.0 on 2026-11-02, weekly releases) powers Longbridge Pro on Windows and macOS. It pins `gpui-pre` snapshots, so expect API churn.

Sources:
- GPUI: https://www.gpui.rs/, https://github.com/zed-industries/zed/blob/main/crates/gpui/README.md, https://crates.io/crates/gpui, https://zed.dev/blog/zed-for-windows-is-here, https://github.com/zed-industries/zed/pull/56065
- gpui-component: https://github.com/longbridge/gpui-component
- Warp: https://github.com/warpdotdev/warp (README: "Warp's UI framework (the `warpui_core` and `warpui` crates) are licensed under the MIT license … The rest of the code … AGPL v3"), https://www.warp.dev/blog/how-warp-works, https://www.warp.dev/blog/launching-warp-on-windows
- Others: https://slint.dev/pricing, https://github.com/emilk/egui, https://github.com/iced-rs/iced/issues/552

### 2.2 Terminal parser/emulation engine (state only, no drawing)

| Candidate | Windows | macOS | Licence | Status | Provides | Must be built |
|---|---|---|---|---|---|---|
| **alacritty_terminal** 0.26.0 (2026-04-06) | Yes | Yes | Apache-2.0 | Mature. No embedding docs or API-stability promise. Zed embeds a **fork**. | Grid, parser (vte), selection, scrollback, reflow on resize, Kitty keyboard, synchronized output, Unicode width tables, `tty` module | Renderer, input mapping, custom-OSC hooks (OSC 7501 / 133: fork or pre-scan) |
| **libghostty-vt** (Ghostty, C ABI; Rust crate 0.2.2) | Yes ("fully supports Windows (and we test it in CI)") | Yes | MIT | API "work in progress", "broke compatibility several times"; 1.0 expected before Ghostty 1.5 (planned March 2027) | Terminal state, render-state snapshot, key/mouse encoders, OSC handling | Renderer, PTY, UI; Zig toolchain in the build |
| wezterm-term / termwiz | Yes | Yes | MIT | `wezterm-term` not on crates.io; last WezTerm tag 20240203 | Full model | Pin a git revision; maintenance risk |
| vte 0.15 | Yes | Yes | Apache/MIT | Stable | Parser only | Everything else |

Sources: https://crates.io/crates/alacritty_terminal, https://ghostty.org/docs/install/release-notes/1-4-0 (Ghostty 1.4.0, 2026-10-27), https://crates.io/crates/termwiz, https://crates.io/crates/vte, https://raw.githubusercontent.com/zed-industries/zed/main/Cargo.toml (Zed's alacritty fork).

### 2.3 Terminal renderer

**No reusable standalone GPU terminal renderer was found.**
- Alacritty's OpenGL renderer and Ghostty's Metal/OpenGL renderer are internal to those apps.
- Zed's `terminal_view` draws an alacritty grid with GPUI, but it is part of Zed (GPL code, see §2.5).
- `iced_term` and `egui_term` are early widgets.

So the glyph-atlas grid renderer would be **our code**: cursor, selection, underline/strike, wide characters, emoji fallback, ligature policy, damage tracking. It would draw from the engine's snapshot (`renderable_content` / `RenderState`).

### 2.4 PTY and process management

| Candidate | Windows | macOS | Notes |
|---|---|---|---|
| **portable-pty** 0.9.0 (MIT) | ConPTY; prefers a **sideloaded conpty.dll + OpenConsole.exe** (same idea as node-pty's `useConptyDll`); always passes `INHERIT_CURSOR \| RESIZE_QUIRK \| WIN32_INPUT_MODE` | openpty | Kill is a single `TerminateProcess`: no job object, so descendants survive. Slow releases. |
| alacritty_terminal::tty | ConPTY, loads `conpty.dll` if present; flags 0 | Unix PTY | No job objects |
| Own thin ConPTY layer | Full control of flags and kill tree | — | What Warp does (with a ConPTY **fork**: immediate custom-OSC flush, a reset OSC against cursor drift) |

Sources: https://raw.githubusercontent.com/wezterm/wezterm/main/pty/src/win/pseudocon.rs, https://raw.githubusercontent.com/wezterm/wezterm/main/pty/src/win/mod.rs, https://raw.githubusercontent.com/alacritty/alacritty/master/alacritty_terminal/src/tty/windows/conpty.rs, https://www.warp.dev/blog/building-warp-on-windows, https://github.com/microsoft/terminal/pull/4741.

### 2.5 Editor component

| Candidate | Licence | Fit |
|---|---|---|
| **gpui-component code editor** | Apache-2.0 | Highlighting (tree-sitter / syntect), gutter, multiple cursors, find/replace, undo, completion. Claimed to handle 200K lines. Folding, accessibility and CJK IME not verified. |
| Zed `editor` crate | **GPL-3.0-or-later**; depends on Zed's workspace/project/LSP crates | Not usable as a library (licence and coupling). Reference only. |
| Iced `text_editor`, egui code editors, Slint TextEdit | MIT / Slint licence | Highlighting at best. No multiple cursors or find/replace (Slint: plain text). |
| cosmic-text + ropey/crop + tree-sitter | MIT/Apache | An editor *kit*: 2–4+ engineer-months to reach CodeMirror's level (agent estimate). |
| Scintilla / RichEdit / NSTextView | Permissive / OS | Native child windows (HWND/NSView) that cannot be composited inside one GPU surface (overlays, clipping, z-order). Excluded for an in-pane editor. |

Sources: https://github.com/longbridge/gpui-component, https://raw.githubusercontent.com/zed-industries/zed/main/crates/editor/Cargo.toml, https://github.com/iced-rs/iced/releases/tag/0.14.0, https://docs.rs/cosmic-text, https://www.scintilla.org/.

### 2.6 What Warp's openness does and does not give

- **Can study:** everything. The client source is public.
- **Can reuse:** `warpui_core`/`warpui` under MIT, with attribution.
- **Cannot copy without AGPL obligations:** everything else, including Warp's terminal model, its ConPTY integration and its shell integrations. A proprietary or permissively licensed SplitNest must not copy AGPL code.
- **Branding and UI** must not be copied regardless of licence.

---

## 3. SplitNest's difficult requirements

| Requirement | Today (Electron) | Rust/GPU (GPUI + alacritty_terminal + own renderer + ConPTY layer) | Harder or less mature after migration? |
|---|---|---|---|
| Split panes, tabs, drag, maximise, restore | React + pure split-tree logic | Port the logic as is; re-implement the views and drag-and-drop. gpui-component has a dock layout. | Same features; rebuild effort |
| PowerShell, WSL, environment, cleanup | node-pty, bundled ConPTY, env cleaning, PTY host restarts | Own ConPTY layer **with job objects** (kills whole trees) and free choice of ConPTY flags and mode | **Better control**; same rules to port (WSL mapping, env cleaning) |
| Fast output, scrollback, selection, search | xterm.js WebGL; measured in §4.2: for `cmd type` the limit is ConPTY itself (11 s raw vs. 11 s in SplitNest); for `wsl cat` SplitNest adds about 0.3 s to ConPTY's 0.5 s | Engine is fast in Rust; selection/search exist in the engine. Renderer, link detection and the search UI are ours. | Gains only where SplitNest's overhead shows (the WSL path); none where ConPTY is the limit. Feature maturity lower at first |
| Unicode, emoji, IME | Chromium text stack + unicode11 | Engine width tables; font fallback via the UI framework (DirectWrite/CoreText). IME composition in a custom grid widget is our code. | **IME and emoji fallback are the hardest gaps** |
| Resize correctness on ConPTY | Fixed with `windowsPty` + `reflowCursorLine`; 2 of 16 measured cases remain | Same problem class: engine reflow vs. ConPTY's buffer. Gains: we can choose `RESIZE_QUIRK`, a newer ConPTY, or a repainting mode, and kill trees safely. | Neutral by itself; better only with deliberate ConPTY work (see 3.1) |
| Claude Code / Codex TUIs | Verified with real CLIs (alt screen, mouse, focus events, OSC 7501, titles) | alacritty_terminal handles the same escape sequences. Kitty keyboard is supported. OSC 7501/133 need a pre-scan or a fork. | Must be re-verified with the real CLIs |
| OSC 7501 negotiation, titles, notifications | xterm parser hooks; capability reply written to the PTY | Pre-scanner on the PTY byte stream (state machine across chunk boundaries) plus reply. The agent state model ports as is. | Equivalent once built |
| Explorer, compact folders | React + pure tree builder | Port the tree builder; virtualised list view to build | Rebuild effort |
| Editor: highlight, find/replace, unsaved, conflicts, Save-before-quit | CodeMirror 6 + SHA-256 versions + watcher + quit flow | gpui-component editor (verify folding, bracket matching, completion); port the version check, watcher and quit flow | **Editor maturity lower**; logic ports as is |
| Themes | One theme source driving CSS, xterm, CodeMirror and the window | The same data drives GPU colours directly (simpler) | Easier |
| Shortcuts | DOM key handling, careful to leave shell keys alone | GPUI key contexts; same rules | Equivalent, needs re-testing |
| Accessibility | Chromium accessibility tree for all chrome (sidebar, dialogs, settings, tabs). Terminal screen-reader mode **off** today. | GPUI AccessKit is new; every custom widget needs roles and names | **Clear regression risk** for the non-terminal UI |
| Display scaling | Chromium per-monitor DPI; tested at 100% real and 125%/150% simulated | Framework DPI handling (GPUI in Zed); must be tested on real 125–200% and mixed-DPI setups | Needs validation |
| Automated testing | Playwright drives the real UI (34 scenarios) | No Playwright equivalent: in-process test API plus UIA/AX automation must be built | **Large hidden cost** |

### 3.1 The terminal corruption issue, separately

The problems investigated in this repository, with their causes:

> **Update (2026-11-03, fix/terminal-resize):** SplitNest now uses the **system** ConPTY, with an in-process answer to node-pty's console-list fork (`src/pty-host/fork-guard.ts`), plus an ordered resize path and a non-rAF refit that removes the WebGL flash. A stricter, non-intrusive harness (`tests/e2e/run-resize.mjs`) showed the bundled ConPTY failing far more cases than diag-reflow measured (34 of 64), now 1 of 75. The remaining case is in xterm.js's widening reflow. See TESTING.md. The table rows above describe the state at the time of this study.

1. **Broken prompt after widening a pane.** Fixed with `reflowCursorLine: true`. Cause: xterm by design does not reflow the cursor line, the bundled ConPTY sends nothing after a resize, and PowerShell does not redraw its prompt.
2. **Output written over earlier output after resizing** (the screenshot with a second `ls` five rows too high). Mostly fixed with `windowsPty`. Cause: ConPTY keeps no scrollback and adds blank rows when growing, while xterm pulled lines back from its scrollback. Measured with a real screen comparison (`tests/e2e/diag-reflow.mjs`): 6 of 16 resize cases differed, now 2.
3. **Remaining two cases.** A long typed command that wrapped, then a window resize that also changes the width: xterm and ConPTY re-wrap differently. The **system** ConPTY (which repaints after a resize) gave 0 of 16 differences. It is not used only because of node-pty's kill path.
4. **Typed text placed over a wrapped prompt.** PSReadLine 2.0 (Windows PowerShell 5.1) keeps a stale start column (verified: correct without PSReadLine). Not a terminal issue.
5. **~1 s ↑/↓ delay.** PSReadLine's history lock was held by another PowerShell. Not a terminal issue.

**Would a native architecture address the cause?** Only partly, and not by being native.
- Causes 1–3 come from two buffer models (ConPTY's and the emulator's) disagreeing after a resize. Every terminal on ConPTY faces this: Windows Terminal shares conhost's buffer code, WezTerm uses `RESIZE_QUIRK`, and Warp forked ConPTY and added a reset sequence.
- A Rust stack with alacritty_terminal or libghostty would need the same deliberate choices.
- What a Rust PTY layer does give is **control**: ConPTY flags, a repainting mode, job-object kill trees, even a ConPTY fork, without node-pty's constraints.
- That control can also be had **inside Electron**, by replacing the Node PTY host with a Rust process (option C, stage 1) or by patching node-pty's kill path.
- Causes 4–5 are in PowerShell and remain on any stack.

So migrating the UI would mostly **replace the surrounding stack**, not fix the cause.

---

## 4. Measurements of the current Electron build

**Machine:** Intel Core i7-10700K (8 cores/16 threads), 64 GB RAM, AMD Radeon RX 9060 XT, 1920×1080 at 100% scaling, Windows 11 Home build 26300, Balanced power plan. Build: `out-themes` (commit 12d933e), Electron 45.2.1.

**Isolation:** every run used a temporary user-data folder and a temporary project folder. The user's running SplitNest was not touched. The scripts stop only the process tree they started.
**Scripts:**
- `tests/perf/measure-packaged.ps1`: the packaged exe, measured at process level.
- `tests/perf/measure-dev.mjs`: the same production bundles under the development Electron runtime. This is needed for in-app hooks, because the packaged build disables Node inspection.
- `tests/perf/conpty-throughput.mjs`: raw ConPTY, with no UI.
**No prompts were sent** to any agent, and no system settings were changed.

### 4.1 Packaged build: size, startup, memory and idle CPU (medians of 3 runs)

**Size on disk:**
- 361 MB unpacked, 96 files. Of that, `splitnest.exe` is 238 MB, `app.asar` (SplitNest's code) 1.9 MB, and node-pty with ConPTY 2.5 MB.
- The last built ZIP is 152 MB (an older build).

Startup (seeded workspace, shells start automatically; times from process start):

| Terminals | Window visible | All shells spawned | Shells settled (CPU quiet ≥1.5 s) |
|---|---|---|---|
| 1 | 438 ms | 740 ms | 2,559 ms |
| 5 | 424 ms | 1,182 ms | 2,131 ms |
| 10 | 419 ms | 1,634 ms | 3,713 ms |

Memory after 20 s settling: private working set ("Memory" in Task Manager), average of 3 samples. Idle CPU: CPU time over 30 s, as a percentage of **one** logical core.

| Process class | 1 terminal | 5 terminals | 10 terminals | Idle CPU (1 / 10 terminals) |
|---|---|---|---|---|
| App: main | 43 MB | 39 MB | 46 MB | 0.36% / 0.10% |
| App: renderer | 36 MB | 42 MB | 53 MB | 0.36% / 0.21% |
| App: GPU process | 56 MB | 65 MB | 73 MB | 0.31% / 0.26% |
| App: utility processes (PTY host + network service) | 34 MB | 65 MB | 103 MB | 0% / 0% |
| **App total** | **169 MB** | **211 MB** | **275 MB** | ≈1.0% / ≈0.6% |
| App helper: agent detection (hidden PowerShell) | 53 MB | 54 MB | 54 MB | 0.47% / 0.47% |
| Shells: PowerShell 5.1 | 26 MB (1) | 127 MB (5) | 265 MB (10) | 0% |
| Console hosts (OpenConsole/conhost) | 2 MB | 9 MB | 17 MB | 0% |

Observations:
- **The PTY host grows by about 7 MB per terminal.** It is a Node.js process holding one node-pty session per terminal.
- **The agent-detection helper costs about 53 MB** and is the largest single idle-CPU consumer. A native process query (in Rust, or a small native module) would remove both costs **in either architecture**.
- **Shells dominate memory at higher terminal counts.** About 26 MB per PowerShell, and that cost is the same under any UI technology.
- **Limitation:** process trees are built from parent IDs. In one 10-terminal run, unrelated processes whose parent ID had been reused were picked up; they are excluded here. Private working set excludes shared DLL pages, so totals are lower than "commit" figures (private bytes: app total ≈ 300 / 360 / 450 MB).

### 4.2 In-app measurements (same production code, development runtime)

3 runs each. Window size 1600×900; 16 MB = 200,000 lines of about 80 characters.

**Startup to an interactive prompt** (launch until "PS perf-project>" is visible in the terminal): **1,192 / 1,381 / 1,295 ms**. Window visible after 222–360 ms.

**Output throughput** (end to end, until a marker printed after the output is visible in the terminal):

| Path | SplitNest (3 runs) | Raw ConPTY, no UI at all (same file, node-pty directly) | UI frames during the stream |
|---|---|---|---|
| `cmd /c type` in a PowerShell tab | 11.1 / 10.9 / 11.2 s (≈1.4 MB/s) | bundled ConPTY **10.95 s**, system ConPTY 11.99 s; 14.3 MB in ~200,000 chunks | p95 17 ms, max 17–50 ms, 0 frames over 50 ms |
| `wsl cat` in a PowerShell tab | 0.83 / 0.83 / 0.80 s (≈19 MB/s) | bundled **0.51 s**, system 1.40 s; 14.5 MB in ~3,400 chunks | p95 17 ms, max 17–35 ms, 0 frames over 50 ms |

- **What this shows:** the `cmd type` path is limited by cmd and ConPTY, which deliver line by line. SplitNest adds almost nothing there, so no UI architecture can make it faster.
- **Where a native stack could gain:** on the fast WSL path SplitNest's stack (PTY host, IPC, xterm parsing and drawing) adds about 0.3 s to ConPTY's 0.5 s for 14.5 MB. This is the realistic upside (an expectation, not measured).
- **The UI stayed at 60 fps** in both cases.

CPU during the stream, as % of one core (median run). Main, renderer and GPU are SplitNest processes; the shell and console host are not:

| Path | PTY host (utility) | Renderer | Main | GPU | Console host (ConPTY) | PowerShell |
|---|---|---|---|---|---|---|
| `cmd /c type` | 118% | 23% | 15% | 9% | 42% | 4% |
| `wsl cat` | 56% | 77% | 36% | 11% | 30% | 10% |

The PTY host's cost on the `cmd type` path comes from ~200,000 small chunks, each passed through Node and IPC. A Rust PTY host would remove most of that overhead (stage 1 of option C) without changing the UI.

**Resize responsiveness** (5 terminals each with 2,000 lines of scrollback; a 20-step window drag, 16 ms apart):
- All terminals settle within **6–33 ms** of the last step.
- UI frames: p95 17 ms, max 17–33 ms, none over 50 ms.
- Correctness (screen agreement) is measured separately in §3.1: 2 of 16 cases still differ.

**Method limitations:**
- Single machine, warm disk cache, 3 runs.
- The development runtime is used for in-app hooks; its memory is not reported (§4.1 has the packaged numbers).
- The marker method measures time until the end of the output is visible, not per-byte latency.
- CPU percentages come from process CPU-time deltas, so short peaks are averaged.

### 4.3 What is measured vs. expected

- **Measured:** everything in 4.1 and 4.2, for this machine only.
- **No native numbers exist** for SplitNest. Statements about native memory or speed below are **architectural expectations**:
  - No Chromium renderer and GPU process.
  - A smaller install, because there's no Chromium runtime.
  - Less per-terminal overhead without the Node PTY host.
- **Native terminal apps are not automatically small.** A GPU UI still uses GPU memory, glyph atlases and scrollback per terminal. The only valid comparison is the prototype in §6 measured with the same scripts.

---

## 5. Migration options

Effort figures assume **one senior engineer** who knows Rust and Windows internals well and has done some GPU-UI work. They cover **feature parity with today's Windows app**; macOS is listed separately. Ranges carry **±50% uncertainty**. They are estimates from component scope, not measurements. A less experienced team should multiply them by about 1.5–2.

### A. Keep and optimise Electron

| | |
|---|---|
| Benefits | Keeps proven xterm.js / CodeMirror / Chromium accessibility, IME and DPI handling, and the 34-scenario E2E suite. Lowest risk. |
| Work | Replace the agent helper with a native process query (removes about 53 MB and most idle CPU). Fix the remaining resize cases by using the system ConPTY with a safe kill path (patched node-pty, or a native module with job objects). Turn on terminal screen-reader support. Optionally trim Chromium features. **macOS**: zsh/bash profiles, process detection without CIM, menu and title bar, signing and notarization. |
| Effort | Windows improvements 3–6 weeks. macOS port 4–8 weeks (no Mac available here to verify). |
| Risks | Electron's baseline stays (about 170 MB app memory at 1 terminal, 361 MB on disk). Electron security updates every release cycle. |
| Validation | Existing suites. A Mac for the macOS port. |
| Maintenance | Moderate: Electron/Chromium upgrades. Mature dependencies. |

### B. Shared Rust UI and terminal architecture (Warp-like)

| | |
|---|---|
| Stack (best candidates today) | GPUI (Apache-2.0) or warpui (MIT) for the UI; alacritty_terminal behind an engine trait (libghostty-vt as the later alternative); own GPU grid renderer; own ConPTY layer with sideloaded conpty.dll and job objects (portable-pty as a base); gpui-component editor. |
| Reused | Assets, themes, state format, test scenarios, behaviour specifications. **No source code** (TypeScript → Rust). |
| Rewritten | All UI, terminal widget and renderer, editor integration, IPC (becomes in-process), PTY layer, persistence, watchers, quit flow, packaging, test harness. |
| Effort | UI shell (layout, tabs, splits, palette, dialogs, settings, explorer) 3–5 months. Terminal widget, renderer, IME and selection 2–4 months. ConPTY/WSL/process layer 1–2 months. Editor integration and save/conflict flow 1–2 months. Accessibility, DPI, packaging and the new test harness 2–3 months. **≈ 10–16 engineer-months for Windows parity**, plus 2–4 months for macOS (shell and PTY differences, signing, IME/accessibility testing). |
| Risks | GPUI is pre-1.0 and "tied to Zed" (breaking changes; vendoring needed). Accessibility and IME regressions in all custom widgets. No ready terminal renderer. Editor maturity below CodeMirror. AGPL boundary with Warp's code. The rebuilt test harness. ConPTY resize issues are **not** solved by the move itself (§3.1). |
| Validation | Real Windows 10/11 at several DPIs, IMEs (Japanese/Chinese/Korean), Narrator and NVDA; real macOS (Apple Silicon and Intel), VoiceOver, Retina and external monitors; PowerShell 5.1/7, several WSL distributions, Claude Code and Codex. |
| Maintenance | High: you own the renderer, widgets, accessibility and IME, and track a pre-1.0 framework and an engine fork. |

### C. Staged approach (practical, because the PTY host is already a separate process behind a small protocol)

1. **Stage 1 (useful whatever is decided): Rust PTY host.**
   - What: a Rust binary that speaks `pty-protocol.ts`'s messages, replacing the Node utility process.
   - What it brings: full control of ConPTY (system ConPTY with repaint, or the bundled one with flags), job-object process-tree cleanup, no Node per-terminal overhead, and a native agent process query.
   - What stays: the Electron UI.
   - Effort: 4–8 weeks, including porting the PTY tests.
   - It also becomes the core of option B.
2. **Stage 2: the time-boxed native prototype (§6)**, in parallel or after stage 1, 4–6 weeks.
3. **Decision.** If the prototype passes, build the native UI against the same Rust core. Electron stays the shipping product until the native app reaches parity on the E2E scenarios. If it fails, stage 1 still improves the Electron app.

| | |
|---|---|
| Benefits | Delivers the measurable improvements first (process cleanup, ConPTY control, helper cost). Defers the large bet until there is evidence. Avoids a second product running in parallel too early. |
| Risks | Two process boundaries during the transition. Stage 1 must not change behaviour (protect it with the existing PTY and E2E tests). |
| Maintenance | Low during stage 1. If B follows, B's maintenance applies. |

**Tauri (comparison only):** a Rust backend with the system WebView (WebView2/WKWebView). It keeps a WebView for the whole UI, so it **does not meet the no-WebView requirement**. It would reuse the React UI, but WebView differences between the platforms would need separate testing.

---

## 6. Feasibility prototype

**Goal:** answer the questions that decide option B, with the cheapest code that can fail them honestly. Time box: 4–6 weeks for one engineer. GPUI and alacritty_terminal first. If GPUI fails a gate, the same scope can be rerun on warpui.

**Scope:**
1. **Window and panes:** one native window with two terminal panes and a draggable divider. No sidebar or explorer.
2. **Shells:** PowerShell 5.1 and 7, and one WSL distribution, through a Rust ConPTY layer (sideloaded conpty.dll, job-object cleanup, cleaned environment). A login shell (zsh) on macOS **only if a Mac is available**.
3. **Terminal:** the alacritty_terminal grid, an own GPU renderer, keyboard input, IME composition, mouse selection, clipboard (copy and bracketed paste), Unicode and emoji, scrollback, resize.
4. **OSC:** pre-scanner for OSC 7501 (`?` reply, records), OSC 133, OSC 0/2 titles. The agent state shown as text.
5. **Editor:** one gpui-component editor pane with open, edit and save, plus the SHA-256 expected-version check and an external-change prompt. Included because editor maturity is a major risk.

**Pass/fail criteria (each measured with scripts like those in `tests/perf`):**

| # | Criterion | Pass |
|---|---|---|
| 1 | Screen agreement after resize | 0 of 16 cases differ in the `diag-reflow` scenario set (console buffer vs. engine grid), PowerShell and WSL |
| 2 | Interactive TUIs | Claude Code and Codex start, render, take input and exit cleanly. Their OSC 7501 reports and `?` negotiation work. `top`/`htop` in WSL are correct. (Observation only; no paid prompts needed.) |
| 3 | Throughput | 16 MB through `wsl cat` in less than SplitNest's 0.8 s, approaching raw ConPTY's 0.5 s. `cmd type` no slower than raw ConPTY's 11 s. UI frames under 50 ms p95 during the stream. |
| 4 | Input | Japanese and Chinese IME composition (Microsoft IME) commits correctly in the terminal and the editor. Shortcuts don't steal shell keys. Copy, paste and bracketed paste work. |
| 5 | Unicode | Emoji, CJK wide characters, combining marks and ZWJ sequences render with the correct width and fallback fonts at 100%, 150% and 200% real scaling. |
| 6 | Accessibility | Narrator/NVDA can read the window's controls and the editor text. Terminal output reading is at least as good as xterm.js with screen-reader mode. |
| 7 | Process cleanup | Closing a pane ends the shell **and** its children (for example `ping -t`, `node` servers). No orphans after 100 open/close cycles. |
| 8 | Resources | Memory and idle CPU per terminal measured with the same method as §4.1, reported with the same process classes. |
| 9 | macOS | Only claimed if criteria 1–8 are run on a real Mac. A Windows-only prototype is **not** evidence for macOS. |

**Decision rule:**
- **Continue to option B** only if criteria 1–7 pass on Windows. Criterion 8 should show a meaningful reduction (for example at least 30% less app memory at 5 terminals), and the effort observed for the terminal widget should be within the estimate.
- **Abandon B (stay on A/C)** if any of these happen:
  - IME or accessibility (4, 6) cannot be made acceptable within the time box;
  - the resize agreement (1) is no better than Electron's;
  - GPUI churn blocks progress for more than a week;
  - the editor needs a custom implementation.

---

## 7. Unresolved questions and unavailable environments

- **macOS:** no Mac was available. Nothing about macOS here is measured or tested.
- **Real display scaling:** only 100% is real on this machine. 125%/150% were simulated in earlier tests. Mixed-DPI and 200% are untested.
- **IME and screen readers:** no CJK IME or Narrator/NVDA testing was done for any candidate.
- **Candidate claims not verified first-hand:** GPUI IME quality, gpui-component editor folding and accessibility, warpui's suitability as a library, and libghostty's Rust bindings in practice. These come from documentation and release notes, not from building them.
- **Licences:** confirm with counsel the AGPL boundary of the Warp repository, and audit the tree-sitter grammars needed for about 25 languages.
- **Which of the remaining resize cases matter in practice**, and whether the system ConPTY's repaint has other costs (flicker, performance). Stage 1 would answer this cheaply.
- **Product goal:** the decision depends on what matters most: macOS availability (favours A), resource use and install size (favours C, then B if the prototype proves it), or a Warp-like experience such as blocks or a custom input editor (favours B, at the cost in §5).
