// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        "common.cancel": "Cancel",
        "common.delete": "Delete",
      };
      return map[key] ?? key;
    },
  }),
}));

vi.mock("../lib/useFocusTrap", () => ({
  useFocusTrap: () => ({ current: null }),
}));

import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import ConfirmDialog from "./ConfirmDialog";

afterEach(() => cleanup());

describe("ConfirmDialog", () => {
  it("renders title and message with dialog semantics", () => {
    render(
      <ConfirmDialog
        title="Delete profile?"
        message="This permanently removes the library."
        confirmLabel="Delete"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("Delete profile?")).toBeInTheDocument();
    expect(screen.getByText("This permanently removes the library.")).toBeInTheDocument();
  });

  it("fires onConfirm when the confirm button is clicked", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog title="t" confirmLabel="Delete" onConfirm={onConfirm} onCancel={onCancel} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("fires onCancel when the cancel button is clicked", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog title="t" confirmLabel="Delete" onConfirm={onConfirm} onCancel={onCancel} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("uses the default Delete/Cancel labels when none are given", () => {
    render(<ConfirmDialog title="t" onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });
});
