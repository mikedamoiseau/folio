import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { clearAllVolatilePositions } from "../lib/volatileResume";

export interface UsePrivateMode {
  /** Current "Don't track this session" state, mirrored from the backend. */
  enabled: boolean;
  /** True until the initial `get_private_mode` read resolves. */
  loading: boolean;
  /** Flips the backend flag. State updates via the `private-mode-changed`
   *  event, not optimistically — every mounted instance (header + reader)
   *  converges on the same value without racing each other. */
  toggle: () => Promise<void>;
}

/**
 * App-wide "Don't track this session" toggle (B-M2 — surfaces the backend
 * guard landed in B-M1). The backend `private_mode` flag is the single
 * source of truth (spec Decision 1); this hook never persists its own
 * copy, so the visible indicator can never disagree with actual tracking
 * state, and the toggle always starts off on a fresh app launch (R-3).
 *
 * Each mounted instance independently reads `get_private_mode` on mount
 * and listens for `private-mode-changed` — safe because the backend
 * broadcasts that event to every window/instance, including the one that
 * issued the change.
 */
export function usePrivateMode(): UsePrivateMode {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const enabledRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    invoke<boolean>("get_private_mode")
      .then((value) => {
        if (cancelled) return;
        enabledRef.current = value;
        setEnabled(value);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    const unlisten = listen<boolean>("private-mode-changed", (event) => {
      const next = event.payload;
      // The moment private mode turns off, drop any volatile resume
      // positions accumulated during the session that just ended — a
      // stale entry must never shadow a real DB position written later.
      if (enabledRef.current && !next) {
        clearAllVolatilePositions();
      }
      enabledRef.current = next;
      setEnabled(next);
    });

    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, []);

  const toggle = useCallback(async () => {
    await invoke<boolean>("set_private_mode", { enabled: !enabledRef.current });
  }, []);

  return { enabled, loading, toggle };
}
