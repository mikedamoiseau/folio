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

vi.mock("../../context/ThemeContext", () => ({
  useTheme: () => ({ mode: "light" }),
}));

import { render, screen, cleanup, waitFor } from "@testing-library/react";
import HighlightsPanel from "../HighlightsPanel";

afterEach(() => cleanup());

beforeEach(() => {
  vi.clearAllMocks();
});

const defaultProps = {
  bookId: "book-1",
  onClose: vi.fn(),
  onGoToChapter: vi.fn(),
};

describe("HighlightsPanel", () => {
  it("renders an empty-state how-to CTA when there are no highlights", async () => {
    render(<HighlightsPanel {...defaultProps} />);
    await waitFor(() => {
      expect(
        screen.getByText(/select text while reading to create one/i),
      ).toBeInTheDocument();
    });
  });
});
