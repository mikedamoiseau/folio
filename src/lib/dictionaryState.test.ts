import { describe, it, expect } from "vitest";
import {
  initialDictionaryState,
  dictionaryReducer,
  isVerifying,
  downloadPercent,
  type DictionaryUiState,
} from "./dictionaryState";
import type { DictionaryStatus } from "./dictionary";

const status = (
  state: DictionaryStatus["state"],
  wordnetVersion: string | null = null,
  sizeBytes: number | null = null,
): DictionaryStatus => ({ state, wordnetVersion, sizeBytes });

describe("dictionaryReducer", () => {
  it("starts unknown", () => {
    expect(initialDictionaryState().phase).toBe("unknown");
  });

  it("maps statusLoaded to the matching phase", () => {
    let s = dictionaryReducer(initialDictionaryState(), {
      type: "statusLoaded",
      status: status("missing"),
    });
    expect(s.phase).toBe("missing");

    s = dictionaryReducer(initialDictionaryState(), {
      type: "statusLoaded",
      status: status("ready", "3.1", 7_000_000),
    });
    expect(s.phase).toBe("ready");
    expect(s.wordnetVersion).toBe("3.1");
    expect(s.sizeBytes).toBe(7_000_000);

    s = dictionaryReducer(initialDictionaryState(), {
      type: "statusLoaded",
      status: status("corrupt"),
    });
    expect(s.phase).toBe("corrupt");
  });

  it("does not let statusLoaded clobber an in-flight download", () => {
    let s = dictionaryReducer(initialDictionaryState(), { type: "downloadStarted" });
    s = dictionaryReducer(s, { type: "downloadProgress", loaded: 100, total: 200 });
    const after = dictionaryReducer(s, {
      type: "statusLoaded",
      status: status("missing"),
    });
    expect(after).toEqual(s);
    expect(after.phase).toBe("downloading");
  });

  it("tracks download start → progress → success", () => {
    let s = dictionaryReducer(initialDictionaryState(), { type: "downloadStarted" });
    expect(s.phase).toBe("downloading");
    expect(s.loaded).toBe(0);

    s = dictionaryReducer(s, { type: "downloadProgress", loaded: 512, total: 1024 });
    expect(s.loaded).toBe(512);
    expect(s.total).toBe(1024);

    s = dictionaryReducer(s, {
      type: "downloadSucceeded",
      status: status("ready", "3.1", 7_000_000),
    });
    expect(s.phase).toBe("ready");
    expect(s.loaded).toBe(0);
    expect(s.wordnetVersion).toBe("3.1");
  });

  it("ignores progress events when not downloading", () => {
    const s = dictionaryReducer(initialDictionaryState(), {
      type: "downloadProgress",
      loaded: 10,
      total: 20,
    });
    expect(s).toEqual(initialDictionaryState());
  });

  it("moves to error on failure and clears progress", () => {
    let s = dictionaryReducer(initialDictionaryState(), { type: "downloadStarted" });
    s = dictionaryReducer(s, { type: "downloadProgress", loaded: 100, total: 200 });
    s = dictionaryReducer(s, { type: "downloadFailed", error: "checksum mismatch" });
    expect(s.phase).toBe("error");
    expect(s.error).toBe("checksum mismatch");
    expect(s.loaded).toBe(0);
  });

  it("returns to missing on delete and clears metadata", () => {
    let s: DictionaryUiState = {
      phase: "ready",
      loaded: 0,
      total: 0,
      wordnetVersion: "3.1",
      sizeBytes: 7_000_000,
      error: null,
    };
    s = dictionaryReducer(s, { type: "deleted" });
    expect(s.phase).toBe("missing");
    expect(s.wordnetVersion).toBeNull();
    expect(s.sizeBytes).toBeNull();
  });
});

describe("isVerifying", () => {
  it("is true once all known bytes are in but before resolution", () => {
    const s: DictionaryUiState = {
      phase: "downloading",
      loaded: 1024,
      total: 1024,
      wordnetVersion: null,
      sizeBytes: null,
      error: null,
    };
    expect(isVerifying(s)).toBe(true);
  });

  it("is false mid-download and when total is unknown", () => {
    expect(
      isVerifying({
        phase: "downloading",
        loaded: 500,
        total: 1024,
        wordnetVersion: null,
        sizeBytes: null,
        error: null,
      }),
    ).toBe(false);
    expect(
      isVerifying({
        phase: "downloading",
        loaded: 500,
        total: 0,
        wordnetVersion: null,
        sizeBytes: null,
        error: null,
      }),
    ).toBe(false);
  });
});

describe("downloadPercent", () => {
  it("computes a clamped percentage", () => {
    expect(
      downloadPercent({
        phase: "downloading",
        loaded: 512,
        total: 1024,
        wordnetVersion: null,
        sizeBytes: null,
        error: null,
      }),
    ).toBe(50);
  });

  it("is null when total is unknown or not downloading", () => {
    expect(
      downloadPercent({
        phase: "downloading",
        loaded: 512,
        total: 0,
        wordnetVersion: null,
        sizeBytes: null,
        error: null,
      }),
    ).toBeNull();
    expect(downloadPercent(initialDictionaryState())).toBeNull();
  });
});
