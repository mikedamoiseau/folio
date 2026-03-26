# R5-6: Display Book Metadata in UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show book language, year, series/volume as pills on BookCard, and add a detail modal for full metadata + description.

**Architecture:** Two UI additions — (1) metadata pills in BookCard's info area, (2) a new BookDetailModal component triggered by an info button on hover. No backend changes; all data already returned by `get_library`.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4

---

### File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/lib/utils.ts` | Modify | Add `formatMetadataPills()` helper |
| `src/lib/utils.test.ts` | Modify | Tests for `formatMetadataPills()` |
| `src/components/BookCard.tsx` | Modify | New props, pills in info area, info button |
| `src/components/BookDetailModal.tsx` | Create | Full metadata modal dialog |
| `src/screens/Library.tsx` | Modify | Pass new props to BookCard, manage modal state |

---

### Task 1: Add `formatMetadataPills` utility

**Files:**
- Modify: `src/lib/utils.ts`
- Modify: `src/lib/utils.test.ts`

This helper takes the raw metadata fields and returns an array of `{ label: string }` objects for rendering as pills. Centralizes the display logic (series+volume formatting, null filtering) so BookCard stays simple.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/utils.test.ts`:

```typescript
import {
  formatDuration,
  filterBooks,
  sortBooks,
  groupBy,
  clamp,
  isSupportedFile,
  formatMetadataPills,
  type BookLike,
} from "./utils";

// ... existing tests ...

