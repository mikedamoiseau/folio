import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from "react";

export type ToastType = "success" | "error" | "info";

interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  addToast: (message: string, type?: ToastType) => void;
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

  const addToast = useCallback((message: string, type: ToastType = "info") => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={(id) => setToasts((prev) => prev.filter((t) => t.id !== id))} />
    </ToastContext.Provider>
  );
}

const TYPE_STYLES: Record<ToastType, string> = {
  success: "bg-green-600 text-white",
  error: "bg-red-600 text-white",
  info: "bg-ink text-paper",
};

export function ToastContainer({ toasts = [], onDismiss }: { toasts?: Toast[]; onDismiss?: (id: number) => void }) {
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
