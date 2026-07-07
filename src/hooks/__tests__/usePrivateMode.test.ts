// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const invoke = vi.fn();
let emittedListener: ((event: { payload: boolean }) => void) | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_name: string, cb: (event: { payload: boolean }) => void) => {
    emittedListener = cb;
    return Promise.resolve(() => {});
  }),
}));

import { usePrivateMode } from "../usePrivateMode";
import {
  setVolatilePosition,
  getVolatilePosition,
  clearAllVolatilePositions,
} from "../../lib/volatileResume";

beforeEach(() => {
  invoke.mockReset();
  emittedListener = null;
  clearAllVolatilePositions();
});

describe("usePrivateMode", () => {
  it("reflects the backend state on mount via get_private_mode", async () => {
    invoke.mockResolvedValue(true);
    const { result } = renderHook(() => usePrivateMode());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(invoke).toHaveBeenCalledWith("get_private_mode");
    expect(result.current.enabled).toBe(true);
  });

  it("defaults to off if the initial read fails", async () => {
    invoke.mockRejectedValue(new Error("no backend"));
    const { result } = renderHook(() => usePrivateMode());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.enabled).toBe(false);
  });

  it("toggle() calls set_private_mode with the flipped value", async () => {
    invoke.mockResolvedValue(false);
    const { result } = renderHook(() => usePrivateMode());
    await waitFor(() => expect(result.current.loading).toBe(false));

    invoke.mockResolvedValue(true);
    await act(async () => {
      await result.current.toggle();
    });
    expect(invoke).toHaveBeenCalledWith("set_private_mode", { enabled: true });
  });

  it("updates enabled when the private-mode-changed event fires (not optimistically from toggle)", async () => {
    invoke.mockResolvedValue(false);
    const { result } = renderHook(() => usePrivateMode());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.enabled).toBe(false);

    act(() => {
      emittedListener?.({ payload: true });
    });
    expect(result.current.enabled).toBe(true);
  });

  it("clears volatile in-session resume positions the instant the event reports mode turning off", async () => {
    invoke.mockResolvedValue(true);
    const { result } = renderHook(() => usePrivateMode());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.enabled).toBe(true);

    setVolatilePosition("book-1", { chapterIndex: 4, scrollPosition: 0.5 });
    expect(getVolatilePosition("book-1")).toBeDefined();

    act(() => {
      emittedListener?.({ payload: false });
    });

    expect(result.current.enabled).toBe(false);
    expect(getVolatilePosition("book-1")).toBeUndefined();
  });

  it("does not clear volatile positions when the event reports mode staying on or turning on", async () => {
    invoke.mockResolvedValue(false);
    const { result } = renderHook(() => usePrivateMode());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      emittedListener?.({ payload: true });
    });
    setVolatilePosition("book-1", { chapterIndex: 4, scrollPosition: 0.5 });

    act(() => {
      emittedListener?.({ payload: true });
    });
    expect(getVolatilePosition("book-1")).toBeDefined();
  });
});
