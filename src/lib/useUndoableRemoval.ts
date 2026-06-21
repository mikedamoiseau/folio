import { useCallback, useState } from "react";
import type { ToastOptions, ToastType } from "../components/Toast";

/** Undo window for reversible destructive actions (ms). */
export const UNDO_WINDOW_MS = 5000;

type AddToast = (message: string, type?: ToastType, options?: ToastOptions) => void;

export interface UndoableRemovalOptions {
  /** Toast message shown while the undo window is open. */
  message: string;
  /** Label for the undo action button. */
  undoLabel: string;
  /**
   * Performs the actual (irreversible) backend removal. Called once the undo
   * window elapses without an undo. Should also refresh any affected views;
   * because it resolves only after the refresh, the optimistic state is
   * cleared without the rows flashing back.
   */
  commit: () => Promise<void>;
  /** Called if `commit` throws. The optimistic removal is reverted first. */
  onError?: (err: unknown) => void;
  /** Override the undo window (defaults to {@link UNDO_WINDOW_MS}). */
  durationMs?: number;
}

export interface UndoableRemoval {
  /** Ids currently hidden optimistically pending commit. Filter these from views. */
  pendingIds: Set<string>;
  /** Optimistically hide `ids`, show an undo toast, and defer the real removal. */
  remove: (ids: string[], options: UndoableRemovalOptions) => void;
}

/**
 * Deferred-execution undo for destructive list actions.
 *
 * Rather than soft-deleting rows in the DB, the affected ids are hidden from
 * the UI immediately and the backend call fires only after a 5s window. The
 * user can cancel within the window via the toast's Undo button. This keeps
 * the irreversible work (file deletion, etc.) from ever happening when undone.
 */
export function useUndoableRemoval(addToast: AddToast): UndoableRemoval {
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const remove = useCallback(
    (ids: string[], options: UndoableRemovalOptions) => {
      setPendingIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.add(id);
        return next;
      });

      const clearPending = () =>
        setPendingIds((prev) => {
          const next = new Set(prev);
          for (const id of ids) next.delete(id);
          return next;
        });

      let settled = false;

      const commit = async () => {
        if (settled) return;
        settled = true;
        try {
          await options.commit();
          // Rows are gone from the source data now, so clearing pending
          // cannot flash them back.
          clearPending();
        } catch (err) {
          clearPending();
          options.onError?.(err);
        }
      };

      const undo = () => {
        if (settled) return;
        settled = true;
        clearPending();
      };

      addToast(options.message, "info", {
        durationMs: options.durationMs ?? UNDO_WINDOW_MS,
        action: { label: options.undoLabel, onClick: undo },
        onTimeout: () => {
          void commit();
        },
      });
    },
    [addToast]
  );

  return { pendingIds, remove };
}
