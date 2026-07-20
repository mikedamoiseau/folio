// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

// Echo interpolation params so we can assert the title is passed through.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        "bookCard.confirmDeletion": "Confirm deletion",
        "bookCard.confirmDeleteQuestion": "Remove this book from your library?",
        "bookCard.removeLabel": "Remove",
        "common.cancel": "Cancel",
        "common.remove": "Remove",
      };
      return map[key] ?? (params ? `${key}:${JSON.stringify(params)}` : key);
    },
  }),
}));

import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import BookCard from "./BookCard";

afterEach(() => cleanup());

describe("BookCard delete confirmation (F2c)", () => {
  function openConfirm(coverPath: string | null) {
    render(
      <BookCard
        book={{
          id: "b1",
          title: "A Very Long And Specific Title",
          author: "Jane Author",
          coverPath,
          totalChapters: 3,
          wantToRead: false,
        }}
        actions={{ onClick: () => {}, onDelete: () => {} }}
        // Force the action buttons to mount: focusing the card sets `interactive`.
      />
    );
    // Reveal hover-only buttons by focusing the card.
    fireEvent.focus(screen.getByRole("button", { name: /A Very Long/i }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  }

  it("shows the full title and author in the confirm dialog", () => {
    openConfirm("/covers/b1.jpg");
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("A Very Long And Specific Title")).toBeInTheDocument();
    expect(within(dialog).getByText("Jane Author")).toBeInTheDocument();
    expect(within(dialog).getByText("Remove this book from your library?")).toBeInTheDocument();
  });

  it("shows the cover thumbnail when a cover exists", () => {
    openConfirm("/covers/b1.jpg");
    const dialog = screen.getByRole("alertdialog");
    const img = dialog.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "asset://localhost//covers/b1.jpg");
  });

  it("renders a placeholder (no img) when there is no cover", () => {
    openConfirm(null);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.querySelector("img")).toBeNull();
    // Title still present so the user knows which book.
    expect(within(dialog).getByText("A Very Long And Specific Title")).toBeInTheDocument();
  });
});
