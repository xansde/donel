import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import styles from './Toast.module.css';

export interface ToastProps {
  open: boolean;
  /** Uma linha de texto (design-system.md §6). */
  message: string;
  /** No máximo uma ação. */
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
  /** Auto-dismiss, em ms. Default ~6s (§6). */
  duration?: number;
  className?: string;
}

/** Toast de canto inferior direito, uma linha + no máx. uma ação (design-system.md §6). */
export function Toast({ open, message, actionLabel, onAction, onDismiss, duration = 6000, className }: ToastProps) {
  useEffect(() => {
    if (!open) return undefined;
    const timer = window.setTimeout(onDismiss, duration);
    return () => window.clearTimeout(timer);
  }, [open, message, duration, onDismiss]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className={styles.viewport}>
      <div role="status" aria-live="polite" className={[styles.toast, className].filter(Boolean).join(' ')}>
        <span className={styles.message}>{message}</span>
        {actionLabel && onAction ? (
          <button type="button" className={styles.action} onClick={onAction}>
            {actionLabel}
          </button>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
