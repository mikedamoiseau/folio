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

export type ImportPhase = "idle" | "scanning" | "importing" | "done" | "cancelled";

export interface ImportProgress {
  phase: ImportPhase;
  current: number;
  total: number;
  filename: string;
  imported: number;
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
}

const IDLE: ImportProgress = {
  phase: "idle",
  current: 0,
  total: 0,
  filename: "",
  imported: 0,
  errors: 0,
};

const ImportContext = createContext<ImportContextValue | null>(null);

interface BackendImportProgress {
  phase: string;
  current: number;
  total: number;
  filename: string;
  imported: number;
  errors: number;
}

function normalizePhase(phase: string): ImportPhase {
  switch (phase) {
    case "scanning":
    case "importing":
    case "done":
    case "cancelled":
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
        errors: event.payload.errors,
      };
      setProgress(next);
      if (phase === "done" || phase === "cancelled") {
        setRunning(false);
        setLastCompletedAt(Date.now());
        // Keep the final phase visible briefly so the user sees the totals,
        // then clear the bar.
        if (clearTimerRef.current !== null) {
          window.clearTimeout(clearTimerRef.current);
        }
        clearTimerRef.current = window.setTimeout(() => {
          setProgress(null);
          clearTimerRef.current = null;
        }, 4000);
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

  const value = useMemo<ImportContextValue>(
    () => ({ running, progress, lastCompletedAt, startFolder, startFiles, cancel }),
    [running, progress, lastCompletedAt, startFolder, startFiles, cancel]
  );

  return <ImportContext.Provider value={value}>{children}</ImportContext.Provider>;
}

export function useImport(): ImportContextValue {
  const ctx = useContext(ImportContext);
  if (!ctx) throw new Error("useImport must be used inside ImportProvider");
  return ctx;
}
