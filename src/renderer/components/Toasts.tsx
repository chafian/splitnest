import { Icon } from './Icon';
import { IconButton } from './IconButton';

export interface Toast {
  id: number;
  kind: 'info' | 'warning' | 'error' | 'agent';
  message: string;
  detail?: string;
  /** Identifies a notice that can be replaced or withdrawn later (agent notices: the tab id). */
  key?: string;
  /** A button next to the text, e.g. "Show" for an agent notice. */
  action?: { label: string; run(): void };
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss(id: number): void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`} data-notice-key={t.key}>
          {t.kind === 'agent' ? <span className="toast__agent-dot" aria-hidden="true" /> : t.kind !== 'info' && <Icon name="warning" size={15} />}
          <div className="toast__text">
            <p>{t.message}</p>
            {t.detail && <p className="toast__detail">{t.detail}</p>}
          </div>
          {t.action && (
            <button type="button" className="button button--small toast__action" onClick={t.action.run}>
              {t.action.label}
            </button>
          )}
          <IconButton icon="close" label="Dismiss" size="sm" onClick={() => onDismiss(t.id)} />
        </div>
      ))}
    </div>
  );
}
