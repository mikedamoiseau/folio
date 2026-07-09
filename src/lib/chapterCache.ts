// In-memory adjacent-chapter prefetch cache for the paginated HTML reader
// (EPUB/MOBI). Holds a small window of sanitized chapter HTML keyed by
// chapter index so prev/next turns render synchronously from cache instead
// of awaiting the `get_chapter_content` IPC round-trip (F-4-3).
//
// Scoped to a single book at a time: switching books resets it so one book's
// HTML can never be served for another. Purely a render-latency optimization
// — never persisted.

export interface ChapterCache {
  /** Book the cached entries belong to; null until the first store. */
  bookId: string | null;
  /** chapter index -> sanitized chapter HTML */
  entries: Map<number, string>;
}

/** Radius (in chapters) of the eviction window around the current chapter. */
export const CACHE_WINDOW = 2;

export function createChapterCache(): ChapterCache {
  return { bookId: null, entries: new Map() };
}

/**
 * Return cached HTML for (bookId, index), or undefined on a miss. A bookId
 * mismatch is always a miss — the cache belongs to a single book at a time.
 */
export function getCachedChapter(
  cache: ChapterCache,
  bookId: string,
  index: number,
): string | undefined {
  if (cache.bookId !== bookId) return undefined;
  return cache.entries.get(index);
}

/**
 * Store HTML for (bookId, index). If the bookId differs from the cache's
 * current book, the cache is reset first so stale entries can't leak across
 * books.
 */
export function setCachedChapter(
  cache: ChapterCache,
  bookId: string,
  index: number,
  html: string,
): void {
  if (cache.bookId !== bookId) {
    cache.bookId = bookId;
    cache.entries.clear();
  }
  cache.entries.set(index, html);
}

/**
 * Evict every entry whose chapter index falls outside
 * [center - radius, center + radius], bounding memory to a small window
 * around the reader's current position.
 */
export function evictOutsideWindow(
  cache: ChapterCache,
  center: number,
  radius: number = CACHE_WINDOW,
): void {
  for (const index of cache.entries.keys()) {
    if (Math.abs(index - center) > radius) {
      cache.entries.delete(index);
    }
  }
}

/**
 * The adjacent chapter indices to prefetch around `current` (current ±1),
 * clamped to [0, totalChapters).
 */
export function adjacentChapterIndices(
  current: number,
  totalChapters: number,
): number[] {
  return [current - 1, current + 1].filter((i) => i >= 0 && i < totalChapters);
}
