// Modal dialog on top of the native <dialog> element (focus trapping,
// Escape to close and inert background are provided by the platform).
import { useEffect, useRef, type ReactNode } from 'react';
import { IconButton } from './IconButton';

interface Props {
  title: string;
  open: boolean;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
}

export function Dialog({ title, open, onClose, children, footer, width = 480, className }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`dialog${className ? ` ${className}` : ''}`}
      style={{ width: `min(${width}px, calc(100vw - 32px))` }}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="dialog__inner">
          <header className="dialog__header">
            <h2>{title}</h2>
            <IconButton icon="close" label="Close" size="sm" onClick={onClose} />
          </header>
          <div className="dialog__body">{children}</div>
          {footer && <footer className="dialog__footer">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

export interface ConfirmRequest {
  title: string;
  message: string;
  detail?: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): void;
  /** Optional second action between Cancel and the main one (e.g. "Discard"). */
  extra?: { label: string; danger?: boolean; run(): void };
}

export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest | null; onClose(): void }) {
  return (
    <Dialog
      title={request?.title ?? ''}
      open={!!request}
      onClose={onClose}
      width={440}
      footer={
        request && (
          <>
            <button type="button" className="button" onClick={onClose} autoFocus>
              Cancel
            </button>
            {request.extra && (
              <button
                type="button"
                className={`button ${request.extra.danger ? 'button--danger-ghost' : ''}`}
                onClick={() => {
                  request.extra!.run();
                  onClose();
                }}
              >
                {request.extra.label}
              </button>
            )}
            <button
              type="button"
              className={`button ${request.danger ? 'button--danger' : 'button--primary'}`}
              onClick={() => {
                request.onConfirm();
                onClose();
              }}
            >
              {request.confirmLabel}
            </button>
          </>
        )
      }
    >
      {request && (
        <>
          <p className="dialog__message">{request.message}</p>
          {request.detail && <p className="dialog__detail">{request.detail}</p>}
        </>
      )}
    </Dialog>
  );
}
