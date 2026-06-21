import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import ReaderSkeleton from "./ReaderSkeleton";

describe("ReaderSkeleton", () => {
  it("renders the full reader chrome by default (header + sidebar)", () => {
    const html = renderToString(<ReaderSkeleton />);
    expect(html).toContain("h-screen");
    // Sidebar placeholder is only present in the full variant.
    expect(html).toContain("w-56");
    expect(html).toContain("animate-pulse");
  });

  it("renders a content-only skeleton (no full-screen chrome) for chapter load", () => {
    const html = renderToString(<ReaderSkeleton variant="content" />);
    expect(html).toContain("animate-pulse");
    expect(html).toContain('aria-hidden="true"');
    // Content variant omits the full-screen wrapper and sidebar.
    expect(html).not.toContain("h-screen");
    expect(html).not.toContain("w-56");
  });
});
