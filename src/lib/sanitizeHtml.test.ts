// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { sanitizeChapterHtml } from "./sanitizeHtml";

describe("sanitizeChapterHtml", () => {
  it("strips <script> elements", () => {
    const out = sanitizeChapterHtml('<p>hi</p><script>alert(1)</script>');
    expect(out).not.toContain("<script");
    expect(out).toContain("<p>hi</p>");
  });

  it("strips onerror event-handler attributes", () => {
    const out = sanitizeChapterHtml('<img src="x" onerror="alert(1)">');
    expect(out).not.toContain("onerror");
  });

  it("strips javascript: URLs from links", () => {
    const out = sanitizeChapterHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain("javascript:");
  });

  it("preserves asset:// image sources (reader's own rewritten images)", () => {
    const src = "asset://localhost/%2FUsers%2Fme%2Fcovers%2Fa.png";
    const out = sanitizeChapterHtml(`<img src="${src}">`);
    expect(out).toContain(src);
  });

  it("preserves data: image sources (EPUB embedded images the server leaves untouched)", () => {
    const src =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    const out = sanitizeChapterHtml(`<img src="${src}">`);
    expect(out).toContain("data:image/png");
  });

  it("preserves https image sources", () => {
    const out = sanitizeChapterHtml('<img src="https://example.com/a.png">');
    expect(out).toContain("https://example.com/a.png");
  });

  it("preserves highlight <mark> with inline style", () => {
    const html =
      '<mark style="background-color:#ff000044;border-radius:2px;padding:1px 0">x</mark>';
    const out = sanitizeChapterHtml(html);
    expect(out).toContain("<mark");
    expect(out).toContain("background-color");
  });
});
