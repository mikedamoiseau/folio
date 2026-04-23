import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock for @tauri-apps/api/core — every test stubs a fresh
// `invoke` implementation via `vi.mocked(invoke).mockImplementation(...)`.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// Import after the mock so the module picks up the stubbed `invoke`.
import { invoke } from "@tauri-apps/api/core";
import { getSupportedFormats, __resetCacheForTests } from "./supportedFormats";

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
});
