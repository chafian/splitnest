import { useEffect, useState } from 'react';
import { LIMITS } from '../../shared/types';
import { Dialog } from './Dialog';

export function RenameDialog({
  open,
  initial,
  onSubmit,
  onClose,
}: {
  open: boolean;
  initial: string;
  onSubmit(name: string): void;
  onClose(): void;
}) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);
  const trimmed = value.trim();
  const submit = () => {
    if (!trimmed) return;
    onSubmit(trimmed);
    onClose();
  };
  return (
    <Dialog
      title="Rename workspace"
      open={open}
      onClose={onClose}
      width={420}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button button--primary" onClick={submit} disabled={!trimmed}>
            Rename
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field__label">Name</span>
        <input
          className="input"
          autoFocus
          maxLength={LIMITS.maxNameLength}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
      </label>
      <p className="settings__hint">Renaming only changes the label. The folder on disk is not renamed.</p>
    </Dialog>
  );
}
