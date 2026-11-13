// "What's new" after an update: the first time a newer SplitNest version starts, a notice offers the
// release notes for that version (GitHub Releases, opened in the browser only when asked). The last
// version the user saw is kept in settings (`lastVersionSeen`).
import { compareVersions, isVersion } from '../../../shared/version';
import { REPO_URL } from '../feedback/links';

export { compareVersions, isVersion } from '../../../shared/version';

export type WhatsNewDecision =
  /** Show the notice for this version. */
  | { kind: 'show'; version: string }
  /** Remember this version without a notice (first install, a downgrade, or an unknown version). */
  | { kind: 'record'; version: string }
  | { kind: 'none' };

/**
 * `lastVersionSeen` is null on a first install, and also after updating from 0.2.0, which did not
 * save it. Those two are told apart by the first-run update notice: an update can only have been
 * installed after it was acknowledged.
 */
export function whatsNewDecision(settings: { lastVersionSeen: string | null; updateNoticeSeen: boolean }, current: string): WhatsNewDecision {
  if (!isVersion(current)) return { kind: 'none' };
  const last = settings.lastVersionSeen;
  if (last === current) return { kind: 'none' };
  if (last === null) return settings.updateNoticeSeen ? { kind: 'show', version: current } : { kind: 'record', version: current };
  return compareVersions(current, last) > 0 ? { kind: 'show', version: current } : { kind: 'record', version: current };
}

/**
 * The release an "Update ready" notice refers to. The updater only installs the newest published
 * release, so its notes are the latest release on GitHub (the downloaded version isn't reported).
 */
export const LATEST_RELEASE_URL = `${REPO_URL}/releases/latest`;

/** This version's release notes on GitHub. */
export function releaseNotesUrl(version: string): string {
  return isVersion(version) ? `${REPO_URL}/releases/tag/v${version}` : `${REPO_URL}/releases`;
}
