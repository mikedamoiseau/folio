import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Pre-MOBI core-format set. Exposed so callers can detect a fallback result
 * via reference equality — `result === FALLBACK_FORMATS` is the signal that
 * the IPC call failed and the UI is showing a degraded view.
 */
export const FALLBACK_FORMATS: ReadonlySet<string> = new Set([
  "epub",
  "pdf",
  "cbz",
  "cbr",
]);

let cache: Promise<Set<string>> | null = null;

/**
 * Ask the backend which book formats this build can actually import. The
 * result is compile-time constant for the session (it switches on cargo
 * features, not runtime state), so we cache the first successful invoke
 * and hand out the same Promise to every later caller.
 *
 * A transient IPC failure during cold start is served the pre-MOBI core
 * set so the UI stays functional, but the rejection is NOT cached — the
 * next call retries. The returned value is the exact `FALLBACK_FORMATS`
 * reference when the fetch failed, which callers use to detect and
 * re-try.
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
  return cache.catch(() => FALLBACK_FORMATS as Set<string>);
}

/** Options for {@link pollSupportedFormats}. */
export interface PollOptions {
  /** Upper bound on attempts (including the first). */
  maxAttempts?: number;
  /** Delay between attempts in ms. */
  retryMs?: number;
  /** Called with every intermediate result, including the initial fallback. */
  onUpdate?: (result: Set<string>) => void;
  /** Abort further attempts when this signal fires. */
  signal?: AbortSignal;
}

/**
 * Call {@link getSupportedFormats} and retry while the result is the
 * `FALLBACK_FORMATS` reference (i.e. the IPC failed). Emits each
 * intermediate state through `onUpdate` so a React hook can show the
 * degraded view immediately and then swap in the real set once it
 * arrives.
 *
 * Returns the last observed result — either a real set after a retry
 * succeeds, or `FALLBACK_FORMATS` after `maxAttempts` attempts.
 */
export async function pollSupportedFormats(
  options: PollOptions = {},
): Promise<Set<string>> {
  const { maxAttempts = 3, retryMs = 2000, onUpdate, signal } = options;
  let last: Set<string> = FALLBACK_FORMATS as Set<string>;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) break;
    last = await getSupportedFormats();
    onUpdate?.(last);
    if (last !== FALLBACK_FORMATS) return last;
    if (attempt < maxAttempts - 1) {
      await sleep(retryMs, signal);
      if (signal?.aborted) break;
    }
  }
  return last;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      resolve();
    });
  });
}

/** React hook variant of {@link getSupportedFormats} — returns `null` until
 *  the first fetch resolves. Retries after a fallback result so a transient
 *  IPC failure during cold start doesn't permanently degrade the view. */
export function useSupportedFormats(): Set<string> | null {
  const [supported, setSupported] = useState<Set<string> | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    pollSupportedFormats({
      signal: controller.signal,
      onUpdate: (s) => {
        if (!controller.signal.aborted) setSupported(s);
      },
    });
    return () => {
      controller.abort();
    };
  }, []);
  return supported;
}

/** Test-only: drop the memoized promise. Do not call from production code. */
export function __resetCacheForTests(): void {
  cache = null;
}
