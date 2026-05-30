# F-1-4 Active Reading Progress Indicators — Design

**Status:** Approved (2026-05-30)

**Goal:** Surface a per-book reading status — **Active**, **Paused**, or
**Finished** — on each library grid card, derived entirely from data the Library
screen already loads. Unread books show nothing. No DB writes, no new IPC.

## Background

The library grid (`src/screens/Library.tsx`) already batch-loads two maps via the
existing `get_all_reading_progress` IPC call:

- `progressMap: Record<string, number>` — reading percent (0–100) per book id
- `lastReadMap: Record<string, number>` — last-read unix timestamp (seconds) per book id

`BookCard` (`src/components/BookCard.tsx`) already renders a top-right progress
pill (`{progress}%`, shown only when `progress > 0`) and a thin progress bar
concept. Status is fully derivable from `progress` + `lastReadAt`, so this feature
is pure presentation layered on existing state.

The research report flagged one concern: grid re-render cost. This design adds no
new data source and no new re-render trigger — `toCardData` already depends on
`progressMap`; we add `lastReadMap` as one more dependency, and status is an O(1)
computation per card.

## Scope

- **In:** A pure status-deriving helper; a `status` prop on `BookCard`; tinting
  the existing top-right progress pill by status.
- **Out:** No DB schema change, no new Tauri command, no persistent writes. The
  status filter dropdown (All / In progress / Finished) is **unchanged**. No
  changes to the reader screen.

## Status taxonomy

A pure function decides status from `(progress, lastReadAt, now)`:

| Status | Condition |
|--------|-----------|
| `unread` | `progress === 0` (or no progress entry) |
| `finished` | `progress >= 100` |
| `active` | `0 < progress < 100` **and** `now - lastReadAt <= 14 days` |
| `paused` | `0 < progress < 100` **and** (`now - lastReadAt > 14 days` **or** no/zero `lastReadAt`) |

- The 14-day boundary is a named constant `PAUSED_AFTER_DAYS = 14`.
- `lastReadAt` is unix **seconds**; `now` is `Date.now() / 1000`. The threshold
  compares seconds.
- A book with `progress > 0` but a missing/zero `lastReadAt` falls to `paused`
  (treated as long-idle) — it is never `active` without a recent timestamp.

## Components

### `getReadingStatus` — pure helper (`src/lib/utils.ts`)

```ts
export type ReadingStatus = "unread" | "active" | "paused" | "finished";

export const PAUSED_AFTER_DAYS = 14;

export function getReadingStatus(
  progress: number,
  lastReadAt: number | undefined,
  nowSecs: number,
): ReadingStatus
```

Lives in `src/lib/utils.ts` alongside the other pure UI logic (per CLAUDE.md:
"Frontend pure logic lives in `src/lib/utils.ts` for testability"). Unit-tested
with Vitest.

### `BookCard` (`src/components/BookCard.tsx`)

- `BookCardData` gains an optional `status?: ReadingStatus`.
- The existing top-right progress pill is restyled by status:
  - **active** — sage background (`#5e8c61`), a small white dot + `{progress}%`
  - **paused** — ochre background (`#c2924e`), a pause glyph + `{progress}%`
  - **finished** — terracotta/accent background (`var(--accent)`), a white check
    icon, **no number**
  - **unread** — pill not rendered (current behaviour: `progress > 0` gate stays)
- When `status` is undefined (caller didn't supply it), the pill keeps its
  current neutral `bg-ink/70` `{progress}%` appearance — backward compatible for
  any other BookCard usage.
- **No new cover element.** BookCard has no progress bar today; this feature only
  restyles the existing pill. (The mockup showed a tinted bar; it is intentionally
  out of scope here to avoid adding card chrome.)
- Status colours are added as Tailwind theme tokens (or arbitrary values keyed to
  the existing `--accent` etc.) so light/dark themes both work; finished reuses
  the existing accent token.
- Glyphs are inline SVG inheriting `currentColor`/white, consistent with the
  card's other icons.
- The pill gets an accessible label (e.g. `title`/`aria-label` like
  `"Paused — 34%"`) so the status isn't conveyed by colour alone.

### `Library.tsx`

- `toCardData` derives `status: getReadingStatus(progressMap[book.id] ?? 0,
  lastReadMap[book.id], nowSecs)` and includes it in `BookCardData`.
- `nowSecs` is computed once per render (`Date.now() / 1000`), not per card.
- `toCardData`'s `useCallback` dependency array adds `lastReadMap` (and the
  `nowSecs` source). No other Library logic changes.

## Data flow

```
get_all_reading_progress (existing IPC, already called)
  → progressMap + lastReadMap (existing state)
  → toCardData(book): status = getReadingStatus(progress, lastReadAt, now)
  → <BookCard status=…>  → tinted top-right pill
```

## Accessibility

- Colour is paired with a glyph/number and an `aria-label`, never colour alone.
- Status hues vs white pill text clear ~4.5:1 at the small bold size; the pill
  uses solid status backgrounds (not translucent) to guarantee legibility over
  arbitrary cover art.

## Testing

**Unit (`src/lib/utils.test.ts`, Vitest):** `getReadingStatus` —
- `progress === 0` → `unread` (regardless of timestamp)
- `progress >= 100` → `finished`
- in-progress, `lastReadAt` = now → `active`
- in-progress, `lastReadAt` = 13 days ago → `active` (boundary inside window)
- in-progress, `lastReadAt` = 15 days ago → `paused` (boundary outside window)
- in-progress, `lastReadAt` = exactly 14 days ago → `active` (`<=` is inclusive)
- in-progress, `lastReadAt` undefined / 0 → `paused`

**Visual:** the four states verified in the mockup (`/tmp/folio-f14-mockup.html`,
real Folio palette + fonts). In-app rendering (dev server) must be checked
manually — automated tests cannot fully verify the visual result.

## Decisions

- **Placement:** tint the existing top-right progress pill (Option A) — reuses
  current real estate, avoids crowding the already-busy card corners.
- **Badged states:** Active / Paused / Finished only; Unread shows nothing.
- **Paused threshold:** 14 days since last read.
- **Filter dropdown:** unchanged (display-only feature).
- **No persistence:** status is derived at render time from existing maps.
