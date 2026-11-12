// Automatic updates: what the page and main share (see src/main/updater.ts).
export type UpdatePhase = 'unavailable' | 'waiting-notice' | 'off' | 'idle' | 'checking' | 'downloading' | 'ready' | 'up-to-date' | 'error';

export interface UpdateStatus {
  phase: UpdatePhase;
  /** The running version. */
  version: string;
  /** When the last check finished (ms since epoch), or null. */
  lastCheck: number | null;
  /** Short reason after a failed check, else null. Never contains a URL or path. */
  error: string | null;
}

export interface UpdatePrefs {
  /** Automatic update checks (setting "Check for updates automatically", on by default). */
  updateCheck: boolean;
  /** The first-run notice about update checks has been acknowledged. Nothing is requested before. */
  updateNoticeSeen: boolean;
}

/** Validates preferences sent by the page. */
export function parseUpdatePrefs(v: unknown): UpdatePrefs | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.updateCheck !== 'boolean' || typeof r.updateNoticeSeen !== 'boolean') return null;
  return { updateCheck: r.updateCheck, updateNoticeSeen: r.updateNoticeSeen };
}

/** One line for Settings › About. */
export function updateStatusText(s: UpdateStatus, now = Date.now()): string {
  const when = s.lastCheck === null ? '' : ` Last checked ${minutesAgo(now - s.lastCheck)}.`;
  switch (s.phase) {
    case 'unavailable':
      return 'Updates are available for the installed version. This copy (portable or development build) never checks.';
    case 'waiting-notice':
      return 'Automatic updates start after you have read the notice about them.';
    case 'off':
      return `Automatic update checks are off.${when}`;
    case 'idle':
      return 'Automatic update checks are on. The first check runs shortly.';
    case 'checking':
      return 'Checking for updates…';
    case 'downloading':
      return 'Downloading an update in the background…';
    case 'ready':
      return 'An update is ready. It is installed when SplitNest restarts.';
    case 'up-to-date':
      return `SplitNest is up to date.${when}`;
    case 'error':
      return `${s.error ?? 'The update check failed.'}${when} It is retried later.`;
  }
}

function minutesAgo(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
