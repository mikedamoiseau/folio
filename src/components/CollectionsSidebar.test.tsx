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
    // The panel is a non-modal overlay: it floats over the grid at the wider
    // width rather than pushing it. The width tokens are the deliverable.
    const panel = document.querySelector("aside");
    expect(panel).not.toBeNull();
    expect(panel).toHaveClass("fixed", "w-[480px]", "max-w-[85vw]");
    expect(panel).not.toHaveClass("w-64");
  });

  it("dims the background without a scrim that blocks pointer events", () => {
    render(<CollectionsSidebar {...baseProps()} />);
    const scrim = document.querySelector("[aria-hidden='true'].fixed.inset-0");
    expect(scrim).not.toBeNull();
    expect(scrim).toHaveClass("pointer-events-none");
  });

  it("closes on an outside click and stops the click reaching the target", () => {
    const props = baseProps();
    render(<CollectionsSidebar {...props} />);

    const outsideBtn = document.createElement("button");
    const outsideClick = vi.fn();
    outsideBtn.addEventListener("click", outsideClick);
    document.body.appendChild(outsideBtn);

    fireEvent.click(outsideBtn);

    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(outsideClick).not.toHaveBeenCalled(); // capture-phase stopPropagation

    outsideBtn.remove();
  });

  it("keeps the panel open after a successful drop (suppressed trailing click)", async () => {
    const { startDrag } = await import("../lib/dragState");
    const props = baseProps();
    props.collections = [
      { id: "c1", name: "Manual", type: "manual", icon: "📗", color: "#4e7a8f", rules: [] },
    ];
    render(<CollectionsSidebar {...props} />);

    // Simulate a drag ending on the manual collection row.
    act(() => { startDrag("book-1"); });
    const row = screen.getByText("Manual");
    fireEvent.mouseUp(row);

    expect(props.onDropBook).toHaveBeenCalledWith("book-1", "c1");

    // The trailing body-targeted click must NOT close the panel.
    fireEvent.click(document.body);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("stays open when a book is dropped on an automated collection (no add)", async () => {
    const { startDrag } = await import("../lib/dragState");
    const props = baseProps();
    props.collections = [
      { id: "a1", name: "Auto", type: "automated", icon: "🤖", color: "#8f7a4e", rules: [] },
    ];
    render(<CollectionsSidebar {...props} />);

    act(() => { startDrag("book-1"); });
    fireEvent.mouseUp(screen.getByText("Auto"));

    // Automated collections can't accept a manual add, but the drop gesture
    // must not be read as a click-outside that closes the panel.
    expect(props.onDropBook).not.toHaveBeenCalled();
    fireEvent.click(document.body);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("does not reopen to a stale form after closing mid-edit", () => {
    const props = baseProps();
    const { rerender } = render(<CollectionsSidebar {...props} />);

    // Open the create form, then close the panel while it is still open.
    fireEvent.click(screen.getByText("collections.newCollection"));
    expect(document.querySelector("input")).not.toBeNull();
    rerender(<CollectionsSidebar {...props} open={false} />);

    // Reopen — should be back on the list (the "All Books" row), not the form.
    rerender(<CollectionsSidebar {...props} open={true} />);
    expect(screen.getByText("collections.allBooks")).toBeInTheDocument();
  });
});

function dataProps() {
  return {
    ...baseProps(),
    collections: [
      { id: "c1", name: "Sci-Fi", type: "manual", rules: [] },
      { id: "c2", name: "Fantasy", type: "manual", rules: [] },
    ] as Collection[],
    seriesList: [
      { name: "Dune", count: 6 },
      { name: "Foundation", count: 7 },
    ],
  };
}

describe("CollectionsSidebar filter", () => {
  it("narrows both the collections and series lists", () => {
    render(<CollectionsSidebar {...dataProps()} />);
    const input = screen.getByLabelText("collections.filterPlaceholder");
    fireEvent.change(input, { target: { value: "fantasy" } });
    expect(screen.getByText("Fantasy")).toBeInTheDocument();
    expect(screen.queryByText("Sci-Fi")).not.toBeInTheDocument();
    expect(screen.queryByText("Dune")).not.toBeInTheDocument();
    // A collection-only match hides the whole Series section — no orphan heading.
    expect(screen.queryByText("collections.series")).not.toBeInTheDocument();
  });

  it("filters case-insensitively by substring", () => {
    render(<CollectionsSidebar {...dataProps()} />);
    fireEvent.change(screen.getByLabelText("collections.filterPlaceholder"), { target: { value: "DUN" } });
    expect(screen.getByText("Dune")).toBeInTheDocument();
    expect(screen.queryByText("Foundation")).not.toBeInTheDocument();
  });

  it("treats a whitespace-only filter as inactive (hides nothing)", () => {
    render(<CollectionsSidebar {...dataProps()} />);
    fireEvent.change(screen.getByLabelText("collections.filterPlaceholder"), { target: { value: "   " } });
    expect(screen.getByText("Sci-Fi")).toBeInTheDocument();
    expect(screen.getByText("Fantasy")).toBeInTheDocument();
    expect(screen.getByText("Dune")).toBeInTheDocument();
  });

  it("clears the filter via the labelled clear button", () => {
    render(<CollectionsSidebar {...dataProps()} />);
    fireEvent.change(screen.getByLabelText("collections.filterPlaceholder"), { target: { value: "fantasy" } });
    expect(screen.queryByText("Sci-Fi")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("collections.clearFilter"));
    expect(screen.getByText("Sci-Fi")).toBeInTheDocument();
  });

  it("returns focus to the filter input after clearing", () => {
    render(<CollectionsSidebar {...dataProps()} />);
    const input = screen.getByLabelText("collections.filterPlaceholder");
    fireEvent.change(input, { target: { value: "fantasy" } });
    fireEvent.click(screen.getByLabelText("collections.clearFilter"));
    expect(input).toHaveFocus();
  });

  it("keeps All Books visible under an active filter", () => {
    render(<CollectionsSidebar {...dataProps()} />);
    fireEvent.change(screen.getByLabelText("collections.filterPlaceholder"), { target: { value: "zzzznomatch" } });
    expect(screen.getByText("collections.allBooks")).toBeInTheDocument();
  });

  it("resets the filter text after the panel closes and reopens", () => {
    const props = dataProps();
    const { rerender } = render(<CollectionsSidebar {...props} />);
    fireEvent.change(screen.getByLabelText("collections.filterPlaceholder"), { target: { value: "fantasy" } });
    rerender(<CollectionsSidebar {...props} open={false} />);
    rerender(<CollectionsSidebar {...props} open={true} />);
    expect(screen.getByLabelText("collections.filterPlaceholder")).toHaveValue("");
    expect(screen.getByText("Sci-Fi")).toBeInTheDocument();
  });
});
