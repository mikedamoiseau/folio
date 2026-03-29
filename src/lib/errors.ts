import type { TFunction } from "i18next";

const ERROR_KEYS: Record<string, string> = {
  pdfium: "errors.pdfium",
  "cannot open file": "errors.fileNotFound",
  "no such file or directory": "errors.fileNotFound",
  "book file not found": "errors.fileNotFound",
  "permission denied": "errors.permissionDenied",
  "invalid format": "errors.invalidFormat",
  duplicate: "errors.duplicate",
  "chapter index": "errors.chapterLoad",
  corrupt: "errors.corrupt",
};

export function friendlyError(raw: string, t: TFunction): string {
  const lower = raw.toLowerCase();
  for (const [key, translationKey] of Object.entries(ERROR_KEYS)) {
    if (lower.includes(key)) return t(translationKey);
  }
  return t("errors.generic");
}
