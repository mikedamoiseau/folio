// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import OverflowMenu from "./OverflowMenu";

afterEach(() => cleanup());

describe("OverflowMenu", () => {
  it("hides its menu until the trigger is clicked", () => {
    render(
      <OverflowMenu label="More">
        <button>Item A</button>
      </OverflowMenu>
    );
    expect(screen.queryByText("Item A")).not.toBeInTheDocument();
    act(() => fireEvent.click(screen.getByRole("button", { name: "More" })));
    expect(screen.getByText("Item A")).toBeInTheDocument();
  });

  it("closes when an item inside is clicked", () => {
    const onClick = vi.fn();
    render(
      <OverflowMenu label="More">
        <button onClick={onClick}>Item A</button>
      </OverflowMenu>
    );
    act(() => fireEvent.click(screen.getByRole("button", { name: "More" })));
    act(() => fireEvent.click(screen.getByText("Item A")));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Item A")).not.toBeInTheDocument();
  });

  it("closes on Escape", () => {
    render(
      <OverflowMenu label="More">
        <button>Item A</button>
      </OverflowMenu>
    );
    act(() => fireEvent.click(screen.getByRole("button", { name: "More" })));
    expect(screen.getByText("Item A")).toBeInTheDocument();
    act(() => fireEvent.keyDown(document, { key: "Escape" }));
    expect(screen.queryByText("Item A")).not.toBeInTheDocument();
  });

  it("exposes the menu trigger with aria-haspopup and aria-expanded", () => {
    render(
      <OverflowMenu label="More">
        <button>Item A</button>
      </OverflowMenu>
    );
    const trigger = screen.getByRole("button", { name: "More" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    act(() => fireEvent.click(trigger));
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });
});
