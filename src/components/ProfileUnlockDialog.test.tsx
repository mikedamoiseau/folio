// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) =>
      opts?.name ? `${key}:${opts.name}` : key,
  }),
}));
vi.mock("../lib/useFocusTrap", () => ({ useFocusTrap: () => ({ current: null }) }));

import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import ProfileUnlockDialog from "./ProfileUnlockDialog";

beforeEach(() => invoke.mockReset());
afterEach(() => cleanup());

describe("ProfileUnlockDialog unlock flow", () => {
  it("shows a pending/spinner state while unlock_profile is in flight", async () => {
    let resolveUnlock: () => void = () => {};
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "unlock_profile") {
        return new Promise<void>((res) => { resolveUnlock = res; });
      }
      return Promise.resolve(undefined);
    });
    const onUnlocked = vi.fn();
    render(<ProfileUnlockDialog profile="work" onUnlocked={onUnlocked} onCancel={() => {}} />);

    fireEvent.change(screen.getByLabelText("profiles.unlockPasswordLabel"), {
      target: { value: "hunter2" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /profiles.unlock/ }));
    });

    const spinner = await screen.findByRole("status");
    expect(spinner).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("unlock_profile", { profile: "work", password: "hunter2" });
    expect(onUnlocked).not.toHaveBeenCalled();

    await act(async () => { resolveUnlock(); });
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
  });

  it("shows a clear inline error on the wrong password and does not call onUnlocked", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "unlock_profile") {
        return Promise.reject({ kind: "InvalidInput", message: "Incorrect password" });
      }
      return Promise.resolve(undefined);
    });
    const onUnlocked = vi.fn();
    render(<ProfileUnlockDialog profile="work" onUnlocked={onUnlocked} onCancel={() => {}} />);

    fireEvent.change(screen.getByLabelText("profiles.unlockPasswordLabel"), {
      target: { value: "wrong" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /profiles.unlock/ }));
    });

    expect(await screen.findByText("errors.incorrectPassword")).toBeInTheDocument();
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it("calls onCancel when the cancel button is clicked", async () => {
    const onCancel = vi.fn();
    render(<ProfileUnlockDialog profile="work" onUnlocked={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("renders no cancel button when onCancel is omitted (startup gate)", () => {
    render(<ProfileUnlockDialog profile="default" onUnlocked={() => {}} />);
    expect(screen.queryByRole("button", { name: "common.cancel" })).not.toBeInTheDocument();
  });
});

describe("ProfileUnlockDialog recovery flow", () => {
  it("does NOT reset the lock immediately — it requires the deliberate confirm step", async () => {
    render(<ProfileUnlockDialog profile="work" onUnlocked={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByText("profiles.cantSignIn"));

    expect(invoke).not.toHaveBeenCalledWith("reset_profile_lock", expect.anything());
    expect(screen.getByText("profiles.recoveryTitle")).toBeInTheDocument();
    expect(screen.getByText("profiles.recoveryMessage")).toBeInTheDocument();
  });

  it("resets the lock and calls onUnlocked after the confirm step is accepted", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "reset_profile_lock") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });
    const onUnlocked = vi.fn();
    render(<ProfileUnlockDialog profile="work" onUnlocked={onUnlocked} onCancel={() => {}} />);

    fireEvent.click(screen.getByText("profiles.cantSignIn"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "profiles.recoveryConfirm" }));
    });

    expect(invoke).toHaveBeenCalledWith("reset_profile_lock", { profile: "work" });
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
  });

  it("cancelling the recovery step returns to the password form without resetting", () => {
    render(<ProfileUnlockDialog profile="work" onUnlocked={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByText("profiles.cantSignIn"));
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));

    expect(screen.getByLabelText("profiles.unlockPasswordLabel")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("reset_profile_lock", expect.anything());
  });
});
