// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";

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

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import PrivateModeToggle from "../PrivateModeToggle";

beforeEach(() => {
  invoke.mockReset();
  emittedListener = null;
});
afterEach(() => cleanup());

describe("PrivateModeToggle", () => {
  it("shows the off-state button and no indicator badge when tracking is on", async () => {
    invoke.mockResolvedValue(false);
    render(<PrivateModeToggle />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_private_mode"));
    expect(screen.queryByText("privateMode.indicatorBadge")).not.toBeInTheDocument();
  });

  it("shows the persistent indicator badge once private mode is on", async () => {
    invoke.mockResolvedValue(true);
    render(<PrivateModeToggle />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_private_mode"));
    expect(await screen.findByText("privateMode.indicatorBadge")).toBeInTheDocument();
  });

  it("opens an info popover enumerating what pauses and what still saves", async () => {
    invoke.mockResolvedValue(false);
    render(<PrivateModeToggle />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_private_mode"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "privateMode.buttonLabel" }));
    });

    const dialog = screen.getByRole("dialog", { name: "privateMode.title" });
    expect(dialog).toBeInTheDocument();
    // Stop list (Decision 6)
    expect(screen.getByText("privateMode.stopProgress")).toBeInTheDocument();
    expect(screen.getByText("privateMode.stopStats")).toBeInTheDocument();
    expect(screen.getByText("privateMode.stopRecent")).toBeInTheDocument();
    expect(screen.getByText("privateMode.stopActivity")).toBeInTheDocument();
    // Continue list (Decision 6)
    expect(screen.getByText("privateMode.continueHighlights")).toBeInTheDocument();
    expect(screen.getByText("privateMode.continueLibrary")).toBeInTheDocument();
  });

  it("the popover's switch calls set_private_mode to turn tracking off", async () => {
    invoke.mockResolvedValue(false);
    render(<PrivateModeToggle />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_private_mode"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "privateMode.buttonLabel" }));
    });

    invoke.mockResolvedValue(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("switch"));
    });
    expect(invoke).toHaveBeenCalledWith("set_private_mode", { enabled: true });
  });

  it("reflects a private-mode-changed event fired by another window/instance", async () => {
    invoke.mockResolvedValue(false);
    render(<PrivateModeToggle />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_private_mode"));
    expect(screen.queryByText("privateMode.indicatorBadge")).not.toBeInTheDocument();

    act(() => {
      emittedListener?.({ payload: true });
    });
    expect(await screen.findByText("privateMode.indicatorBadge")).toBeInTheDocument();
  });
});
