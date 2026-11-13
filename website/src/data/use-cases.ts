import type { Block, ShotName } from './features';

export interface UseCase {
  slug: string;
  name: string;
  title: string;
  description: string;
  summary: string;
  intro: string;
  shots: ShotName[];
  blocks: Block[];
  related: string[];
}

export const useCases: UseCase[] = [
  {
    slug: 'claude-code-windows-powershell-wsl',
    name: 'Run Claude Code on Windows with PowerShell and WSL side by side',
    title: 'Run Claude Code on Windows with PowerShell and WSL side by side',
    description:
      'Use SplitNest to run Claude Code in PowerShell and in WSL in split panes of one Windows workspace, with live agent state and what to expect in each shell.',
    summary: 'Keep a PowerShell tab and a WSL tab for the same project in one window, and know which agent is doing what.',
    intro:
      'Many Windows projects end up needing both worlds: PowerShell for the Windows toolchain, and WSL for Linux tooling. SplitNest runs real PowerShell and WSL shells in resizable panes of the same workspace, and shows agent state on both.',
    shots: ['hero'],
    related: ['workspaces-splits-tabs', 'agent-aware-tabs', 'resume-conversations'],
    blocks: [
      {
        h: 'Set up one workspace, two shells',
        html: `<ol>
<li>Choose <strong>Open folder…</strong> (or ${'<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd>'}) and pick your project folder. A PowerShell terminal starts there. PowerShell 7 is used automatically when installed; otherwise Windows PowerShell 5.1.</li>
<li>Split the pane left/right or top/bottom, then use the arrow next to <strong>New terminal</strong> to choose a WSL distribution for the new tab.</li>
<li>Rename the tabs (for example <em>Windows</em> and <em>Linux</em>) with ${'<kbd>F2</kbd>'}. The shell stays visible in smaller text on the tab.</li>
</ol>
<p>WSL is optional and SplitNest never installs or configures it. If it is missing, install it by following Microsoft's WSL documentation and then use <strong>Settings → Refresh shell list</strong>.</p>`,
      },
      {
        h: 'Where a WSL pane starts',
        html: `<p>A WSL pane starts in the Linux path that <code>wslpath</code> reports for the workspace folder, for example <code>/mnt/c/...</code>. If the folder cannot be mapped (a network share, or a drive that is not mounted inside the distribution), the pane explains why and offers an explicit <em>Start in home directory instead</em> button. It never silently starts somewhere else.</p>`,
      },
      {
        h: 'Run Claude Code in either shell',
        html: `<p>Start Claude Code in a tab the way you normally would. SplitNest answers the status protocol's feature query that Claude Code waits for, so Claude Code reports its own state (Working, Needs you, Done) and the tab shows its logo. No Claude Code settings or hooks are changed.</p>
<p>In both shells SplitNest also looks for the agent's process (in WSL, among the Linux processes started in that terminal), so it is found even if it does not report. Claude Code's first-run questions are not reported, so they show as idle.</p>`,
      },
      {
        h: 'After a restart',
        html: `<p>Layouts and folders come back with nothing running. A terminal where Claude Code was running offers <strong>Resume Claude Code</strong>. In a PowerShell tab it types <code>claude --resume &lt;id&gt;</code> for the exact conversation. In a WSL tab SplitNest knows only that Claude Code ran there, so it starts the shell in the workspace folder and opens Claude Code's own list of earlier conversations.</p>`,
      },
      {
        h: 'Good to know',
        html: `<ul>
<li>The displayed directory is where the shell started; SplitNest does not track <code>cd</code>.</li>
<li>WSL output is slower than PowerShell's: about 1.15 s instead of 0.48 s for 16 MB of text in the packaged app, as measured in the project's tests.</li>
<li>Closing a WSL pane ends only that pane's <code>wsl.exe</code> session. SplitNest never runs <code>wsl --shutdown</code>.</li>
</ul>`,
      },
    ],
  },
  {
    slug: 'manage-multiple-ai-coding-agents',
    name: 'Manage several AI coding agents in parallel',
    title: 'Manage several AI coding agents in parallel on Windows',
    description:
      'Run Claude Code, Codex and other CLI agents across projects at once: one workspace per project, live state on every tab, and an inbox that shows which agent is waiting.',
    summary: 'Several agents across several projects, without losing track of which one is waiting on you.',
    intro:
      'Running more than one agent means more tabs, more windows and more "which one was waiting?". SplitNest gives each project a workspace, each agent a state, and puts everything that is waiting in one list.',
    shots: ['hero', 'agent-inbox'],
    related: ['agent-inbox', 'agent-aware-tabs', 'workspaces-splits-tabs'],
    blocks: [
      {
        h: 'One workspace per project',
        html: `<p>Add each project folder as a workspace. Every workspace keeps its own layout, and switching workspaces does not stop anything: background tabs keep running. The sidebar shows how many shells are running in each workspace, and a summary of its agents ("1 agent needs you · 2 working").</p>`,
      },
      {
        h: 'Name what each tab is for',
        html: `<p>Split a pane so an agent sits beside a plain shell for tests or logs, and rename the tabs (<em>Backend</em>, <em>Tests</em>, <em>Logs</em>). Two agents in one folder are fine; each tab tracks its own agent. Drag a tab to another pane to rearrange, and its shell keeps running.</p>`,
      },
      {
        h: 'See state without switching tabs',
        html: `<p>Each agent tab shows a logo, a name and a state. <strong>Working</strong> is mint and pulsing, <strong class="badge-needs">Needs you</strong> is amber, then Done and Error. The window title carries a count, such as <code>(1) car-rental — SplitNest</code>, so you can see it in the taskbar while SplitNest is behind another window. A state the agent reported is solid; a guess is dashed with a "?".</p>`,
      },
      {
        h: 'Go straight to the one that is waiting',
        html: `<p>The bell in the title bar opens the agent inbox (${'<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>'}), which lists every waiting agent across all workspaces. Agents that need you come first, then errors, then finished turns, and within each group the longest wait comes first. ${'<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>U</kbd>'} jumps to the next waiting agent from anywhere.</p>`,
      },
      {
        h: 'Which agents',
        html: `<p>Claude Code, Codex, Gemini CLI, GitHub Copilot CLI, Cursor Agent, Aider, OpenCode, Qwen Code and Amp are recognised. Agents that report their own state (the Program Status Protocol, OSC 7501) give the most accurate result; for others SplitNest falls back to process detection in PowerShell and WSL tabs, and to clearly marked guesses.</p>`,
      },
      {
        h: 'Good to know',
        html: `<p>SplitNest is an early release (v0.2) tested on Windows 11 x64. Scrollback is per pane and lives only in memory. See the <a href="/docs/troubleshooting/">known limitations</a> for the full list.</p>`,
      },
    ],
  },
  {
    slug: 'never-miss-agent-permission-prompt',
    name: 'Never miss an agent’s permission prompt',
    title: 'Never miss an AI agent’s permission prompt on Windows',
    description:
      'Get told the moment an AI agent needs permission: SplitNest uses amber tab states, in-app notices, Windows notifications and a taskbar flash.',
    summary: 'Get told the moment an agent is blocked, in the way that fits where you are looking.',
    intro:
      'An agent that stops to ask for permission is blocked until you notice. SplitNest watches for that state and tells you, without spamming you about the tab you are already looking at.',
    shots: ['notification'],
    related: ['notifications', 'agent-inbox', 'agent-aware-tabs'],
    blocks: [
      {
        h: 'It starts with the tab',
        html: `<p>When an agent reports that it needs a permission, a question or a sign-in, its tab turns <strong class="badge-needs">Needs you</strong>: an amber badge, pill and underline. That state stays until the agent itself reports that it continues. Opening or typing into the tab never clears it, because the agent is still blocked.</p>`,
      },
      {
        h: 'Then it finds you',
        html: `<ul>
<li>Looking at that tab: nothing, because you can see it.</li>
<li>SplitNest in front, but another tab, workspace or Settings shown: an in-app notice at the bottom right with a <strong>Show</strong> button.</li>
<li>SplitNest minimized or behind another program: a Windows notification. Clicking it brings SplitNest back and shows that exact tab. The taskbar button also flashes, and a small amber dot stays on it until you have seen the tab.</li>
</ul>`,
      },
      {
        h: 'Keep your prompt out of the notification',
        html: `<p>Notifications use SplitNest's own words, such as <em>Claude Code needs permission</em>, plus the workspace and tab name. The agent's session title and message can contain your prompt, so they are left out unless you turn on <em>Include what the agent wrote</em>. It is off by default.</p>`,
      },
      {
        h: 'A bell is a guess, and labelled as one',
        html: `<p>For an agent that does not report its state, a terminal bell is treated as "Needs you?", shown dashed. Estimated states do not notify unless you turn that on in Settings, so a stray bell does not wake you up.</p>`,
      },
      {
        h: 'If several are waiting',
        html: `<p>More than three Windows notifications within 10 seconds become one summary. The agent inbox lists everything waiting right now, and ${'<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>U</kbd>'} walks through them.</p>`,
      },
      {
        h: 'If no banner appears',
        html: `<p>Windows needs a Start menu entry to show an app's notifications; SplitNest adds one with the first notification. <em>Send a test notification</em> in Settings shows whether Windows accepts them. If no banner appears, check Do Not Disturb and SplitNest's entry in Windows Settings → System → Notifications.</p>`,
      },
    ],
  },
  {
    slug: 'resume-agent-conversations-after-restart',
    name: 'Pick up agent conversations after a restart',
    title: 'Pick up Claude Code, Codex and Gemini CLI conversations after a restart',
    description:
      'Restart Windows or SplitNest without losing track of an agent conversation. SplitNest restores your layout and offers a visible, one-click Resume for Claude Code, Codex and Gemini CLI.',
    summary: 'Restore the layout, then resume the exact conversation with one click, with nothing run behind your back.',
    intro:
      'Restarting Windows or closing SplitNest ends your shells, but you do not want to lose the thread of an agent conversation. SplitNest brings the layout back and offers to resume each conversation, only when you click.',
    shots: ['resume'],
    related: ['resume-conversations', 'workspaces-splits-tabs'],
    blocks: [
      {
        h: 'What comes back by itself',
        html: `<p>Workspaces, folders, pane layouts, tab names and appearance settings. By default nothing is running: each terminal shows <strong>Ready to start</strong> with a shell selector, and the workspace notice offers <strong>Start all shells</strong>. Previous processes are never resumed and commands are never replayed.</p>`,
      },
      {
        h: 'What you can resume',
        html: `<p>If Claude Code, Codex or Gemini CLI was running in a terminal when SplitNest closed, that terminal says so and offers <strong>Resume Claude Code</strong> (or Codex, or Gemini CLI) next to <em>Start PowerShell only</em>. The notice offers <strong>Resume agents (N)</strong> for the whole workspace. The text above the button states exactly what will run, and nothing runs until you click.</p>`,
      },
      {
        h: 'What it types',
        html: `<p>A new PowerShell starts in the folder the agent ran in, and <code>claude --resume &lt;id&gt;</code>, <code>codex resume &lt;id&gt;</code> or <code>gemini --resume &lt;id&gt;</code> is typed at the prompt, visibly. Two Claude Code agents in the same folder each resume their own conversation. If SplitNest cannot be sure which conversation was meant, it opens the agent's own list of earlier conversations instead of guessing. Gemini CLI has no such list on its command line, so there Resume runs <code>gemini --resume</code>, its most recent conversation in that folder.</p>`,
      },
      {
        h: 'What is stored',
        html: `<p>The agent, the conversation id, the folder, and optionally the conversation title shown above the button. Never conversation text. Titles can contain words from your prompt, so you can turn them off in Settings → Workspaces, which also removes the saved ones. Resume works through the agents' own session records, so no hooks or agent settings are installed.</p>`,
      },
      {
        h: 'Prefer it automatic?',
        html: `<p>Settings → Workspaces has <em>Resume agents automatically when the app opens</em>, off by default. It resumes them without a click, each workspace the first time it is shown.</p>`,
      },
      {
        h: 'Limits',
        html: `<p>In WSL tabs SplitNest cannot tell which conversation ran, so Resume opens the agent's own list. Codex's <code>/new</code> is not followed. If an agent ran in a folder outside the workspace folder, Resume is refused and the terminal offers a plain shell. The agents' session files are undocumented, so a future agent update may make Resume fall back to the agent's list.</p>`,
      },
    ],
  },
];
