// Automatic updates in the page: the first-run notice (no update request is made before it is
// acknowledged, see src/main/updater.ts) and "Update ready" with Restart now.
import { useEffect, useState } from 'react';
import type { UpdateStatus } from '../../../shared/updates';
import { api } from '../../api';
import { Icon } from '../../components/Icon';

export const PRIVACY_URL = 'https://splitnest.dev/privacy/';

/** The updater's state, kept current. */
export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    let alive = true;
    void api.updateStatus().then((s) => alive && setStatus(s));
    const off = api.onUpdateStatus((s) => setStatus(s));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return status;
}

interface Props {
  status: UpdateStatus | null;
  /** Saves the choice in settings (and tells main, which applies it at once). */
  onChoose(updateCheck: boolean): void;
}

export function UpdateNotices({ status, onChoose }: Props) {
  const [laterFor, setLaterFor] = useState<string | null>(null);
  if (!status) return null;

  if (status.phase === 'waiting-notice') {
    return (
      <div className="notice notice--update" role="region" aria-label="Automatic updates" data-testid="update-notice">
        <div className="notice__row">
          <Icon name="restart" size={16} className="notice__icon" />
          <span className="notice__text">
            <strong>SplitNest keeps itself up to date.</strong>{' '}
            <span className="notice__meta">
              It asks GitHub for new releases shortly after starting and then every few hours, sending only the app version, platform and architecture (plus your IP address, as any web request does). Updates download in the background and are installed when SplitNest restarts. Nothing has been sent yet.{' '}
              <a href={PRIVACY_URL} onClick={(e) => (e.preventDefault(), void api.openExternal(PRIVACY_URL))}>
                Privacy policy
              </a>
            </span>
          </span>
          <button type="button" className="button button--small button--primary" data-testid="update-notice-keep" onClick={() => onChoose(true)}>
            Keep automatic updates
          </button>
          <button type="button" className="button button--small" data-testid="update-notice-off" onClick={() => onChoose(false)}>
            Turn off
          </button>
        </div>
      </div>
    );
  }

  if (status.phase === 'ready' && laterFor !== 'ready') {
    return (
      <div className="notice notice--update" role="region" aria-label="Update ready" data-testid="update-ready">
        <div className="notice__row">
          <Icon name="restart" size={16} className="notice__icon" />
          <span className="notice__text">
            <strong>An update is ready.</strong> <span className="notice__meta">Restart SplitNest to finish installing it. Otherwise it is installed the next time SplitNest starts.</span>
          </span>
          <button type="button" className="button button--small button--primary" data-testid="update-restart" onClick={() => void api.restartToUpdate()}>
            Restart now
          </button>
          <button type="button" className="button button--small" onClick={() => setLaterFor('ready')}>
            Later
          </button>
        </div>
      </div>
    );
  }
  return null;
}
