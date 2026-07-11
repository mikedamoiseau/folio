// Pure reducer for the Settings > Dictionary download state machine (F-1-1).
//
// Kept framework-free so every transition is unit-testable without React or the
// Tauri bridge. The SettingsPanel component wires real `invoke`/`listen` calls
// to these actions; this module only decides the next UI state.

import type { DictionaryStatus } from "./dictionary";

/**
 * UI phase of the dictionary feature:
 *  - `unknown`     — status not yet fetched (initial).
 *  - `missing`     — no artifact; offer download.
 *  - `downloading` — download in progress (see loaded/total).
 *  - `ready`       — installed and usable.
 *  - `corrupt`     — present but unusable; offer re-download.
 *  - `error`       — a download attempt failed; offer retry.
 */
export type DictionaryPhase =
  | "unknown"
  | "missing"
  | "downloading"
  | "ready"
  | "corrupt"
  | "error";

export interface DictionaryUiState {
  phase: DictionaryPhase;
  /** Compressed bytes downloaded so far (downloading phase). */
  loaded: number;
  /** Total compressed bytes; 0 when the server sent no Content-Length. */
  total: number;
  /** WordNet version string, when ready. */
  wordnetVersion: string | null;
  /** Installed artifact size in bytes, when ready. */
  sizeBytes: number | null;
  /** Human-readable error message, in the error phase. */
  error: string | null;
}

export type DictionaryAction =
  | { type: "statusLoaded"; status: DictionaryStatus }
  | { type: "downloadStarted" }
  | { type: "downloadProgress"; loaded: number; total: number }
  | { type: "downloadSucceeded"; status: DictionaryStatus }
  | { type: "downloadFailed"; error: string }
  | { type: "deleted" };

export function initialDictionaryState(): DictionaryUiState {
  return {
    phase: "unknown",
    loaded: 0,
    total: 0,
    wordnetVersion: null,
    sizeBytes: null,
    error: null,
  };
}

function phaseFromStatus(status: DictionaryStatus): DictionaryPhase {
  return status.state; // "missing" | "ready" | "corrupt" map 1:1
}

export function dictionaryReducer(
  state: DictionaryUiState,
  action: DictionaryAction,
): DictionaryUiState {
  switch (action.type) {
    case "statusLoaded": {
      // A status refresh must not clobber an in-flight download (status is
      // fetched on settings-open / reader-mount, never mid-download, but guard
      // anyway so an out-of-order refresh can't reset the progress bar).
      if (state.phase === "downloading") {
        return state;
      }
      return {
        ...state,
        phase: phaseFromStatus(action.status),
        wordnetVersion: action.status.wordnetVersion,
        sizeBytes: action.status.sizeBytes,
        error: null,
      };
    }
    case "downloadStarted":
      return { ...state, phase: "downloading", loaded: 0, total: 0, error: null };
    case "downloadProgress":
      // Progress only applies while downloading; ignore stray late events.
      if (state.phase !== "downloading") {
        return state;
      }
      return { ...state, loaded: action.loaded, total: action.total };
    case "downloadSucceeded":
      return {
        ...state,
        phase: phaseFromStatus(action.status),
        wordnetVersion: action.status.wordnetVersion,
        sizeBytes: action.status.sizeBytes,
        loaded: 0,
        total: 0,
        error: null,
      };
    case "downloadFailed":
      return { ...state, phase: "error", loaded: 0, total: 0, error: action.error };
    case "deleted":
      return {
        ...state,
        phase: "missing",
        loaded: 0,
        total: 0,
        wordnetVersion: null,
        sizeBytes: null,
        error: null,
      };
    default:
      return state;
  }
}

/**
 * True once all bytes are downloaded but the install hasn't resolved yet — the
 * backend is verifying the checksum + decompressing. Only meaningful when a
 * Content-Length was provided (`total > 0`).
 */
export function isVerifying(state: DictionaryUiState): boolean {
  return state.phase === "downloading" && state.total > 0 && state.loaded >= state.total;
}

/** Download progress as a 0–100 percentage, or `null` when total is unknown. */
export function downloadPercent(state: DictionaryUiState): number | null {
  if (state.phase !== "downloading" || state.total <= 0) {
    return null;
  }
  return Math.min(100, Math.round((state.loaded / state.total) * 100));
}
