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

describe("CollectionsSidebar collapse", () => {
  it("collapses and expands the Collections section via its header", () => {
    render(<CollectionsSidebar {...dataProps()} />);
    const header = screen.getByRole("button", { name: "collections.collections" });
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Sci-Fi")).toBeInTheDocument();
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Sci-Fi")).not.toBeInTheDocument();
    fireEvent.click(header);
    expect(screen.getByText("Sci-Fi")).toBeInTheDocument();
  });

  it("collapses the Series section independently of Collections", () => {
    render(<CollectionsSidebar {...dataProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "collections.series" }));
    expect(screen.queryByText("Dune")).not.toBeInTheDocument();
    expect(screen.getByText("Sci-Fi")).toBeInTheDocument(); // collections untouched
  });

  it("keeps aria-controls pointing at a mounted container while collapsed", () => {
    render(<CollectionsSidebar {...dataProps()} />);
    const header = screen.getByRole("button", { name: "collections.collections" });
    const id = header.getAttribute("aria-controls")!;
    fireEvent.click(header); // collapse
    expect(document.getElementById(id)).toBeInTheDocument();
  });

  it("an active filter temporarily expands a manually-collapsed matching section", () => {
    render(<CollectionsSidebar {...dataProps()} />);
    const header = screen.getByRole("button", { name: "collections.collections" });
    fireEvent.click(header); // collapse Collections
    expect(screen.queryByText("Sci-Fi")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("collections.filterPlaceholder"), { target: { value: "sci" } });
    expect(screen.getByText("Sci-Fi")).toBeInTheDocument();       // auto-expanded
    expect(header).toHaveAttribute("aria-expanded", "true");
    fireEvent.change(screen.getByLabelText("collections.filterPlaceholder"), { target: { value: "" } });
    expect(screen.queryByText("Sci-Fi")).not.toBeInTheDocument(); // re-collapsed
  });

  it("shows the no-matches line for a non-empty section with zero matches", () => {
    render(<CollectionsSidebar {...dataProps()} />);
    fireEvent.change(screen.getByLabelText("collections.filterPlaceholder"), { target: { value: "dune" } });
    // Series matches "Dune"; Collections has zero matches -> no-matches line shown.
    expect(screen.getByText("collections.noMatches")).toBeInTheDocument();
    expect(screen.getByText("Dune")).toBeInTheDocument();
  });

  it("hides section headers for empty source lists", () => {
    render(<CollectionsSidebar {...baseProps()} />); // no collections, no series
    expect(screen.queryByRole("button", { name: "collections.collections" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "collections.series" })).not.toBeInTheDocument();
  });

  it("resets collapse state after close and reopen", () => {
    const props = dataProps();
    const { rerender } = render(<CollectionsSidebar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "collections.collections" }));
    expect(screen.queryByText("Sci-Fi")).not.toBeInTheDocument();
    rerender(<CollectionsSidebar {...props} open={false} />);
    rerender(<CollectionsSidebar {...props} open={true} />);
    expect(screen.getByText("Sci-Fi")).toBeInTheDocument(); // expanded again
  });

  it("re-expands the Series section after a second header click", () => {
    render(<CollectionsSidebar {...dataProps()} />);
    const header = screen.getByRole("button", { name: "collections.series" });
    fireEvent.click(header); // collapse
    expect(screen.queryByText("Dune")).not.toBeInTheDocument();
    fireEvent.click(header); // expand
    expect(screen.getByText("Dune")).toBeInTheDocument();
    expect(header).toHaveAttribute("aria-expanded", "true");
  });

  it("leaves a manually-collapsed section collapsed under a whitespace-only filter", () => {
    render(<CollectionsSidebar {...dataProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "collections.collections" })); // collapse
    fireEvent.change(screen.getByLabelText("collections.filterPlaceholder"), { target: { value: "   " } });
    expect(screen.queryByText("Sci-Fi")).not.toBeInTheDocument(); // still collapsed (filter inactive)
  });

  it("clear button restores manual collapse state after a filter auto-expanded a section", () => {
    render(<CollectionsSidebar {...dataProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "collections.collections" })); // collapse
    fireEvent.change(screen.getByLabelText("collections.filterPlaceholder"), { target: { value: "sci" } });
    expect(screen.getByText("Sci-Fi")).toBeInTheDocument(); // auto-expanded
    fireEvent.click(screen.getByLabelText("collections.clearFilter"));
    expect(screen.queryByText("Sci-Fi")).not.toBeInTheDocument(); // manual collapse restored
  });

  it("marks the section-header chevron aria-hidden", () => {
    render(<CollectionsSidebar {...dataProps()} />);
    const header = screen.getByRole("button", { name: "collections.collections" });
    expect(header.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("renders the filter input outside the scrolling nav", () => {
    render(<CollectionsSidebar {...dataProps()} />);
    const input = screen.getByLabelText("collections.filterPlaceholder");
    const nav = document.querySelector("[aria-label='collections.title']");
    expect(nav).toBeInTheDocument();
    expect(nav!.contains(input)).toBe(false);
  });

  it("owns dividers per section presence", () => {
    // Scope to <nav>: the footer and suggestion blocks also use border-t, but only
    // section dividers live inside the nav.
    const navDividers = () =>
      document.querySelector("[aria-label='collections.title']")!
        .querySelectorAll(".border-t.border-warm-border").length;
    // Every rendered section owns a top divider (All Books always precedes it).
    const { rerender } = render(<CollectionsSidebar {...dataProps()} />);
    expect(navDividers()).toBe(2);
    rerender(<CollectionsSidebar {...dataProps()} seriesList={[]} />);
    expect(navDividers()).toBe(1);
    // Series-only: the Series section still gets its divider under All Books.
    rerender(<CollectionsSidebar {...dataProps()} collections={[]} />);
    expect(navDividers()).toBe(1);
  });

  it("does not fire selection callbacks when the active row is filtered out of view", () => {
    const props = dataProps();
    render(<CollectionsSidebar {...props} activeCollectionId="c1" activeSeries="Dune" />);
    fireEvent.change(screen.getByLabelText("collections.filterPlaceholder"), { target: { value: "fantasy" } });
    expect(screen.queryByText("Sci-Fi")).not.toBeInTheDocument();
    expect(screen.queryByText("Dune")).not.toBeInTheDocument();
    expect(screen.getByText("Fantasy")).toBeInTheDocument(); // no crash
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onSelectSeries).not.toHaveBeenCalled();
  });

  it("ignores a header toggle while a filter is active, preserving the collapse choice", () => {
    render(<CollectionsSidebar {...dataProps()} />);
    const header = screen.getByRole("button", { name: "collections.collections" });
    fireEvent.click(header); // manually collapse Collections
    fireEvent.change(screen.getByLabelText("collections.filterPlaceholder"), { target: { value: "sci" } });
    expect(screen.getByText("Sci-Fi")).toBeInTheDocument(); // filter force-expands (has a match)
    fireEvent.click(header); // click during filter must NOT flip the saved collapse
    fireEvent.change(screen.getByLabelText("collections.filterPlaceholder"), { target: { value: "" } });
    expect(screen.queryByText("Sci-Fi")).not.toBeInTheDocument(); // still collapsed after clearing
  });

  it("disables the section headers while a filter is active", () => {
    render(<CollectionsSidebar {...dataProps()} />);
    const header = screen.getByRole("button", { name: "collections.collections" });
    expect(header).toBeEnabled();
    fireEvent.change(screen.getByLabelText("collections.filterPlaceholder"), { target: { value: "sci" } });
    expect(header).toBeDisabled();
  });

  it("leaves a manually-collapsed section collapsed when the filter matches nothing in it", () => {
    render(<CollectionsSidebar {...dataProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "collections.collections" })); // collapse Collections
    // "dune" matches a series but no collection: the collapsed Collections section
    // must stay collapsed rather than pop open just to show a no-matches line.
    fireEvent.change(screen.getByLabelText("collections.filterPlaceholder"), { target: { value: "dune" } });
    expect(screen.getByText("Dune")).toBeInTheDocument();
    expect(screen.queryByText("collections.noMatches")).not.toBeInTheDocument();
    expect(screen.queryByText("Sci-Fi")).not.toBeInTheDocument();
  });

  it("shows a no-matches line in every expanded section when nothing matches", () => {
    render(<CollectionsSidebar {...dataProps()} />);
    fireEvent.change(screen.getByLabelText("collections.filterPlaceholder"), { target: { value: "zzzznomatch" } });
    expect(screen.getAllByText("collections.noMatches")).toHaveLength(2);
  });

  it("keeps the Series aria-controls container mounted while collapsed", () => {
    render(<CollectionsSidebar {...dataProps()} />);
    const header = screen.getByRole("button", { name: "collections.series" });
    const id = header.getAttribute("aria-controls")!;
    fireEvent.click(header); // collapse
    expect(document.getElementById(id)).toBeInTheDocument();
  });

  it("auto-expands a collapsed Series section that matches, then re-collapses on clear", () => {
    render(<CollectionsSidebar {...dataProps()} />);
    const header = screen.getByRole("button", { name: "collections.series" });
    fireEvent.click(header); // collapse Series
    expect(screen.queryByText("Dune")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("collections.filterPlaceholder"), { target: { value: "dune" } });
    expect(screen.getByText("Dune")).toBeInTheDocument();
    expect(header).toHaveAttribute("aria-expanded", "true");
    fireEvent.change(screen.getByLabelText("collections.filterPlaceholder"), { target: { value: "" } });
    expect(screen.queryByText("Dune")).not.toBeInTheDocument();
  });

  it("resets a collapsed Series section after close and reopen", () => {
    const props = dataProps();
    const { rerender } = render(<CollectionsSidebar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "collections.series" }));
    expect(screen.queryByText("Dune")).not.toBeInTheDocument();
    rerender(<CollectionsSidebar {...props} open={false} />);
    rerender(<CollectionsSidebar {...props} open={true} />);
    expect(screen.getByText("Dune")).toBeInTheDocument();
  });
});
