// Static-analysis helpers for UX-consistency guards.
//
// These pure functions consume source text and return findings. The Vitest
// suite in `uxConsistency.audit.test.ts` walks `src/**/*.{tsx,ts}` and feeds
// each file through them, so the production bundle never imports this module.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface Finding {
  file: string;
  line: number;
  match: string;
}

const SOURCE_EXTENSIONS = new Set([".tsx", ".ts"]);
const TEST_SUFFIXES = [".test.ts", ".test.tsx", ".audit.ts"];

export function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
        walk(full);
        continue;
      }
      const dot = entry.lastIndexOf(".");
      if (dot < 0) continue;
      const ext = entry.slice(dot);
      if (!SOURCE_EXTENSIONS.has(ext)) continue;
      if (TEST_SUFFIXES.some((s) => entry.endsWith(s))) continue;
      out.push(full);
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// Spacing — bans arbitrary `[Npx]` / `[Nrem]` spacing values that are not on
// the 4px grid. Tailwind half-step classes (p-1.5, mt-0.5, ...) are explicitly
// allowed: they are the deliberate 2px sub-grid for compact components.
// ---------------------------------------------------------------------------

const SPACING_PROPS = [
  "p", "px", "py", "pt", "pr", "pb", "pl",
  "m", "mx", "my", "mt", "mr", "mb", "ml",
  "gap", "gap-x", "gap-y",
  "space-x", "space-y",
  "inset", "inset-x", "inset-y",
  "top", "right", "bottom", "left",
];

const SPACING_ARBITRARY_RE = new RegExp(
  String.raw`\b(?:${SPACING_PROPS.join("|")})-\[([^\]]+)\]`,
  "g",
);

export function findOffGridSpacing(source: string, file: string): Finding[] {
  const out: Finding[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    SPACING_ARBITRARY_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SPACING_ARBITRARY_RE.exec(line)) !== null) {
      const value = m[1].trim();
      if (isOnFourPxGrid(value)) continue;
      out.push({ file, line: i + 1, match: m[0] });
    }
  }
  return out;
}

function isOnFourPxGrid(raw: string): boolean {
  // Accept pixel values that are non-negative multiples of 4, and rem values
  // whose pixel equivalent (assuming 16px root) is a multiple of 4.
  const px = raw.match(/^(\d+(?:\.\d+)?)px$/);
  if (px) {
    const n = parseFloat(px[1]);
    return Number.isFinite(n) && n >= 0 && n % 4 === 0;
  }
  const rem = raw.match(/^(\d+(?:\.\d+)?)rem$/);
  if (rem) {
    const n = parseFloat(rem[1]) * 16;
    return Number.isFinite(n) && n >= 0 && Math.abs(n - Math.round(n)) < 1e-9 && n % 4 === 0;
  }
  // Anything non-numeric (CSS variables, calc(), etc.) is allowed — not our concern.
  return true;
}

// Convenience: scan a tree and return all findings.
export function scanTreeForOffGridSpacing(root: string): Finding[] {
  const out: Finding[] = [];
  for (const file of collectSourceFiles(root)) {
    const source = readFileSync(file, "utf8");
    out.push(
      ...findOffGridSpacing(source, relative(root, file)),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// SVG stroke-width — the codebase uses two strokes (1.5 for outline icons,
// 2 for filled-edge icons). Loading spinners with `animate-spin` may use a
// thicker stroke (3 or 4) for legibility at small sizes.
// ---------------------------------------------------------------------------

const ALLOWED_STROKES = new Set(["1.5", "2"]);
const SPINNER_STROKES = new Set(["3", "4"]);
const STROKE_RE = /strokeWidth=(?:"([0-9.]+)"|\{([0-9.]+)\})/g;

export function findOffNormStrokeWidth(source: string, file: string): Finding[] {
  const out: Finding[] = [];
  STROKE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STROKE_RE.exec(source)) !== null) {
    const value = (m[1] ?? m[2]).trim();
    if (ALLOWED_STROKES.has(value)) continue;
    if (SPINNER_STROKES.has(value) && enclosingSvgIsSpinner(source, m.index)) continue;
    const line = source.slice(0, m.index).split("\n").length;
    out.push({ file, line, match: m[0] });
  }
  return out;
}

function enclosingSvgIsSpinner(source: string, pos: number): boolean {
  // Find the nearest preceding "<svg" tag. We don't need a real parser:
  // there are no nested SVGs in this codebase.
  const head = source.slice(0, pos);
  const svgStart = head.lastIndexOf("<svg");
  if (svgStart < 0) return false;
  // Slice from "<svg" through the strokeWidth match — captures the opening
  // tag's attributes plus any intervening JSX. If "animate-spin" appears
  // anywhere in that slice (typically as a className on the svg element or
  // a wrapping element), treat the match as a spinner.
  const slice = source.slice(svgStart, pos);
  return slice.includes("animate-spin");
}

export function scanTreeForOffNormStrokeWidth(root: string): Finding[] {
  const out: Finding[] = [];
  for (const file of collectSourceFiles(root)) {
    const source = readFileSync(file, "utf8");
    out.push(
      ...findOffNormStrokeWidth(source, relative(root, file)),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Animation timing — Tailwind duration classes must come from the cluster the
// codebase already converged on: 150 / 200 / 300 ms. Arbitrary `duration-[…]`
// brackets are banned outright.
// ---------------------------------------------------------------------------

const ALLOWED_DURATIONS = new Set(["150", "200", "300"]);
const DURATION_RE = /\bduration-(\[[^\]]+\]|\d+)(?![a-z0-9_-])/g;

export function findOffClusterDuration(source: string, file: string): Finding[] {
  const out: Finding[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    DURATION_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DURATION_RE.exec(line)) !== null) {
      const value = m[1];
      if (value.startsWith("[")) {
        out.push({ file, line: i + 1, match: m[0] });
        continue;
      }
      if (!ALLOWED_DURATIONS.has(value)) {
        out.push({ file, line: i + 1, match: m[0] });
      }
    }
  }
  return out;
}

export function scanTreeForOffClusterDuration(root: string): Finding[] {
  const out: Finding[] = [];
  for (const file of collectSourceFiles(root)) {
    const source = readFileSync(file, "utf8");
    out.push(
      ...findOffClusterDuration(source, relative(root, file)),
    );
  }
  return out;
}
