import type { TFunction } from "i18next";

/**
 * Structured error payload produced by the Rust backend (roadmap #55).
 * Every Tauri command now returns this shape when it fails; older/tauri-host
 * errors may arrive as plain strings or Error instances.
 */
export type FolioErrorPayload = {
  kind:
    | "NotFound"
    | "PermissionDenied"
    | "InvalidInput"
    | "Network"
    | "Database"
    | "Io"
    | "Serialization"
    | "Internal"
    | string;
  message: string;
};

function isFolioErrorPayload(x: unknown): x is FolioErrorPayload {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.kind === "string" &&
    typeof o.message === "string" &&
    o.message.length > 0
  );
}

/** Normalize anything `invoke()` (or any callback) may throw into `{kind?, message}`. */
export function toFolioError(raw: unknown): { kind?: string; message: string } {
  if (isFolioErrorPayload(raw)) return { kind: raw.kind, message: raw.message };
  if (typeof raw === "string") return { message: raw };
  if (raw instanceof Error) return { message: raw.message };
  try {
    return { message: String(raw) };
  } catch {
    return { message: "Unknown error" };
  }
}

/** Default translation key per error kind — used when nothing more specific matches. */
const KIND_TO_KEY: Record<string, string> = {
  NotFound: "errors.fileNotFound",
  PermissionDenied: "errors.permissionDenied",
  Network: "errors.networkError",
  InvalidInput: "errors.invalidInput",
  Database: "errors.database",
  Io: "errors.io",
  Serialization: "errors.corrupt",
  Internal: "errors.generic",
};

/**
 * Message-substring → translation key. Kept in sync with Rust variant messages
 * so errors raised before the migration (or by sub-systems that still build
 * strings) still map to the right translated copy.
 *
 * Exported for test-only validation that each substring still appears somewhere
 * in the Rust backend (see `errors.sync.test.ts`).
 */
export const MESSAGE_KEYS: Record<string, string> = {
  pdfium: "errors.pdfium",
  "cannot open file": "errors.fileNotFound",
  "no such file or directory": "errors.fileNotFound",
  "book file not found": "errors.fileNotFound",
  "permission denied": "errors.permissionDenied",
  "invalid format": "errors.invalidFormat",
  "unsupported file format": "errors.invalidFormat",
  duplicate: "errors.duplicate",
  "chapter index": "errors.chapterIndex",
  corrupt: "errors.corrupt",
  "timed out": "errors.timeout",
  "request timed out": "errors.timeout",
  timeout: "errors.timeout",
  "connection refused": "errors.networkError",
  "connection reset": "errors.networkError",
  "network error": "errors.networkError",
  "http error": "errors.networkError",
  "dns error": "errors.networkError",
  "url blocked": "errors.urlBlocked",
  "too large": "errors.tooLarge",
  "could not find eocd": "errors.notZip",
  "not a valid zip": "errors.notZip",
  "not a valid rar": "errors.notRar",
};

/**
 * Map an error from the backend to a user-facing, translated message.
 *
 * Accepts the raw value thrown by `invoke()` (structured `{kind, message}`,
 * a string, an Error, or anything else). Translation priority:
 *
 *   1. Message-substring match (most specific user-facing copy)
 *   2. Fallback to `kind` → default key (NotFound, PermissionDenied, Network)
 *   3. Raw message (better than a generic "Something went wrong")
 */
export function friendlyError(raw: unknown, t: TFunction): string {
  const { kind, message } = toFolioError(raw);
  const lower = message.toLowerCase();

  for (const [key, translationKey] of Object.entries(MESSAGE_KEYS)) {
    if (lower.includes(key)) return t(translationKey);
  }

  if (kind && KIND_TO_KEY[kind]) {
    return t(KIND_TO_KEY[kind]);
  }

  return message;
}
