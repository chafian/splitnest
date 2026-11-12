// What a terminal tab shows. The custom name (if any) always wins; titles a
// shell sets through escape sequences only ever appear in the tooltip, so
// they can never overwrite a name the user chose.

export interface TabLabelInput {
  /** User-chosen name from the saved layout. */
  customName?: string | null;
  profileId: string;
  /** Profile label from discovery or the running session ("Ubuntu-22.04"). */
  shellLabel: string;
  /** Last title the shell set via OSC 0/2, if any. Informational only. */
  shellTitle?: string | null;
  /** AI agent running in the tab ("Claude Code"), if any. */
  agentLabel?: string | null;
  /** The agent's session title ("Fix login redirect"), if it reports one. */
  agentTitle?: string | null;
}

export interface TabLabel {
  /** Main text on the tab. */
  primary: string;
  /** Shell identity shown next to a custom name; null when it would repeat `primary`. */
  secondary: string | null;
  /** The default label the tab returns to when its custom name is cleared. */
  defaultName: string;
  /** Complete label for tooltips: `Project B · PowerShell`, or just the shell. */
  full: string;
  /** Extra tooltip line for the shell-set title, when it adds information. */
  titleLine: string | null;
}

export function shortShellName(profileId: string, label: string): string {
  if (profileId === 'windows-powershell') return 'PowerShell';
  if (profileId === 'pwsh') return 'PowerShell 7';
  return label;
}

export function tabLabel(input: TabLabelInput): TabLabel {
  const defaultName = shortShellName(input.profileId, input.shellLabel);
  const custom = input.customName?.trim() || null;
  // ConPTY reports the shell's executable path as the first title; that adds nothing.
  const rawTitle = input.shellTitle?.trim() || null;
  const title = rawTitle && !/\.exe$/i.test(rawTitle) ? rawTitle : null;
  const agent = input.agentLabel?.trim() || null;
  const session = agent ? input.agentTitle?.trim() || null : null;
  // Priority: your name > the agent's session title > the agent > the shell.
  const primary = custom ?? session ?? agent ?? defaultName;
  const second = custom ? (agent ?? defaultName) : session ? agent : agent ? defaultName : null;
  const secondary = second && second.toLowerCase() !== primary.toLowerCase() ? second : null;
  const titleLine = title && title !== primary && title !== defaultName && title !== input.shellLabel ? title : null;
  return { primary, secondary, defaultName, full: secondary ? `${primary} · ${secondary}` : primary, titleLine };
}
