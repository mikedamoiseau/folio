// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useUndoableRemoval, UNDO_WINDOW_MS } from "./useUndoableRemoval";
import type { ToastOptions } from "../components/Toast";

afterEach(() => cleanup());

/**
 * Fake addToast that captures the options so the test can drive the
 * timeout / undo paths directly, isolating the hook from real timers.
 */
function makeFakeToast() {
  const captured: { message: string; options?: ToastOptions }[] = [];
  const addToast = (message: string, _type?: string, options?: ToastOptions) => {
    captured.push({ message, options });
  };
  return { addToast: addToast as never, captured };
}

describe("useUndoableRemoval", () => {
  it("optimistically marks ids pending and uses the default 5s window", () => {
    const { addToast, captured } = makeFakeToast();
    const { result } = renderHook(() => useUndoableRemoval(addToast));

    act(() => {
      result.current.remove(["a", "b"], {
        message: "removed",
        undoLabel: "Undo",
        commit: vi.fn().mockResolvedValue(undefined),
      });
    });

    expect(result.current.pendingIds.has("a")).toBe(true);
    expect(result.current.pendingIds.has("b")).toBe(true);
    expect(captured[0].options?.durationMs).toBe(UNDO_WINDOW_MS);
    expect(UNDO_WINDOW_MS).toBe(5000);
  });

  it("commits (calls backend) and clears pending when the window elapses", async () => {
    const { addToast, captured } = makeFakeToast();
    const commit = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useUndoableRemoval(addToast));

    act(() => {
      result.current.remove(["a"], { message: "removed", undoLabel: "Undo", commit });
    });

    await act(async () => {
      await captured[0].options?.onTimeout?.();
    });

    expect(commit).toHaveBeenCalledTimes(1);
    expect(result.current.pendingIds.has("a")).toBe(false);
  });

  it("cancels the commit and restores when undo is clicked", async () => {
    const { addToast, captured } = makeFakeToast();
    const commit = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useUndoableRemoval(addToast));

    act(() => {
      result.current.remove(["a"], { message: "removed", undoLabel: "Undo", commit });
    });

    act(() => {
      captured[0].options?.action?.onClick();
    });

    // Undo restores immediately.
    expect(result.current.pendingIds.has("a")).toBe(false);

    // A late timeout must not double-commit.
    await act(async () => {
      await captured[0].options?.onTimeout?.();
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it("reverts the optimistic removal and reports the error when commit fails", async () => {
    const { addToast, captured } = makeFakeToast();
    const err = new Error("boom");
    const commit = vi.fn().mockRejectedValue(err);
    const onError = vi.fn();
    const { result } = renderHook(() => useUndoableRemoval(addToast));

    act(() => {
      result.current.remove(["a"], { message: "removed", undoLabel: "Undo", commit, onError });
    });

    await act(async () => {
      await captured[0].options?.onTimeout?.();
    });

    expect(commit).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(err);
    expect(result.current.pendingIds.has("a")).toBe(false);
  });
});
