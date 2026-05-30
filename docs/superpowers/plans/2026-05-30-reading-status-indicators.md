# F-1-4 Reading Status Indicators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a per-book reading status (Active / Paused / Finished; Unread shows nothing) on each library grid card, by tinting the existing top-right progress pill — derived from data already loaded, no DB writes or new IPC.

**Architecture:** A pure `getReadingStatus` helper in `src/lib/utils.ts` (unit-tested) maps `(progress, lastReadAt, now)` → status. `BookCard` gains an optional `status` prop and tints its existing top-right pill. `Library.tsx`'s `toCardData` derives the status from the already-loaded `progressMap` + `lastReadMap`.

**Tech Stack:** React 19, TypeScript, Tailwind v4, react-i18next, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-30-reading-status-indicators-design.md`

**Pre-flight notes:**
- Run frontend tests from project root: `npm run test` (Vitest, once) and `npm run type-check`.
- `src/lib/utils.ts` uses **named exports**; `src/lib/utils.test.ts` imports them and uses `import { describe, it, expect } from "vitest"`.
- `bg-accent` is a valid Tailwind token in this project (used in Library.tsx). Status hues for active/paused use arbitrary values `bg-[#5e8c61]` / `bg-[#c2924e]`; finished reuses `bg-accent` (theme-aware).
- i18n: use `t(key, { defaultValue: "…" })` so no locale-file edits are needed now (i18next returns the defaultValue when the key is absent).

---

### Task 1: `getReadingStatus` pure helper

**Files:**
- Modify: `src/lib/utils.ts` (add type, constant, function)
- Modify: `src/lib/utils.test.ts` (add tests)

- [ ] **Step 1: Write the failing tests** — append to `src/lib/utils.test.ts`. First add `getReadingStatus` and `PAUSED_AFTER_DAYS` to the existing top `import { … } from "./utils";` block, then add this describe block at the end of the file:

```ts
describe("getReadingStatus", () => {
  const DAY = 86400;
  const now = 1_700_000_000; // fixed reference (unix seconds)

  it("returns unread when progress is 0", () => {
    expect(getReadingStatus(0, now, now)).toBe("unread");
    expect(getReadingStatus(0, undefined, now)).toBe("unread");
  });

  it("returns finished when progress is 100 or more", () => {
    expect(getReadingStatus(100, now, now)).toBe("finished");
    expect(getReadingStatus(150, now - 999 * DAY, now)).toBe("finished");
  });

  it("returns active for in-progress read within the window", () => {
    expect(getReadingStatus(34, now, now)).toBe("active");
    expect(getReadingStatus(34, now - 13 * DAY, now)).toBe("active");
  });

  it("treats exactly 14 days as still active (inclusive boundary)", () => {
    expect(getReadingStatus(34, now - PAUSED_AFTER_DAYS * DAY, now)).toBe("active");
  });

  it("returns paused for in-progress read older than the window", () => {
    expect(getReadingStatus(34, now - 15 * DAY, now)).toBe("paused");
  });

  it("returns paused for in-progress book with no/zero last-read timestamp", () => {
    expect(getReadingStatus(34, undefined, now)).toBe("paused");
    expect(getReadingStatus(34, 0, now)).toBe("paused");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- src/lib/utils.test.ts`
Expected: FAIL — `getReadingStatus`/`PAUSED_AFTER_DAYS` not exported.

- [ ] **Step 3: Implement the helper** — add to `src/lib/utils.ts` (near the other pure helpers; placement is not critical since exports are named):

```ts
export type ReadingStatus = "unread" | "active" | "paused" | "finished";

/** Days of inactivity after which an in-progress book is considered paused. */
export const PAUSED_AFTER_DAYS = 14;

/**
 * Derive a book's reading status from its progress and last-read time.
 * Pure: callers pass `nowSecs` (unix seconds) so it is deterministic/testable.
 * - progress >= 100        → finished
 * - progress <= 0          → unread
 * - in progress, read <=14d ago → active
 * - in progress, older or no timestamp → paused
 */
export function getReadingStatus(
  progress: number,
  lastReadAt: number | undefined,
  nowSecs: number,
): ReadingStatus {
  if (progress >= 100) return "finished";
  if (progress <= 0) return "unread";
  if (!lastReadAt) return "paused";
  const ageDays = (nowSecs - lastReadAt) / 86400;
  return ageDays <= PAUSED_AFTER_DAYS ? "active" : "paused";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- src/lib/utils.test.ts`
Expected: PASS (all 6 new cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/utils.ts src/lib/utils.test.ts
git commit -m "feat(library): add getReadingStatus helper"
```

---

### Task 2: Tint the BookCard progress pill by status

**Files:**
- Modify: `src/components/BookCard.tsx`

- [ ] **Step 1: Add the `status` field to `BookCardData`** and import the type. At the top of the file add to the imports:

```tsx
import { formatMetadataPills } from "../lib/utils";
import { type ReadingStatus } from "../lib/utils";
```

(If `formatMetadataPills` is already imported from `"../lib/utils"`, instead extend that import: `import { formatMetadataPills, type ReadingStatus } from "../lib/utils";`)

In the `BookCardData` interface, add after `isImported?: boolean;`:

```tsx
  status?: ReadingStatus;
```

- [ ] **Step 2: Destructure `status`** — in the component body where `book` is destructured (`const { id, title, … isImported } = book;`), add `status`:

```tsx
  const { id, title, author, coverPath, format, progress, language, publishYear, series, volume, rating, isImported, status } = book;
```

- [ ] **Step 3: Replace the progress-badge JSX.** Find the existing block:

```tsx
        {/* Progress badge */}
        {progress != null && progress > 0 && !confirming && (
          <span className="absolute top-2 right-2 bg-ink/70 text-paper text-[10px] font-medium px-2 py-0.5 rounded-full backdrop-blur-sm">
            {progress}%
          </span>
        )}
```

Replace it with:

```tsx
        {/* Progress / reading-status badge */}
        {progress != null && progress > 0 && !confirming && (() => {
          const bg =
            status === "active" ? "bg-[#5e8c61]"
            : status === "paused" ? "bg-[#c2924e]"
            : status === "finished" ? "bg-accent"
            : "bg-ink/70";
          const label =
            status === "finished" ? t("bookCard.statusFinished", { defaultValue: "Finished" })
            : status === "active" ? t("bookCard.statusActive", { defaultValue: "Active — {{p}}%", p: progress })
            : status === "paused" ? t("bookCard.statusPaused", { defaultValue: "Paused — {{p}}%", p: progress })
            : t("bookCard.progressRead", { defaultValue: "{{p}}% read", p: progress });
          return (
            <span
              className={`absolute top-2 right-2 inline-flex items-center gap-1 text-paper text-[10px] font-medium px-2 py-0.5 rounded-full backdrop-blur-sm ${bg}`}
              title={label}
              aria-label={label}
            >
              {status === "finished" ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <>
                  {status === "active" && (
                    <span className="w-1.5 h-1.5 rounded-full bg-paper" aria-hidden="true" />
                  )}
                  {status === "paused" && (
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <rect x="6" y="5" width="4" height="14" rx="1" />
                      <rect x="14" y="5" width="4" height="14" rx="1" />
                    </svg>
                  )}
                  {progress}%
                </>
              )}
            </span>
          );
        })()}
```

Notes:
- When `status` is undefined (other BookCard callers), `bg` falls back to the original `bg-ink/70` and the pill shows `{progress}%` with no glyph — backward compatible.
- `t` is already available in this component (`const { t } = useTranslation();`).

- [ ] **Step 4: Type-check and run the frontend test suite** (no behavioural test for the presentational change; verify nothing breaks and types are sound):

Run: `npm run type-check`
Expected: no errors.
Run: `npm run test`
Expected: PASS (existing suite unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/components/BookCard.tsx
git commit -m "feat(library): tint book card pill by reading status"
```

---

### Task 3: Derive status in Library's `toCardData`

**Files:**
- Modify: `src/screens/Library.tsx`

- [ ] **Step 1: Import the helper.** Add `getReadingStatus` to the existing import from `"../lib/utils"` (Library already imports helpers from there). If there is no existing `../lib/utils` import, add:

```tsx
import { getReadingStatus } from "../lib/utils";
```

- [ ] **Step 2: Add `status` to `toCardData`.** Find the `toCardData` callback (builds a `BookCardData`, currently sets `progress: progressMap[book.id] ?? 0`). Add a `status` field and extend the dependency array:

```tsx
  const toCardData = useCallback((book: BookGridItem): BookCardData => ({
    // …existing fields unchanged…
    progress: progressMap[book.id] ?? 0,
    status: getReadingStatus(
      progressMap[book.id] ?? 0,
      lastReadMap[book.id],
      Date.now() / 1000,
    ),
    // …remaining existing fields unchanged…
  }), [progressMap, lastReadMap]);
```

Keep every other field exactly as it is; only add the `status` line and add `lastReadMap` to the dependency array (it was previously `[progressMap]`).

- [ ] **Step 3: Type-check and run tests**

Run: `npm run type-check`
Expected: no errors.
Run: `npm run test`
Expected: PASS.

- [ ] **Step 4: Manual visual check (best-effort).** If a dev environment is available, run `npm run tauri dev`, open the library, and confirm: a recently-read in-progress book shows a sage pill with a dot + %, an old in-progress book shows an ochre pill with a pause glyph + %, a 100% book shows a terracotta pill with a check (no %), and an unread book shows no pill. If the dev server cannot be exercised in this environment, note that the visual result was not verified in-app and rely on the mockup (`/tmp/folio-f14-mockup.html`) + type-check.

- [ ] **Step 5: Commit**

```bash
git add src/screens/Library.tsx
git commit -m "feat(library): derive reading status for grid cards"
```

---

## After all tasks

- [ ] Dispatch a final code reviewer for the whole branch.
- [ ] Run `~/bin/pr-review.sh --no-branch --description "F-1-4 reading status indicators"`. Do not modify code while that script runs. Antigravity may return empty output (judge by Codex + CI).
- [ ] Run the full gate: `npm run type-check && npm run test` (root). No Rust changed, so the Rust gate is unaffected, but `cargo fmt --check`/`clippy` cost nothing to confirm if desired.
- [ ] Optionally add real i18n keys (`bookCard.statusActive`/`statusPaused`/`statusFinished`/`progressRead`) to the locale files; the defaultValues keep it working until then.
- [ ] Update the F-1-4 row in `.claude/reports/20260525-research-team-main.md` (mark SHIPPED).
- [ ] Use superpowers:finishing-a-development-branch.
```
