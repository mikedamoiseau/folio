import { describe, it, expect } from "vitest";
import { hasActiveLibraryFilters } from "../utils";

const NONE = {
  search: "",
  filterFormat: "all",
  filterStatus: "all",
  filterRating: "all",
  filterSource: "all",
  filterWantToRead: false,
  filterTagIds: [] as string[],
};

describe("hasActiveLibraryFilters (F2f empty-state cause)", () => {
  it("returns false when nothing is filtering (truly-empty view)", () => {
    expect(hasActiveLibraryFilters(NONE)).toBe(false);
  });

  it("returns true for a non-empty search", () => {
    expect(hasActiveLibraryFilters({ ...NONE, search: "dune" })).toBe(true);
  });

  it.each([
    ["filterFormat", { filterFormat: "epub" }],
    ["filterStatus", { filterStatus: "finished" }],
    ["filterRating", { filterRating: "4" }],
    ["filterSource", { filterSource: "linked" }],
    ["filterWantToRead", { filterWantToRead: true }],
  ])("returns true when %s is set", (_label, override) => {
    expect(hasActiveLibraryFilters({ ...NONE, ...override })).toBe(true);
  });

  it("returns true when tag filters are active", () => {
    expect(hasActiveLibraryFilters({ ...NONE, filterTagIds: ["t1"] })).toBe(true);
  });
});
