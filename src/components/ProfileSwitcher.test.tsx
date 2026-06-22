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
import ProfileSwitcher from "./ProfileSwitcher";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "get_profiles")
      return Promise.resolve([
        { name: "default", is_active: true },
        { name: "work", is_active: false },
      ]);
    return Promise.resolve(undefined);
  });
});
afterEach(() => cleanup());

async function openDropdown() {
  render(<ProfileSwitcher onSwitch={() => {}} />);
  // wait for profiles to load, then open
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_profiles"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button"));
  });
}

describe("ProfileSwitcher delete confirmation", () => {
  it("does NOT delete immediately when the delete button is clicked — it asks first", async () => {
    await openDropdown();
    const delBtn = await screen.findByLabelText("profiles.deleteLabel:work");
    await act(async () => fireEvent.click(delBtn));

    // No delete_profile call yet — a confirm dialog must intervene.
    expect(invoke).not.toHaveBeenCalledWith("delete_profile", expect.anything());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("deletes only after the confirm dialog is accepted", async () => {
    await openDropdown();
    const delBtn = await screen.findByLabelText("profiles.deleteLabel:work");
    await act(async () => fireEvent.click(delBtn));

    const confirmBtn = screen.getByRole("button", { name: "profiles.deleteConfirm" });
    await act(async () => fireEvent.click(confirmBtn));

    expect(invoke).toHaveBeenCalledWith("delete_profile", { name: "work" });
  });

  it("does not render a delete control for the active profile", async () => {
    await openDropdown();
    // active profile is "default"; its delete label must be absent
    expect(screen.queryByLabelText("profiles.deleteLabel:default")).not.toBeInTheDocument();
  });
});

describe("ProfileSwitcher switching loading state", () => {
  it("shows a loading spinner on the row while switch_profile is in flight", async () => {
    // Hold switch_profile pending so the loading state stays visible.
    let resolveSwitch: () => void = () => {};
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_profiles")
        return Promise.resolve([
          { name: "default", is_active: true },
          { name: "work", is_active: false },
        ]);
      if (cmd === "switch_profile")
        return new Promise<void>((res) => {
          resolveSwitch = res;
        });
      return Promise.resolve(undefined);
    });

    await openDropdown();
    const workRow = screen.getByText("work").closest("div")!;
    await act(async () => fireEvent.click(workRow));

    // Spinner (role=status) appears while the switch is pending.
    const spinner = await screen.findByRole("status");
    expect(spinner).toBeInTheDocument();
    expect(spinner).toHaveAttribute("aria-label", "profiles.switching");

    // Resolve the switch; spinner goes away.
    await act(async () => {
      resolveSwitch();
    });
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });
});
