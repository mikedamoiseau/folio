import { describe, it, expect } from "vitest";
import {
  missingRequiredFields,
  connectionResultFeedback,
  type BackupFieldSpec,
  type ConnectionTestResultLike,
} from "./backupConnection";

const fields: BackupFieldSpec[] = [
  { key: "host", label: "Host", required: true },
  { key: "port", label: "Port", required: false },
  { key: "user", label: "Username", required: true },
];

// Simple identity-ish translator that records key + interpolation so we can
// assert which message branch was taken without pulling in i18next.
const t = (key: string, opts?: Record<string, unknown>): string =>
  opts ? `${key}|${JSON.stringify(opts)}` : key;

describe("missingRequiredFields", () => {
  it("returns labels of blank required fields", () => {
    expect(missingRequiredFields(fields, { host: "", user: "  " })).toEqual([
      "Host",
      "Username",
    ]);
  });

  it("ignores optional fields and trims whitespace", () => {
    expect(missingRequiredFields(fields, { host: " h ", user: "u" })).toEqual([]);
    expect(missingRequiredFields(fields, { host: "h", user: "u", port: "" })).toEqual([]);
  });

  it("treats missing keys as missing required values", () => {
    expect(missingRequiredFields(fields, {})).toEqual(["Host", "Username"]);
  });
});

describe("connectionResultFeedback", () => {
  it("maps Ok to a non-error message with latency", () => {
    const r: ConnectionTestResultLike = { status: "Ok", latency_ms: 42 };
    expect(connectionResultFeedback(r, t)).toEqual({
      text: 'settings.connected|{"ms":42}',
      isError: false,
    });
  });

  it("defaults missing latency to 0", () => {
    const r: ConnectionTestResultLike = { status: "Ok" };
    expect(connectionResultFeedback(r, t)).toEqual({
      text: 'settings.connected|{"ms":0}',
      isError: false,
    });
  });

  it("maps each failure status to a distinct error message", () => {
    expect(connectionResultFeedback({ status: "AuthFailed" }, t)).toEqual({
      text: "settings.authFailed",
      isError: true,
    });
    expect(connectionResultFeedback({ status: "PermissionDenied" }, t)).toEqual({
      text: "settings.writePermissionDenied",
      isError: true,
    });
    expect(connectionResultFeedback({ status: "Timeout" }, t)).toEqual({
      text: "settings.connectionTimeout",
      isError: true,
    });
  });

  it("uses the backend message for NetworkError when present, else a fallback", () => {
    expect(
      connectionResultFeedback({ status: "NetworkError", message: "DNS fail" }, t)
    ).toEqual({ text: "DNS fail", isError: true });
    expect(connectionResultFeedback({ status: "NetworkError" }, t)).toEqual({
      text: "settings.networkError",
      isError: true,
    });
  });
});
