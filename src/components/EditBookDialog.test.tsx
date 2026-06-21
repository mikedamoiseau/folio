// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { renderToString } from "react-dom/server";

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));

const addToast = vi.fn();
vi.mock("./Toast", () => ({ useToast: () => ({ addToast }) }));

import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import EditBookDialog from "./EditBookDialog";

const baseProps = {
  bookId: "book-1",
  initialTitle: "Test Book",
  initialAuthor: "Test Author",
  onClose: vi.fn(),
  onSaved: vi.fn(),
};

describe("EditBookDialog", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_book_tags") return Promise.resolve([]);
      if (cmd === "get_all_tags") return Promise.resolve([]);
      return Promise.resolve(null);
    });
  });

  it("renders the tag input with placeholder", () => {
    const html = renderToString(<EditBookDialog {...baseProps} />);
    expect(html).toContain("editor.addTagPlaceholder");
  });

  it("renders the Tags label", () => {
    const html = renderToString(<EditBookDialog {...baseProps} />);
    expect(html).toContain("editor.tagsLabel");
  });

  it("shows a success toast after saving", async () => {
    addToast.mockReset();
    const onSaved = vi.fn();
    await act(async () => {
      render(<EditBookDialog {...baseProps} onSaved={onSaved} initialTitle="Test Book" />);
    });
    // change the title so there is something to save
    const titleInput = screen.getByDisplayValue("Test Book");
    await act(async () => fireEvent.change(titleInput, { target: { value: "New Title" } }));

    const saveBtn = screen.getByRole("button", { name: "common.save" });
    await act(async () => fireEvent.click(saveBtn));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(addToast).toHaveBeenCalledWith("common.saved", "success");
  });
});

afterEach(() => cleanup());
