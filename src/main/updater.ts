// Automatic updates for the installed Windows app (Squirrel.Windows, Electron's built-in
// autoUpdater, feed = this repository's GitHub Releases "latest" downloads).
//
// Privacy rules (see website /privacy/ and CODE_SIGNING.md):
// - Nothing is requested before the user has seen the first-run notice (setting
//   `updateNoticeSeen`). Until then the updater does not even set its feed.
// - With `updateCheck` off, no automatic request is ever made; "Check now" in Settings is the
//   user's explicit request and works either way.
// - The request is Squirrel fetching <feed>/RELEASES (and, for an update, the package) from GitHub:
//   no identifiers, no telemetry. Portable and development builds never check.
//
// Lifecycle: check 30 s after checks are allowed, then every 6 h; on Windows a check downloads the
// update in the background. When it is ready the page offers "Restart now"; restarting goes through
// SplitNest's normal quit flow (running shells and unsaved files are asked about first). If the user
// never restarts, the next start from the Start menu runs the new version anyway. A failed check or
// download leaves the running version untouched (Squirrel verifies the package before switching)
// and is retried with growing delays.
import type { UpdatePhase, UpdatePrefs, UpdateStatus } from '../shared/updates';
export type { UpdatePhase, UpdatePrefs, UpdateStatus };

/** What the updater needs from Electron's autoUpdater (Squirrel.Windows on Windows). */
export interface AutoUpdaterLike {
  setFeedURL(options: { url: string }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
  on(event: 'checking-for-update' | 'update-available' | 'update-not-available' | 'update-downloaded', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface UpdaterDeps {
  /** True only for a Squirrel-installed, packaged Windows build. */
  installed: boolean;
  version: string;
  feedUrl: string;
  autoUpdater: AutoUpdaterLike;
  prefs(): UpdatePrefs;
  onStatus(status: UpdateStatus): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  now(): number;
  log(message: string): void;
}

export const FIRST_CHECK_DELAY_MS = 30_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Retry after an error: 30 min, doubling, at most the normal interval. */
export const RETRY_BASE_MS = 30 * 60 * 1000;

/** The GitHub Releases feed of a repository (`owner/name`); null for anything else. */
export function githubFeedUrl(repo: string): string | null {
  return /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo) ? `https://github.com/${repo}/releases/latest/download` : null;
}

/** A short, path- and URL-free description of an update error for the page. */
export function describeUpdateError(error: unknown): string {
  const text = String((error as Error)?.message ?? error ?? '');
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network|getaddrinfo|internet/i.test(text)) return 'No connection to GitHub.';
  if (/sha|checksum|hash|corrupt|invalid/i.test(text)) return 'The downloaded update did not pass verification; the current version is unchanged.';
  if (/404|not found/i.test(text)) return 'No update information was found on GitHub.';
  return 'The update could not be completed; the current version is unchanged.';
}

export class Updater {
  private phase: UpdatePhase;
  private lastCheck: number | null = null;
  private error: string | null = null;
  private timer: unknown = null;
  private feedSet = false;
  private listening = false;
  private failures = 0;
  private disposed = false;

  constructor(private readonly deps: UpdaterDeps) {
    this.phase = deps.installed ? 'waiting-notice' : 'unavailable';
  }

  status(): UpdateStatus {
    return { phase: this.phase, version: this.deps.version, lastCheck: this.lastCheck, error: this.error };
  }

  /** Call at start-up and whenever the preferences change. Never makes a request by itself. */
  evaluate(): void {
    if (this.disposed || !this.deps.installed) return;
    if (this.phase === 'checking' || this.phase === 'downloading' || this.phase === 'ready') return;
    const p = this.deps.prefs();
    if (!p.updateNoticeSeen) {
      this.cancelTimer();
      this.set('waiting-notice');
      return;
    }
    if (!p.updateCheck) {
      this.cancelTimer();
      this.set('off');
      return;
    }
    if (this.phase === 'waiting-notice' || this.phase === 'off' || this.phase === 'unavailable') this.set('idle');
    if (this.timer === null) this.schedule(this.lastCheck === null ? FIRST_CHECK_DELAY_MS : CHECK_INTERVAL_MS);
  }

  /** "Check now" in Settings: the user's explicit request, allowed even with automatic checks off. */
  checkNow(): UpdateStatus {
    this.check(true);
    return this.status();
  }

  /** "Restart now": only when an update is ready. The caller has already run the quit flow. */
  installAndRestart(): boolean {
    if (this.phase !== 'ready') return false;
    this.deps.autoUpdater.quitAndInstall();
    return true;
  }

  get readyToInstall(): boolean {
    return this.phase === 'ready';
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  private check(manual: boolean): void {
    if (this.disposed || !this.deps.installed) return;
    if (this.phase === 'checking' || this.phase === 'downloading' || this.phase === 'ready') return;
    const p = this.deps.prefs();
    // Automatic checks need the notice seen and checks on; a manual check is the user's request.
    if (!manual && (!p.updateNoticeSeen || !p.updateCheck)) return this.evaluate();
    this.cancelTimer();
    this.listen();
    if (!this.feedSet) {
      this.deps.autoUpdater.setFeedURL({ url: this.deps.feedUrl });
      this.feedSet = true;
    }
    this.error = null;
    this.set('checking');
    try {
      this.deps.autoUpdater.checkForUpdates();
    } catch (e) {
      this.failed(e);
    }
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    const u = this.deps.autoUpdater;
    u.on('update-available', () => this.set('downloading'));
    u.on('update-not-available', () => {
      this.lastCheck = this.deps.now();
      this.failures = 0;
      this.set('up-to-date');
      this.next(CHECK_INTERVAL_MS);
    });
    u.on('update-downloaded', () => {
      this.lastCheck = this.deps.now();
      this.failures = 0;
      this.cancelTimer();
      this.set('ready');
      this.deps.log('update downloaded; applied on restart');
    });
    u.on('error', (e) => this.failed(e));
  }

  private failed(e: unknown): void {
    this.lastCheck = this.deps.now();
    this.error = describeUpdateError(e);
    this.failures++;
    this.deps.log(`update check failed (${this.failures})`);
    this.set('error');
    this.next(Math.min(CHECK_INTERVAL_MS, RETRY_BASE_MS * 2 ** (this.failures - 1)));
  }

  /** Schedules the next automatic check if automatic checks are (still) on. */
  private next(ms: number): void {
    const p = this.deps.prefs();
    if (p.updateNoticeSeen && p.updateCheck) this.schedule(ms);
  }

  private schedule(ms: number): void {
    this.cancelTimer();
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      this.check(false);
    }, ms);
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  private set(phase: UpdatePhase): void {
    if (this.phase === phase && phase !== 'error') return;
    this.phase = phase;
    this.deps.onStatus(this.status());
  }
}
