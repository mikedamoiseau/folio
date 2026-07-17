import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useFocusTrap } from "../lib/useFocusTrap";

interface ConfirmDialogProps {
  /** Heading / question. */
  title: string;
  /** Optional body copy explaining the consequence. */
  message?: ReactNode;
  /** Confirm button label. Defaults to the translated "Delete". */
  confirmLabel?: string;
  /** Cancel button label. Defaults to the translated "Cancel". */
  cancelLabel?: string;
  /** Style the confirm button as destructive (red). Defaults to true. */
  destructive?: boolean;
  /** Disable the confirm button (e.g. while the action is in flight). */
  confirmDisabled?: boolean;
  /** Extra content (e.g. a cover thumbnail) rendered above the buttons. */
  children?: ReactNode;
  /**
   * Where initial focus lands on open. `"cancel"` (default) focuses the cancel
   * button — a safe default for destructive confirmations. `"dialog"` focuses
   * the dialog container so no action button is highlighted on open — use for
   * neutral prompts (e.g. opt-in) where nudging a choice is undesirable.
   */
  autoFocus?: "cancel" | "dialog";
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Styled confirmation dialog for destructive / blocking decisions. Replaces
 * the browser `confirm()` (unstyled, no theming, no context). Per
 * docs/UX-CONVENTIONS.md, decisions belong in a dialog — reversible actions
 * use an undo toast instead (see `useUndoableRemoval`).
 *
 * Controlled: the caller mounts it only while a confirmation is pending.
 */
export default function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  destructive = true,
  confirmDisabled = false,
  children,
  autoFocus = "cancel",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const dialogRef = useFocusTrap(onCancel, true, autoFocus === "dialog");

  return (
    <>
      <div
        className="fixed inset-0 bg-ink/40 backdrop-blur-sm z-[90] animate-fade-in"
        onClick={onCancel}
      />
      <div className="fixed inset-0 z-[90] flex items-center justify-center p-4 pointer-events-none">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className="bg-surface rounded-2xl shadow-xl border border-warm-border w-full max-w-sm pointer-events-auto animate-slide-in-up overflow-hidden focus:outline-none"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-6 py-5 space-y-3">
            <h2 className="font-serif text-lg font-semibold text-ink leading-snug">{title}</h2>
            {message && <div className="text-sm text-ink-muted leading-relaxed">{message}</div>}
            {children}
            <div className="flex gap-2 justify-end pt-2">
              <button
                onClick={onCancel}
                className="px-4 py-1.5 text-sm font-medium text-ink-muted hover:text-ink hover:bg-warm-subtle rounded-lg transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
              >
                {cancelLabel ?? t("common.cancel")}
              </button>
              <button
                onClick={onConfirm}
                disabled={confirmDisabled}
                className={`px-4 py-1.5 text-sm font-medium text-white rounded-lg transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${
                  destructive ? "bg-red-600 hover:bg-red-500" : "bg-accent hover:bg-accent-hover"
                }`}
              >
                {confirmLabel ?? t("common.delete")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
