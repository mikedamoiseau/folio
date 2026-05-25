import { describe, it, expect, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));

import SeriesStackCard from "./SeriesStackCard";

const threeCover = [
  { id: "b1", coverSrc: "cover1.jpg" },
  { id: "b2", coverSrc: "cover2.jpg" },
  { id: "b3", coverSrc: "cover3.jpg" },
];

describe("SeriesStackCard", () => {
  it("renders series name and book count", () => {
    const html = renderToString(
      <SeriesStackCard
        seriesName="Achille Talon"
        bookCount={9}
        covers={threeCover}
        onClick={() => {}}
      />
    );
    expect(html).toContain("Achille Talon");
    expect(html).toContain("seriesView.bookCount");
  });

  it("renders 3 cover images for 3+ book series", () => {
    const html = renderToString(
      <SeriesStackCard
        seriesName="Test"
        bookCount={5}
        covers={threeCover}
        onClick={() => {}}
      />
    );
    const imgCount = (html.match(/<img /g) || []).length;
    expect(imgCount).toBe(3);
  });

  it("renders 2 cover images for 2-book series", () => {
    const html = renderToString(
      <SeriesStackCard
        seriesName="Test"
        bookCount={2}
        covers={threeCover.slice(0, 2)}
        onClick={() => {}}
      />
    );
    const imgCount = (html.match(/<img /g) || []).length;
    expect(imgCount).toBe(2);
  });

  it("renders fallback icon when front cover is missing", () => {
    const html = renderToString(
      <SeriesStackCard
        seriesName="Test"
        bookCount={3}
        covers={[{ id: "b1", coverSrc: null }, { id: "b2", coverSrc: "c2.jpg" }]}
        onClick={() => {}}
      />
    );
    expect(html).toContain("<svg");
    const imgCount = (html.match(/<img /g) || []).length;
    expect(imgCount).toBe(1);
  });

  it("sets title attribute for full series name", () => {
    const html = renderToString(
      <SeriesStackCard
        seriesName="A Very Long Series Name"
        bookCount={3}
        covers={threeCover}
        onClick={() => {}}
      />
    );
    expect(html).toContain('title="A Very Long Series Name"');
  });

  it("applies hover scale class on front card", () => {
    const html = renderToString(
      <SeriesStackCard
        seriesName="Test"
        bookCount={3}
        covers={threeCover}
        onClick={() => {}}
      />
    );
    expect(html).toContain("group-hover:scale-");
  });
});
