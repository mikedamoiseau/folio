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
        id="book-1"
        title="Test Book"
        author="Test Author"
        coverPath="/covers/test.jpg"
        totalChapters={10}
        onClick={() => {}}
      />
    );
    // The img tag should have loading="lazy"
    expect(html).toContain('loading="lazy"');
  });

  it("renders placeholder when no cover path", () => {
    const html = renderToString(
      <BookCard
        id="book-2"
        title="No Cover Book"
        author="Test Author"
        coverPath={null}
        totalChapters={5}
        onClick={() => {}}
      />
    );
    // Should not have an img tag at all
    expect(html).not.toContain("<img");
    expect(html).not.toContain('loading="lazy"');
  });
});
