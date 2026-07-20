// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const invoke = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import WantToReadToggle from "../WantToReadToggle";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});
afterEach(() => cleanup());

describe("WantToReadToggle", () => {
  it("calls onChange only after the command resolves", async () => {
    // Defer the invoke so we can observe the ordering: onChange must not fire
    // until the write commits (no optimistic flip).
    let resolveInvoke!: () => void;
    invoke.mockReturnValueOnce(
      new Promise<void>((res) => {
        resolveInvoke = () => res();
      }),
    );
    const onChange = vi.fn();
    render(<WantToReadToggle bookId="b1" value={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "library.wantToRead" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("set_want_to_read", { bookId: "b1", want: true }),
    );
    // Command in flight — the flag must not change yet.
    expect(onChange).not.toHaveBeenCalled();
    resolveInvoke();
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(true));
  });

  it("marks aria-disabled and drops a second click while a write is pending", async () => {
    // Keep the first invoke in flight so the button stays "pending".
    let resolveInvoke!: () => void;
    invoke.mockReturnValueOnce(
      new Promise<void>((res) => {
        resolveInvoke = () => res();
      }),
    );
    const onChange = vi.fn();
    render(<WantToReadToggle bookId="b1" value={false} onChange={onChange} />);
    const btn = screen.getByRole("button", { name: "library.wantToRead" });
    fireEvent.click(btn);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    // Pending: aria-disabled set, but the button is not natively disabled
    // (stays focusable / in tab order).
    expect(btn).toHaveAttribute("aria-disabled", "true");
    expect(btn).not.toBeDisabled();
    // A second click while pending must not fire another IPC call.
    fireEvent.click(btn);
    expect(invoke).toHaveBeenCalledTimes(1);
    resolveInvoke();
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  });

  it("keeps DOM focus on the button while a write is pending", async () => {
    // aria-disabled (not native `disabled`) must keep the button focusable:
    // native disable blurs focus to <body> and never restores it.
    let resolveInvoke!: () => void;
    invoke.mockReturnValueOnce(
      new Promise<void>((res) => {
        resolveInvoke = () => res();
      }),
    );
    const onChange = vi.fn();
    render(<WantToReadToggle bookId="b1" value={false} onChange={onChange} />);
    const btn = screen.getByRole("button", { name: "library.wantToRead" });
    btn.focus();
    expect(btn).toHaveFocus();
    fireEvent.click(btn);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    // Pending: focus must remain on the button.
    expect(btn).toHaveAttribute("aria-disabled", "true");
    expect(document.activeElement).toBe(btn);
    expect(btn).toHaveFocus();
    resolveInvoke();
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  });

  it("on failure, does not change the flag and calls onError", async () => {
    invoke.mockRejectedValueOnce(new Error("nope"));
    const onChange = vi.fn();
    const onError = vi.fn();
    render(
      <WantToReadToggle bookId="b1" value={false} onChange={onChange} onError={onError} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "library.wantToRead" }));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });
});
