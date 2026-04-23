import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock for @tauri-apps/api/core — every test stubs a fresh
// `invoke` implementation via `vi.mocked(invoke).mockImplementation(...)`.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// Import after the mock so the module picks up the stubbed `invoke`.
import { invoke } from "@tauri-apps/api/core";
import {
  FALLBACK_FORMATS,
  getSupportedFormats,
  pollSupportedFormats,
  __resetCacheForTests,
} from "./supportedFormats";

describe("getSupportedFormats", () => {
  beforeEach(() => {
    __resetCacheForTests();
    vi.mocked(invoke).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the backend-reported extensions on success", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(["epub", "pdf", "mobi"]);
    const out = await getSupportedFormats();
    expect([...out].sort()).toEqual(["epub", "mobi", "pdf"]);
  });

  it("returns the pre-MOBI fallback when the IPC call rejects", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("IPC closed"));
    const out = await getSupportedFormats();
    expect([...out].sort()).toEqual(["cbr", "cbz", "epub", "pdf"]);
  });

  it("caches successful results across calls", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(["epub", "pdf", "mobi"]);
    const first = await getSupportedFormats();
    const second = await getSupportedFormats();
    expect(second).toBe(first);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("retries the backend after a transient failure (does not cache rejections)", async () => {
    // Simulates the real bug: a single failed call must not permanently
    // degrade the session. The first caller gets FALLBACK, but the next
    // caller re-runs invoke and gets the real MOBI-enabled set.
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(["epub", "pdf", "mobi", "azw3"]);

    const first = await getSupportedFormats();
    expect([...first].sort()).toEqual(["cbr", "cbz", "epub", "pdf"]);

    const second = await getSupportedFormats();
    expect(second.has("mobi")).toBe(true);
    expect(second.has("azw3")).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("returns the exact FALLBACK_FORMATS reference on failure so callers can detect it", async () => {
    // Reference equality matters — `pollSupportedFormats` and the hook use
    // it to tell a real result apart from a fallback.
    vi.mocked(invoke).mockRejectedValueOnce(new Error("bang"));
    const result = await getSupportedFormats();
    expect(result).toBe(FALLBACK_FORMATS);
  });
});

describe("pollSupportedFormats", () => {
  beforeEach(() => {
    __resetCacheForTests();
    vi.mocked(invoke).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a real result on first success without retrying", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(["epub", "pdf", "mobi"]);
    const updates: Set<string>[] = [];
    const result = await pollSupportedFormats({
      maxAttempts: 3,
      retryMs: 0,
      onUpdate: (s) => updates.push(s),
    });
    expect(result.has("mobi")).toBe(true);
    expect(updates).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("retries after FALLBACK and emits each intermediate state", async () => {
    // First call rejects → FALLBACK; second resolves with the real set.
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(["epub", "pdf", "mobi", "azw3"]);

    const updates: Set<string>[] = [];
    const result = await pollSupportedFormats({
      maxAttempts: 3,
      retryMs: 0,
      onUpdate: (s) => updates.push(s),
    });

    // Final result is the real set, not FALLBACK.
    expect(result.has("mobi")).toBe(true);
    expect(result).not.toBe(FALLBACK_FORMATS);
    // Caller observed both the transient FALLBACK and the real set.
    expect(updates).toHaveLength(2);
    expect(updates[0]).toBe(FALLBACK_FORMATS);
    expect(updates[1].has("mobi")).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("stops retrying after maxAttempts and returns FALLBACK", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("persistent"));
    const updates: Set<string>[] = [];
    const result = await pollSupportedFormats({
      maxAttempts: 3,
      retryMs: 0,
      onUpdate: (s) => updates.push(s),
    });
    expect(result).toBe(FALLBACK_FORMATS);
    expect(updates).toHaveLength(3);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("respects a cancellation signal mid-retry", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("persistent"));
    const controller = new AbortController();
    const updates: Set<string>[] = [];

    const promise = pollSupportedFormats({
      maxAttempts: 5,
      retryMs: 100,
      signal: controller.signal,
      onUpdate: (s) => {
        updates.push(s);
        if (updates.length === 2) controller.abort();
      },
    });

    const result = await promise;
    expect(result).toBe(FALLBACK_FORMATS);
    // Cancellation stops further attempts after the one that triggered abort.
    expect(updates.length).toBeLessThanOrEqual(3);
  });
});
