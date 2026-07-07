/**
 * In-memory-only reading-position store used while "Don't track this
 * session" (private mode) is on (spec Decision 4 / D-5, B-M2).
 *
 * Private mode suppresses the backend's `reading_progress` write
 * (`apply_reading_progress`), so the DB row for a book goes stale for the
 * rest of the private session. Without this store, closing a book and
 * reopening it later in the same session (e.g. browsing back through the
 * library) would silently rewind to wherever the book was *before* private
 * mode was turned on.
 *
 * This is a plain module-level `Map` — never written to the DB,
 * localStorage, IndexedDB, or the sync file, and it evaporates with the
 * page. That mirrors private mode itself resetting to off on every app
 * restart (R-3): there is no persistence layer here to disagree with.
 *
 * Cleared in full whenever private mode turns off, so a later private
 * session never resumes from a stale earlier one, and a real DB position
 * written during a subsequent non-private session is never shadowed by a
 * leftover private-session entry.
 */

export interface VolatilePosition {
  chapterIndex: number;
  scrollPosition: number;
}

const positions = new Map<string, VolatilePosition>();

export function getVolatilePosition(bookId: string): VolatilePosition | undefined {
  return positions.get(bookId);
}

export function setVolatilePosition(bookId: string, position: VolatilePosition): void {
  positions.set(bookId, position);
}

export function clearAllVolatilePositions(): void {
  positions.clear();
}