// ---------------------------------------------------------------------------
// formatMetadataPills
// ---------------------------------------------------------------------------
describe("formatMetadataPills", () => {
  it("returns empty array when all fields are null", () => {
    expect(formatMetadataPills({})).toEqual([]);
  });

  it("includes language pill when language is set", () => {
    const pills = formatMetadataPills({ language: "fr" });
    expect(pills).toEqual([{ label: "fr" }]);
  });

  it("includes year pill when publishYear is set", () => {
    const pills = formatMetadataPills({ publishYear: 2024 });
    expect(pills).toEqual([{ label: "2024" }]);
  });

  it("formats series with volume", () => {
    const pills = formatMetadataPills({ series: "Aria", volume: 30 });
    expect(pills).toEqual([{ label: "Aria #30" }]);
  });

  it("formats series without volume", () => {
    const pills = formatMetadataPills({ series: "Aria" });
    expect(pills).toEqual([{ label: "Aria" }]);
  });

  it("returns all pills in order: language, year, series", () => {
    const pills = formatMetadataPills({
      language: "en",
      publishYear: 2023,
      series: "Dune",
      volume: 1,
    });
    expect(pills).toEqual([
      { label: "en" },
      { label: "2023" },
      { label: "Dune #1" },
    ]);
  });

  it("skips null and undefined fields", () => {
    const pills = formatMetadataPills({
      language: null,
      publishYear: undefined,
      series: "Saga",
      volume: null,
    });
    expect(pills).toEqual([{ label: "Saga" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- --run`
Expected: FAIL — `formatMetadataPills` is not exported from `./utils`

- [ ] **Step 3: Write minimal implementation**

Add to the end of `src/lib/utils.ts`:

```typescript
export interface MetadataPill {
  label: string;
}

export function formatMetadataPills(meta: {
  language?: string | null;
  publishYear?: number | null;
  series?: string | null;
  volume?: number | null;
}): MetadataPill[] {
  const pills: MetadataPill[] = [];
  if (meta.language) pills.push({ label: meta.language });
  if (meta.publishYear != null) pills.push({ label: String(meta.publishYear) });
  if (meta.series) {
    const seriesLabel = meta.volume != null ? `${meta.series} #${meta.volume}` : meta.series;
    pills.push({ label: seriesLabel });
  }
  return pills;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- --run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/utils.ts src/lib/utils.test.ts
git commit -m "feat: add formatMetadataPills utility for R5-6"
```

---

### Task 2: Add metadata pills and info button to BookCard

**Files:**
- Modify: `src/components/BookCard.tsx`

- [ ] **Step 1: Add new props to BookCardProps interface**

Replace the existing `BookCardProps` interface in `src/components/BookCard.tsx`:

```typescript
interface BookCardProps {
  id: string;
  title: string;
  author: string;
  coverPath: string | null;
  totalChapters: number;
  format?: "epub" | "cbz" | "cbr" | "pdf";
  progress?: number; // 0-100
  language?: string | null;
  publishYear?: number | null;
  series?: string | null;
  volume?: number | null;
  onClick: () => void;
  onDelete?: (id: string) => void;
  onEdit?: (id: string) => void;
  onInfo?: (id: string) => void;
  onRemoveFromCollection?: () => void;
  onScanForMetadata?: (id: string) => void;
  isScanning?: boolean;
}
```

- [ ] **Step 2: Destructure new props in component function**

Update the destructuring to include the new props:

```typescript
export default function BookCard({
  id,
  title,
  author,
  coverPath,
  format,
  progress,
  language,
  publishYear,
  series,
  volume,
  onClick,
  onDelete,
  onEdit,
  onInfo,
  onRemoveFromCollection,
  onScanForMetadata,
  isScanning,
}: BookCardProps) {
```

- [ ] **Step 3: Add import for formatMetadataPills**

Add at the top of `src/components/BookCard.tsx`:

```typescript
import { formatMetadataPills } from "../lib/utils";
```

- [ ] **Step 4: Compute pills and add to info area**

Inside the component body (after `const [confirming, setConfirming] = ...`), add:

```typescript
const pills = formatMetadataPills({ language, publishYear, series, volume });
```

Then replace the `{/* Info area */}` section (lines 205-221) with:

```tsx
      {/* Info area */}
      <div className="px-3 py-2.5">
        <p className="text-sm font-medium text-ink truncate leading-snug" title={title}>
          {title}
        </p>
        <p className="text-xs text-ink-muted truncate mt-0.5" title={author}>
          {author}
        </p>
        {pills.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {pills.map((pill) => (
              <span
                key={pill.label}
                className="text-[10px] leading-tight bg-warm-subtle text-ink-muted px-1.5 py-0.5 rounded-full"
              >
                {pill.label}
              </span>
            ))}
          </div>
        )}
        {progress != null && progress > 0 && (
          <div className="mt-2 h-0.5 rounded-full bg-warm-subtle">
            <div
              className="h-full rounded-full bg-accent transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
      </div>
```

- [ ] **Step 5: Add info button to hover action buttons**

In the `{/* Action buttons — hover reveal */}` section, add the info button after the `onScanForMetadata` button block (before the closing `</div>` of the action buttons container):

```tsx
            {onInfo && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onInfo(id); }}
                aria-label={`Details for ${title}`}
                className="w-6 h-6 flex items-center justify-center rounded-full bg-ink/60 text-paper hover:bg-accent focus:opacity-100 focus:outline-none"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" />
                  <path d="M12 16v-4m0-4h.01" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                </svg>
              </button>
            )}
```

- [ ] **Step 6: Run type check**

Run: `npm run type-check`
Expected: No errors (Library.tsx may warn about missing new props, but they're all optional so it should pass)

- [ ] **Step 7: Commit**

```bash
git add src/components/BookCard.tsx
git commit -m "feat: add metadata pills and info button to BookCard"
```

---

### Task 3: Create BookDetailModal component

**Files:**
- Create: `src/components/BookDetailModal.tsx`

- [ ] **Step 1: Create the component file**

Write `src/components/BookDetailModal.tsx`:

```tsx
import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

interface Book {
  id: string;
  title: string;
  author: string;
  cover_path: string | null;
  format: "epub" | "cbz" | "cbr" | "pdf";
  description: string | null;
  series: string | null;
  volume: number | null;
  language: string | null;
  publisher: string | null;
  publish_year: number | null;
}

interface BookDetailModalProps {
  book: Book;
  onClose: () => void;
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
}

export default function BookDetailModal({ book, onClose, onOpen, onEdit }: BookDetailModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    // Auto-focus first button
    const firstBtn = dialogRef.current?.querySelector<HTMLElement>("button");
    firstBtn?.focus();
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const coverSrc = book.cover_path ? convertFileSrc(book.cover_path) : null;

  const metadataRows: { label: string; value: string }[] = [];
  if (book.series) {
    const val = book.volume != null ? `${book.series} #${book.volume}` : book.series;
    metadataRows.push({ label: "Series", value: val });
  }
  if (book.language) metadataRows.push({ label: "Language", value: book.language });
  if (book.publish_year != null) metadataRows.push({ label: "Year", value: String(book.publish_year) });
  if (book.publisher) metadataRows.push({ label: "Publisher", value: book.publisher });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Details for ${book.title}`}
        className="bg-surface border border-warm-border rounded-2xl shadow-xl max-w-md w-full mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header: cover + title */}
        <div className="flex gap-4 p-5">
          {coverSrc ? (
            <img
              src={coverSrc}
              alt={`Cover of ${book.title}`}
              className="w-[100px] h-[150px] object-cover rounded-lg shadow-sm flex-shrink-0"
            />
          ) : (
            <div className="w-[100px] h-[150px] bg-warm-subtle rounded-lg flex items-center justify-center flex-shrink-0">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" className="text-ink-muted opacity-50">
                <path
                  d="M4 19.5v-15A2.5 2.5 0 016.5 2H20v20H6.5a2.5 2.5 0 010-5H20"
                  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                />
              </svg>
            </div>
          )}
          <div className="flex flex-col justify-center min-w-0">
            <h2 className="text-lg font-semibold text-ink leading-snug">{book.title}</h2>
            <p className="text-sm text-ink-muted mt-1">{book.author}</p>
            {book.format !== "epub" && (
              <span className="mt-2 self-start text-[10px] font-semibold uppercase tracking-wider bg-warm-subtle text-ink-muted px-2 py-0.5 rounded">
                {book.format}
              </span>
            )}
          </div>
        </div>

        {/* Metadata rows */}
        {metadataRows.length > 0 && (
          <div className="px-5 pb-3">
            <div className="border-t border-warm-border pt-3 space-y-1.5">
              {metadataRows.map((row) => (
                <div key={row.label} className="flex text-sm">
                  <span className="text-ink-muted w-20 flex-shrink-0">{row.label}</span>
                  <span className="text-ink">{row.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Description */}
        {book.description && (
          <div className="px-5 pb-3">
            <div className="border-t border-warm-border pt-3">
              <p className="text-sm text-ink-muted leading-relaxed max-h-40 overflow-y-auto">
                {book.description}
              </p>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 px-5 py-4 border-t border-warm-border">
          <button
            type="button"
            onClick={() => onOpen(book.id)}
            className="flex-1 px-4 py-2 rounded-xl bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          >
            Open
          </button>
          <button
            type="button"
            onClick={() => onEdit(book.id)}
            className="flex-1 px-4 py-2 rounded-xl bg-warm-subtle text-ink text-sm font-medium hover:bg-warm-border transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          >
            Edit
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run type check**

Run: `npm run type-check`
Expected: PASS — no errors

- [ ] **Step 3: Commit**

```bash
git add src/components/BookDetailModal.tsx
git commit -m "feat: add BookDetailModal component for R5-6"
```

---

### Task 4: Wire everything up in Library.tsx

**Files:**
- Modify: `src/screens/Library.tsx`

- [ ] **Step 1: Add import for BookDetailModal**

Add at the top of `src/screens/Library.tsx`, alongside the other component imports:

```typescript
import BookDetailModal from "../components/BookDetailModal";
```

- [ ] **Step 2: Add detailBook state**

Inside the `Library` component function, after the existing `useState` declarations (around the `editingBook` state), add:

```typescript
const [detailBook, setDetailBook] = useState<Book | null>(null);
```

- [ ] **Step 3: Pass new props to BookCard**

In the BookCard render (around line 736), add the new props. The updated BookCard usage becomes:

```tsx
                <BookCard
                  id={book.id}
                  title={book.title}
                  author={book.author}
                  coverPath={book.cover_path}
                  totalChapters={book.total_chapters}
                  format={book.format}
                  progress={progressMap[book.id] ?? 0}
                  language={book.language}
                  publishYear={book.publish_year}
                  series={book.series}
                  volume={book.volume}
                  onClick={() => navigate(`/reader/${book.id}`)}
                  onDelete={handleRemoveBook}
                  onEdit={(id) => {
                    const book = books.find((b) => b.id === id);
                    if (book) setEditingBook(book);
                  }}
                  onInfo={(id) => {
                    const book = books.find((b) => b.id === id);
                    if (book) setDetailBook(book);
                  }}
                  onRemoveFromCollection={
```

(The rest of the props — `onRemoveFromCollection`, `isScanning`, `onScanForMetadata` — stay unchanged.)

- [ ] **Step 4: Render BookDetailModal**

At the end of the Library component's JSX return, just before the closing fragment (`</>` or closing `</div>`), alongside the existing `EditBookDialog` render, add:

```tsx
        {detailBook && (
          <BookDetailModal
            book={detailBook}
            onClose={() => setDetailBook(null)}
            onOpen={(id) => {
              setDetailBook(null);
              navigate(`/reader/${id}`);
            }}
            onEdit={(id) => {
              setDetailBook(null);
              const book = books.find((b) => b.id === id);
              if (book) setEditingBook(book);
            }}
          />
        )}
```

- [ ] **Step 5: Run type check**

Run: `npm run type-check`
Expected: PASS

- [ ] **Step 6: Run all tests**

Run: `npm run test -- --run`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/screens/Library.tsx
git commit -m "feat: wire up metadata pills and detail modal in Library (R5-6)"
```

---

### Task 5: Final verification

- [ ] **Step 1: Run full CI check suite**

```bash
cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test && cd .. && npm run type-check && npm run test -- --run
```

Expected: All checks pass. No Rust changes were made, so cargo checks should pass trivially.

- [ ] **Step 2: Manual smoke test (if dev server available)**

Run `npm run tauri dev` and verify:
1. BookCards show language/year/series pills below author when metadata exists
2. Hover reveals ⓘ info button alongside edit/delete
3. Clicking ⓘ opens centered modal with cover, title, metadata rows, description
4. Modal closes on Escape and backdrop click
5. "Open" button navigates to reader
6. "Edit" button opens edit dialog
7. Books with no metadata show no pills and no empty states
