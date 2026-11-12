/**
 * Feature pages. Every statement here is taken from README.md and docs/USER_GUIDE.md.
 * Body strings are trusted HTML written in this repository.
 */
export type ShotName = 'hero' | 'agent-inbox' | 'notification' | 'resume' | 'editor' | 'light-theme' | 'palette';

export interface Block {
  h: string;
  html: string;
}
export interface Feature {
  slug: string;
  name: string;
  summary: string;
  title: string;
  description: string;
  intro: string;
  shots: ShotName[];
  blocks: Block[];
  related: string[];
  docs?: { label: string; href: string };
}

const k = (s: string) => `<kbd>${s.split('+').join('</kbd>+<kbd>')}</kbd>`;

export const features: Feature[] = [
  {
    slug: 'agent-aware-tabs',
    name: 'Agent-aware tabs',
    summary: 'See at a glance whether each agent is working, waiting for you, done or failed.',
    title: 'Agent-aware terminal tabs for Claude Code, Codex and more',
    description:
      'SplitNest shows the logo and live state of Claude Code, Codex, Gemini CLI and six more agents on each terminal tab: Working, Needs you, Done or Error.',
    intro:
      'When an AI coding agent runs in a tab, the tab shows its logo instead of the status dot, its name and what it is doing. The sidebar sums it up per workspace and the window title carries a count, so it shows in the taskbar.',
    shots: ['hero'],
    related: ['notifications', 'agent-inbox', 'resume-conversations'],
    docs: { label: 'Agents in the user guide', href: '/docs/agents/' },
    blocks: [
      {
        h: 'Four states, one glance',
        html: `<p>An agent tab is always in one of these states. Idle shows no pill.</p>
<ul>
<li><strong>Working</strong>: a mint, pulsing badge.</li>
<li><strong class="badge-needs">Needs you</strong>: an amber badge, pill and underline, for example when the agent waits for a permission or an answer.</li>
<li><strong>Done</strong> and <strong>Error</strong>: when a turn finishes or the agent stops with an error.</li>
</ul>
<p>The sidebar sums it up per workspace ("1 agent needs you · 2 working"), and the window title gets a count such as <code>(1) car-rental — SplitNest</code>, so it shows in the taskbar.</p>`,
      },
      {
        h: 'Supported agents',
        html: `<p>Claude Code, Codex, Gemini CLI, GitHub Copilot CLI, Cursor Agent, Aider, OpenCode, Qwen Code and Amp get their logo and name on the tab. If the agent reports a session title, the tab shows it (for example <em>Fix login redirect · Claude Code</em>); a name you gave the tab still wins. Agent logos are trademarks of their owners.</p>`,
      },
      {
        h: 'How SplitNest knows',
        html: `<ol>
<li><strong>The agent reports itself</strong> through the Program Status Protocol (OSC 7501). SplitNest answers the protocol's feature query, which Claude Code waits for before reporting; Codex reports on its own. This was checked with Claude Code 2.1.316 and Codex 0.166.0.</li>
<li><strong>Process detection</strong> in PowerShell tabs: a hidden helper looks for the agent's process under the tab's shell, every 3 seconds while something changes and otherwise every 12 seconds. Command lines never leave the main process and are not logged.</li>
<li><strong>Fallbacks</strong> for an identified agent that does not report: a terminal bell means "Needs you?" and a spinner in the title or recent output means "Working?". Output, bells or titles alone never make a program count as an agent.</li>
</ol>
<p>No agent settings or hooks are changed.</p>`,
      },
      {
        h: 'Reported or estimated: you can tell',
        html: `<p>A state the agent reported is shown solid. A guess is shown dashed with a "?" ("Needs you?", "Working?"), reads "may need you" in the sidebar, is not counted in the window title, and the tooltip says what it is based on. Once an agent has reported, nothing about it is guessed any more for that run.</p>
<p>Opening or typing into a tab clears its notification and a Done or Error you have now seen. It never clears what the agent is waiting for: a permission request stays until the agent itself reports that it continues.</p>`,
      },
      {
        h: 'When the agent exits',
        html: `<p>When the agent's process ends, the shell's prompt or title comes back, or the session ends, its logo, state and session title all go, so the next program in that terminal starts clean.</p>`,
      },
      {
        h: 'Limits',
        html: `<ul>
<li>WSL tabs cannot use process detection, because Linux processes are not visible to Windows. They rely on the agent's own reports or Claude Code's exact title.</li>
<li>Claude Code's first-run questions (for example "Claude in Chrome extension detected") are not reported by Claude, so they show as idle.</li>
</ul>`,
      },
    ],
  },
  {
    slug: 'notifications',
    name: 'Notifications',
    summary: 'In-app notices, Windows notifications and a taskbar flash when an agent needs you, finishes or fails.',
    title: 'Agent notifications on Windows: permission prompts, done and errors',
    description:
      'SplitNest notifies you when an AI agent needs permission, asks a question, finishes or fails, with an in-app notice, a Windows notification and a taskbar flash.',
    intro:
      'Agent notifications are on by default (Settings → Notifications). SplitNest tells you when an agent needs you (a permission, a question, sign-in, or anything else it waits for), finishes, or stops with an error.',
    shots: ['notification'],
    related: ['agent-aware-tabs', 'agent-inbox'],
    docs: { label: 'Notifications in the user guide', href: '/docs/agents/' },
    blocks: [
      {
        h: 'Where you see it',
        html: `<ul>
<li><strong>Nothing</strong> for the tab you are looking at.</li>
<li><strong>An in-app notice</strong> at the bottom right with a <strong>Show</strong> button when SplitNest is in front but another tab, workspace or Settings is shown.</li>
<li><strong>A Windows notification</strong> when SplitNest is minimized or behind another program. Clicking it, also later from Notification Center, brings SplitNest back and shows that exact tab.</li>
</ul>
<p>For "needs you" the taskbar button also flashes, and a small amber dot stays on it until you have seen the tab.</p>`,
      },
      {
        h: 'What it says, and what it does not',
        html: `<p>The text is SplitNest's own words, for example <em>Claude Code needs permission</em>, followed by the workspace and the name you gave the tab (<em>car-rental · Backend</em>), or else the agent's name.</p>
<p>The agent's session title and message can contain your prompt, so they are left out unless you turn on <em>Include what the agent wrote</em>. That setting is off by default.</p>`,
      },
      {
        h: 'When it fires',
        html: `<ul>
<li>A notice goes away when the agent continues or you open the tab.</li>
<li><em>Finished</em> comes from the agent's own report (Claude Code and Codex both report it at the end of a turn) and is skipped if the agent starts working again within 1.5 seconds.</li>
<li>Estimated states (a bell) do not notify unless you turn that on.</li>
<li>More than three Windows notifications within 10 seconds become one summary.</li>
<li>SplitNest removes its notifications from Notification Center when it quits.</li>
</ul>`,
      },
      {
        h: 'Only real agents can raise a Windows notification',
        html: `<p>In PowerShell tabs only agents SplitNest found running in the tab can raise a Windows notification; a program that merely prints a status report naming an agent cannot. WSL tabs cannot be checked that way, so there the agent's report is enough.</p>`,
      },
      {
        h: 'The Start menu entry',
        html: `<p>Windows needs a Start menu entry to show an app's notifications, so the first notification adds <em>SplitNest</em> to the Start menu. Windows does not display the very notification that registers an app, so SplitNest shows that first one a second time 3 seconds later. <em>Send a test notification</em> in Settings shows whether Windows accepts them; if no banner appears, check Do Not Disturb and SplitNest's entry in Windows Settings → System → Notifications.</p>`,
      },
    ],
  },
  {
    slug: 'agent-inbox',
    name: 'Agent inbox',
    summary: 'One list of every agent waiting for you, across all workspaces, with one shortcut to jump to the next.',
    title: 'Agent inbox: every waiting AI agent in one list',
    description:
      'The SplitNest agent inbox lists every agent waiting for you across all workspaces, most urgent first, and jumps to the next one with Ctrl+Shift+U.',
    intro:
      'The bell in the title bar opens the agent inbox: every agent that is waiting for you, in all workspaces. The bell shows how many, and turns amber when one needs you.',
    shots: ['agent-inbox'],
    related: ['notifications', 'agent-aware-tabs'],
    docs: { label: 'Agent inbox in the user guide', href: '/docs/agents/' },
    blocks: [
      {
        h: 'Open it and jump',
        html: `<ul>
<li>${k('Ctrl+Shift+A')} opens the inbox.</li>
<li>${k('Ctrl+Shift+U')} goes to the next waiting agent, also from Settings or another workspace; pressing it again walks through all of them.</li>
<li>Clicking a row does the same for that one. Both are in the command palette too, together with one entry per waiting agent.</li>
</ul>`,
      },
      {
        h: 'What is listed',
        html: `<ul>
<li>An agent that <strong class="badge-needs">needs you</strong> (permission, a question, sign-in), from the moment it waits until it continues or exits. Opening its tab does not remove it, because it is still blocked.</li>
<li>A finished turn or an error, until you look at that tab or the agent works again.</li>
</ul>`,
      },
      {
        h: 'Order',
        html: `<p>Agents that need you first, then errors, then finished turns. Within each group, the one that has waited longest comes first. Each row shows the agent, what it needs, the workspace and tab, and how long it has waited.</p>`,
      },
      {
        h: 'Same rules as notifications',
        html: `<p>The kinds you turned off in Settings → Notifications are not listed, and what the agent wrote appears only with <em>Include what the agent wrote</em>. Nothing is saved: the inbox is what is waiting right now, not a history.</p>`,
      },
    ],
  },
  {
    slug: 'resume-conversations',
    name: 'Resume conversations',
    summary: 'After a restart, a Resume button brings back the Claude Code or Codex conversation that was running.',
    title: 'Resume Claude Code and Codex conversations after a restart',
    description:
      'SplitNest remembers which Claude Code or Codex conversation ran in a terminal and offers a Resume button after a restart. It saves only the id, folder and an optional title.',
    intro:
      'If Claude Code or Codex was running when SplitNest closed, that terminal says so after a restart and offers Resume Claude Code (or Codex) next to Start PowerShell only. The restore notice offers Resume agents (N).',
    shots: ['resume'],
    related: ['workspaces-splits-tabs', 'agent-aware-tabs'],
    docs: { label: 'Resume in the user guide', href: '/docs/agents/' },
    blocks: [
      {
        h: 'What the button does',
        html: `<p>It starts a new PowerShell in the folder the agent ran in and types <code>claude --resume &lt;id&gt;</code> or <code>codex resume &lt;id&gt;</code> at the prompt, visibly. The text above the button says exactly that before you click. <strong>Nothing runs until you click.</strong></p>`,
      },
      {
        h: 'Which conversation',
        html: `<p>Claude Code's own record for the agent process in that tab is used, so two agents in one folder each get their own, and it follows <code>/clear</code>. For Codex it is the conversation started in that folder after the agent started, or the id the tab itself resumed. If SplitNest cannot be sure, Resume opens the agent's own list of earlier conversations instead of guessing.</p>`,
      },
      {
        h: 'What is saved',
        html: `<p>The agent, the conversation id and the folder, with the tab. <strong>Never conversation text.</strong> Also the conversation's title (Claude Code's own name for it, or the session title an agent reports), shown above the button. Titles are on by default (Settings → Workspaces → <em>Show conversation titles for Resume</em>); a title can contain words from your prompt, and turning the setting off removes the saved ones.</p>`,
      },
      {
        h: 'No setup',
        html: `<p>No hooks or agent settings are installed or changed. If the agent does not start within 25 seconds, the terminal says so and stays usable. Settings → Workspaces → <em>Resume agents automatically when the app opens</em> is off by default.</p>`,
      },
      {
        h: 'Limits',
        html: `<ul>
<li>WSL tabs: Windows cannot see their processes, so SplitNest knows only that Claude Code or Codex ran there, not which conversation. Resume there starts the shell in the workspace folder and opens the agent's own list.</li>
<li>The agents' session files are undocumented; if a future version changes them, Resume falls back to the agent's list.</li>
<li>Codex's <code>/new</code> is not followed: the saved conversation stays the one the tab started with.</li>
<li>If the agent ran in a folder outside the workspace folder, Resume is refused and the terminal offers a plain shell.</li>
</ul>`,
      },
    ],
  },
  {
    slug: 'workspaces-splits-tabs',
    name: 'Workspaces, splits and tabs',
    summary: 'One workspace per project, resizable split panes, named tabs, and layouts that come back after a restart.',
    title: 'Workspaces, split panes and tabs for PowerShell and WSL',
    description:
      'SplitNest organises terminals as project workspaces with resizable split panes, named and draggable tabs, focus mode, and layouts that are restored after a restart.',
    intro:
      'Each project folder is a workspace in the sidebar with its running-shell count. Inside it, split any pane left/right or top/bottom, give tabs names such as Backend or Tests, and switch projects without stopping a single session.',
    shots: ['hero'],
    related: ['resume-conversations', 'themes-command-palette', 'file-explorer-editor'],
    docs: { label: 'Workspaces and terminals in the user guide', href: '/docs/workspaces/' },
    blocks: [
      {
        h: 'Workspaces',
        html: `<p>One project folder per workspace. Background tabs and workspaces keep running. Removing a workspace never deletes files; it only removes the entry and ends its sessions after confirmation. The sidebar count shows running shells only.</p>`,
      },
      {
        h: 'Splits and tabs',
        html: `<ul>
<li>Every split pane has its own tab bar, so it can hold several terminals. Drag dividers to resize, or focus a divider with Tab and use the arrow keys.</li>
<li>Rename a terminal (for example <em>Backend</em>, <em>Tests</em>, <em>Logs</em>) with a double-click or ${k('F2')}. Titles set by the shell never replace a name you chose.</li>
<li>Drag a tab to reorder it or drop it on another pane's tab bar to move it; its shell keeps running.</li>
<li>${k('Ctrl+Shift+M')} maximises a pane; the other panes stay open underneath. ${k('Ctrl+Shift+Enter')} hides both sidebars (focus mode).</li>
</ul>`,
      },
      {
        h: 'PowerShell and WSL',
        html: `<p>The default shell can be PowerShell 7 (used automatically when installed), Windows PowerShell 5.1, or a WSL distribution. WSL panes start in the Linux path that <code>wslpath</code> reports for the workspace folder. If the folder cannot be mapped, the pane says why and offers an explicit button to start in the home directory; it never silently starts somewhere else. SplitNest never installs or configures WSL.</p>`,
      },
      {
        h: 'Short prompts',
        html: `<p>Long folder paths no longer wrap the prompt: PowerShell shows <code>PS car-rental&gt;</code> instead of the full path, and WSL bash gets <code>PROMPT_DIRTRIM=1</code>. Only the prompt changes; terminal output is never rewritten, and your profile files are not modified. It is on by default and can be turned off in Settings.</p>`,
      },
      {
        h: 'Restoring after a restart',
        html: `<p>Layouts and folders come back after a restart, with nothing running. Each restored terminal shows <strong>Ready to start</strong>, and <strong>Start all shells</strong> starts new shells in their saved folders. Previous processes are never resumed and commands are never replayed. Optionally, Settings can start fresh shells automatically.</p>`,
      },
    ],
  },
  {
    slug: 'file-explorer-editor',
    name: 'File explorer and editor',
    summary: 'A file tree and a built-in CodeMirror editor beside your terminals, with safe, explicit saving.',
    title: 'Built-in file explorer and code editor beside your terminals',
    description:
      'SplitNest has a file explorer and a built-in CodeMirror 6 editor with syntax highlighting, find and replace, and a SHA-256 check before every save.',
    intro:
      'A file explorer sits beside the terminals. Click a file to open it in the built-in editor (CodeMirror 6) as a tab in a pane next to your shells.',
    shots: ['editor'],
    related: ['git-status', 'workspaces-splits-tabs'],
    docs: { label: 'Explorer and editor in the user guide', href: '/docs/tools/' },
    blocks: [
      {
        h: 'File explorer',
        html: `<ul>
<li>A tree of the workspace folder with Material Icon Theme file icons, and compact folders for deep trees (<code>src/main/java/com/example</code> as one row).</li>
<li>Arrow keys navigate; click or press Enter to open a file. ${k('Ctrl+Enter')} inserts the file's quoted path at the terminal prompt without running it.</li>
<li>The tree never runs, renames, moves or deletes files.</li>
</ul>`,
      },
      {
        h: 'Editor',
        html: `<ul>
<li>Syntax highlighting for about two dozen languages, including TypeScript/JavaScript, Python, Go, Rust, JSON, YAML, Markdown and PowerShell. Other files open as plain text.</li>
<li>Line numbers, folding, bracket matching, multiple cursors, word completion, and find/replace (${k('Ctrl+F')}).</li>
<li>Encoding (UTF-8, UTF-8 with BOM, UTF-16 LE) and line endings (LF/CRLF) are kept.</li>
</ul>`,
      },
      {
        h: 'Saving that does not surprise you',
        html: `<ul>
<li>Saving is always explicit with ${k('Ctrl+S')}. There is no auto-save.</li>
<li>Changes made on disk by git, formatters, other editors or your terminals are noticed. An unmodified tab reloads quietly; with unsaved edits you choose Keep my edits, Reload from disk or Overwrite file.</li>
<li>Every save first checks the file's current content (a SHA-256 of its bytes, not just its timestamp) against the version you started from. If it changed, the save is refused until you choose.</li>
<li>Closing or quitting with unsaved files offers Save and close / Discard / Cancel.</li>
</ul>`,
      },
      {
        h: 'Limits and safety',
        html: `<p>Only existing files inside the workspace folder can be opened (up to 5 MB), and new files are never created. Binary files are refused. Files that are not valid UTF-8 or UTF-16, read-only files, and files reached through a link or junction to outside the workspace open read-only. File contents are never logged or stored in the app's state; only the open file paths are saved.</p>`,
      },
    ],
  },
  {
    slug: 'git-status',
    name: 'Git status',
    summary: 'Branch and changed-line counts for every workspace in a repository. Read-only.',
    title: 'Per-workspace Git status in the sidebar',
    description:
      'SplitNest shows each workspace’s Git branch and lines added and removed since the last commit. It only reads the repository and never changes it. Needs Git for Windows.',
    intro:
      'Each workspace in a Git repository shows its branch and the lines added and removed since the last commit. SplitNest only reads the repository; it never changes it.',
    shots: [],
    related: ['workspaces-splits-tabs', 'file-explorer-editor'],
    docs: { label: 'Git status in the user guide', href: '/docs/tools/' },
    blocks: [
      {
        h: 'What you see',
        html: `<ul>
<li>The branch name, or <em>detached at 1a2b3c4</em>. A clean workspace shows only that.</li>
<li><strong>+added −removed</strong> appears only when lines were added or removed since the last commit (staged and unstaged together, tracked files). The tooltip has every number, the upstream branch and how far ahead or behind it is.</li>
<li>A small dot means files changed without changed lines: a rename, a mode change, a binary file, or untracked files.</li>
</ul>`,
      },
      {
        h: 'When it updates',
        html: `<p>When you select a workspace, come back to SplitNest from another program, or save a file in the editor, and after terminal output in that workspace has settled (a <code>git switch</code> shows within about a second). Output that never stops, like a development server's log, causes a check at most every 30 seconds.</p>`,
      },
      {
        h: 'Read-only by design',
        html: `<p>SplitNest never changes the repository: no index refresh and no locks. Git's file-system monitor, external diff and text-conversion programs are switched off for these checks. If the repository's own Git configuration names a filter program, only the branch is shown and the tooltip says that changes were not checked. Submodules are not looked into.</p>`,
      },
      {
        h: 'Requirements',
        html: `<p>Needs Git for Windows (<code>git.exe</code> on PATH). Without it the rest of SplitNest works and no Git status is shown. It can be turned off in Settings → Workspaces. A workspace folder on a Windows drive shows Git status also when its terminals run WSL; workspaces whose folder is inside WSL show none in this version.</p>`,
      },
    ],
  },
  {
    slug: 'themes-command-palette',
    name: 'Themes and command palette',
    summary: 'Five themes, a light mode that follows Windows, and a keyboard-first command palette.',
    title: 'Five themes and a keyboard-first command palette',
    description:
      'SplitNest ships Graphite, Silver Light, Midnight Blue, Ember and Lagoon themes, can follow Windows light and dark, and has a Ctrl+Shift+P command palette.',
    intro:
      'Five themes change the whole app instantly, and a command palette reaches workspaces, shells, settings and agents from the keyboard.',
    shots: ['light-theme', 'palette'],
    related: ['workspaces-splits-tabs', 'agent-inbox'],
    docs: { label: 'Settings and shortcuts in the user guide', href: '/docs/settings/' },
    blocks: [
      {
        h: 'Themes',
        html: `<p><strong>Graphite</strong> (default), <strong>Silver Light</strong>, <strong>Midnight Blue</strong>, <strong>Ember</strong> and <strong>Lagoon</strong>. They change surfaces, text, buttons, focus, terminal colours, the editor's syntax colours and the window's title bar.</p>
<p>Mode: <em>Dark</em> uses the chosen dark theme, <em>Light</em> uses Silver Light, and <em>Match system</em> follows Windows (Silver Light by day, your dark theme at night) and switches live when Windows does.</p>`,
      },
      {
        h: 'Command palette',
        html: `<p>${k('Ctrl+Shift+P')} opens a command palette for workspaces, shells, settings and agents. The title bar's search box opens it too. Agent commands include the agent inbox, the next waiting agent, and Resume for a terminal or a whole workspace.</p>`,
      },
      {
        h: 'Keyboard first',
        html: `<p>Plain Ctrl+letter keys always go to the shell; SplitNest's own shortcuts use Ctrl+Shift, Ctrl+Alt or Ctrl+Tab. The full table is in the in-app list (${k('Ctrl+Shift+/')}) and in the <a href="/docs/shortcuts/">shortcut reference</a>. The shortcuts are a fixed table; there is no user configuration yet.</p>`,
      },
    ],
  },
];
