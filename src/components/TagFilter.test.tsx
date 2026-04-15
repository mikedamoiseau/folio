import { describe, it, expect, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));

import TagFilter from "./TagFilter";

const sampleTags = [
  { id: "t1", name: "fiction" },
  { id: "t2", name: "sci-fi" },
  { id: "t3", name: "romance" },
];

const sampleBookTagMap = new Map<string, Set<string>>([
  ["b1", new Set(["t1", "t2"])],
  ["b2", new Set(["t1"])],
  ["b3", new Set(["t3"])],
]);

describe("TagFilter", () => {
  it("renders the button with default label when no tags selected", () => {
    const html = renderToString(
      <TagFilter
        allTags={sampleTags}
        bookTagMap={sampleBookTagMap}
        selectedTagIds={[]}
        onChangeSelectedTagIds={() => {}}
      />
    );
    expect(html).toContain("library.tagsAll");
  });

  it("renders selected tag chips when tags are selected", () => {
    const html = renderToString(
      <TagFilter
        allTags={sampleTags}
        bookTagMap={sampleBookTagMap}
        selectedTagIds={["t1"]}
        onChangeSelectedTagIds={() => {}}
      />
    );
    expect(html).toContain("fiction");
  });

  it("renders with aria-label for accessibility", () => {
    const html = renderToString(
      <TagFilter
        allTags={sampleTags}
        bookTagMap={sampleBookTagMap}
        selectedTagIds={[]}
        onChangeSelectedTagIds={() => {}}
      />
    );
    expect(html).toContain("library.filterByTags");
  });

  it("renders nothing when there are no tags", () => {
    const html = renderToString(
      <TagFilter
        allTags={[]}
        bookTagMap={new Map()}
        selectedTagIds={[]}
        onChangeSelectedTagIds={() => {}}
      />
    );
    // Should not render the button at all
    expect(html).toBe("");
  });
});
