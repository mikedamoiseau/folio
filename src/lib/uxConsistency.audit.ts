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
