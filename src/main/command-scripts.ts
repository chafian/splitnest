// The `splitnest` command in SplitNest's terminals: `splitnest notify [--title TITLE] MESSAGE`.
// It only writes a notification escape code (OSC 99, base64 so any text survives code pages and
// `;`) to its own terminal, so SplitNest knows which tab sent it: no socket, no network. Main
// writes the scripts into the user-data folder at start and appends their folder to the PATH of
// the shells it starts: `windows\splitnest.cmd` for PowerShell, `wsl\splitnest` (sh) for WSL,
// which appends the Windows PATH inside Linux. The .ps1 lives in `windows\lib`, off the PATH, so
// PowerShell never picks it (and its execution policy) over the .cmd.
import path from 'node:path';

const USAGE = 'usage: splitnest notify [--title TITLE] MESSAGE';

export const SPLITNEST_CMD = ['@echo off', 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0lib\\splitnest.ps1" %*', 'exit /b %ERRORLEVEL%', ''].join('\r\n');

export const SPLITNEST_PS1 = [
  '# SplitNest: splitnest notify [--title TITLE] MESSAGE  (raises a SplitNest notification for this terminal)',
  '$a = @($args)',
  `if ($a.Count -lt 1 -or $a[0] -ne 'notify') { [Console]::Error.WriteLine('${USAGE}'); exit 2 }`,
  "$title = ''; $words = @()",
  'for ($i = 1; $i -lt $a.Count; $i++) {',
  "  if ($a[$i] -eq '--title' -and $i + 1 -lt $a.Count) { $title = [string]$a[$i + 1]; $i++ } else { $words += [string]$a[$i] }",
  '}',
  "$body = $words -join ' '",
  `if (-not $title -and -not $body) { [Console]::Error.WriteLine('${USAGE}'); exit 2 }`,
  '$e = [char]27; $bel = [char]7',
  'function Part($p, $text, $more) {',
  '  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))',
  "  $d = if ($more) { ':d=0' } else { '' }",
  // ${…}: `$d:p` would read as a drive-qualified variable.
  '  [Console]::Out.Write("${e}]99;i=splitnest${d}:p=${p}:e=1;${b64}${bel}")',
  '}',
  "if ($title) { Part 'title' $title ([bool]$body) }",
  "if ($body) { Part 'body' $body $false }",
  '',
].join('\r\n');

export const SPLITNEST_SH = [
  '#!/bin/sh',
  '# SplitNest: splitnest notify [--title TITLE] MESSAGE  (raises a SplitNest notification for this terminal)',
  `usage() { echo '${USAGE}' >&2; exit 2; }`,
  '[ "$1" = notify ] || usage',
  'shift',
  'title=',
  'if [ "$1" = --title ] && [ $# -ge 2 ]; then title=$2; shift 2; fi',
  'body=$*',
  '[ -n "$title$body" ] || usage',
  'b64() { printf %s "$1" | base64 | tr -d "\\n"; }',
  'out() {',
  "  if [ -n \"$title\" ] && [ -n \"$body\" ]; then printf '\\033]99;i=splitnest:d=0:p=title:e=1;%s\\007' \"$(b64 \"$title\")\"",
  "  elif [ -n \"$title\" ]; then printf '\\033]99;i=splitnest:p=title:e=1;%s\\007' \"$(b64 \"$title\")\"; fi",
  "  if [ -n \"$body\" ]; then printf '\\033]99;i=splitnest:p=body:e=1;%s\\007' \"$(b64 \"$body\")\"; fi",
  '}',
  '# The terminal itself, even when output is piped or redirected.',
  '# In a subshell: dash exits the whole script when a redirect on `:` fails (no terminal).',
  'if ( : >/dev/tty ) 2>/dev/null; then out >/dev/tty; else out; fi',
  '',
].join('\n');

export interface CommandDirs {
  /** On the PATH of PowerShell sessions. */
  windows: string;
  /** On the (Windows) PATH of WSL sessions, which WSL appends inside Linux. */
  wsl: string;
}

export interface ScriptFs {
  mkdir(dir: string): Promise<void>;
  readText(file: string): Promise<string | null>;
  writeText(file: string, text: string): Promise<void>;
}

/** Writes the scripts under `root` (only those that differ) and returns the folders to put on PATH. */
export async function installCommandScripts(root: string, fs: ScriptFs): Promise<CommandDirs> {
  const dirs: CommandDirs = { windows: path.win32.join(root, 'windows'), wsl: path.win32.join(root, 'wsl') };
  const files: [string, string][] = [
    [path.win32.join(dirs.windows, 'splitnest.cmd'), SPLITNEST_CMD],
    [path.win32.join(dirs.windows, 'lib', 'splitnest.ps1'), SPLITNEST_PS1],
    [path.win32.join(dirs.wsl, 'splitnest'), SPLITNEST_SH],
  ];
  for (const [file, text] of files) {
    if ((await fs.readText(file)) === text) continue;
    await fs.mkdir(path.win32.dirname(file));
    await fs.writeText(file, text);
  }
  return dirs;
}

/** A PATH value with `dir` appended (after the user's own folders, so nothing of theirs is shadowed). */
export function pathWith(env: NodeJS.ProcessEnv, dir: string): { key: string; value: string } {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path';
  const current = env[key] ?? '';
  const parts = current.split(';').filter(Boolean);
  if (!parts.some((p) => p.toLowerCase() === dir.toLowerCase())) parts.push(dir);
  return { key, value: parts.join(';') };
}
