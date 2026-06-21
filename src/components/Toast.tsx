import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from "react";

export type ToastType = "success" | "error" | "info";

/**
 * Auto-dismiss interval for toasts (ms).
 *
 * Toasts are intentionally transient — anything that needs to persist past
 * this window belongs in an inline error banner or a dialog instead. See
 * `docs/UX-CONVENTIONS.md` for the surface taxonomy.
 */
export const TOAST_AUTO_DISMISS_MS = 4000;

/** An inline action button rendered inside a toast (e.g. "Undo"). */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  /** Override the auto-dismiss window. Used by undo toasts (5s). */
  durationMs?: number;
  /** Inline action button. Clicking it cancels `onTimeout`. */
  action?: ToastAction;
  /**
   * Runs when the toast auto-dismisses OR is manually dismissed via the ×.
   * Does NOT run when `action` is clicked. Undo toasts use this to commit the
   * deferred operation once the window passes without an undo.
   */
  onTimeout?: () => void;
}

interface Toast {
  id: number;
  message: string;
  type: ToastType;
  action?: ToastAction;
}

interface ToastContextValue {
  addToast: (message: string, type?: ToastType, options?: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue>({
  addToast: () => {},
});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const onTimeouts = useRef<Map<number, () => void>>(new Map());

  // Remove a toast and clear its timer. When `runTimeout` is true, fire the
  // toast's onTimeout (commit). The undo action passes `false` to suppress it.
  const finalize = useCallback((id: number, runTimeout: boolean) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    const cb = onTimeouts.current.get(id);
    onTimeouts.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
    if (runTimeout && cb) cb();
  }, []);

  const addToast = useCallback(
    (message: string, type: ToastType = "info", options?: ToastOptions) => {
      const id = nextId.current++;
      if (options?.onTimeout) onTimeouts.current.set(id, options.onTimeout);
      setToasts((prev) => [...prev, { id, message, type, action: options?.action }]);
      const duration = options?.durationMs ?? TOAST_AUTO_DISMISS_MS;
      const timer = setTimeout(() => finalize(id, true), duration);
      timers.current.set(id, timer);
    },
    [finalize]
  );

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <ToastContainer
        toasts={toasts}
        onDismiss={(id) => finalize(id, true)}
        onAction={(id) => {
          const toast = toasts.find((t) => t.id === id);
          finalize(id, false);
          toast?.action?.onClick();
        }}
      />
    </ToastContext.Provider>
  );
}

const TYPE_STYLES: Record<ToastType, string> = {
  success: "bg-green-600 text-white",
  error: "bg-red-600 text-white",
  info: "bg-ink text-paper",
};

export function ToastContainer({
  toasts = [],
  onDismiss,
  onAction,
}: {
  toasts?: Toast[];
  onDismiss?: (id: number) => void;
  onAction?: (id: number) => void;
}) {
  return (
    <div
      aria-live="polite"
      role="status"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-2 pointer-events-none"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium animate-fade-in flex items-center gap-2 max-w-sm ${TYPE_STYLES[toast.type]}`}
          onMouseEnter={(e) => {
            // Pause auto-dismiss on hover by clearing parent's timeout
            e.currentTarget.dataset.paused = "true";
          }}
          onMouseLeave={(e) => {
            delete e.currentTarget.dataset.paused;
          }}
        >
          <span className="flex-1">{toast.message}</span>
          {toast.action && onAction && (
            <button
              onClick={() => onAction(toast.id)}
              className="font-semibold underline underline-offset-2 hover:opacity-80 text-xs whitespace-nowrap"
            >
              {toast.action.label}
            </button>
          )}
          {onDismiss && (
            <button
              onClick={() => onDismiss(toast.id)}
              className="opacity-60 hover:opacity-100 text-xs ml-1"
              aria-label="Dismiss"
            >
              &times;
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
