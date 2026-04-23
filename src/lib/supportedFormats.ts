import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

const FALLBACK = new Set(["epub", "pdf", "cbz", "cbr"]);

let cache: Promise<Set<string>> | null = null;

/**
 * Ask the backend which book formats this build can actually import. The
 * result is compile-time constant for the session (it switches on cargo
 * features, not runtime state), so we cache the first invoke and hand out
 * the same Promise to every caller.
 *
 * Falls back to the pre-MOBI core-format set if the IPC call fails — that
 * keeps the UI functional on older backends and during early startup.
 */
export function getSupportedFormats(): Promise<Set<string>> {
  if (!cache) {
    cache = invoke<string[]>("get_supported_formats")
      .then((exts) => new Set(exts))
      .catch(() => FALLBACK);
  }
  return cache;
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
