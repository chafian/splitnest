// Automatic updates (src/main/updater.ts): when requests may happen, the lifecycle, and errors.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECK_INTERVAL_MS, describeUpdateError, FIRST_CHECK_DELAY_MS, githubFeedUrl, RETRY_BASE_MS, Updater, type AutoUpdaterLike, type UpdatePrefs, type UpdateStatus } from '../../src/main/updater';

class FakeAutoUpdater implements AutoUpdaterLike {
  calls: string[] = [];
  handlers = new Map<string, ((...a: unknown[]) => void)[]>();
  setFeedURL(o: { url: string }) {
    this.calls.push(`feed ${o.url}`);
  }
  checkForUpdates() {
    this.calls.push('check');
  }
  quitAndInstall() {
    this.calls.push('quitAndInstall');
  }
  on(event: string, listener: (...a: never[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener as (...a: unknown[]) => void]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }
}

function setup(over: { installed?: boolean; prefs?: Partial<UpdatePrefs> } = {}) {
  const u = new FakeAutoUpdater();
  const prefs: UpdatePrefs = { updateCheck: true, updateNoticeSeen: false, ...over.prefs };
  const statuses: UpdateStatus[] = [];
  const updater = new Updater({
    installed: over.installed ?? true,
    version: '0.2.0',
    feedUrl: 'https://github.com/chafian/splitnest/releases/latest/download',
    autoUpdater: u,
    prefs: () => prefs,
    onStatus: (s) => statuses.push(s),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    log: () => undefined,
  });
  return { u, prefs, updater, statuses, phases: () => statuses.map((s) => s.phase) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('updater: no request before the first-run notice', () => {
  it('an installed copy waits for the notice: no feed, no check, however long it runs', async () => {
    const { u, updater } = setup();
    updater.evaluate();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
    expect(u.calls).toEqual([]);
    expect(updater.status().phase).toBe('waiting-notice');
  });

  it('once the notice is acknowledged, the first check comes 30 s later, and only then is the feed set', async () => {
    const { u, prefs, updater } = setup();
    updater.evaluate();
    prefs.updateNoticeSeen = true;
    updater.evaluate();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1);
    expect(u.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(u.calls).toEqual(['feed https://github.com/chafian/splitnest/releases/latest/download', 'check']);
  });

  it('portable and development builds never check, even when asked', async () => {
    const { u, updater } = setup({ installed: false, prefs: { updateNoticeSeen: true } });
    updater.evaluate();
    updater.checkNow();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(u.calls).toEqual([]);
    expect(updater.status().phase).toBe('unavailable');
  });

  it('with automatic checks off nothing is requested automatically; "Check now" is the user asking', async () => {
    const { u, prefs, updater } = setup({ prefs: { updateNoticeSeen: true, updateCheck: false } });
    updater.evaluate();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(u.calls).toEqual([]);
    expect(updater.status().phase).toBe('off');
    updater.checkNow();
    expect(u.calls.at(-1)).toBe('check');
    u.emit('update-not-available');
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(u.calls.filter((c) => c === 'check')).toHaveLength(1); // no automatic follow-up
    prefs.updateCheck = true; // turned back on
    updater.evaluate();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(u.calls.filter((c) => c === 'check')).toHaveLength(2);
  });

  it('turning automatic checks off cancels the pending check', async () => {
    const { u, prefs, updater } = setup({ prefs: { updateNoticeSeen: true } });
    updater.evaluate();
    prefs.updateCheck = false;
    updater.evaluate();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(u.calls).toEqual([]);
  });
});

describe('updater: lifecycle', () => {
  it('up to date: checks again every 6 hours', async () => {
    const { u, updater, phases } = setup({ prefs: { updateNoticeSeen: true } });
    updater.evaluate();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    u.emit('update-not-available');
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    u.emit('update-not-available');
    expect(u.calls.filter((c) => c === 'check')).toHaveLength(2);
    expect(phases()).toEqual(['idle', 'checking', 'up-to-date', 'checking', 'up-to-date']);
  });

  it('an update downloads in the background, then waits for a restart; no more checks meanwhile', async () => {
    const { u, updater, phases } = setup({ prefs: { updateNoticeSeen: true } });
    updater.evaluate();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    u.emit('update-available');
    u.emit('update-downloaded');
    expect(updater.readyToInstall).toBe(true);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
    expect(u.calls.filter((c) => c === 'check')).toHaveLength(1);
    expect(phases()).toEqual(['idle', 'checking', 'downloading', 'ready']);
    expect(updater.installAndRestart()).toBe(true);
    expect(u.calls.at(-1)).toBe('quitAndInstall');
  });

  it('restart is refused unless an update is ready', () => {
    const { u, updater } = setup({ prefs: { updateNoticeSeen: true } });
    expect(updater.installAndRestart()).toBe(false);
    expect(u.calls).not.toContain('quitAndInstall');
  });

  it('a failed check keeps the current version, says why without paths, and retries after 30 min, 1 h, 2 h …', async () => {
    const { u, updater } = setup({ prefs: { updateNoticeSeen: true } });
    updater.evaluate();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    u.emit('error', new Error('getaddrinfo ENOTFOUND github.com'));
    expect(updater.status()).toMatchObject({ phase: 'error', error: 'No connection to GitHub.' });
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS - 1);
    expect(u.calls.filter((c) => c === 'check')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(u.calls.filter((c) => c === 'check')).toHaveLength(2);
    u.emit('error', new Error('SHA1 mismatch C:\\Users\\me\\AppData\\Local\\splitnest\\packages\\x.nupkg'));
    expect(updater.status().error).toBe('The downloaded update did not pass verification; the current version is unchanged.');
    expect(updater.status().error).not.toContain('C:\\');
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * 2);
    expect(u.calls.filter((c) => c === 'check')).toHaveLength(3);
    u.emit('update-not-available'); // recovered
    expect(updater.status().phase).toBe('up-to-date');
  });

  it('checkForUpdates throwing is handled like an error', async () => {
    const { u, updater } = setup({ prefs: { updateNoticeSeen: true } });
    u.checkForUpdates = () => {
      throw new Error('Update.exe not found');
    };
    updater.checkNow();
    expect(updater.status().phase).toBe('error');
  });

  it('a second request while checking or downloading is ignored', () => {
    const { u, updater } = setup({ prefs: { updateNoticeSeen: true } });
    updater.checkNow();
    updater.checkNow();
    u.emit('update-available');
    updater.checkNow();
    expect(u.calls.filter((c) => c === 'check')).toHaveLength(1);
  });
});

describe('updater: feed and messages', () => {
  it('builds the GitHub Releases feed only for a plain owner/name', () => {
    expect(githubFeedUrl('chafian/splitnest')).toBe('https://github.com/chafian/splitnest/releases/latest/download');
    expect(githubFeedUrl('chafian/splitnest-update-test')).toBe('https://github.com/chafian/splitnest-update-test/releases/latest/download');
    for (const bad of ['', 'splitnest', 'a/b/c', 'evil.com/x?y', 'chafian/splitnest#x', '../x']) expect(githubFeedUrl(bad)).toBeNull();
  });

  it('error descriptions are short and never echo the original message', () => {
    expect(describeUpdateError(new Error('connect ETIMEDOUT 140.82.121.4:443'))).toBe('No connection to GitHub.');
    expect(describeUpdateError(new Error('404 Not Found RELEASES'))).toBe('No update information was found on GitHub.');
    expect(describeUpdateError(new Error('something odd at C:\\secret\\path'))).toBe('The update could not be completed; the current version is unchanged.');
  });
});
