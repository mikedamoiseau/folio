import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import {
  findOffGridSpacing,
  scanTreeForOffGridSpacing,
} from "./uxConsistency.audit";

const SRC = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// findOffGridSpacing — unit-level checks against synthetic source snippets.
// ---------------------------------------------------------------------------
describe("findOffGridSpacing", () => {
  it("ignores standard Tailwind scale classes (no brackets)", () => {
    const src = `<div className="p-4 mt-2 gap-1.5 px-3 mb-0.5">x</div>`;
    expect(findOffGridSpacing(src, "x.tsx")).toEqual([]);
  });

  it("flags arbitrary px values that are not multiples of 4", () => {
    const src = `<div className="p-[5px] mt-[13px]">x</div>`;
    const out = findOffGridSpacing(src, "x.tsx");
    expect(out.map((f) => f.match)).toEqual(["p-[5px]", "mt-[13px]"]);
  });

  it("accepts arbitrary px values that are 4px multiples", () => {
    const src = `<div className="p-[8px] gap-[12px] mb-[64px]">x</div>`;
    expect(findOffGridSpacing(src, "x.tsx")).toEqual([]);
  });

  it("accepts rem values whose px equivalent is a 4px multiple", () => {
    const src = `<div className="p-[0.5rem] mt-[1rem]">x</div>`;
    expect(findOffGridSpacing(src, "x.tsx")).toEqual([]);
  });

  it("flags rem values whose px equivalent is off-grid", () => {
    const src = `<div className="p-[0.625rem]">x</div>`; // 10px
    const out = findOffGridSpacing(src, "x.tsx");
    expect(out.map((f) => f.match)).toEqual(["p-[0.625rem]"]);
  });

  it("ignores non-numeric arbitrary values (CSS variables, calc)", () => {
    const src = `<div className="p-[var(--gap)] mt-[calc(100%-1px)]">x</div>`;
    expect(findOffGridSpacing(src, "x.tsx")).toEqual([]);
  });

  it("reports correct line numbers", () => {
    const src = `// header\n<div className="p-[7px]">x</div>\n<div className="p-2">ok</div>`;
    const out = findOffGridSpacing(src, "x.tsx");
    expect(out).toHaveLength(1);
    expect(out[0].line).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Repo guard — fails if any production source file ships off-grid arbitrary
// spacing values. Locks in the current clean state.
// ---------------------------------------------------------------------------
describe("repo spacing", () => {
  it("contains no off-grid arbitrary spacing values", () => {
    const findings = scanTreeForOffGridSpacing(SRC);
    if (findings.length > 0) {
      const detail = findings
        .map((f) => `  ${f.file}:${f.line}  ${f.match}`)
        .join("\n");
      throw new Error(
        `Off-grid spacing values found (must be 4px multiples):\n${detail}`,
      );
    }
    expect(findings).toEqual([]);
  });
});
