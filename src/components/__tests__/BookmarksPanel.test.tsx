// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import en from "../../locales/en.json";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => {
      const parts = key.split(".");
      let val: unknown = en;
      for (const p of parts) val = (val as Record<string, unknown>)?.[p];
      let str = typeof val === "string" ? val : key;
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          str = str.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v));
        }
      }
      return str;
    },
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../../lib/useFocusTrap", () => ({
  useFocusTrap: () => ({ current: null }),
}));

import { render, screen, cleanup, waitFor } from "@testing-library/react";
import BookmarksPanel from "../BookmarksPanel";

afterEach(() => cleanup());

beforeEach(() => {
  vi.clearAllMocks();
});

const defaultProps = {
  bookId: "book-1",
  currentChapterIndex: 0,
  toc: [],
  onClose: vi.fn(),
  onNavigate: vi.fn(),
};

describe("BookmarksPanel", () => {
  it("renders an empty-state how-to CTA when there are no bookmarks", async () => {
    render(<BookmarksPanel {...defaultProps} />);
    await waitFor(() => {
      expect(
        screen.getByText(/while reading to add one/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("b")).toBeInTheDocument();
  });
});
