// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, p?: Record<string, unknown> | string) =>
      typeof p === "string" ? p : k,
  }),
}));

import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import CollectionsSidebar, { type Collection } from "./CollectionsSidebar";

const SUGGESTIONS = [
  { name: "EPUB Books", icon: "📚", color: "#4e7a8f", rules: [{ field: "format", operator: "equals", value: "epub" }], matchedBookCount: 48, heuristicType: "format" },
  { name: "CBZ Books", icon: "📚", color: "#8f7a4e", rules: [{ field: "format", operator: "equals", value: "cbz" }], matchedBookCount: 627, heuristicType: "format" },
];

function baseProps() {
  return {
    open: true,
    collections: [] as Collection[],
    activeCollectionId: null,
    activeSeries: null,
    seriesList: [],
    onClose: vi.fn(),
    onSelect: vi.fn(),
    onSelectSeries: vi.fn(),
    onCreate: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onDropBook: vi.fn(),
  };
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "get_collection_suggestions") return Promise.resolve(SUGGESTIONS);
    return Promise.resolve(undefined);
  });
});
afterEach(() => cleanup());

async function clickSuggest() {
  const btn = screen.getByText("Suggest Collections");
  await act(async () => { fireEvent.click(btn); });
  await waitFor(() => expect(screen.getByText("EPUB Books")).toBeInTheDocument());
}

describe("CollectionsSidebar suggestions", () => {
  it("does not show stale suggestions after the sidebar is closed and reopened", async () => {
    const props = baseProps();
    const { rerender } = render(<CollectionsSidebar {...props} />);
    await clickSuggest();

    // Close (parent sets open=false — component instance stays mounted).
    rerender(<CollectionsSidebar {...props} open={false} />);
    // Reopen.
    rerender(<CollectionsSidebar {...props} open={true} />);

    expect(screen.queryByText("EPUB Books")).not.toBeInTheDocument();
  });

  it("dismisses the whole suggestions panel in one action", async () => {
    render(<CollectionsSidebar {...baseProps()} />);
    await clickSuggest();

    const closeAll = screen.getByLabelText("Dismiss suggestions");
    await act(async () => { fireEvent.click(closeAll); });

    expect(screen.queryByText("EPUB Books")).not.toBeInTheDocument();
    expect(screen.queryByText("CBZ Books")).not.toBeInTheDocument();
  });
});

describe("CollectionsSidebar overlay", () => {
  it("overlays at min(480px, 85vw) instead of the old narrow width", () => {
    render(<CollectionsSidebar {...baseProps()} />);
    // Pure styling milestone: the width tokens are the deliverable. Dialog/
    // modal semantics (role, aria-modal, focus trap, scrim) land in M2.
    const panel = document.querySelector("aside");
    expect(panel).not.toBeNull();
    expect(panel).toHaveClass("fixed", "w-[480px]", "max-w-[85vw]");
    expect(panel).not.toHaveClass("w-64");
  });
});
