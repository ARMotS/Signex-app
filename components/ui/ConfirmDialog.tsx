"use client";

import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * "Are you sure?" before something is removed. On the page body: a transformed
 * ancestor (animate-fade-in) would otherwise pin it inside its card. Above the
 * details panel, which it can open from.
 */
export default function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busyLabel,
  busy,
  error,
  confirmDisabled,
  onCancel,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  error?: string | null;
  confirmDisabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 animate-fade-in"
      onClick={(e) => {
        e.stopPropagation();
        if (!busy) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-label={title}
        className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-5 space-y-3">
          <h3 className="font-mono text-sm font-medium text-ink-black">{title}</h3>
          <div className="text-sm text-ink-muted space-y-3">{children}</div>
          {error && <p className="text-xs text-ink-red break-words">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-ink-border bg-ink-surface/50">
          <button type="button" onClick={onCancel} disabled={busy} className="act">
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={busy || confirmDisabled} className="act act-red">
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
