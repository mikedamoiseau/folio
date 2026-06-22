// Pure logic for the remote-backup config section of SettingsPanel.
//
// Extracted here so the Save / Test-connection decision logic is unit
// testable without rendering the (very large) SettingsPanel component.

export interface BackupFieldSpec {
  key: string;
  label: string;
  required: boolean;
}

export interface ConnectionTestResultLike {
  status: "Ok" | "AuthFailed" | "PermissionDenied" | "NetworkError" | "Timeout";
  latency_ms?: number;
  message?: string;
}

/**
 * Returns the labels of required fields that are missing or blank.
 * Empty array means validation passed.
 */
export function missingRequiredFields(
  fields: BackupFieldSpec[],
  values: Record<string, string>
): string[] {
  return fields
    .filter((f) => f.required && !values[f.key]?.trim())
    .map((f) => f.label);
}

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/**
 * Maps a connection test result to user-facing feedback. `isError` lets the
 * caller pick the right styling and lets callers distinguish a successful
 * connection from any failure mode.
 */
export function connectionResultFeedback(
  result: ConnectionTestResultLike,
  t: Translate
): { text: string; isError: boolean } {
  switch (result.status) {
    case "Ok":
      return { text: t("settings.connected", { ms: result.latency_ms ?? 0 }), isError: false };
    case "AuthFailed":
      return { text: t("settings.authFailed"), isError: true };
    case "PermissionDenied":
      return { text: t("settings.writePermissionDenied"), isError: true };
    case "NetworkError":
      return { text: result.message || t("settings.networkError"), isError: true };
    case "Timeout":
      return { text: t("settings.connectionTimeout"), isError: true };
  }
}
