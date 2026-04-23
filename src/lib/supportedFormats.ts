import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

const FALLBACK = new Set(["epub", "pdf", "cbz", "cbr"]);

let cache: Promise<Set<string>> | null = null;

/**
 * Ask the backend which book formats this build can actually import. The
 * result is compile-time constant for the session (it switches on cargo
 * features, not runtime state), so we cache the first successful invoke
 * and hand out the same Promise to every later caller.
 *
 * A transient IPC failure during cold start is served the pre-MOBI core
 * set so the UI stays functional, but the rejection is NOT cached — the
 * next call retries. Caching the rejection would permanently degrade the
 * session (import dialog, drag-drop, OPDS gating all stuck without MOBI
 * until restart).
 */
export function getSupportedFormats(): Promise<Set<string>> {
  if (!cache) {
    const pending = invoke<string[]>("get_supported_formats").then(
      (exts) => new Set(exts),
    );
    cache = pending;
    pending.catch(() => {
      // Drop the rejected promise so the next caller re-tries the IPC.
      cache = null;
    });
  }
  // Current callers still get FALLBACK on this invocation; only later
  // calls get a fresh attempt.
  return cache.catch(() => FALLBACK);
}

/** Test-only: drop the memoized promise. Do not call from production code. */
export function __resetCacheForTests(): void {
  cache = null;
}

/** React hook variant of {@link getSupportedFormats} — returns `null` until
 *  the first fetch resolves. */
export function useSupportedFormats(): Set<string> | null {
  const [supported, setSupported] = useState<Set<string> | null>(null);
  useEffect(() => {
    let cancelled = false;
    getSupportedFormats().then((s) => {
      if (!cancelled) setSupported(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return supported;
}
