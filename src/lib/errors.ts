import type { TFunction } from "i18next";

const ERROR_KEYS: Record<string, string> = {
  pdfium: "errors.pdfium",
  "cannot open file": "errors.fileNotFound",
  "no such file or directory": "errors.fileNotFound",
  "book file not found": "errors.fileNotFound",
  "permission denied": "errors.permissionDenied",
  "invalid format": "errors.invalidFormat",
  "unsupported file format": "errors.invalidFormat",
  duplicate: "errors.duplicate",
  "chapter index": "errors.chapterLoad",
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

export function friendlyError(raw: string, t: TFunction): string {
  const lower = raw.toLowerCase();
  for (const [key, translationKey] of Object.entries(ERROR_KEYS)) {
    if (lower.includes(key)) return t(translationKey);
  }
  // Show the raw error rather than a useless generic message
  return raw;
}
