import { describe, it, expect, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));

import ChapterLoadProgress from "./ChapterLoadProgress";

describe("ChapterLoadProgress", () => {
  it("shows the chapter count and an indeterminate bar when loaded is unknown", () => {
    const html = renderToString(<ChapterLoadProgress total={280} />);
    // Honest indeterminate state: chapter count, no faked percentage
    expect(html).toContain("reader.loadingChapters");
    expect(html).toContain("count&quot;:280");
    expect(html).toContain("animate-chapter-load-indeterminate");
    expect(html).not.toContain("reader.loadedChapters");
  });

  it("shows a 'Loaded X / N' counter and a determinate bar when loaded is set", () => {
    const html = renderToString(<ChapterLoadProgress total={280} loaded={45} />);
    expect(html).toContain("reader.loadedChapters");
    expect(html).toContain("loaded&quot;:45");
    expect(html).toContain("total&quot;:280");
    // determinate bar width reflects actual progress (45/280 ≈ 16%)
    expect(html).toContain("width:16%");
    expect(html).not.toContain("animate-chapter-load-indeterminate");
  });

  it("clamps the bar width to 100% and never exceeds the total", () => {
    const html = renderToString(<ChapterLoadProgress total={10} loaded={10} />);
    expect(html).toContain("width:100%");
  });

  it("treats a zero total as indeterminate to avoid divide-by-zero", () => {
    const html = renderToString(<ChapterLoadProgress total={0} loaded={0} />);
    expect(html).toContain("reader.loadingChapters");
    expect(html).toContain("animate-chapter-load-indeterminate");
  });
});
