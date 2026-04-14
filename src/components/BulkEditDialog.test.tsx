import { describe, it, expect, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));

import BulkEditDialog from "./BulkEditDialog";

const mockBooks = [
  { id: "1", title: "A", author: "Same Author", cover_path: null, total_chapters: 1, added_at: 0, format: "epub" as const, series: "S1", volume: null, rating: null, language: "en", publish_year: 2020, is_imported: true },
  { id: "2", title: "B", author: "Same Author", cover_path: null, total_chapters: 1, added_at: 0, format: "epub" as const, series: "S2", volume: null, rating: null, language: "en", publish_year: 2020, is_imported: true },
];

describe("BulkEditDialog", () => {
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
