// Path helpers for the explorer. Relative paths use `/` and are relative to
// the workspace root ('' is the root itself).

export function joinRelative(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

export function parentOf(relativePath: string): string {
  const i = relativePath.lastIndexOf('/');
  return i < 0 ? '' : relativePath.slice(0, i);
}

export function toWindowsPath(root: string, relativePath: string): string {
  if (!relativePath) return root;
  return `${root.replace(/[\\/]+$/, '')}\\${relativePath.replace(/\//g, '\\')}`;
}

/** PowerShell single-quoted literal: no variable expansion; `'` is doubled. */
export function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** POSIX shell single-quoted literal: `'` becomes `'\''`. */
export function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Text to insert into a terminal for a workspace item. PowerShell gets the
 * absolute Windows path. WSL gets the absolute Linux path when the session
 * started in the mapped workspace folder, otherwise the path relative to it.
 */
export function terminalPathText(options: {
  shell: 'powershell' | 'wsl';
  workspaceRoot: string;
  relativePath: string;
  linuxRoot?: string | null;
}): string {
  if (options.shell === 'powershell') return quotePowerShell(toWindowsPath(options.workspaceRoot, options.relativePath));
  const rel = options.relativePath || '.';
  if (options.linuxRoot && options.linuxRoot.startsWith('/')) {
    return quotePosix(options.relativePath ? `${options.linuxRoot.replace(/\/+$/, '')}/${options.relativePath}` : options.linuxRoot);
  }
  return quotePosix(rel);
}
