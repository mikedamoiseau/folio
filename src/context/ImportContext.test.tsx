// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

const invoke = vi.fn();
let progressHandler: ((e: { payload: Record<string, unknown> }) => void) | null = null;
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, cb: (e: { payload: Record<string, unknown> }) => void) => {
    progressHandler = cb;
    return Promise.resolve(() => {});
  },
}));

import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { ImportProvider, useImport } from "./ImportContext";

function emit(payload: Record<string, unknown>) {
  act(() => {
    progressHandler?.({ payload: { current: 0, total: 0, filename: "", imported: 0, duplicates: 0, errors: 0, ...payload } });
  });
}

function Harness() {
  const { progress, retry, dismiss, startFolder } = useImport();
  return (
    <div>
      <span data-testid="phase">{progress?.phase ?? "none"}</span>
      <button onClick={() => void startFolder("/books")}>start</button>
      <button onClick={() => void retry()}>retry</button>
      <button onClick={() => dismiss()}>dismiss</button>
    </div>
  );
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  progressHandler = null;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("ImportContext error handling", () => {
  it("persists the error phase instead of auto-clearing after 4s", async () => {
    render(<ImportProvider><Harness /></ImportProvider>);
    emit({ phase: "error", filename: "IO: permission denied" });
    expect(screen.getByTestId("phase")).toHaveTextContent("error");

    act(() => vi.advanceTimersByTime(5000));
    // still visible — error must not vanish like the 4s done/empty toast
    expect(screen.getByTestId("phase")).toHaveTextContent("error");
  });

  it("clears a non-error terminal phase after 4s", async () => {
    render(<ImportProvider><Harness /></ImportProvider>);
    emit({ phase: "done", imported: 3 });
    expect(screen.getByTestId("phase")).toHaveTextContent("done");
    act(() => vi.advanceTimersByTime(4000));
    expect(screen.getByTestId("phase")).toHaveTextContent("none");
  });

  it("dismiss() clears a persisted error", async () => {
    render(<ImportProvider><Harness /></ImportProvider>);
    emit({ phase: "error", filename: "boom" });
    await act(async () => fireEvent.click(screen.getByText("dismiss")));
    expect(screen.getByTestId("phase")).toHaveTextContent("none");
  });

  it("retry() re-runs the last folder import", async () => {
    render(<ImportProvider><Harness /></ImportProvider>);
    await act(async () => fireEvent.click(screen.getByText("start")));
    expect(invoke).toHaveBeenCalledWith("start_folder_import", { folderPath: "/books" });
    emit({ phase: "error", filename: "boom" });

    invoke.mockClear();
    await act(async () => fireEvent.click(screen.getByText("retry")));
    expect(invoke).toHaveBeenCalledWith("start_folder_import", { folderPath: "/books" });
  });
});
