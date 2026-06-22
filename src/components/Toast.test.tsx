// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { renderToString } from "react-dom/server";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { ToastProvider, ToastContainer, useToast, TOAST_AUTO_DISMISS_MS } from "./Toast";

describe("Toast System", () => {
  it("ToastProvider renders children", () => {
    const html = renderToString(
      <ToastProvider>
        <div>child</div>
      </ToastProvider>
    );
    expect(html).toContain("child");
  });

  it("ToastContainer renders with correct role", () => {
    const html = renderToString(
      <ToastProvider>
        <ToastContainer />
      </ToastProvider>
    );
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="status"');
  });

  it("ToastContainer renders at bottom-center position", () => {
    const html = renderToString(
      <ToastProvider>
        <ToastContainer />
      </ToastProvider>
    );
    expect(html).toContain("fixed");
    expect(html).toContain("bottom");
  });

  it("auto-dismisses transient toasts after the documented interval", () => {
    expect(TOAST_AUTO_DISMISS_MS).toBe(4000);
  });
});

describe("Toast undo action", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  function UndoTrigger({
    onUndo,
    onTimeout,
    durationMs,
  }: {
    onUndo: () => void;
    onTimeout: () => void;
    durationMs?: number;
  }) {
    const { addToast } = useToast();
    return (
      <button
        onClick={() =>
          addToast("Book removed", "info", {
            durationMs,
            action: { label: "Undo", onClick: onUndo },
            onTimeout,
          })
        }
      >
        trigger
      </button>
    );
  }

  it("clicking Undo runs the undo callback and cancels the timeout", () => {
    const onUndo = vi.fn();
    const onTimeout = vi.fn();
    render(
      <ToastProvider>
        <UndoTrigger onUndo={onUndo} onTimeout={onTimeout} durationMs={5000} />
      </ToastProvider>
    );

    act(() => fireEvent.click(screen.getByText("trigger")));
    expect(screen.getByText("Book removed")).toBeInTheDocument();

    act(() => fireEvent.click(screen.getByText("Undo")));
    expect(onUndo).toHaveBeenCalledTimes(1);

    // Even after the full window elapses, the commit (onTimeout) must NOT fire.
    act(() => vi.advanceTimersByTime(6000));
    expect(onTimeout).not.toHaveBeenCalled();
    expect(screen.queryByText("Book removed")).not.toBeInTheDocument();
  });

  it("lets the timeout (commit) fire when the window elapses without undo", () => {
    const onUndo = vi.fn();
    const onTimeout = vi.fn();
    render(
      <ToastProvider>
        <UndoTrigger onUndo={onUndo} onTimeout={onTimeout} durationMs={5000} />
      </ToastProvider>
    );

    act(() => fireEvent.click(screen.getByText("trigger")));
    act(() => vi.advanceTimersByTime(5000));

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onUndo).not.toHaveBeenCalled();
    expect(screen.queryByText("Book removed")).not.toBeInTheDocument();
  });

  it("manual dismiss commits (runs onTimeout) rather than cancelling", () => {
    const onUndo = vi.fn();
    const onTimeout = vi.fn();
    render(
      <ToastProvider>
        <UndoTrigger onUndo={onUndo} onTimeout={onTimeout} durationMs={5000} />
      </ToastProvider>
    );

    act(() => fireEvent.click(screen.getByText("trigger")));
    act(() => fireEvent.click(screen.getByLabelText("Dismiss")));

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onUndo).not.toHaveBeenCalled();
  });
});
