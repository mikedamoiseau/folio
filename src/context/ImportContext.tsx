import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type ImportPhase =
  | "idle"
  | "scanning"
  | "importing"
  | "done"
  | "cancelled"
  | "empty"
  | "error";

export interface ImportProgress {
  phase: ImportPhase;
  current: number;
  total: number;
  filename: string;
  imported: number;
  duplicates: number;
  errors: number;
}

interface ImportContextValue {
  running: boolean;
  progress: ImportProgress | null;
  /** Bumped to Date.now() each time the backend signals a terminal phase. */
  lastCompletedAt: number | null;
  startFolder: (folderPath: string) => Promise<void>;
  startFiles: (paths: string[]) => Promise<void>;
  cancel: () => Promise<void>;
  /** Re-run the most recent import request (used by the error-phase retry). */
  retry: () => Promise<void>;
  /** Manually clear a persisted (error) status bar. */
  dismiss: () => void;
}

type ImportRequest =
  | { kind: "folder"; path: string }
  | { kind: "files"; paths: string[] };

const IDLE: ImportProgress = {
  phase: "idle",
  current: 0,
  total: 0,
  filename: "",
  imported: 0,
  duplicates: 0,
  errors: 0,
};

const ImportContext = createContext<ImportContextValue | null>(null);

interface BackendImportProgress {
  phase: string;
  current: number;
  total: number;
  filename: string;
  imported: number;
  duplicates: number;
  errors: number;
}

function normalizePhase(phase: string): ImportPhase {
  switch (phase) {
    case "scanning":
    case "importing":
    case "done":
    case "cancelled":
    case "empty":
    case "error":
      return phase;
    default:
      return "idle";
  }
}

export function ImportProvider({ children }: { children: ReactNode }) {
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [lastCompletedAt, setLastCompletedAt] = useState<number | null>(null);
  const clearTimerRef = useRef<number | null>(null);
  const lastRequestRef = useRef<ImportRequest | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<BackendImportProgress>("import-progress", (event) => {
      if (cancelled) return;
      const phase = normalizePhase(event.payload.phase);
      const next: ImportProgress = {
        phase,
        current: event.payload.current,
        total: event.payload.total,
        filename: event.payload.filename,
        imported: event.payload.imported,
        duplicates: event.payload.duplicates,
        errors: event.payload.errors,
      };
      setProgress(next);
      if (
        phase === "done" ||
        phase === "cancelled" ||
        phase === "empty" ||
        phase === "error"
      ) {
        setRunning(false);
        // `empty`/`error` mean no books were processed, so the grid did not
        // change — skip the `lastCompletedAt` bump that triggers `loadBooks`
        // in Library.
        if (phase !== "empty" && phase !== "error") {
          setLastCompletedAt(Date.now());
        }
        // Keep the final phase visible briefly so the user sees the totals,
        // then clear the bar. The `error` phase persists instead — a failed
        // import needs a friendly message + retry, not a 4s flash, so it stays
        // until the user retries or dismisses it.
        if (clearTimerRef.current !== null) {
          window.clearTimeout(clearTimerRef.current);
          clearTimerRef.current = null;
        }
        if (phase !== "error") {
          clearTimerRef.current = window.setTimeout(() => {
            setProgress(null);
            clearTimerRef.current = null;
          }, 4000);
        }
      } else {
        setRunning(true);
      }
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    // Rehydrate on mount in case an import is already running.
    invoke<boolean>("is_import_running")
      .then((r) => {
        if (!cancelled && r) setRunning(true);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (clearTimerRef.current !== null) {
        window.clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }
      unlisten?.();
    };
  }, []);

  const rollbackOptimistic = useCallback(async () => {
    setProgress(null);
    try {
      const stillRunning = await invoke<boolean>("is_import_running");
      setRunning(stillRunning);
    } catch {
      setRunning(false);
    }
  }, []);

  const startFolder = useCallback(async (folderPath: string) => {
    lastRequestRef.current = { kind: "folder", path: folderPath };
    setProgress({ ...IDLE, phase: "scanning", filename: folderPath });
    setRunning(true);
    try {
      await invoke("start_folder_import", { folderPath });
    } catch (err) {
      await rollbackOptimistic();
      throw err;
    }
  }, [rollbackOptimistic]);

  const startFiles = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    lastRequestRef.current = { kind: "files", paths };
    setProgress({ ...IDLE, phase: "importing", total: paths.length });
    setRunning(true);
    try {
      await invoke("start_files_import", { paths });
    } catch (err) {
      await rollbackOptimistic();
      throw err;
    }
  }, [rollbackOptimistic]);

  const cancel = useCallback(async () => {
    await invoke("cancel_import");
  }, []);

  const dismiss = useCallback(() => {
    if (clearTimerRef.current !== null) {
      window.clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    setProgress(null);
  }, []);

  // Re-run the last import. Already-imported books are deduplicated by hash
  // on the backend, so retrying the whole batch safely re-attempts only the
  // files that previously failed.
  const retry = useCallback(async () => {
    const req = lastRequestRef.current;
    if (!req) return;
    if (req.kind === "folder") await startFolder(req.path);
    else await startFiles(req.paths);
  }, [startFolder, startFiles]);

  const value = useMemo<ImportContextValue>(
    () => ({ running, progress, lastCompletedAt, startFolder, startFiles, cancel, retry, dismiss }),
    [running, progress, lastCompletedAt, startFolder, startFiles, cancel, retry, dismiss]
  );

  return <ImportContext.Provider value={value}>{children}</ImportContext.Provider>;
}

export function useImport(): ImportContextValue {
  const ctx = useContext(ImportContext);
  if (!ctx) throw new Error("useImport must be used inside ImportProvider");
  return ctx;
}
