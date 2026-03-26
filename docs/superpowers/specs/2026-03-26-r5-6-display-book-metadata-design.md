# R5-6: Display Book Metadata in UI

**Date:** 2026-03-26
**Status:** Approved
**Review finding:** R5-6 — `BookMetadata` includes language and description but neither is displayed in UI

## Problem

The `Book` model has `language`, `description`, `series`, `volume`, `publisher`, and `publish_year` fields. These are stored in the database, returned by `get_library`, and editable via the Edit Book dialog — but never shown to users in any read-only view. Users can't see their book metadata without opening the edit dialog.

## Solution

Two complementary changes:

### 1. Metadata pills on BookCard

Add small pill badges below the author line in BookCard's info area. Show only when data is present:

- **Language** — e.g. `fr`, `en`
- **Year** — e.g. `2024`
- **Series + volume** — e.g. `Aria #30` (or just `Aria` if no volume)

Styling: `bg-warm-subtle text-ink-muted` rounded pills, `text-[10px]`, in a flex-wrap row with `gap-1`. Sits inside the existing `px-3 py-2.5` info area between author and progress bar.

New BookCard props: `language?: string | null`, `publishYear?: number | null`, `series?: string | null`, `volume?: number | null`.

### 2. Book detail modal

A centered modal dialog showing full book metadata and description.

**Trigger:** An ⓘ (info) button added to BookCard's hover action buttons (top-left group, alongside edit and delete).

**Layout:**
- Top section: cover image (left, ~120px wide) + title/author/format (right), horizontal flex
- Middle section: metadata fields as labeled rows — Series, Volume, Language, Year, Publisher. Only render rows where data exists.
- Description section: full text, `max-h-40 overflow-y-auto` for long descriptions
- Bottom: "Open" button (accent, navigates to reader) and "Edit" button (secondary, opens edit dialog)

**Behavior:**
- Closes on Escape key and backdrop click
- Focus trapped within modal while open
- `role="dialog"`, `aria-modal="true"`, `aria-label` for accessibility

**New component:** `src/components/BookDetailModal.tsx`
- Props: `book: Book`, `onClose: () => void`, `onOpen: (id: string) => void`, `onEdit: (id: string) => void`

**State in Library.tsx:** `detailBook: Book | null` — when set, renders the modal. The ⓘ button sets it; modal's onClose clears it.

## Not in scope

- No changes to the Reader view
- No new backend commands (all data already returned by `get_library`)
- No new database fields or migrations

## Files to modify

- `src/components/BookCard.tsx` — add metadata pills + info button, new props
- `src/components/BookDetailModal.tsx` — new component
- `src/screens/Library.tsx` — pass new props to BookCard, manage detail modal state
