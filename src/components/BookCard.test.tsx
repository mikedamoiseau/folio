import { describe, it, expect, vi } from "vitest";
import { renderToString } from "react-dom/server";

// Mock tauri API
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

// Mock react-i18next
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));

import BookCard from "./BookCard";

describe("BookCard", () => {
  it("renders cover image with loading=lazy attribute", () => {
    const html = renderToString(
      <BookCard
        book={{
          id: "book-1",
          title: "Test Book",
          author: "Test Author",
          coverPath: "/covers/test.jpg",
          totalChapters: 10,
        }}
        actions={{ onClick: () => {} }}
      />
    );
    expect(html).toContain('loading="lazy"');
  });

  it("renders placeholder when no cover path", () => {
    const html = renderToString(
      <BookCard
        book={{
          id: "book-2",
          title: "No Cover Book",
          author: "Test Author",
          coverPath: null,
          totalChapters: 5,
        }}
        actions={{ onClick: () => {} }}
      />
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain('loading="lazy"');
  });

  it("accepts book data and actions as separate props", () => {
    const html = renderToString(
      <BookCard
        book={{
          id: "book-3",
          title: "Props Test",
          author: "Author",
          coverPath: null,
          totalChapters: 1,
          format: "pdf",
          rating: 4,
          series: "My Series",
          volume: 2,
        }}
        actions={{
          onClick: () => {},
          onDelete: () => {},
          onInfo: () => {},
        }}
      />
    );
    expect(html).toContain("Props Test");
    expect(html).toContain("Author");
    expect(html).toContain("pdf");
  });
});
