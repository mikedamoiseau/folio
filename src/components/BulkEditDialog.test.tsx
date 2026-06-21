// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { renderToString } from "react-dom/server";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));

import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import BulkEditDialog from "./BulkEditDialog";

const mockBooks = [
  { id: "1", title: "A", author: "Same Author", cover_path: null, total_chapters: 1, added_at: 0, format: "epub" as const, series: "S1", volume: null, rating: null, language: "en", publish_year: 2020, is_imported: true },
  { id: "2", title: "B", author: "Same Author", cover_path: null, total_chapters: 1, added_at: 0, format: "epub" as const, series: "S2", volume: null, rating: null, language: "en", publish_year: 2020, is_imported: true },
];

beforeEach(() => invoke.mockReset());
afterEach(() => cleanup());

describe("BulkEditDialog (SSR contract)", () => {
  it("shows shared values pre-filled", () => {
    const html = renderToString(
      <BulkEditDialog bookIds={["1", "2"]} books={mockBooks} onClose={() => {}} onSave={() => {}} />
    );
    expect(html).toContain('value="Same Author"');
    expect(html).toContain('value="en"');
    expect(html).toContain('value="2020"');
  });

  it("shows mixed placeholder when values differ", () => {
    const html = renderToString(
      <BulkEditDialog bookIds={["1", "2"]} books={mockBooks} onClose={() => {}} onSave={() => {}} />
    );
    expect(html).toContain("bulkEdit.multipleValues");
  });

  it("shows book count in title", () => {
    const html = renderToString(
      <BulkEditDialog bookIds={["1", "2"]} books={mockBooks} onClose={() => {}} onSave={() => {}} />
    );
    expect(html).toContain("2");
  });
});

describe("BulkEditDialog per-field opt-in", () => {
  function setup() {
    const onClose = vi.fn();
    const onSave = vi.fn();
    invoke.mockResolvedValue(2);
    render(<BulkEditDialog bookIds={["1", "2"]} books={mockBooks} onClose={onClose} onSave={onSave} />);
    return { onClose, onSave };
  }

  it("renders a warning banner because some fields have different values", () => {
    setup();
    expect(screen.getByText(/bulkEdit\.mixedBanner/)).toBeInTheDocument();
  });

  it("saves NOTHING and just closes when no field is enabled", async () => {
    const { onClose } = setup();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "common.save" })));
    expect(invoke).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("only sends fields whose checkbox is enabled", async () => {
    const { onSave } = setup();
    // enable the Author field via its checkbox
    const authorCheckbox = screen.getByRole("checkbox", { name: /bulkEdit\.author/ });
    await act(async () => fireEvent.click(authorCheckbox));

    const authorInput = screen.getByLabelText("bulkEdit.author") as HTMLInputElement;
    expect(authorInput).not.toBeDisabled();
    await act(async () => fireEvent.change(authorInput, { target: { value: "New Author" } }));

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "common.save" })));
    expect(invoke).toHaveBeenCalledWith("bulk_update_metadata", {
      bookIds: ["1", "2"],
      fields: { author: "New Author" },
    });
    expect(onSave).toHaveBeenCalledWith(2);
  });

  it("keeps inputs disabled until their checkbox is checked", () => {
    setup();
    expect(screen.getByLabelText("bulkEdit.author")).toBeDisabled();
    expect(screen.getByLabelText("bulkEdit.series")).toBeDisabled();
  });

  it("flags an enabled mixed field as overwriting all selected books", async () => {
    setup();
    // series differs (S1 vs S2) -> enabling it should warn about overwrite
    const seriesCheckbox = screen.getByRole("checkbox", { name: /bulkEdit\.series/ });
    await act(async () => fireEvent.click(seriesCheckbox));
    expect(screen.getByText(/bulkEdit\.overwriteWarning/)).toBeInTheDocument();
  });
});
