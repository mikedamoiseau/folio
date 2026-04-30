import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import {
  findOffClusterDuration,
  findOffGridSpacing,
  findOffNormStrokeWidth,
  scanTreeForOffClusterDuration,
  scanTreeForOffGridSpacing,
  scanTreeForOffNormStrokeWidth,
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
// findOffNormStrokeWidth — unit-level checks against synthetic SVG snippets.
// ---------------------------------------------------------------------------
describe("findOffNormStrokeWidth", () => {
  it("accepts the canonical strokes (1.5 and 2)", () => {
    const src = `<svg><path strokeWidth="1.5"/></svg><svg><path strokeWidth="2"/></svg>`;
    expect(findOffNormStrokeWidth(src, "x.tsx")).toEqual([]);
  });

  it("flags non-canonical strokes outside spinner context", () => {
    const src = `<svg><path strokeWidth="1.75"/></svg>`;
    const out = findOffNormStrokeWidth(src, "x.tsx");
    expect(out.map((f) => f.match)).toEqual([`strokeWidth="1.75"`]);
  });

  it("flags 2.5 even though it is between the two cluster values", () => {
    const src = `<svg><path strokeWidth="2.5"/></svg>`;
    expect(findOffNormStrokeWidth(src, "x.tsx")).toHaveLength(1);
  });

  it("allows strokeWidth 3 inside an animate-spin SVG", () => {
    const src = `<svg className="animate-spin"><circle strokeWidth="3"/></svg>`;
    expect(findOffNormStrokeWidth(src, "x.tsx")).toEqual([]);
  });

  it("allows strokeWidth 4 inside an animate-spin SVG", () => {
    const src = `<svg className="animate-spin"><circle strokeWidth="4"/></svg>`;
    expect(findOffNormStrokeWidth(src, "x.tsx")).toEqual([]);
  });

  it("flags strokeWidth 3 outside an animate-spin SVG", () => {
    const src = `<svg className="text-red-500"><path strokeWidth="3"/></svg>`;
    expect(findOffNormStrokeWidth(src, "x.tsx")).toHaveLength(1);
  });

  it("supports curly-brace JSX values", () => {
    const src = `<svg><path strokeWidth={1.5}/></svg><svg><path strokeWidth={3}/></svg>`;
    const out = findOffNormStrokeWidth(src, "x.tsx");
    expect(out.map((f) => f.match)).toEqual([`strokeWidth={3}`]);
  });

  it("reports correct line numbers", () => {
    const src = `// 1\n<svg>\n  <path strokeWidth="2.5"/>\n</svg>`;
    const out = findOffNormStrokeWidth(src, "x.tsx");
    expect(out).toHaveLength(1);
    expect(out[0].line).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// findOffClusterDuration — Tailwind animation duration cluster.
// ---------------------------------------------------------------------------
describe("findOffClusterDuration", () => {
  it("accepts the cluster (150 / 200 / 300)", () => {
    const src = `<div className="duration-150 duration-200 duration-300">x</div>`;
    expect(findOffClusterDuration(src, "x.tsx")).toEqual([]);
  });

  it("flags off-cluster integer durations", () => {
    const src = `<div className="duration-250 duration-400">x</div>`;
    const out = findOffClusterDuration(src, "x.tsx");
    expect(out.map((f) => f.match)).toEqual(["duration-250", "duration-400"]);
  });

  it("flags arbitrary bracket durations", () => {
    const src = `<div className="duration-[180ms]">x</div>`;
    expect(findOffClusterDuration(src, "x.tsx")).toHaveLength(1);
  });

  it("ignores unrelated `duration` substrings", () => {
    const src = `const duration = 200; // not a class`;
    expect(findOffClusterDuration(src, "x.tsx")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Repo guards
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

describe("repo SVG strokes", () => {
  it("uses only 1.5 / 2 strokes (3 / 4 allowed only on animate-spin SVGs)", () => {
    const findings = scanTreeForOffNormStrokeWidth(SRC);
    if (findings.length > 0) {
      const detail = findings
        .map((f) => `  ${f.file}:${f.line}  ${f.match}`)
        .join("\n");
      throw new Error(
        `Off-norm SVG strokeWidth values found (must be 1.5 or 2; 3 / 4 allowed only inside animate-spin SVGs):\n${detail}`,
      );
    }
    expect(findings).toEqual([]);
  });
});

describe("repo animation durations", () => {
  it("uses only the 150 / 200 / 300 ms cluster (no arbitrary brackets)", () => {
    const findings = scanTreeForOffClusterDuration(SRC);
    if (findings.length > 0) {
      const detail = findings
        .map((f) => `  ${f.file}:${f.line}  ${f.match}`)
        .join("\n");
      throw new Error(
        `Off-cluster Tailwind duration classes found (must be 150 / 200 / 300):\n${detail}`,
      );
    }
    expect(findings).toEqual([]);
  });
});
