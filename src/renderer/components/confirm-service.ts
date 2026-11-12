// Lets components outside App's direct children (e.g. editor banners) use the
// app's single confirmation dialog.
import type { ConfirmRequest } from './Dialog';

let handler: ((request: ConfirmRequest) => void) | null = null;

export function setConfirmHandler(next: ((request: ConfirmRequest) => void) | null): void {
  handler = next;
}

export function requestConfirm(request: ConfirmRequest): void {
  handler?.(request);
}
